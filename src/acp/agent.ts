import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Agent } from '@agentclientprotocol/sdk';
import type { AgentEvent, PolicyAnswer, RunOptions } from '../agent/loop.js';
import { packageVersion } from '../packageRoot.js';
import type { Tool } from '../tools/types.js';

/**
 * `o4c acp` (plan 0006 H2): o4c as an Agent Client Protocol agent over stdio, so an editor that
 * speaks ACP (Zed, JetBrains, Neovim plugins, the VS Code extension in H2b, phone clients) can drive
 * it. One adapter for all of them.
 *
 * - stdout is the protocol channel (newline-delimited JSON-RPC); nothing else may be written there,
 *   which `runAcp` enforces by sending `console.log` to stderr.
 * - Streaming text and thinking become `agent_message_chunk` / `agent_thought_chunk`; each tool
 *   call becomes a `tool_call` (with a kind the editor can show: read, edit, execute, search, ...)
 *   and its result a `tool_call_update`.
 * - Anything o4c would ask about (Manual-mode rules: writes, shell, rules that say ask) becomes a
 *   `session/request_permission` to the editor; "always" is remembered for the session.
 * - `session/cancel` aborts the turn; the prompt then ends with stopReason `cancelled`.
 */
export interface AcpRunner {
  run(message: string, options: RunOptions): Promise<string>;
}

export interface AcpDeps {
  /** A runner (an AgentLoop) for a new session in `cwd`. */
  newRunner(cwd: string): AcpRunner;
  /** o4c's own decision for a tool call before anyone is asked: allow, deny, or ask the user. */
  decide(tool: Tool, input: Record<string, unknown>): Promise<'allow' | 'ask' | { verdict: 'deny'; reason: string }>;
  /** The run options every turn gets (context window, think level, ...). */
  runOptions?: () => Partial<RunOptions>;
  agentName?: string;
}

const TOOL_KIND: Record<string, 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'> = {
  read_file: 'read',
  write_file: 'edit',
  edit_file: 'edit',
  run_shell: 'execute',
  job_output: 'execute',
  pty: 'execute',
  grep_files: 'search',
  glob_files: 'search',
  code_graph: 'search',
  web_fetch: 'fetch',
  web_search: 'fetch',
  task: 'think',
};

export function toolKind(name: string): 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other' {
  return TOOL_KIND[name] ?? 'other';
}

export function toolTitle(name: string, input: Record<string, unknown> = {}): string {
  const subject = input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.agent;
  return typeof subject === 'string' && subject ? `${name}: ${subject.length > 80 ? `${subject.slice(0, 77)}...` : subject}` : name;
}

interface Session {
  runner: AcpRunner;
  abort?: AbortController;
  alwaysAllowed: Set<string>;
}

export class O4cAcpAgent implements Agent {
  private readonly sessions = new Map<string, Session>();
  private nextSession = 1;
  private nextToolCall = 1;

  constructor(
    private readonly conn: Pick<AgentSideConnection, 'sessionUpdate' | 'requestPermission'>,
    private readonly deps: AcpDeps,
  ) {}

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
      authMethods: [],
      agentInfo: { name: this.deps.agentName ?? 'o4c', version: packageVersion() },
    } as never;
  }

  async authenticate() {
    return {} as never;
  }

  async newSession(params: { cwd: string }) {
    const sessionId = `o4c-${process.pid}-${this.nextSession++}`;
    this.sessions.set(sessionId, { runner: this.deps.newRunner(params.cwd), alwaysAllowed: new Set() });
    return { sessionId } as never;
  }

  async cancel(params: { sessionId: string }) {
    this.sessions.get(params.sessionId)?.abort?.abort();
  }

  async prompt(params: { sessionId: string; prompt: { type: string; text?: string; resource?: { uri?: string; text?: string } }[] }) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    const text = params.prompt
      .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'resource' && b.resource?.text ? `[${b.resource.uri ?? 'resource'}]\n${b.resource.text}` : ''))
      .filter(Boolean)
      .join('\n\n');
    const abort = new AbortController();
    session.abort = abort;
    const sid = params.sessionId;
    const pending: { id: string; name: string }[] = [];
    let stepLimit = false;
    // Fire and forget: once the editor has gone, each update rejects, and that is nothing to report.
    const update = (u: Record<string, unknown>) => this.conn.sessionUpdate({ sessionId: sid, update: u } as never).catch(() => undefined);
    const onEvent = (e: AgentEvent) => {
      if (e.type === 'delta' && e.text) void update({ sessionUpdate: e.kind === 'think' ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: e.text } });
      else if ((e.type === 'text' || e.type === 'think') && !e.streamed && e.text) void update({ sessionUpdate: e.type === 'think' ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: e.text } });
      else if (e.type === 'tool_call' && e.toolName) {
        const id = `call-${this.nextToolCall++}`;
        pending.push({ id, name: e.toolName });
        void update({ sessionUpdate: 'tool_call', toolCallId: id, title: toolTitle(e.toolName, e.toolInput), kind: toolKind(e.toolName), status: 'in_progress', rawInput: e.toolInput ?? {} });
      } else if (e.type === 'tool_result') {
        const i = pending.findIndex((p) => p.name === e.toolName);
        const call = i >= 0 ? pending.splice(i, 1)[0]! : pending.shift();
        if (call) {
          const out = e.toolOutput ?? e.text ?? '';
          void update({ sessionUpdate: 'tool_call_update', toolCallId: call.id, status: /^(Error|Refused|Blocked|Denied)/.test(out) ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: out.length > 20_000 ? `${out.slice(0, 20_000)}\n...` : out } }] });
        }
      }
    };
    const toolPolicy = async (tool: Tool, input: Record<string, unknown>): Promise<PolicyAnswer> => {
      const decided = await this.deps.decide(tool, input);
      if (decided !== 'ask') return decided;
      const key = `${tool.name}:${toolTitle(tool.name, input)}`;
      if (session.alwaysAllowed.has(tool.name) || session.alwaysAllowed.has(key)) return 'allow';
      const res = (await this.conn.requestPermission({
        sessionId: sid,
        toolCall: { toolCallId: `perm-${this.nextToolCall++}`, title: toolTitle(tool.name, input), kind: toolKind(tool.name), status: 'pending', rawInput: input },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'always', name: `Always allow ${tool.name} this session`, kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      } as never)) as { outcome: { outcome: string; optionId?: string } };
      if (res.outcome.outcome === 'selected' && res.outcome.optionId === 'always') {
        session.alwaysAllowed.add(tool.name);
        return 'allow';
      }
      if (res.outcome.outcome === 'selected' && res.outcome.optionId === 'allow') return 'allow';
      return { verdict: 'declined', reason: 'the user rejected it in the editor' };
    };
    try {
      await session.runner.run(text, {
        ...(this.deps.runOptions?.() ?? {}),
        signal: abort.signal,
        onEvent,
        toolPolicy,
        onStepLimit: async () => {
          stepLimit = true;
          return 'summarize';
        },
      });
      return { stopReason: stepLimit ? 'max_turn_requests' : 'end_turn' } as never;
    } catch (err) {
      if (abort.signal.aborted) return { stopReason: 'cancelled' } as never;
      throw err;
    } finally {
      session.abort = undefined;
    }
  }
}

/** Runs the agent on this process's stdin/stdout until the client closes the connection. */
export async function runAcp(deps: AcpDeps): Promise<void> {
  // stdout belongs to the protocol from here on.
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = console.log;
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const conn = new AgentSideConnection((c) => new O4cAcpAgent(c, deps), stream);
  await (conn as unknown as { closed?: Promise<void> }).closed;
}
