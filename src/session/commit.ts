import { spawnSync } from 'node:child_process';

/**
 * `/commit` (plan 0006 E10): a commit message generated from the diff, shown for approval, then
 * committed. What is staged is what gets committed; with nothing staged, every change is (`git add
 * -A`), and the approval prompt says so. No Co-Authored-By or other trailer by default - a model
 * that writes one has it removed - and `commitTrailer` in config adds the user's own.
 */
const MAX_DIFF_CHARS = 40_000;

function git(args: string[], cwd: string, input?: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export interface CommitDiff {
  /** True: only the staged changes go in. False: everything is staged first. */
  staged: boolean;
  diff: string;
  stat: string;
}

/** The diff `/commit` would commit, or a reason there is nothing to. */
export function commitDiff(cwd = process.cwd()): CommitDiff | { error: string } {
  if (!git(['rev-parse', '--git-dir'], cwd).ok) return { error: 'This folder is not a git repository.' };
  const staged = git(['diff', '--cached', '--stat'], cwd).out.trim() !== '';
  if (!staged && git(['status', '--porcelain'], cwd).out.trim() === '') return { error: 'Nothing to commit - the working tree is clean.' };
  if (staged) {
    return { staged, stat: git(['diff', '--cached', '--stat'], cwd).out.trim(), diff: clip(git(['diff', '--cached'], cwd).out) };
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd).out.trim();
  const stat = [git(['diff', 'HEAD', '--stat'], cwd).out.trim(), untracked ? `new files:${['', ...untracked.split('\n')].join('\n  ')}` : '']
    .filter(Boolean)
    .join('\n');
  return { staged, stat, diff: clip(git(['diff', 'HEAD'], cwd).out + (untracked ? `\nNew files:\n${untracked}` : '')) };
}

function clip(diff: string): string {
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut at ${MAX_DIFF_CHARS.toLocaleString()} characters)` : diff;
}

export function commitPrompt(d: CommitDiff, hint: string): string {
  return [
    'Write a git commit message for this change.',
    'First line: an imperative summary, at most 72 characters. Then, only if the change needs it, a blank line and a short body saying what changed and why.',
    'No trailers (no Co-Authored-By, Signed-off-by), no markdown fences, no preamble - output the message and nothing else.',
    ...(hint ? [`The user says: ${hint}`] : []),
    '',
    d.diff,
  ].join('\n');
}

/** The model's reply as a message: fences, think blocks and trailers out; the user's trailer in. */
export function cleanCommitMessage(text: string, trailer?: string): string {
  let s = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(s);
  if (fenced) s = fenced[1]!.trim();
  const lines = s.split('\n').filter((l) => !/^\s*(co-authored-by|signed-off-by|generated-by)\s*:/i.test(l));
  s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return trailer?.trim() ? `${s}\n\n${trailer.trim()}` : s;
}

/** Stages (when nothing was staged) and commits. The new commit's short hash, or git's error. */
export function runCommit(message: string, stageAll: boolean, cwd = process.cwd()): { hash?: string; error?: string } {
  if (stageAll) {
    const add = git(['add', '-A'], cwd);
    if (!add.ok) return { error: add.out.trim() };
  }
  const c = git(['commit', '-F', '-'], cwd, `${message}\n`);
  if (!c.ok) return { error: c.out.trim() };
  return { hash: git(['rev-parse', '--short', 'HEAD'], cwd).out.trim() };
}
