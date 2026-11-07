# o4c

A terminal coding agent built for **local models first**. o4c runs against your own llama.cpp
server (or any OpenAI-compatible endpoint, Ollama and LM Studio included), keeps a searchable history
of every task in the project, plans work as checklists, and indexes your code with tree-sitter so the
model reads less and finds more. It also works with Anthropic's Claude, and inside editors through the
Agent Client Protocol.

Priorities, in order: speed, lowest token use, easy to install and use, help inside the app.
No telemetry - o4c only goes online for the model you point it at, and for web and update checks you
ask for.

## Install

**Single executable** (Node included, nothing else to install): download `o4c-win32-x64.exe`,
`o4c-linux-x64` or `o4c-darwin-arm64` (Apple Silicon) from the
[GitHub releases](https://github.com/Open4Coding/o4c-agent/releases) (`SHA256SUMS.txt` is there to
check the download). On Linux and macOS, `chmod +x` it; on macOS the file is not notarized, so clear
the download flag once with `xattr -d com.apple.quarantine o4c-darwin-arm64`. To build one yourself:
`npm run build:sea` with Node 26.

**From npm:**

```
npm install -g @open4coding/o4c-agent
```

**From source:**

```
git clone https://github.com/Open4Coding/o4c-agent
cd o4c-agent
npm install
npm run build
npm link          # puts `o4c` on your PATH
```

Node 24.2 or newer.

## Point it at a model

The first time o4c starts it runs **`/setup`**: it looks for llama.cpp (port 8080), Ollama (11434), LM
Studio (1234) and any server you name, asks for the key if the server wants one, checks one real tool
call, and saves the result. Run `/setup` again any time.

By hand, in `~/.o4c/config.json`:

```json
{ "provider": "local", "baseUrl": "http://192.168.0.10:8080" }
```

Keys go in the `credentials` map of `~/.o4c/config.json` or `.o4c/config.local.json` (never a shared
project file) - `"credentials": { "local": "...", "anthropic": { "env": "MY_KEY" } }` - or the usual
`O4C_LOCAL_API_KEY` / `ANTHROPIC_API_KEY`. o4c reads the model name and context size from the server.
A `fallbackChain` in config names servers to try when one fails; failed requests are retried with
backoff first.

**Anthropic:** set `ANTHROPIC_API_KEY` and run `o4c -p anthropic`, or put `"provider": "anthropic"` in
the config.

## Use

```
o4c                      # interactive session in the current project
o4c -c                   # continue the newest session
o4c "add a --verbose flag and a test for it"     # one-shot
o4c acp                  # Agent Client Protocol on stdio, for editors
```

The first time you run it in a folder, o4c asks whether to trust it; only trusted projects get a
`.o4c/` folder (config, sessions, logs, databases, checkpoints).

Inside a session, type `/` for every command; `/help-<command>` explains one, `/help <question>`
searches the docs. A few to start with:

| Command | What it does |
|---|---|
| `/mode` (or Tab) | Manual, Accept Edits, Plan (read-only), Plan-Write, Auto - and your own modes |
| `/think` | How hard the model thinks: five levels, or an exact token budget |
| `/plan <goal>`, `/ultraplan <goal>` | A plan with a checklist; `/view-plan` to see and work it |
| `/goal <done looks like>` | Keep working until it is verified (or a turn budget runs out) |
| `/undo`, `/rewind`, `/diff` | Every turn is checkpointed; go back in files, conversation, or both |
| `/commit` | A commit message from the diff, shown for approval |
| `/resume`, `/fork`, `/clear` | Old sessions, a copy of this one, or start fresh |
| `/context`, `/window`, `/compact` | What the model sees, and how much of the past it gets |
| `/settings` | Every setting, its value and where it comes from |
| `/doctor`, `/status`, `/stats` | Health checks, setup at a glance, usage totals |
| `/debug`, `/view-log` | The exact last request and why; the run logs, in your editor |

Keys: Ctrl+G writes the message in your own editor, Ctrl+R searches what you typed before, Ctrl+Q
queues a message while the model works (plain Enter steers the running turn), `!cmd` runs a shell command
yourself and hands its output to the next message, `@file` attaches a file. `/keyboard` lists them all;
`~/.o4c/keybindings.json` remaps them.

