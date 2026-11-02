import { createHash } from 'node:crypto';

/**
 * Notices a turn going in circles (plan 0006 B16) - the most common way a local model burns a
 * whole session. Three patterns, all counted within one user turn:
 *
 *  - the same call returning the same result again: a note at 3, a firmer one at 5, and at 8 the
 *    call is not run and the turn stops. Same call with a different result is progress (running the
 *    tests again after an edit), so the key is the call and its result together.
 *  - an A-B-A-B alternation of two such pairs (edit, revert, edit, revert) - caught at four
 *    calls, before either pair has repeated often enough to trip the first rule.
 *  - five different calls in a row that all came back with the same result ("No matches...").
 *
 * The notes are appended to the tool result, where the model reads them at the moment it matters.
 */

export const REPEAT_NOTE = 3;
export const REPEAT_FIRM = 5;
export const REPEAT_STOP = 8;
const SAME_RESULT_STREAK = 5;

const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class LoopGuard {
  private readonly counts = new Map<string, number>();
  private readonly history: string[] = [];
  private readonly results: string[] = [];
  private alternationNoted = false;

  /** Before running a call: a refusal when this exact call already went round REPEAT_STOP - 1 times. */
  refuse(name: string, input: Record<string, unknown>): string | undefined {
    const call = `${name}:${stable(input)}`;
    for (const [key, count] of this.counts) {
      if (key.startsWith(`${call}#`) && count >= REPEAT_STOP - 1) {
        return `[o4c] Not run: this exact ${name} call has already returned the same result ${count} times this turn. Stop repeating it - change approach, or report what is blocking you.`;
      }
    }
    return undefined;
  }

  /** After running a call: a note to append to its result, if this turn is going in circles. */
  record(name: string, input: Record<string, unknown>, output: string): string | undefined {
    const call = `${name}:${stable(input)}`;
    const resultHash = hash(output);
    const key = `${call}#${resultHash}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    this.history.push(key);
    this.results.push(resultHash);

    if (count >= REPEAT_FIRM) {
      return `\n[o4c] You have now made this exact ${name} call ${count} times this turn and it returned the same result each time. Repeating it will not change the result. Do something different, or stop and say what is blocking you. (At ${REPEAT_STOP} it will not be run.)`;
    }
    if (count >= REPEAT_NOTE) {
      return `\n[o4c] This is the ${count}${count === 3 ? 'rd' : 'th'} time this turn this exact ${name} call returned this same result. Try a different approach.`;
    }

    const h = this.history;
    if (!this.alternationNoted && h.length >= 4) {
      const [a, b] = [h[h.length - 2], h[h.length - 1]];
      if (a !== b && h.slice(-4).every((k, i) => k === (i % 2 === 0 ? a : b))) {
        this.alternationNoted = true;
        return '\n[o4c] The last four calls alternate between the same two calls with the same two results - this is a loop. Step back and change approach.';
      }
    }

    const r = this.results;
    if (r.length >= SAME_RESULT_STREAK && r.slice(-SAME_RESULT_STREAK).every((x) => x === resultHash)) {
      return `\n[o4c] The last ${SAME_RESULT_STREAK} calls all returned exactly this result. Changing the arguments slightly is not working - rethink what you are looking for.`;
    }
    return undefined;
  }

  /** True once a call has been refused this turn - the loop ends the turn. */
  stopped = false;
}
