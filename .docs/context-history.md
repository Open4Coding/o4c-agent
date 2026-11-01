# Context window types and task history

Every request o4c sends to the model carries some of what happened before. **The context window
type decides how much, and where it comes from.** There are four:

| Type | What each request carries | Kept in history? |
|---|---|---|
| `none` | Only your current message (and the tool calls it makes). One-shot answers. | No |
| `floating` | The recent conversation, sized by `/window`. **The default** — what o4c always did. | Yes |
| `pointer` | Floating, plus one line naming past tasks that match, which the model can open. | Yes |
| `curated` | The model searches past tasks, picks what helps, and gets that plus your last 3 exchanges. | Yes |

Choose one with `/set-contextwindowtype <type>`. Type it with no argument (or pick it from the `/set`
list) to see the four with your current choice. It takes effect on the very next request and is
saved for this project; `/set-global-contextwindowtype` sets your machine-wide default, and
`/set-contextwindowtype default` goes back to it.

Within one request, every type keeps everything the model is doing right now — a long task with
many tool calls is never cut off half-way. The type only decides what carries over **between** your
messages.

## Task history

In a trusted project, o4c keeps every exchange as a numbered **task** in `.o4c/db/history.db`:
what you asked, the final answer, any errors, which files were written, and which functions in them
changed. A short follow-up such as "try again" is filed under the task it follows, as `#502.1`,
`#502.2`, so a whole attempt reads as one thread.

Nothing is sent anywhere — the file stays in your project, like the session files. The `none` type
writes nothing to it.

### `pointer` — a hint, only when something matches

Before each request o4c searches the history for your message. If a past task shares at least two
meaningful words with it, or one exact file or function name, the model sees a single line like:

```
[o4c history] Past tasks that may help: #412 "fix the CRLF bug in the bat installer" (+2 follow-ups). Read one with search_history {"open": "#412"}
```

You see it too, as a dim `[info] history hint sent: ...` line. If nothing matches, nothing is added and nothing is spent. A task is marked **stale** when the code it
changed has since been removed or renamed (o4c checks with the Code Graph).

### `curated` — the model builds its own context

Before each request the model makes two short calls: it writes a few search terms, then picks which
of the matching tasks to load. Those tasks, plus your last three exchanges, are what it sees. The
loaded part is limited to 15% of the model's context window (at most 30,000 tokens); give your own
limit with `/set-contextwindowtype curated 20%` or `curated 20000`.

The two calls make every request start a little later, and on a paid API they cost a little — so
`curated` is never the default.

### `search_history` — the model's own search

With `pointer` or `curated`, the model also gets a `search_history` tool: `{"query": "..."}` lists
matching tasks by number, `{"open": "#412"}` reads one.

What a task keeps: your request, the final answer, errors, the files and functions it changed, and
**notes**: the model's narration between tool calls and the end of each of its thinking blocks, so
what a long research turn worked out is still there for the next one. Notes are searched too.

### `/worked` — tell o4c what worked

`/worked` marks the last task as having worked, so searches rank it higher; `/worked no` marks it as
not working, so they rank it lower; `/worked clear` removes the mark. Add a number to mark a specific
task: `/worked #412`. o4c never decides this on its own — a wrong guess would promote a bad answer.
