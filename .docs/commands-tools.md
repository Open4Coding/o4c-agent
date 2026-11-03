# Commands: diagnostics, data, jobs and integrations

## `/help`

Every command with a one-line description. `/help-<command>` (e.g. `/help-mode`) shows one in detail,
with its section from these docs; `/help <question>` searches the docs.

## `/all`

Every command, hidden ones included, in one list - pick one to run it (or to fill it in when it needs an
argument).

## `/doctor`

Checks everything that can make o4c fail - Node, config files, git, the shell, grammars, databases, disk
space, the model server, and one real tool call - and says how to fix each failure.

## `/debug`

o4c debugging itself: the exact last request (system prompt, every message, the tools), what went into
it and why (context breakdown, window, cache break, permission rules), and the raw response - written to
a file and opened in your editor. Works after a reload too, from the FULLCONTEXT log.

## `/last-error`

The last failed request in full, and the end of `crash.log`.

## `/view-log`

Open a log in your editor: `run` (default - the newest run log made readable, think blocks included),
`full` (the FULLCONTEXT log: every request and response), `lifecycle`, or `crash`. Old run logs are pruned:
the newest 50 and the last 7 days are always kept (`logsToKeep`, `logsKeepDays`).

## `/view-prompt`

The system prompt this session sends, section by section with token estimates, and which profile chose
it (config `promptProfile`: `default`, `qwen` or `small`).

## `/view-db`

Look into this project's databases (`.o4c/db`) and the global ones: pick a database, a table, then a row
to see it in full. Read-only.

## `/database-backup`

Back up every o4c database - this project's history, code graph and session list, and the global
memories - to a dated folder in `.o4c/backups`, as a consistent snapshot even while o4c is using them.

## `/database-restore`

Pick a backup; it is checked, you confirm, and o4c restarts with it. The databases it replaces are kept
in a `before-restore` folder.

## `/ps`

Background jobs started by `run_shell` with `background: true` (dev servers, long builds): id, command,
state, how long.

## `/kill`

`/kill <id>` - stop a background job and everything it started.

## `/mcp`

The configured MCP servers and their state. `/mcp inspect <server>` shows one server's capabilities,
tools (and which the `tools` filter hides), prompts and resources. `/mcp add <preset>` adds a well-known
server (`filesystem`, `git`, `memory`, `sequential-thinking`, `time`, `fetch`) to the MCP config; `/mcp add`
lists them. A server's resources can be attached to a message with `@<server>:<uri or name>`; its prompts
become `/mcp-<server>-<prompt>` commands when the server is granted `slashCommands`. See `mcp.md`.
