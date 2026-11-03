import type { Tool } from './types.js';
import { childEnv } from '../session/redact.js';
import { currentShell } from './shell.js';

/**
 * The `pty` tool (plan 0006 G11, Q8) - off unless config `ptyTool` is true. It lets the model drive
 * an interactive program the way a person would: start it in a real pseudo-terminal, type into it,
 * press keys, and read the SCREEN (what a terminal would show, cursor moves and redraws applied),
 * not a raw byte stream. For REPLs, prompts that insist on a TTY, ssh, text UIs.
 *
 * Both halves are optional dependencies loaded only when the tool is first used: `@lydell/node-pty`
 * (prebuilt binaries, no compiler needed) and `@xterm/headless` (the screen). A machine without
 * them gets a plain message, never a crash. Mutating, so every mode treats it like run_shell; at
 * most three sessions, all killed when o4c exits.
 */
export const PTY_CONFIG_KEY = 'ptyTool';
const MAX_SESSIONS = 3;
const SETTLE_MS = 400;
const MAX_WAIT_MS = 15_000;

interface PtyProcess {
  write(data: string): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  pid: number;
}

interface Screen {
  write(data: string): void;
  buffer: { active: { length: number; viewportY: number; cursorX: number; cursorY: number; getLine(i: number): { translateToString(trim?: boolean): string } | undefined } };
}

interface Session {
  id: number;
  command: string;
  pty: PtyProcess;
  screen: Screen;
  lastOutput: number;
  exited?: number;
  rows: number;
}

const sessions = new Map<number, Session>();
let nextId = 1;
let exitHooked = false;

export const KEYS: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  delete: '\x1b[3~',
  space: ' ',
};

/** "ctrl+c" -> \x03, "up" -> ESC[A; unknown names come back undefined. */
export function keyBytes(name: string): string | undefined {
  const k = name.trim().toLowerCase();
  const ctrl = /^ctrl\+([a-z])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
  return KEYS[k];
}

