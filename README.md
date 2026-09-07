# open4coding harness (v0)

The core agent loop for open4coding, invoked as `o4c`.

## v0 scope

- Prompt -> LLM call -> tool-call parsing -> tool execution -> repeat until done.
- Anthropic (Claude) provider, designed so other providers can be added without touching the loop.
- Tools: `read_file`, `write_file`, `run_shell` (in-process for now — not yet plugins).

Plugin architecture (protocol-over-process-boundary) is deliberately deferred to v0.2, once this
core loop is proven end-to-end. See `docs/PATH_FORWARD.md` in the research workspace for the
full roadmap and rationale.

## Setup

```
npm install
export ANTHROPIC_API_KEY=sk-...   # or set it in your environment however you prefer
npm run build
npm link                          # makes the `o4c` command available globally
```

## Usage

```
o4c "list the files in this directory and tell me what this project is"
```

Or during development, without building first:

```
npm run dev -- "your prompt here"
```
