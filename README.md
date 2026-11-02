# o4c

A terminal coding agent built for **local models first**. o4c runs against your own llama.cpp
server (or any OpenAI-compatible endpoint), keeps a searchable history of every task in the project,
plans work as checklists, and indexes your code with tree-sitter so the model reads less and finds
more. It also works with Anthropic's Claude.

Priorities, in order: speed, lowest token use, easy to install and use, help inside the app.
No telemetry.

## Install

From source (the npm package is coming):

```
git clone https://github.com/Open4Coding/o4c-agent
cd o4c-agent
npm install
npm run build
npm link          # puts `o4c` on your PATH
```

Node 24.2 or newer.

## Point it at a model

**Local server (llama.cpp `llama-server`, or anything OpenAI-compatible):** put the server in
`~/.o4c/config.json` once:

```json
{ "provider": "local", "baseUrl": "http://192.168.0.10:8080" }
```

If the server needs a key, add `"localApiKey": "..."` to `config.local.json` (personal, never shared)
or set `O4C_LOCAL_API_KEY`. o4c reads the model name and context size from the server itself.

**Anthropic:** set `ANTHROPIC_API_KEY` and run `o4c -p anthropic`, or put `"provider": "anthropic"` in
the config.

With no flag and no config, o4c uses a local server; it uses Anthropic only when `ANTHROPIC_API_KEY`
is the only credential it can find.

## Use

```
o4c                      # interactive session in the current project
o4c "add a --verbose flag and a test for it"     # one-shot
```

The first time you run it in a folder, o4c asks whether to trust it; only trusted projects get a
`.o4c/` folder (config, sessions, logs, databases).

Inside a session, type `/` for a dropdown of every command. A few to start with:

| Command | What it does |
|---|---|
| `/mode` (or Shift+Tab) | Manual, Accept-edits, Plan (read-only), Plan-Write, Auto |
| `/think` | How hard the model thinks: five levels |
| `/plan <goal>`, `/ultraplan <goal>` | Make a plan with a checklist; `/view-plan` to see and work it |
| `/resume`, `/clear` | Pick up an old session, or start fresh (the old one is saved) |
| `/context`, `/window` | What is in the context window, and how much of the past to send |
| `/worked` | Mark a past task as one that worked, so it ranks higher later |
| `/view-db` | Look inside the project's databases, read-only |
| `/datagraph` | The code graph on or off |
| `/mcp` | MCP servers and their state |
| `/keyboard` | Keys for your OS |
| `/help` | All commands |

Settings: `/set-...` (session behaviour) and `/config-...` (appearance). Every setting has a
project form (`/set-x`, `/set-local-x`) and a home form (`/set-global-x`).

## What the model can do

Tools: `read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files`, `run_shell`,
`code_graph`, `search_history`, `update_plan`, plus any tool from a configured MCP server.
`glob_files` and `grep_files` skip what `.gitignore` excludes. What needs your approval depends on
the mode.

## Context and history

Every task (your request, the answer, notes, errors, files touched) is stored in the project's
`.o4c/db/history.db`. How much of the past each request carries is your choice - only the current
message, the recent conversation (default), a pointer to matching past tasks, or context the model
picks itself. See [`.docs/context-history.md`](.docs/context-history.md).

## Code graph

o4c indexes the project with tree-sitter (in the background, into `.o4c/db/datagraph.db`) and uses
it to answer "where is this defined, who calls it" without the model grepping the whole tree. See
[`.docs/code-graph-acceptance.md`](.docs/code-graph-acceptance.md) for how accurate it is.

## Plans

`/plan <goal>` makes a plan with a checklist where every step has a way to check it is done, saved in
the project. The active plan is worked one item at a time; "done" needs a verification note. See
[`.docs/plans.md`](.docs/plans.md).

## MCP servers

o4c can use tools from MCP servers. Nothing is enabled by default. See [`.docs/mcp.md`](.docs/mcp.md)
for the config format, per-server grants, and secure (air-gapped) mode.

## More

- [`.docs/interactive-repl.md`](.docs/interactive-repl.md) - the interactive session, keys, VS Code
- Logs: `.o4c/logs/` (one file per run; API keys are redacted)

## Developing o4c

`npm test` runs the suite; `npm run dev -- "prompt"` runs from source without building. The mock
provider makes no network calls and needs no key - it exercises the loop and real tools for free:

```
o4c -p mock "read package.json and tell me the version"
```

Ink is a vendored, patched copy (`vendor/`, see [`patches/README.md`](patches/README.md)).
