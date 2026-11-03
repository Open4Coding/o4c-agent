---
name: review
description: Review code changes for bugs, missing tests and callers left behind - read-only, findings ranked by severity.
allowed-tools: read_file, grep_files, glob_files, run_shell, code_graph, ask_user
---
# Code review

Review the change the user points at (default: the uncommitted diff - `git diff HEAD`). Read-only:
do not edit files; report.

1. Get the change: `git diff HEAD` (or the files/commit named). Read every changed hunk in full,
   plus enough of the surrounding file to know what the code is for.
2. For each changed function, find its callers (grep_files, or code_graph) and check they still fit the
   new signature and behaviour.
3. Look for, in this order:
   - wrong results: off-by-one, inverted conditions, unhandled empty/null cases, wrong units;
   - error paths: exceptions swallowed, resources not released, partial writes;
   - concurrency and ordering: awaits missing, races on shared state;
   - tests: is the new behaviour tested? Would the tests have caught the bug you found?
   - leftovers: debug output, commented-out code, TODOs that the change was meant to resolve.
4. Run the tests that cover the change if there is an obvious command for it.

Report each finding as: file:line - what is wrong - a concrete failing input or scenario - the fix.
Most severe first. If nothing is wrong, say so plainly and say what you checked.
