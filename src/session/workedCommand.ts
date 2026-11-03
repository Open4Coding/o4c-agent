import { taskNumber, type InfiniteContextStore } from './infiniteContextStore.js';

/**
 * `/worked` - the manual "worked" mark on a task (NextUp item 23, checklist B7). Manual on
 * purpose: design doc 4.6 decided correctness is never inferred, because promoting a wrong answer
 * is worse than not promoting a right one. A marked task ranks up in every search; one marked as
 * not working ranks down.
 *
 * `/worked` marks this session's latest task; `/worked no` and `/worked clear` set the other two
 * states; a task number (`/worked #412`, `/worked #412.1 no`) marks that one instead.
 */
export function markWorkedCommand(store: InfiniteContextStore, sessionId: string, arg: string): string {
  const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const number = words.find((w) => /^#?\d+(?:\.\d+)?$/.test(w));
  const rest = words.filter((w) => w !== number);
  const verdict = rest[0] ?? 'yes';
  if (rest.length > 1 || !['yes', 'no', 'clear'].includes(verdict)) {
    return 'Usage: /worked [#task] [yes|no|clear] - with no task number it marks the last task in this session.';
  }

  const task = number ? store.getTaskByNumber(number) : store.lastTask(sessionId);
  if (!task) {
    return number
      ? `No task ${number} in this project's history.`
      : 'Nothing to mark yet - /worked marks the last task once one has run in this session.';
  }
  store.markWorked(task.id, verdict === 'clear' ? null : verdict === 'yes');
  const named = `${taskNumber(task)} "${task.title}"`;
  if (verdict === 'clear') return `Cleared the mark on ${named}.`;
  return verdict === 'yes'
    ? `Marked ${named} as worked - history search will rank it higher.`
    : `Marked ${named} as did not work - history search will rank it lower.`;
}

/**
 * `/mark-incorrect [#task] [reason]` (plan 0006 E22) - the counterpart to `/worked`: the answer was
 * wrong. Ranks the task down like `/worked no`, and keeps the reason in the task's errors so the
 * next search that finds it, and `/reflect`, see what was wrong rather than just that it was.
 */
export function markIncorrectCommand(store: InfiniteContextStore, sessionId: string, arg: string): string {
  const words = arg.trim().split(/\s+/).filter(Boolean);
  const number = words[0] && /^#?\d+(?:\.\d+)?$/.test(words[0]) ? words[0] : undefined;
  const reason = (number ? words.slice(1) : words).join(' ');
  const task = number ? store.getTaskByNumber(number) : store.lastTask(sessionId);
  if (!task) {
    return number
      ? `No task ${number} in this project's history.`
      : 'Nothing to mark yet - /mark-incorrect marks the last task once one has run in this session.';
  }
  store.markIncorrect(task.id, reason);
  return `Marked ${taskNumber(task)} "${task.title}" as incorrect${reason ? ' (reason kept with it)' : ''} - history search will rank it lower${reason ? ' and show why' : ''}. /worked clear undoes the mark.`;
}

let incorrectMarker: ((arg: string) => string) | undefined;

/** Set by cli.ts when this project has history.db. */
export function setIncorrectMarker(next: ((arg: string) => string) | undefined): void {
  incorrectMarker = next;
}

export function markIncorrect(arg: string): string {
  return incorrectMarker ? incorrectMarker(arg) : 'No task history here - it needs a trusted project, where o4c keeps .o4c/db/history.db.';
}
