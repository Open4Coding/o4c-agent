import type { AgentLoop } from '../../agent/loop.js';
import type { ContextEntry } from '../../agent/contextEntry.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  StopReason,
  ToolCall,
} from '../../providers/types.js';
import {
  entryFindings,
  forbiddenFindings,
  maxTokensFindings,
  promptTokens,
  windowFindings,
  wireFindings,
  type Violation,
} from './invariants.js';

export const SUMMARY_PROMPT_PREFIX = 'You produce structured JSON summaries';
export const TAG_RE = /\[\[E\d+\]\]/;

const CHARS_PER_TOKEN = 4;
const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';

export type SummarizerMode = 'ok' | 'throw' | 'garbage' | 'huge';

export interface ScriptedCall {
  argTokens: number;
  resultTokens: number;
  tool?: string;
}

/** One provider round. Sizes are in tokens (chars / 4), the same convention the loop estimates with. */
export interface ScriptRound {
  /** `'overflow'` asks for more than any max_tokens cap, so the round is always cut off. */
  thinkTokens?: number | 'overflow';
  responseTokens?: number;
  /** Ends the response with a dangling connective, like a real mid-sentence stop. */
  endMidSentence?: boolean;
  calls?: ScriptedCall[];
  /** Tool-call JSON cut off mid-arguments: no call is returned and the stop is max_tokens. */
  truncatedToolCall?: boolean;
  /** Aborts the turn's signal during this round's request, then fails the request. */
  abortDuring?: boolean;
}

export interface ProviderConfig {
  window: number;
  /** Multiplier on the server-side token count versus chars / 4 (a tokenizer that disagrees). */
  drift: number;
  summarizer: SummarizerMode;
}

export interface ProviderStats {
  requests: number;
  summarizerCalls: number;
  summarizerOverWindow: number;
  peakFraction: number;
  capHits: number;
  aborts: number;
  overrun: number;
}

export class TagGen {
  private n = 0;
  next(): string {
    this.n += 1;
    return `[[E${this.n}]]`;
  }
}

/** Plain filler text of about `tokens` tokens (no tag), for system prompts and tool schemas. */
export function plainText(tokens: number): string {
  const chars = Math.max(0, tokens) * CHARS_PER_TOKEN;
  return FILLER.repeat(Math.ceil(chars / FILLER.length) + 1).slice(0, chars);
}

/** Filler text that starts with a unique tag, so the wire can be checked for hidden entries. */
export function tagged(tag: string, tokens: number): string {
  if (tokens <= 0) return '';
  const chars = Math.max(tokens * CHARS_PER_TOKEN, tag.length + 1);
  return `${tag} ${FILLER.repeat(Math.ceil(chars / FILLER.length) + 1)}`.slice(0, chars);
}

