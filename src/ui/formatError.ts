import Anthropic from '@anthropic-ai/sdk';
import { MaxIterationsError } from '../agent/loop.js';

export function formatError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error (status ${err.status ?? 'unknown'}): ${err.message}`;
  }
  if (err instanceof MaxIterationsError) {
    return `Stopped: ${err.message} - the task may be incomplete.`;
  }
  if (err instanceof Error) {
    return `Unexpected error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}
