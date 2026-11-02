/**
 * `/review` (plan 0006 D9): a read-only turn that reviews this session's changes - the checkpoint
 * diff when there is one (everything since the session's first change), else the model is told to
 * look with git itself. Findings ranked, nothing edited.
 */
const MAX_DIFF_CHARS = 30_000;

export function reviewPrompt(diff: string | undefined, focus: string): string {
  const what = focus ? `Focus on: ${focus}\n\n` : '';
  const body = diff
    ? `These are the changes made in this session (a diff against the files before the first change):\n\n${diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut at ${MAX_DIFF_CHARS.toLocaleString()} characters - read the rest of the changed files yourself)` : diff}`
    : 'There is no checkpoint record of this session\'s changes. Use `git diff` and `git status` (run_shell) to see what changed.';
  return [
    'Review the changes below as a careful reviewer would. Do not change any files.',
    '',
    what + body,
    '',
    'Report, most serious first: bugs and wrong behaviour, missing or broken error handling, changes without tests that need them, callers or docs left out of step, and risky edits. Give file:line for each finding and say how sure you are. If you find nothing worth raising, say so plainly.',
  ].join('\n');
}
