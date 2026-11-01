# Plans

o4c can make a plan with a checklist for a piece of work, keep it with the project, and then work
through it one item at a time. Plans are stored in the project's own database
(`.o4c/db/history.db`), so they need a trusted project.

## Making a plan

```
/plan add an export command for plans
```

o4c runs one turn in **Plan mode** (read-only, whatever mode you are in): the model looks at what it
needs to and answers with a plan in a fixed shape - a name, a short summary, the plan itself, and a
checklist where every step has a way to check it is done. That answer is saved as a numbered plan
(`0001`, `0002`, ...) and becomes the **active plan**.

```
/ultraplan rework the session picker
```

The same, for bigger work. Before the model starts, o4c gathers material itself: the past tasks
that best match the goal (opened, as `search_history` would show them) and the Code Graph's map of
the files and functions that matter for it. The model reads that first, thinks at least at `high`,
and gets up to 15 tool rounds to look into what is still unclear.

## Seeing and changing plans

- `/plans` lists every plan, newest first, with its progress.
- `/view-plan` opens a list of plans; pick one, then:
  - **View** - the header and summary, then the checklist (Enter, Enter is this).
  - **View full** - the whole plan text, then the checklist.
  - **Make active** / **Park** - only the active plan is kept in view while o4c works.
  - **Checklist** - the checklist as a level of its own: pick an item to see it in full (checks,
    verification, notes, the past tasks that worked on it), then leave it, or reword, move, remove,
    or add one after it. No model call. Rewording and adding put a command with the text in the
    input box for you to finish.
  - **Export** - writes `.o4c/plans/NNNN.Name.plan.md` and `.checklist.md`, for git and editors.

The checklist always comes last, so it ends right above the input box. Marks: `[ ]` not started,
`[>]` in progress, `[x]` done, `[-]` skipped. The current item's checks are listed under it.

## Working through a plan

While a plan is active, every request carries a short note about it: the plan, the current item
and its checks, and "work on this item only". The model moves through the plan with the
`update_plan` tool:

- it **starts** an item before working on it,
- it marks it **done** only with a verification note - what it ran or checked, and the result.
  o4c refuses "done" without one.

In **Auto** mode the model moves on by itself. In every other mode it asks first: you see
"Mark plan item N done?" with its verification, and say yes or no. You can always ask in plain words
too ("add a step after 3 for the docs", "skip item 5") - the model makes the change through the same
tool.

## Files

SQLite is the source of truth. An exported file is a snapshot: editing it changes nothing in o4c,
and the next export overwrites it.

Plan files that were written into `.o4c/plans/` some other way - by hand, or by the model in
Plan-Write mode - are imported once, at startup or when you run `/plans`, if they follow the naming
convention `NNNN.Name.plan.md` / `NNNN.Name.checklist.md`. `[x]` items arrive done, noted as
imported. Files that do not fit the convention are listed by `/plans`, not guessed at.
