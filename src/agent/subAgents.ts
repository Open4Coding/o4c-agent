import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import { AgentLoop, type PolicyAnswer } from './loop.js';
import type { ContextEntry } from './contextEntry.js';

/**
 * Sub-agents (plan 0006 G4): the `task` tool hands a self-contained job to a child agent with its
 * own empty context and a smaller tool set, and gets back only the child's final answer. The point
 * on a one-slot local server is not speed - children run one at a time, inside the parent's tool
 * call - but keeping a long search or a noisy test run out of the main conversation's context.
 *
 * Depth 1: a child never gets the `task` tool. Built-in profiles: `explore` (read-only search,
 * returns a summary with file:line references) and `verify` (runs the checks, reports what passed
 * and what failed). A user profile is `.o4c/agents/<name>.md` (or `~/.o4c/agents/`) with
 * frontmatter `description` and `tools`, and the body as the child's instructions. The child's tool
 * calls go through the same permission policy as the parent's, so Manual mode still asks.
 */
export interface AgentProfile {
  name: string;
  description: string;
  tools: string[];
  prompt: string;
  maxIterations: number;
  scope: 'built-in' | 'project' | 'global';
}

export const BUILT_IN_PROFILES: readonly AgentProfile[] = [
  {
    name: 'explore',
    description: 'Read-only search of the codebase; returns a short summary with file:line references.',
    tools: ['read_file', 'grep_files', 'glob_files', 'code_graph'],
    prompt: [
      'You are a research sub-agent. Answer the question you are given by searching and reading the code - you cannot change anything.',
      'Work efficiently: search first (grep_files, glob_files, code_graph), then read only the parts that matter.',
      'Your final answer is all the caller sees: make it a short, complete summary - the answer first, then the evidence as file:line references, then anything you could not determine. No preamble.',
    ].join('\n'),
    maxIterations: 30,
    scope: 'built-in',
  },
  {
    name: 'verify',
    description: 'Runs the build/tests/linters for a change and reports exactly what passed and what failed.',
    tools: ['read_file', 'grep_files', 'glob_files', 'run_shell', 'job_output'],
    prompt: [
      'You are a verification sub-agent. Find out whether the work described to you is correct by running the project\'s own checks (tests, type check, build, linters) - you do not fix anything.',
      'Find the right commands (package.json scripts, Makefile, README), run the relevant ones, and read failures closely.',
      'Your final answer is all the caller sees: PASS or FAIL first, then each command run with its result, then for each failure the exact error and the file:line it points to. No preamble.',
    ].join('\n'),
    maxIterations: 30,
    scope: 'built-in',
  },
];

function parseProfileFile(text: string): { description?: string; tools?: string[]; maxIterations?: number; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  const tools = meta.tools?.replace(/^\[|\]$/g, '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const max = Number(meta['max-iterations'] ?? meta.maxiterations);
  return { description: meta.description, tools, ...(Number.isInteger(max) && max > 0 ? { maxIterations: max } : {}), body: m[2]!.trim() };
}

function readProfiles(dir: string, scope: AgentProfile['scope']): AgentProfile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
  const out: AgentProfile[] = [];
  for (const n of names.sort()) {
    try {
      const p = parseProfileFile(readFileSync(join(dir, n), 'utf-8'));
      const name = n.slice(0, -3).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      if (!name || !p.body) continue;
      out.push({ name, description: p.description ?? `Sub-agent from ${join(dir, n)}`, tools: p.tools ?? ['read_file', 'grep_files', 'glob_files'], prompt: p.body, maxIterations: p.maxIterations ?? 30, scope });
    } catch {
      // Unreadable: not a profile.
    }
  }
  return out;
}

/** Built-in, then global, then project - a later one of the same name replaces an earlier one. */
export function loadProfiles(projectRoot: string | undefined, home = homedir()): AgentProfile[] {
  const byName = new Map<string, AgentProfile>();
  for (const p of BUILT_IN_PROFILES) byName.set(p.name, p);
  for (const p of readProfiles(join(home, '.o4c', 'agents'), 'global')) byName.set(p.name, p);
  if (projectRoot) for (const p of readProfiles(join(projectRoot, '.o4c', 'agents'), 'project')) byName.set(p.name, p);
  return [...byName.values()];
}

export interface TaskRuntime {
  provider: LLMProvider;
  /** Every tool the parent has right now; a child gets the subset its profile names (never `task`). */
  tools: () => readonly Tool[];
  environment: readonly string[];
  /** The policy the parent's current turn runs under - set per turn, so a child obeys the same mode. */
  policy?: (tool: Tool, input: Record<string, unknown>) => Promise<PolicyAnswer>;
  contextWindow?: number;
  /** History: a recorder per child run, so each run is filed as its own finished task. */
  record?: () => { onEntry: (entry: ContextEntry) => void; finish: () => void };
}

let runtime: TaskRuntime | undefined;

export function setTaskRuntime(next: TaskRuntime | undefined): void {
  runtime = next;
}

export function setTaskPolicy(policy: TaskRuntime['policy']): void {
  if (runtime) runtime.policy = policy;
}

export function childSystemPrompt(profile: AgentProfile, environment: readonly string[]): string {
  return [profile.prompt, ...(environment.length ? ['', '# Environment', ...environment] : [])].join('\n');
}

/** The `task` tool for these profiles. Built once per session, so its description is fixed. */
export function createTaskTool(profiles: readonly AgentProfile[]): Tool {
  return {
    name: 'task',
    description: [
      'Hand a self-contained job to a sub-agent with its own fresh context; you get back only its final answer. Use it to keep a long search or a noisy test run out of this conversation. One at a time; a sub-agent cannot start another.',
      'Agents:',
      ...profiles.map((p) => `- ${p.name}: ${p.description}`),
      'Give the task everything the agent needs - it sees nothing of this conversation.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: profiles.map((p) => p.name), description: 'Which sub-agent.' },
        task: { type: 'string', description: 'The complete, self-contained job description.' },
      },
      required: ['agent', 'task'],
    },
    async execute(input, context) {
      const profile = profiles.find((p) => p.name === input.agent);
      if (!profile) return `No sub-agent "${String(input.agent)}". Agents: ${profiles.map((p) => p.name).join(', ')}.`;
      const job = typeof input.task === 'string' ? input.task.trim() : '';
      if (!job) return 'The task is empty - describe the job for the sub-agent.';
      if (!runtime) return 'Sub-agents are not available in this session.';
      const rt = runtime;
      const tools = rt.tools().filter((t) => t.name !== 'task' && profile.tools.includes(t.name));
      const record = rt.record?.();
      const child = new AgentLoop(rt.provider, tools, childSystemPrompt(profile, rt.environment));
      let toolCalls = 0;
      context?.onOutput?.(`[${profile.name}] started\n`);
      try {
        const answer = await child.run(job, {
          maxIterations: profile.maxIterations,
          signal: context?.signal,
          contextWindow: rt.contextWindow,
          toolPolicy: rt.policy,
          onStepLimit: async () => 'summarize',
          onEntry: (e) => record?.onEntry(e),
          onEvent: (event) => {
            if (event.type === 'tool_call') {
              toolCalls++;
              context?.onOutput?.(`[${profile.name}] ${event.toolName}\n`);
            }
          },
        });
        const used = child.getUsage();
        return `${answer.trim() || '(the sub-agent gave no answer)'}\n\n(${profile.name} sub-agent: ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}, ${used.inputTokens.toLocaleString()} prompt / ${used.outputTokens.toLocaleString()} generated tokens)`;
      } catch (err) {
        return `The ${profile.name} sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        record?.finish();
      }
    },
  };
}