/**
 * Scripted LLMProvider. Main-loop calls consume `script` in order; summarizer calls (recognised by
 * their system prompt) are answered per `summarizer`. Every main request is checked against the
 * invariants before it is answered, so a violation is recorded at the exact step it happened.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly tags = new TagGen();
  readonly violations: Violation[] = [];
  readonly stats: ProviderStats = {
    requests: 0,
    summarizerCalls: 0,
    summarizerOverWindow: 0,
    peakFraction: 0,
    capHits: 0,
    aborts: 0,
    overrun: 0,
  };
  script: ScriptRound[] = [];
  cursor = 0;
  abortController: AbortController | undefined;
  /** Sizes (tokens) for the next tool results, consumed in call order by the test tools. */
  readonly resultQueue: number[] = [];
  private loop: AgentLoop | undefined;
  private readonly tagByEntry = new Map<string, string>();

  constructor(private readonly config: ProviderConfig) {}

  attach(loop: AgentLoop): void {
    this.loop = loop;
  }

  /** Called for every entry the loop appends, before anything can hide it. */
  noteEntry(entry: ContextEntry): void {
    const match = entry.content.match(TAG_RE);
    if (match) this.tagByEntry.set(entry.id, match[0]);
  }

  violate(invariant: string, detail: string): void {
    this.violations.push({ invariant, detail, step: this.stats.requests });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (request.systemPrompt?.startsWith(SUMMARY_PROMPT_PREFIX)) return this.summarize(request);

    this.stats.requests += 1;
    const round = this.script[this.cursor];
    this.cursor += 1;
    this.checkRequest(request);

    if (round?.abortDuring) {
      this.stats.aborts += 1;
      this.abortController?.abort();
      throw new Error('request aborted by test');
    }
    if (!round) {
      // The loop can legitimately ask again after a cutoff the script did not plan for; answer
      // briefly and count it, so the scenario still ends and the overrun is visible in the report.
      this.stats.overrun += 1;
      return this.produce({ responseTokens: 20 }, request);
    }
    return this.produce(round, request);
  }

  private checkRequest(request: CompletionRequest): void {
    if (!this.loop) throw new Error('ScriptedProvider used before attach()');
    const window = this.config.window;
    const prompt = promptTokens(request, this.config.drift);
    this.stats.peakFraction = Math.max(this.stats.peakFraction, prompt / window);
    if (request.maxTokens === Math.min(32768, Math.floor(window / 4))) this.stats.capHits += 1;

    const findings = [
      ...wireFindings(request.messages),
      ...entryFindings(this.loop.getEntries(), this.loop.getVisibleTokenEstimate(), window),
      ...maxTokensFindings(request.maxTokens, window),
      ...windowFindings(prompt, request.maxTokens, window),
      ...forbiddenFindings(request.messages, this.hiddenTags()),
    ];
    for (const f of findings) this.violate(f.invariant, f.detail);
  }

  private hiddenTags(): Set<string> {
    const hidden = new Set<string>();
    for (const entry of this.loop?.getEntries() ?? []) {
      if (entry.agent_visible !== false) continue;
      const tag = this.tagByEntry.get(entry.id);
      if (tag) hidden.add(tag);
    }
    return hidden;
  }

  private produce(round: ScriptRound, request: CompletionRequest): CompletionResponse {
    const cap = request.maxTokens ?? 0;
    const calls = round.calls ?? [];
    const wantThink =
      round.thinkTokens === 'overflow' ? cap + 1000 : round.thinkTokens ?? 0;
    const wantResponse = round.responseTokens ?? 0;
    const wantCallTokens = calls.reduce((sum, c) => sum + c.argTokens, 0);

    // Generation stops at the cap, in stream order: think, then response, then tool arguments.
    let remaining = cap;
    const think = Math.min(wantThink, remaining);
    remaining -= think;
    const response = Math.min(wantResponse, remaining);
    remaining -= response;
    const callsFit = calls.length > 0 && !round.truncatedToolCall && wantCallTokens <= remaining;
    const cut =
      think < wantThink ||
      response < wantResponse ||
      Boolean(round.truncatedToolCall) ||
      (calls.length > 0 && !callsFit);

    const toolCalls: ToolCall[] = [];
    if (callsFit) {
      for (const [k, c] of calls.entries()) {
        const tag = this.tags.next();
        this.resultQueue.push(c.resultTokens);
        toolCalls.push({
          id: `call-${tag.slice(2, -2)}-${k}`,
          name: c.tool ?? 'read_file',
          input: { path: `${tag}.txt`, content: tagged(tag, c.argTokens) },
        });
      }
    }

    const thinkText = think > 0 ? tagged(this.tags.next(), think) : '';
    let responseText = response > 0 ? tagged(this.tags.next(), response) : '';
    if (round.endMidSentence && !cut && responseText) responseText += ' and';
    const content = thinkText ? `<think>${thinkText}</think>${responseText}` : responseText;

    const stopReason: StopReason = cut ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    const argOut = callsFit ? wantCallTokens : 0;
    request.onToken?.(content, 'text');
    return {
      content,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: promptTokens(request, this.config.drift),
        outputTokens: think + response + argOut,
      },
    };
  }

  private summarize(request: CompletionRequest): CompletionResponse {
    this.stats.summarizerCalls += 1;
    const inputTokens = promptTokens(request, this.config.drift);
    if (inputTokens > this.config.window) this.stats.summarizerOverWindow += 1;

    let content: string;
    switch (this.config.summarizer) {
      case 'throw':
        throw new Error('summarizer unavailable (scripted)');
      case 'garbage':
        content = 'not json at all ### ';
        break;
      case 'huge':
        content = JSON.stringify({ current_work: plainText(2 * this.config.window) });
        break;
      case 'ok':
        content = JSON.stringify({ user_intent: 'scripted goal', current_work: plainText(300) });
        break;
    }
    return { content, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens, outputTokens: 0 } };
  }
}
