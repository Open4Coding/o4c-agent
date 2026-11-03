# Commands: settings, modes, keyboard and appearance

Settings are saved in `config.json` files: global (`~/.o4c/config.json`), solution (`.o4c-solution/` above
a group of repos), this project (`.o4c/config.json`, shared) and personal (`.o4c/config.local.json`,
gitignored). Later ones win. `/settings` shows every setting with the value in force and where it comes
from.

## `/settings`

Every setting in one list - its current value and the scope it comes from; pick one to change it.

## `/set`

Browse the `/set-*` commands (session behaviour) and run one. `/config` is the same for `/config-*`
(appearance and plumbing).

## `/config`

Browse the `/config-*` commands and run one.

## `/mode`

Switch mode: **Manual** (asks before every write and command), **Auto** (asks nothing), **Accept Edits**
(writes files freely, asks before commands), **Plan** (read-only), **Plan-Write** (read-only except plan
files). Tab cycles them. `/mode <name>` picks one directly, including your own custom modes from config
`modes` (a base mode plus a note to the model and an optional tool list).

## `/think`

How much the model reasons: `nothink`, `low`, `med`, `high`, `xhigh` - `/think <level>`, or the picker.
`/think 4000` (or `4k`) sets an exact token budget instead, until a level is chosen again. Saved per
model.

## `/set-think`

The thinking level new sessions start at for this project (does not change this one).
`/set-global-think` for every project, `/set-local-think` is the same as `/set-think`.

## `/set-local-think`

Same as `/set-think`.

## `/set-global-think`

The thinking level new sessions start at in every project.

## `/set-sessionname`

`/set-sessionname <name>` - rename this session (as shown in `/resume`).

## `/set-sessionsToSave`

`/set-sessionsToSave <n>` - how many sessions `/resume` keeps for this project before pruning the
oldest.

## `/set-local-sessionsToSave`

Same as `/set-sessionsToSave`.

## `/set-global-sessionsToSave`

How many sessions `/resume` keeps, as this machine's default.

## `/set-sessionview`

How a session is shown: `compact` (one line per tool call) or `full` (everything streamed as it comes).

## `/set-local-sessionview`

Same as `/set-sessionview`.

## `/set-global-sessionview`

The session view as this machine's default.

## `/set-contextwindowtype`

What carries across turns: `none` (only the current turn, nothing recorded), `floating` (the
conversation, sized by `/window` - the default), `pointer` (floating plus a one-line hint naming past
tasks that match, which the model can open with `search_history`), or `curated` (before the turn the
model picks what to load from history, up to a budget, plus the last three exchanges). See
`context-history.md`.

## `/set-local-contextwindowtype`

Same as `/set-contextwindowtype`.

## `/set-global-contextwindowtype`

The context window type as this machine's default.

## `/config-contextwindow-modelinitiatedsearches`

Whether the model may search past tasks on its own (`search_history`): on, off, or auto (only with the
pointer and curated context window types - the default).

## `/set-shell`

The shell `run_shell` uses: `auto` (cmd on Windows, bash elsewhere), `cmd`, `pwsh`, `powershell`, `bash`
or `sh`.

## `/set-notify`

How o4c gets your attention when a long turn ends or an approval waits: `bell` (default), `toast` (an
OS notification), `both` or `off`. A turn counts as long after `notifyAfterSeconds` (20). With
`ntfyUrl` in config the same messages also go to your phone through ntfy.

## `/set-mouse`

Click in the input box to place the cursor. Off by default: while it is on, the mouse wheel no longer
scrolls back through the conversation and selecting text needs Shift+drag.

## `/set-blockgap`

Blank rows between blocks in the conversation: 0, 1 (default) or 2.

## `/set-autoallowreadonly`

`/set-autoallowreadonly on|off` - let read-only shell commands (`git status`, `ls`, `dir`, `cat`...) run
without asking, even in Manual mode.

## `/set-pinnedcommands`

Choose hidden commands to show in the plain `/` list too.

## `/config-highlightcolor`

The colour of the highlighted row in pickers and the `/` palette.

## `/config-local-highlightcolor`

Same as `/config-highlightcolor`, for this project.

## `/config-global-highlightcolor`

The highlight colour as this machine's default.

## `/config-editor`

The editor o4c opens for Ctrl+G, `/view-log`, `/edit-config` and `/debug`: `/config-editor code --wait`
(a GUI editor needs its wait flag), or `/config-editor default` to go back to `VISUAL` / `EDITOR`.

## `/config-model`

The current model's registry entry (`~/.o4c/models.json`):
`/config-model name="Qwen 27B" context=229376 think=med price_in=0 price_out=0 comment="..."`.
`key=` clears a field. Context and sampling apply from the next start.

## `/view-model`

What o4c knows about the current model: its registry entry next to what was detected from the server
(context window, which thinking controls it accepts).

## `/edit-config`

Open a config file - global, solution, this project, or personal - in your editor; it is checked as JSON
when you close the editor.

## `/view-permissions`

The permission rules in force (allow / ask / deny patterns from every config scope), with where each
comes from, and the protected paths.

## `/hooks`

The hooks configured in `hooks` (Claude Code's format: PreToolUse, PostToolUse, UserPromptSubmit, Stop,
SessionStart, PreCompact, Notification), and anything wrong with them.

## `/keyboard`

Keybindings and terminal notes for this system; `/keyboard windows|mac|linux` for another.

## `/keyboard-windows`

Keybindings and notes for Windows terminals.

## `/keyboard-mac`

Keybindings and notes for macOS terminals.

## `/keyboard-linux`

Keybindings and notes for Linux terminals.

## `/keyboard-bindings`

Your Ctrl+letter bindings. Remap them in `~/.o4c/keybindings.json`, e.g. `{ "editor": "ctrl+e" }` -
Ctrl+A to Ctrl+Z only, and never C, H, I, J or M.

## `/colorview`

Every colour the interface draws with, each line in its own colour.

## `/tips`

`/tips on|off` - the one-line tip at the start of a session; `/tips` lists them all.
