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

/** The shell `run_shell` actually uses: Node's `exec` picks `ComSpec` on Windows and `/bin/sh` elsewhere. */
export function shellFor(os: OsKey, env: NodeJS.ProcessEnv = process.env): string {
  if (os === 'windows') return env.ComSpec || 'cmd.exe';
  return '/bin/sh';
}

/** A line for the system prompt stating the real OS and shell, so the model doesn't guess Unix commands. */
export function platformPromptLine(os: OsKey = detectCurrentOs(), env: NodeJS.ProcessEnv = process.env): string {
  const shell = shellFor(os, env);
  if (os === 'windows') {
    return `Platform: Windows. Shell commands run in ${shell}, not a Unix shell: use Windows commands (dir, type, findstr, where, cd) and backslash paths. Do not assume Unix commands such as ls, cat, pwd, or grep exist.`;
  }
  return `Platform: ${os === 'macos' ? 'macOS' : 'Linux'}. Shell commands run in ${shell}.`;
}