## What the model can do

Tools: `read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files`, `run_shell` (with background
jobs: `job_output`, `/ps`, `/kill`), `code_graph`, `search_history`, `update_plan`, `remember`, `ask_user`,
`skill`, `task` (sub-agents), `web_fetch` and `web_search`, plus any tool from a configured MCP server.
`pty` (driving interactive programs in a real terminal) is there when config `ptyTool` is true. What needs
your approval depends on the mode and your permission rules (`/view-permissions`).

## Context and history

Every task (your request, the answer, notes, errors, files touched) is stored in the project's
`.o4c/db/history.db`. How much of the past each request carries is your choice - only the current
message, the recent conversation (default), a pointer to matching past tasks, or context the model
picks itself. `/worked` and `/mark-incorrect` tell later searches which answers to trust. See
[`.docs/context-history.md`](.docs/context-history.md).

## Code graph

o4c indexes the project with tree-sitter (in the background, into `.o4c/db/datagraph.db`) and uses
it to answer "where is this defined, who calls it" without the model grepping the whole tree. See
[`.docs/code-graph-acceptance.md`](.docs/code-graph-acceptance.md) for how accurate it is.

## Plans

`/plan <goal>` makes a plan with a checklist where every step has a way to check it is done, saved in
the project. The active plan is worked one item at a time; "done" needs a verification note. See
[`.docs/plans.md`](.docs/plans.md).

## Make it yours

- **Instructions:** `O4C.md` (or `AGENTS.md` / `CLAUDE.md`) in the project, `~/.o4c/o4c.md` everywhere,
  and `.o4c-solution/O4C.md` above a group of repos. `/init` writes a first one.
- **Custom commands:** `.o4c/commands/<name>.md` becomes `/<name>`; its text goes into the input box.
- **Skills:** `.o4c/skills/<name>/SKILL.md` - instructions the model loads when a job matches (bundled:
  `review`, `security-review`, `commit`).
- **Sub-agents:** `.o4c/agents/<name>.md` beside the built-in `explore` and `verify`.
- **Hooks:** a `hooks` block in config, in Claude Code's own format - existing hook scripts work.
- **Custom modes:** `modes` in config - a built-in mode plus a note to the model and a tool list.
- **Models:** `/config-model` keeps per-model notes, context, thinking level and price.

## Editors

`o4c acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com), so Zed, JetBrains, Neovim
plugins and ACP phone apps can drive it. For VS Code there is the **o4c extension**
([o4c-vscode](https://github.com/Open4Coding/o4c-vscode)): a chat panel, and o4c's edits shown as VS Code
diffs to accept or reject.

## Scripting

One-shot runs are scriptable: `--output-format text|json|stream-json`, exit codes 0 (done), 1 (error),
2 (a tool needed approval nobody could give), 3 (step limit), `--max-turns`, `--permission-mode plan`,
`--allowed-tools`, `--json-schema <file>` for structured output, and piped stdin as the prompt.

## MCP servers

o4c can use tools, prompts and resources from MCP servers - local or remote (headers, OAuth). Nothing
is enabled by default; `/mcp add` adds a well-known server. See [`.docs/mcp.md`](.docs/mcp.md) for the
config format, per-server grants and tool filters, and secure (air-gapped) mode.

## More

- [`.docs/commands-sessions.md`](.docs/commands-sessions.md), [`.docs/commands-settings.md`](.docs/commands-settings.md),
  [`.docs/commands-tools.md`](.docs/commands-tools.md) - every command
- [`.docs/interactive-repl.md`](.docs/interactive-repl.md) - the interactive session, keys, terminals
- Logs: `.o4c/logs/` (API keys are redacted; old runs are pruned after 7 days beyond the newest 50)
- Updates: `o4c --check-update` or `/update` - only when you ask

## Developing o4c

`npm test` runs the suite; `npm run dev -- "prompt"` runs from source without building. The mock
provider makes no network calls and needs no key - it exercises the loop and real tools for free:

```
o4c -p mock "read package.json and tell me the version"
```

`o4c eval run` runs the task set in `eval/` against a model and `o4c eval diff` compares two runs.
Ink is a vendored, patched copy (`vendor/`, see [`patches/README.md`](patches/README.md)).
