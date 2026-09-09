# Interactive REPL

`o4c` can run as a one-shot command or as an interactive, multi-turn session.

- `o4c "some prompt"` — runs once, prints the answer, exits. Each invocation starts with no
  memory of any previous one.
- `o4c` (no prompt argument) — starts an interactive session. Conversation history persists
  across turns until you exit, so follow-up questions and multi-step tasks work naturally.

## REPL commands

- Type a message and press Enter to send it.
- `/reset` — clears conversation history and starts fresh, without restarting the process.
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

1. Open this project folder in VS Code.
2. Open the integrated terminal (`` Ctrl+` ``, or **View > Terminal**).
3. Run `o4c` (or `npm run dev`, or `node dist/cli.js`) exactly as you would anywhere else.

If you're developing the harness itself and want to step through the TypeScript source with
breakpoints instead of just running it, add a debug configuration. Create (or extend)
`.vscode/launch.json`:

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

Then **Run and Debug** (`Ctrl+Shift+D`) > **o4c REPL (debug)** > **Start Debugging** (`F5`). No
prompt argument is passed, so it starts the interactive REPL with breakpoints active. Add
`"args": ["-p", "local"]` (or any other flags) to the configuration to change how it launches.

## Notes

- Each REPL turn calls the configured provider's real backend, same as one-shot mode. With
  `-p anthropic` (the default) that means real cost per turn — use `-p mock` or `-p local` for
  free iteration.
- `--image <path>` applies to every turn in a session, not just the first, since the flag is set
  once for the whole process.
