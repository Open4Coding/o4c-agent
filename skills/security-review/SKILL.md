---
name: security-review
description: Security review of code or a change - injection, auth, secrets, unsafe deserialization, path traversal; read-only, with concrete exploit paths.
allowed-tools: read_file, grep_files, glob_files, run_shell, code_graph, ask_user
---
# Security review

Review the code or change the user names (default: `git diff HEAD`) for vulnerabilities. Read-only.
Only report what you can tie to a concrete path from untrusted input to a dangerous sink.

Check, for each place untrusted data enters (HTTP params, files, env, CLI args, model output):
- **Injection:** SQL built with string concatenation; shell commands with interpolated input
  (`exec`, `spawn` with `shell: true`); template injection; eval/Function.
- **Path traversal:** user-controlled paths joined without normalising and checking they stay inside
  the intended root (`..`, absolute paths, symlinks).
- **AuthN/AuthZ:** endpoints or actions missing a permission check; checks done on the client only;
  IDs that let one user reach another's data.
- **Secrets:** keys or tokens in code, logs, error messages or committed config; secrets passed to
  child processes that do not need them.
- **Deserialization / parsing:** unsafe YAML/pickle/JSON revivers; XML external entities;
  regexes that can backtrack catastrophically on attacker input.
- **Crypto:** home-made crypto, weak hashes for passwords, missing constant-time comparison.
- **Dependencies:** a new dependency, or a version known to be vulnerable.

Report each finding as: severity - file:line - the input path from source to sink - why it is
exploitable - the fix. Say explicitly which areas you checked and found nothing in.
