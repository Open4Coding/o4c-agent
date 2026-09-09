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
