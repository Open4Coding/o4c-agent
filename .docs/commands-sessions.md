# Commands: sessions, context, plans and history

Every command here is local unless it says otherwise - no model call, nothing sent anywhere.

## `/clear`

Start a fresh session. Asks first; the current session is saved and stays in `/resume`. If a turn is
running it is stopped. o4c restarts into an empty conversation.

## `/resume`

Pick one of the saved sessions (the newest 20 by default - see `/set-sessionsToSave`) and continue it:
the conversation, the input history and the session's token totals come back. From the shell,
`o4c -c` resumes the newest one without the picker.

## `/session`

More than one session at a time in this window. `/session new <task>` starts a background session that
works on that task on its own while you carry on here; you are told when it finishes. `/session` (or
Ctrl+X) lists this session and every background one with its state - pick one to see what it is doing,
stop it, or, once it has finished, open it here and carry on the conversation (the session you leave
stays saved; `/resume` brings it back). `/session stop <n>` stops one; `/session help` explains it all.

A background session is a headless o4c in this project with the same tools as a one-shot run, so it can
change files - give it work that does not touch what you are changing in the foreground. It talks to the
same provider and model. Background sessions need a trusted project, and stop when you quit o4c.

## `/fork`

Copy the conversation so far into a new session and carry on in the copy. The original stays exactly as
it was; `/resume` goes back to it. The copy is titled "<title> (fork)".

## `/context` (alias `/ctx`)

What the next request will contain and how big it is: a breakdown by part (system prompt, tools,
project instructions, memories, history), how full the context window is, the sliding window if one is
on, and this session's token use.

## `/compact`

Summarise the older part of the conversation now instead of waiting for the window to fill. Keeps about
the last turn word for word. `/compact <focus>` tells the summary what to keep in detail. Superseded file
reads are dropped first, which is often enough on its own.

## `/window`

Send only the recent part of the conversation: `/window 40000` (tokens), `/window 50%`, or
`/window off`. Nothing is deleted - turning it off sends everything again. Useful on small context
windows; the model can still search what fell outside it.

## `/stats`

Totals for this session, this project and the whole machine: prompt and generated tokens, cache share,
active time, requests, your messages, tool calls, tasks, and (with a price set in `/config-model`) the
cost.

## `/status`

Setup and health on one screen: model and server, context use, cache and drafting rates, which
instruction files were read, the prompt profile, thinking level, shell, MCP servers, checkpoints,
memories and permission rules.

## `/plan`

`/plan <goal>` - the model researches read-only and writes a plan with a checklist, saved in this
project (`.o4c/db/history.db`, exported to `.o4c/plans/`). The active plan's open items ride along with
every message so the model keeps to it; it ticks items with the `update_plan` tool.

## `/ultraplan`

Like `/plan`, but o4c first gathers research itself - past tasks, the code graph's map of the code
involved, the files - and the model thinks harder before writing the plan.

## `/plans`

List this project's plans with their state, and import any plan files someone dropped into
`.o4c/plans/`.

## `/view-plan`

Pick a plan, then read it (summary or in full, checklist last), make it the active one, park it, edit
its items, or export it.

## `/plan-reword`

`/plan-reword <plan> <item> <text>` - change an item's wording. Normally filled in for you by
`/view-plan`'s "Edit items".

## `/plan-add`

`/plan-add <plan> <after item> <text>` - add an item after another one. Normally filled in by
`/view-plan`.

## `/goal`

`/goal <what done looks like>` sets a goal o4c keeps working toward: after every turn it is checked -
by `goalVerifyCommand` from config (exit 0 = met, e.g. `npm test`) or, without one, by the model
answering "GOAL MET" after checking - and if it is not met the next step is queued for you to see.
`/goal budget 20 <goal>` sets the turn budget (default 10), `/goal` shows it, `/goal off` clears it.

## `/btw`

`/btw <question>` - ask something on the side without it entering the conversation: the model answers
from the current context, nothing is added to history, and the main task is not disturbed.

## `/queue`

Show the messages waiting to run after the current turn (queued with Ctrl+Q while the model works).
Pick one to edit or drop it. To drop everything at once while the turn runs, press Ctrl+K: the hint under the
queued list shows whenever something is waiting. Ctrl+K also drops steering messages the model has not read yet.

## `/review`

Have the model review this session's changes (from the checkpoint diff), read-only: bugs, missing tests,
callers left behind. `/review <focus>` narrows it.

## `/reflect`

The model reads your recent finished tasks and writes short lessons into memory - what worked, what to
avoid - which later sessions see. Uses one model call.

## `/memory`

List what o4c remembers: rules and lessons for this project and globally (`~/.o4c/db/global.db`). The
model adds to it with the `remember` tool; you can too.

## `/memory-edit`

Edit or delete a remembered rule or lesson.

## `/init`

Scan the project (languages, build and test commands, layout) and write an `O4C.md` with what the model
should know. Read every session afterwards; edit it freely.

## `/worked`

Mark the last task as having worked so history search ranks it higher: `/worked`, `/worked no`,
`/worked clear`, or `/worked #412` for a specific task. See also `/mark-incorrect`.

