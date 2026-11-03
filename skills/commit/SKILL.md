---
name: commit
description: Make a git commit of the current work - check what is staged, write a clear message, commit; never adds a Co-Authored-By trailer.
allowed-tools: run_shell, read_file, ask_user
---
# Commit

1. `git status --short` and `git diff --cached --stat`. If nothing is staged, look at
   `git diff --stat` and stage only the files that belong to the change being committed
   (`git add <paths>`) - never `git add -A` blindly; leave unrelated or generated files out and say so.
2. Read the staged diff (`git diff --cached`). If it contains secrets, debug output or files that
   should not be committed, stop and tell the user instead of committing.
3. Write the message: an imperative summary line of at most 72 characters, then (only if the change
   needs it) a blank line and a short body saying what changed and why. Follow the style of
   `git log --oneline -10`. No Co-Authored-By, Signed-off-by or other trailer unless the user asks.
4. Commit with the message passed through a file or `-F -`, not a long `-m` with quotes to escape.
5. Show `git log --oneline -1` and stop. Do not push unless the user asked for that too.
