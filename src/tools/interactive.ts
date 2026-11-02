/**
 * Shell commands that can only hang without a terminal (plan 0006 B23). `run_shell` closes stdin,
 * so a prompt reads end-of-file and usually fails fast - but an editor, a pager or a REPL can sit
 * there until the timeout, and the model learns nothing from "timed out". These are refused up
 * front with what to do instead.
 */

/** Set for every command: tools that would prompt, page or colour their output do not. */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  CI: '1',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EDITOR: 'true',
  DEBIAN_FRONTEND: 'noninteractive',
  PIP_NO_INPUT: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};

const EDITORS = new Set(['vim', 'vi', 'nvim', 'nano', 'emacs', 'pico', 'joe', 'notepad', 'code']);
const PAGERS = new Set(['less', 'more', 'most']);
const MONITORS = new Set(['top', 'htop', 'btop', 'watch']);
const REPLS = new Set(['python', 'python3', 'py', 'node', 'irb', 'ghci', 'psql', 'mysql', 'sqlite3', 'lua', 'R', 'julia', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh']);

/** Each command in a pipeline or chain, split on && || ; | & (quotes respected loosely). */
function segments(command: string): Array<{ words: string[]; piped: boolean }> {
  const out: Array<{ words: string[]; piped: boolean }> = [];
  let current = '';
  let quote: string | undefined;
  let piped = false;
  const push = (nextPiped: boolean) => {
    const words = current.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (words.length) out.push({ words, piped });
    current = '';
    piped = nextPiped;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = undefined;
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === '|' && command[i + 1] !== '|') {
      push(true);
    } else if ((c === '&' || c === '|') && command[i + 1] === c) {
      push(false);
      i++;
    } else if (c === ';' || c === '&') {
      push(false);
    } else {
      current += c;
    }
  }
  push(false);
  return out;
}

const base = (word: string) => word.replace(/^["']|["']$/g, '').split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/** Why this command cannot run here, or undefined when it can. */
export function interactiveReason(command: string): string | undefined {
  for (const { words, piped } of segments(command)) {
    const [first, ...rest] = words;
    const name = base(first);
    const args = rest.filter((a) => !/^[<>]|^\d?>/.test(a));
    if (EDITORS.has(name) && !(name === 'code' && args.some((a) => a.startsWith('--')))) {
      return `${name} is an interactive editor and would wait forever here. Change files with edit_file or write_file.`;
    }
    // Output going to a file: nothing waits on a terminal.
    const redirected = words.some((w) => /^\d?>>?/.test(w));
    if (PAGERS.has(name) && !redirected && (piped || args.length > 0)) {
      return `${name} is a pager and would wait for a keypress here. Read the file with read_file, or drop the "| ${name}".`;
    }
    if (MONITORS.has(name)) {
      return `${name} runs until stopped and draws a full screen. Take one sample instead (e.g. "ps", "tasklist").`;
    }
    if (REPLS.has(name) && !piped && args.length === 0) {
      return `${name} with nothing to run starts an interactive prompt. Pass a script or a command (e.g. ${name === 'node' ? 'node -e "..."' : name.startsWith('py') ? `${name} -c "..."` : `${name} <file>`}).`;
    }
    if (name === 'git') {
      const sub = args[0];
      if (sub === 'rebase' && args.some((a) => a === '-i' || a === '--interactive')) return 'git rebase -i opens an editor. Rebase without -i, or use git commands that take their input as arguments.';
      if (sub === 'add' && args.some((a) => a === '-i' || a === '-p' || a === '--patch' || a === '--interactive')) return 'git add -p/-i asks questions interactively. Stage whole files with git add <path>.';
      if (sub === 'commit' && !args.some((a) => /^(-m|-am|-F|--message|--file|--no-edit|-C|--reuse-message|--fixup|--amend)/.test(a))) {
        return 'git commit without a message opens an editor. Pass the message with -m "...".';
      }
    }
    if (name === 'ssh') {
      const positional = args.filter((a) => !a.startsWith('-'));
      if (positional.length <= 1) return 'ssh without a remote command opens an interactive session. Give the command to run: ssh host "command".';
    }
  }
  return undefined;
}
