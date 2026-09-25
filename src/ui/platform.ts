/**
 * General-purpose "what OS is this" detection - deliberately its own small module rather than
 * living inside a feature-specific file, so any future OS-conditional behavior (e.g.
 * o4c-agent-design.md §2.1's documented "disable Ctrl+Z on Windows, no SIGTSTP there" pattern)
 * can import the same fact instead of re-deriving `process.platform` ad hoc.
 */
export type OsKey = 'windows' | 'macos' | 'linux';

/** `platform` is injectable for tests only (defaults to `process.platform`, which is a static
 * value for the life of the process - there's no real difference between "detected at startup"
 * and "detected on demand" here, just where the read happens). Anything other than win32/darwin
 * buckets to 'linux', matching this project's own framing of Linux as the Unix baseline. */
export function detectCurrentOs(platform: NodeJS.Platform = process.platform): OsKey {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}
