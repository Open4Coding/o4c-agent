# Interactive REPL

`o4c` can run as a one-shot command or as an interactive, multi-turn session.

- `o4c "some prompt"` — runs once, prints the answer, exits. Each invocation starts with no
  memory of any previous one.
- `o4c` (no prompt argument) — starts an interactive session. Conversation history persists
  across turns until you exit, so follow-up questions and multi-step tasks work naturally.

## REPL commands

- Type a message and press Enter to send it. Up/down arrow recalls previously submitted
  messages (per-session only, not persisted across restarts). The input has no concept of
  "current line" separate from the rest of what you've typed - it's one buffer, even across
  multiple lines (e.g. from Ctrl+Enter). So left/right arrow, and Ctrl+A / Ctrl+E, move by a
  single character or to the absolute start/end of the *entire* prompt, not just the line the
  cursor happens to be on - and Ctrl+U clears everything you've typed, all lines at once, not
  just one of them. Standard readline/bash conventions, used instead of Home/End/Ctrl+Backspace
  since terminals send those as raw escape sequences Ink's input handling doesn't parse into
  dedicated keys.
- You can keep typing while a turn is still in progress. Submitting while busy queues the
  message instead of running it immediately - each one is shown as "Queued #1: ...",
  "Queued #2: ...", and so on. They run automatically, one at a time in the order you sent
  them, as each turn finishes - submitting more than one while busy keeps all of them.
- `/clear` — clears conversation history and starts fresh, without restarting the process.
- `/debug` — shows the raw underlying conversation data (every message, tool call, and tool
  result, not the pretty-printed view) instead of the normal screen. Press `Esc` to return to
  the normal session. If the raw data is longer than fits on one screen, only the most recent
  lines are shown (Ink's rendering repaints this view rather than letting the terminal scroll
  it, unlike the normal scrollback) — there's a note when it's been trimmed.
- `/exit` or `/quit` — ends the session.
- Ctrl+D (EOF on stdin) also ends the session cleanly.

## Running from a terminal

After the normal setup (`npm install`, `npm run build`, `npm link` — see the main README):

```
o4c
```

From source without building first:

```
npm run dev
```

With a specific provider, same flags as one-shot mode (e.g. the free self-hosted local server):

```
o4c -p local
```

## Running from VS Code

The simplest way is the integrated terminal — it's a real shell, so nothing about the harness
changes:

1. Open this project folder **directly** in VS Code (**File > Open Folder...** ->
   `o4c-agent`, not a parent folder — see Troubleshooting below for why this matters).
2. Open the integrated terminal (`` Ctrl+` ``, or **View > Terminal**).
3. Run `o4c` (or `npm run dev`, or `node dist/cli.js`) exactly as you would anywhere else.

If you're developing the harness itself and want to step through the TypeScript source with
breakpoints instead of just running it, use the debug configuration already checked into this
repo at `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "o4c REPL (debug)",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["tsx", "src/cli.ts"],
      "console": "integratedTerminal",
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

**Run and Debug** (`Ctrl+Shift+D`) > **o4c REPL (debug)** > **Start Debugging** (`F5`). No
prompt argument is passed, so it starts the interactive REPL with breakpoints active. Add
`"args": ["-p", "local"]` (or any other flags) to the configuration to change how it launches.

## Troubleshooting

- **Run and Debug shows "Open a file which can be debugged or run" instead of "o4c REPL
  (debug)"**: VS Code only auto-loads `.vscode/launch.json` relative to the currently *open
  folder*. If you opened a parent directory (e.g. `D:\Open4Coding`) instead of `o4c-agent`
  itself, the config won't be found even though the file exists on disk. Fix: **File > Open
  Folder...** and open `o4c-agent` directly, not its parent.
- **`o4c: command not found` / "not recognized" in the terminal**: `npm link` (part of the main
  README's setup) registers the global `o4c` command — if it was skipped, or if you're in a
  terminal session that was already open *before* running it, `o4c` won't resolve. Run
  `npm link` from the project root, then open a **new** terminal (PATH is read once per shell
  session, not live-reloaded) — `npx tsx src/cli.ts` works in the meantime without needing the
  link at all.

## Notes

- Each REPL turn calls the configured provider's real backend, same as one-shot mode. With
  `-p anthropic` (the default) that means real cost per turn — use `-p mock` or `-p local` for
  free iteration.
- `--image <path>` applies to every turn in a session, not just the first, since the flag is set
  once for the whole process.