## `/mark-incorrect`

The last answer was wrong: `/mark-incorrect [#task] [reason]` ranks that task down in history search and
keeps your reason with it, so a later search that finds it - and `/reflect` - see what was wrong.
`/worked clear` undoes the mark.

## `/datagraph`

Show or hide the code graph from the model: `/datagraph on`, `/datagraph off`. Off, the model uses grep,
glob and reading files only; the index keeps updating either way.

## `/undo`

Put the files back as they were before the last turn's changes (from the checkpoint taken before it).
Only files o4c changed; your git repository is never touched - checkpoints live in a shadow repository
under `.o4c/checkpoints`.

## `/rewind`

Pick an earlier turn and go back to it: the files, the conversation, or both.

## `/diff`

Show what changed in this session's files since the first checkpoint.

## `/commit`

Commit with a message the model writes from the diff, shown to you first: commit, edit it in your
editor, or cancel. Commits what is staged, or everything when nothing is. No Co-Authored-By or other
trailer unless config `commitTrailer` sets one. `/commit <hint>` steers the message.

## `/copy`

Copy the last reply to the clipboard; `/copy 2` the one before. Uses the system clipboard and, for SSH,
the terminal's OSC 52.

## `/update`

Ask npm and GitHub whether a newer o4c is out and say how to update. Only when you run it - o4c never
checks on its own - and not at all in secure mode. Same as `o4c --check-update`.

## `/setup`

Find a model server (llama.cpp on 8080, Ollama on 11434, LM Studio on 1234, and the configured URL), ask
for its key if it wants one, check one real tool call, and save it in the global config. Runs by itself
the first time o4c starts.

## `/endpoint-add`

Add a model service that speaks the OpenAI Chat Completions protocol:

- **Local AI server**: llama.cpp, Ollama, LM Studio or any OpenAI-compatible server, on this machine or
  your network. Add as many as you have, each under its own name (`phoebe`, `laptop`...), and switch
  between them with `/endpoint <name>`. o4c asks for the address and the key (if the server has one),
  checks that it is up and which model it has loaded, then makes one real tool call. A named local
  server runs exactly like the built-in `local`: it is checked at start, gets the `/think` levels and
  slot pinning, and o4c uses whatever model it has loaded at the time. Saved as
  `"phoebe": { "url": "http://192.168.1.20:8080", "model": "...", "local": true }`.
- **Amazon Bedrock**: `bedrock-runtime` (AWS's recommended endpoint) or `bedrock-mantle` (for models
  runtime does not serve), in the region you pick. It needs an Amazon Bedrock API key (Bedrock console >
  API keys). Runtime has no models list, so o4c offers the gpt-oss models and lets you type any other id.
- **OpenAI**, **OpenRouter**, or **any other** OpenAI-compatible URL.
- **GitHub Copilot**: your Copilot plan, signed in with your GitHub login (see below).

o4c asks for the key (saved in your global `~/.o4c/config.json` credentials, never in a project), the
model and a name, then checks one real tool call before saving anything. The endpoint is kept in the
global config:

```json
"endpoints": { "bedrock": { "url": "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", "model": "openai.gpt-oss-120b-1:0" } }
```

Optional `"contextWindow"` per endpoint; without it o4c assumes 128,000 tokens unless the models
registry knows the model. An endpoint gets only standard request fields - the llama.cpp extras o4c uses
with a local server (slot pinning, prefill progress, ending thinking early, exact token counts) are off.

### GitHub Copilot

Runs o4c on the models of your own Copilot plan, on github.com or on an enterprise at
`<name>.ghe.com` (GitHub Enterprise Cloud with data residency). It needs no API key. o4c signs in with
your GitHub login, taking the first one it finds:

1. `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN` / `GITHUB_TOKEN` for github.com, or `GH_ENTERPRISE_TOKEN` for
   an enterprise host;
2. a token you paste into `/endpoint-add` (saved in your global credentials);
3. the GitHub CLI's login: `gh auth login --hostname <host>` once, and o4c asks `gh` on every start.

A token you create yourself comes from `https://<host>/settings/personal-access-tokens/new`.

o4c then reads your account to find its Copilot API, lists the models your plan and its policies allow,
and checks one real tool call. The list has the models that answer Chat Completions. The GPT-5 and
later family answers only OpenAI's Responses API, which o4c does not speak yet, so o4c names those
models and does not offer them. It also names the models a Copilot policy has turned off. The model's
context window comes from the list.

```json
"endpoints": { "copilot": { "url": "https://api.individual.githubcopilot.com", "model": "gpt-4.1", "contextWindow": 64000, "copilot": "github.com" } }
```

Copilot bills by its own measure (AI credits or premium requests, depending on the plan). o4c makes one
request per model step, so a long task uses more of the allowance than one chat question.

## `/endpoint [name]`

Which model service o4c runs on: `local`, `anthropic`, or an endpoint you added. Picking one saves it as
`provider` in the global config and restarts o4c on it. `-p <name>` on the command line selects an
endpoint for one run.

## `/exit` (alias `/quit`)

End the session. It is saved and can be resumed.
