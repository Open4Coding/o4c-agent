# o4c (v0)

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

## Developing without spending money

`o4c` defaults to the real Anthropic API, which costs real money per call. While developing/testing
the harness itself (CLI parsing, the agent loop, tool execution), use the free mock provider instead —
no `ANTHROPIC_API_KEY` needed, zero network calls:

```
o4c --provider mock "read package.json and tell me the version"
```

The mock provider (`src/providers/mock.ts`) isn't a model simulator — it makes one trivial tool call
(if tools are available) so real tool execution still runs against your real files/shell, then returns
a canned final answer. It exists purely to exercise the loop end-to-end for free; use
`--provider anthropic` (the default) once you actually want a real response.
