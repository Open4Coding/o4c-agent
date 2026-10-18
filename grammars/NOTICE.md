# Vendored tree-sitter grammars and tag queries

Third-party assets, bundled deliberately rather than fetched at runtime. Fetching would be
network egress, and secure mode forbids egress - a fetch-on-demand design hands the
secure-mode user a Code Graph with no parsers at all.

**Everything loadable is bundled.** 19 grammars, 25.07 MB on disk but **2.26 MB gzipped**
(10.7x, because WASM parse tables are highly repetitive), and the published package tarball is
2.71 MB in total. An unused grammar costs nothing at runtime because loading is lazy. An
earlier plan shipped only seven grammars to keep the install small; that was a disk figure
mistaken for a download cost.

Further grammars are supported by pointing `O4C_WASM_DIR` at a directory holding
`wasm/tree-sitter-<id>.wasm` plus a matching `queries/<id>.scm`.

## ABI compatibility is the binding constraint, not size

A grammar must be built against a runtime that this `web-tree-sitter` can load. Measured
2026-10-18 against `web-tree-sitter@0.27.1`:

| Payload | Grammars | Loadable |
|---|---:|---|
| `@repomix/tree-sitter-wasms@0.1.17` | 17 | **17 / 17** |
| `@vscode/tree-sitter-wasm@0.3.1` | 16 | **16 / 16** |
| `tree-sitter-wasms@0.1.13` | 36 | **0 / 36** |

That third row is the trap. It is the broadest payload on npm, it is the upstream the repomix
one was forked from, and **every grammar in it fails to load** with a bare `Error` out of
emscripten's `getDylinkMetadata`. A pass that picked the smaller build of each grammar across
payloads silently replaced nine working grammars with broken ones during this build, Rust among
them, with no symptom until load time. `src/test/codeGraphTags.test.ts` now load-tests every
bundled grammar for exactly this reason.

## `wasm/` - compiled parsers

| Source | Licence | Grammars taken |
|---|---|---|
| [`@repomix/tree-sitter-wasms`](https://github.com/repomix/tree-sitter-wasms) v0.1.17 | **Unlicense** | c, c_sharp, cpp, css, dart, go, java, javascript, php, python, ruby, rust, solidity, swift, tsx, typescript, vue |
| [`@vscode/tree-sitter-wasm`](https://github.com/microsoft/vscode) v0.3.1 | **MIT** | bash, powershell |

Upstream grammar versions, as those packages pinned them: tree-sitter-typescript ^0.23.2,
tree-sitter-javascript ^0.25.0, tree-sitter-python ^0.25.0, tree-sitter-go ^0.25.0,
tree-sitter-rust ^0.24.0, tree-sitter-java ^0.23.5.

The grammars are tree-sitter-org projects, MIT as far as their package metadata states.
**Loose end, not verified:** the individual upstream LICENSE files have not been read one by
one. The Unlicense/MIT above covers the packaging repositories, not necessarily every compiled
artifact. Worth closing before any public release.

## `queries/` - tag queries

Derived from [aider](https://github.com/Aider-AI/aider) (**Apache-2.0**, compatible with this
repository's licence), `aider/queries/`, which collects `tags.scm` files published by grammar
repositories. 15 of the 19 grammars have a query and are registered in `src/graph/languages.ts`.

### Local additions, all of them load-bearing

Published tag queries turned out to be unreliable in precisely the most important case - the
plain function call. Five of fifteen languages needed work:

| Query | Problem as published | Fix |
|---|---|---|
| `typescript.scm`, `tsx.scm` | **No call captures at all** - definitions and type references only | Grafted the call patterns from `javascript-tags.scm`; the TS grammar is a JS superset |
| `c.scm` | 5 definition patterns, **0 references** | Authored `call_expression` with `identifier` and `field_expression` |
| `cpp.scm` | 8 definition patterns, **0 references** | Same, plus `qualified_identifier` for `ns::fn()` |
| `swift.scm` | 12 definition patterns, **0 references** | Authored for `call_suffix` / `navigation_expression`, which neither C-style form matches |
| `c_sharp.scm` | Captured only `obj.Method()`; a plain `Foo(x)` produced nothing | Added `invocation_expression` with `identifier` |
| `php.scm` | `function` field expected `qualified_name`; a bare `square($x)` carries plain `(name)` | Added that pattern |

`c_sharp.scm` additionally has **2 of 12 patterns disabled for version skew** - marked
`; [version-skew, disabled]` - because `type_parameter_constraints_clause`'s `target` field and
the `type_constraint` node do not exist in the bundled grammar version. Both were generic-type
constraint references; no calls are lost.

Removed: `kotlin.scm` and `lua.scm`. Queries exist upstream but the only payload carrying those
grammars is the ABI-dead one, so they would be queries with no parser.

## Two traps worth recording

**1. Capture names are not consistent.** Java emits `@name.reference.method` for an invocation
where JavaScript, Python, Go and Rust emit `@name.reference.call`. An extractor must key on the
capture-name **prefix** (`name.definition.` / `name.reference.`), never an exact name. Aider
does the same for the same reason (`repomap.py:319-322`). The tree-sitter docs describe eight
standard capture names; real query files do not honour that strictly.

**2. Macros are invisible.** tree-sitter does not expand them, so macro-defined call sites in
C and C++ cannot be seen at all. This is structural - no query fixes it - and it is why
macro-heavy C measured 0.58 against a 1.00 grep baseline in the codebase-memory paper
(`docs/research/code-graph/0001.INDEPENDENT-GRADING.md`). Record it as a known hole.

## Bundled but not registered

`css`, `html`*, `powershell`, `solidity`, `vue` - grammars load, but no tag query exists yet,
so `languageForPath` returns `undefined` and these report `degraded` rather than an empty
result. CSS/HTML need a different extraction model entirely: *selector defined -> class/id
referenced*, not definitions and calls.

\* no ABI-compatible HTML grammar was found; only `css` ships.

## Not bundled, and why

**SQL** and **Assembly** have no ABI-compatible prebuilt WASM on npm. `tree-sitter-sql@0.1.0`
is grammar source only, and building it needs a toolchain - which would destroy the
zero-native-modules property. **Kotlin** and **Lua** likewise, for now.
