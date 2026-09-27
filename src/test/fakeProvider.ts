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
    // Snapshot now: `request.messages` is a live reference to the caller's array,
    // which gets mutated further after this call returns.
    this.receivedRequests.push(structuredClone(request));
    const next = this.queue.shift();
    if (!next) {
      throw new Error('FakeProvider: no more scripted responses queued');
    }
    return next;
  }
}
