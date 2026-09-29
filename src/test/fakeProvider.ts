import type { CompletionRequest, CompletionResponse, LLMProvider } from '../providers/types.js';

/**
 * A scripted LLMProvider for testing the agent loop without a real API call.
 * Give it a queue of responses; each call to complete() returns the next one.
 */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  private queue: CompletionResponse[];
  public callCount = 0;
  public receivedRequests: CompletionRequest[] = [];

  constructor(responses: CompletionResponse[]) {
    this.queue = [...responses];
  }

  /** Adds more scripted responses to the end of the queue - for tests that need to keep using
   * the same instance (and its accumulating `receivedRequests`) across more than one batch. */
  enqueue(...responses: CompletionResponse[]): void {
    this.queue.push(...responses);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.callCount++;
    // Snapshot now: `request.messages` is a live reference to the caller's array, which gets
    // mutated further after this call returns. `onToken`/`signal` are excluded - neither is
    // structured-cloneable (a function and, depending on the runtime, an AbortSignal), and
    // recording them was never the point; `receivedRequests` is for asserting on what was *asked*
    // (messages, tools, systemPrompt), not on these two call-mechanics-only fields.
    const { onToken, signal, ...cloneable } = request;
    this.receivedRequests.push(structuredClone(cloneable) as CompletionRequest);
    const next = this.queue.shift();
    if (!next) {
      throw new Error('FakeProvider: no more scripted responses queued');
    }
    // Simulates streaming for anything that cares to check it (AgentLoop's own 'delta' wiring),
    // one call with the full content - not truly incremental, matching MockProvider's own
    // simplification. Always 'text': tests exercising think-block behavior here script raw
    // <think> tags directly into content and rely on the tag-stripper (kind-based labeling is a
    // separate, additive signal real providers give - this fake has no equivalent to give).
    onToken?.(next.content, 'text');
    return next;
  }
}
