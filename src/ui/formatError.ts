import Anthropic from '@anthropic-ai/sdk';

export function formatError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error (status ${err.status ?? 'unknown'}): ${err.message}`;
  }
  return `Unexpected error: ${(err as Error).message}`;
}