function render(s: Session): string {
  const b = s.screen.buffer.active;
  const lines: string[] = [];
  for (let i = b.viewportY; i < Math.min(b.length, b.viewportY + s.rows); i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const state = s.exited !== undefined ? ` - exited with ${s.exited}` : '';
  return [`[pty ${s.id}: ${s.command}${state}; cursor row ${b.cursorY + 1}, col ${b.cursorX + 1}]`, ...lines].join('\n');
}

/** Waits until the program has been quiet for SETTLE_MS (or MAX_WAIT_MS passes, or it exits). */
async function settle(s: Session, signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 120));
  while (Date.now() - start < MAX_WAIT_MS && !signal?.aborted && s.exited === undefined) {
    if (Date.now() - s.lastOutput >= SETTLE_MS) return;
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function load(): Promise<{ spawn: (file: string, args: string[] | string, opts: Record<string, unknown>) => PtyProcess; Terminal: new (o: Record<string, unknown>) => Screen } | string> {
  try {
    const ptyMod = (await import('@lydell/node-pty')) as unknown as { spawn: (file: string, args: string[] | string, opts: Record<string, unknown>) => PtyProcess; default?: { spawn: unknown } };
    const xterm = (await import('@xterm/headless')) as unknown as { Terminal?: new (o: Record<string, unknown>) => Screen; default?: { Terminal: new (o: Record<string, unknown>) => Screen } };
    const spawn = (ptyMod.spawn ?? (ptyMod.default as { spawn: typeof ptyMod.spawn }).spawn) as typeof ptyMod.spawn;
    const Terminal = xterm.Terminal ?? xterm.default!.Terminal;
    return { spawn, Terminal };
  } catch (err) {
    return `The pty tool needs two optional packages that are not installed here (@lydell/node-pty, @xterm/headless): ${err instanceof Error ? err.message : String(err)}. Reinstall o4c with optional dependencies, or use run_shell.`;
  }
}

export function stopAllPty(): void {
  for (const s of sessions.values()) {
    try {
      s.pty.kill();
    } catch {
      // Already gone.
    }
  }
  sessions.clear();
}

export const ptyTool: Tool = {
  name: 'pty',
  description: [
    'Drive an interactive program in a real terminal (REPLs, tools that demand a TTY, prompts, text UIs). Actions:',
    '- start: {command} (default: the shell) - returns an id and the screen.',
    '- send: {id, text?, keys?} - types text, then presses keys in order (enter, tab, esc, up, down, left, right, backspace, ctrl+c, ctrl+d, ...). Returns the screen once output settles.',
    '- screen: {id} - the screen now. stop: {id} - ends it.',
    'Use run_shell for ordinary non-interactive commands.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'send', 'screen', 'stop'] },
      id: { type: 'number', description: 'The session, from start.' },
      command: { type: 'string', description: 'start: the program and its arguments.' },
      text: { type: 'string', description: 'send: text to type (no Enter unless you add the enter key).' },
      keys: { type: 'array', items: { type: 'string' }, description: 'send: keys to press after the text.' },
    },
    required: ['action'],
  },
  mutating: true,
  async execute(input, context) {
    const action = String(input.action ?? '');
    if (action === 'start') {
      if (sessions.size >= MAX_SESSIONS) return `At most ${MAX_SESSIONS} pty sessions at once - stop one first (open: ${[...sessions.keys()].join(', ')}).`;
      const lib = await load();
      if (typeof lib === 'string') return lib;
      const given = typeof input.command === 'string' && input.command.trim() ? input.command.trim() : undefined;
      const command = given ?? currentShell().exe;
      const rows = 30;
      const cols = 120;
      const screen = new lib.Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
      const isWin = process.platform === 'win32';
      const opts = { cols, rows, cwd: process.cwd(), env: childEnv() };
      // No command: the shell itself, directly. A command: through the platform shell, so its own
      // quoting and PATH lookup apply exactly as they would typed into a terminal.
      const pty = !given ? lib.spawn(command, [], opts) : isWin ? lib.spawn('cmd.exe', `/c ${given}`, opts) /* a raw command line: node-pty would re-quote an array */ : lib.spawn('/bin/sh', ['-c', given], opts);
      const s: Session = { id: nextId++, command, pty, screen, lastOutput: Date.now(), rows };
      pty.onData((d) => {
        s.lastOutput = Date.now();
        screen.write(d);
      });
      pty.onExit((e) => {
        s.exited = e.exitCode;
      });
      sessions.set(s.id, s);
      if (!exitHooked) {
        exitHooked = true;
        process.once('exit', stopAllPty);
      }
      context?.onOutput?.(`[pty ${s.id}] started: ${command}\n`);
      await settle(s, context?.signal);
      return render(s);
    }
    const id = Number(input.id);
    const s = sessions.get(id);
    if (!s) return `No pty session ${Number.isFinite(id) ? id : '(missing id)'}. Open: ${[...sessions.keys()].join(', ') || 'none'}.`;
    if (action === 'screen') return render(s);
    if (action === 'stop') {
      try {
        s.pty.kill();
      } catch {
        // Already exited.
      }
      sessions.delete(id);
      return `pty ${id} stopped.`;
    }
    if (action === 'send') {
      if (s.exited !== undefined) return `${render(s)}\n(The program has exited; start a new session.)`;
      const keys = Array.isArray(input.keys) ? input.keys.map(String) : [];
      const bad = keys.filter((k) => keyBytes(k) === undefined);
      if (bad.length) return `Unknown key${bad.length === 1 ? '' : 's'}: ${bad.join(', ')}. Known: ${Object.keys(KEYS).join(', ')}, ctrl+a..ctrl+z.`;
      if (typeof input.text === 'string' && input.text) s.pty.write(input.text);
      for (const k of keys) s.pty.write(keyBytes(k)!);
      await settle(s, context?.signal);
      return render(s);
    }
    return `Unknown action "${action}" - start, send, screen or stop.`;
  },
};
