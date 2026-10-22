# Code Graph acceptance test

**Measured 2026-10-22**, re-run after two resolution changes: import-aware disambiguation, and
telling `f()` from `o.f()`. Reproduce with
`npm run build && node scripts/graph-grade.mjs <path-to-repomix>`.

Every percentage in the figures block below is re-derived from `.docs/code-graph-acceptance.json`
by `src/test/codeGraphAcceptance.test.ts`, which also rejects any percentage in that block that
the stored counts do not produce. Editing a number here by hand fails the suite. That guard
exists because earlier in this project I quoted a recall figure from the literature that was a
single cell of a table whose author forbade reading it that way, and it reached a design document
and a memory file before being caught.

---

## What is being measured, and against what

The graph resolves call sites by **name**, plus two pieces of syntactic evidence: what the
referencing file imported, and whether the call was written `f()` or `o.f()`. The TypeScript compiler resolves them by **type**, with full
module resolution, and it is the thing the language is defined by — so for TypeScript it is an
oracle in the strict sense, not a second heuristic. `scripts/graph-oracle.mjs` walks a
`ts.Program`, takes `checker.getResolvedSignature(call).declaration` for every call site, and
emits ground-truth `caller → callee` edges.

**Two repositories**, because the independent-grading review found call-graph recall in this field
varying from 0.026 to 0.967 *across repositories*, with no signal available at query time to say
which case you are in. A figure from one repository is not a property of a tool. Step 5 is the
clearest vindication of that choice so far: the same change moved one repository by 8.8 points and
the other by almost nothing.

**Each reported with and without its test files**, because o4c's own call sites are dominated by
`assert.equal` and friends, and a figure propped up by test code would not survive contact with a
real codebase. The oracle program is identical across the two cells of a repository; only the
reporting filter on the caller's path changes, so the cells differ by exactly one thing.

### What the universe excludes, and why

| Excluded | Count (o4c / repomix) | Why |
|---|---|---|
| `new X()` | 591 / 651 | The TypeScript query captures it as `name.reference.class`, which `isAssertedCall` already excludes. Grading it would measure a claim the graph does not make. |
| `a["b"]()`, `(f ?? g)()` | 47 / 144 | No query pattern captures these shapes, so they are not claims either. |
| Targets outside the repository | 9,550 / 16,011 | A call into `node_modules` or the standard library is not something the graph is wrong about; it is outside what the graph indexes. These are the `outOfUniverse` bucket — counted as neither right nor wrong. |

The constructor exclusion is defensible but it also **flatters recall**, so the figures block
reports recall again over a denominator widened by every in-repo constructor call, counting all of
them as misses. Both numbers are on the record.

`repomix` was given a real `npm install` before measurement. Without it the compiler could type
almost nothing and left 13,003 of 20,154 call sites unresolved — an oracle with a hole that size
is not an oracle. After installing, 29 remain unresolved. o4c's oracle had zero throughout, which
is what identified the cause.

### The figures describe a tree, not a constant

o4c is one of the two graded repositories, so its own test files are among the files indexed — and
adding a test file, **including the one that guards these figures**, moves the counts slightly. The
JSON records the commit it was taken at (`commit`, `workingTreeDirty`) for that reason. A re-run on
a later tree will give slightly different numbers for the two o4c cells, and the guard test will
then require this document to be updated to match, which is the intended workflow rather than a
failure. The guard never re-measures; it only holds the prose and the stored counts together.

This matters for reading the step-5 comparison below: **repomix's denominators are identical across
the two runs** (3,966 and 1,219 oracle edges both times) because that repository was untouched, so
its deltas are exact. o4c's are not, and are quoted only where the raw count is the point.

There is a second, less respectable reason the o4c cells wobble. Nothing in o4c reads
`.gitignore` — neither `walkFiles` nor this harness — so the 32 untracked scratch files in
`.tmp-repro/`, left over from a terminal-debugging session, are indexed like source. They
contribute 27 definitions of `write` between them, which makes an already ambiguous name far worse
and costs the o4c cells recall that a clean checkout would not lose. The harness deliberately does
**not** skip them, because it must index exactly what the product indexes; teaching the walker
about `.gitignore` is a real change with its own consequences for `grep_files` and `glob_files`,
and it is on the list rather than smuggled in here.

---

<!-- figures:start -->

## Figures

| Cell | Precision | Recall | Recall incl. constructors | F1 |
|---|---|---|---|---|
| o4c-agent, with tests | **99.7%** (6031/6047, 95% CI 99.6%-99.8%) | **93.0%** (6031/6488, 95% CI 92.3%-93.6%) | 88.2% (6031/6839) | 0.962 |
| o4c-agent, without tests | **99.3%** (1185/1193, 95% CI 98.7%-99.7%) | **93.7%** (1185/1265, 95% CI 92.2%-94.9%) | 91.9% (1185/1289) | 0.964 |
| repomix, with tests | **99.7%** (3642/3654, 95% CI 99.4%-99.8%) | **91.8%** (3642/3966, 95% CI 90.9%-92.6%) | 87.4% (3642/4166) | 0.956 |
| repomix, without tests | **99.7%** (1152/1155, 95% CI 99.2%-99.9%) | **94.5%** (1152/1219, 95% CI 93.1%-95.6%) | 83.0% (1152/1388) | 0.971 |

Precision is over *graded* edges — those whose call site the oracle ruled on. Recall is over every
in-repo oracle edge, and its denominator includes edges the graph answered **wrongly**, so a wrong
answer is penalised twice: once in precision and once in recall.

Target line numbers agree on 100.0% (6029/6031), 99.8% (1183/1185), 100.0% (3641/3642) and
99.9% (1151/1152) of the recovered edges respectively. That is not a headline figure but it is
useful corroboration: if the two sides were accidentally agreeing on files for some structural
reason, line numbers would not line up as well.

<!-- figures:end -->

---

## What import-aware disambiguation bought, and what it did not

Step 5 added one piece of evidence: if the referencing file imports the name, the import names the
file, and the tie is broken. On **repomix with tests**, whose oracle is identical across both runs:

| | 2026-10-18 | with imports | |
|---|---|---|---|
| Precision | 99.6% (3246/3260) | 99.6% (3592/3606) | unchanged |
| Recall | 81.8% (3246/3966) | **90.6%** (3592/3966) | **+8.8 points** |

346 call sites moved from declined to correctly resolved, out of 365 the new evidence spoke to at
all — so it was right about 19 in 20 of them, at a precision that did not move. repomix without
tests gained less, 92.6% → 93.2%, which is the expected shape: a test file calling into `src/` is
the canonical cross-module call, and that is the traffic the with-tests cell carries.

**o4c gained almost nothing: 46 call sites.** That is a raw count rather than a ratio, so it is not
a denominator artefact — and it is the more interesting half of the result.

### The prediction this replaces was wrong, and the measurement says why

The 2026-10-18 version of this document said import disambiguation "would address roughly four
fifths of the remaining misses", reasoning from the fact that 84.3% of misses had the right target
among their candidates. That second clause is still true (84.4% now). The inference from it was
not: *having the right target among your candidates* and *being able to tell which one it is by
import* are different properties, and I treated them as one.

Measured over every ambiguous asserted call site in both repositories:

| | o4c | repomix |
|---|---|---|
| Ambiguous call sites | 833 | 1,459 |
| …with no import binding for the name at all | **767** | **1,088** |
| …import present, but not a relative specifier | 13 | 2 |
| …specifier resolved to no candidate file | **0** | **4** |
| …specifier resolved, but the target file defines the name twice | 7 | 0 |
| …resolved | 46 | 365 |

Two things fall out of that table. The path resolution itself is **not** the bottleneck — it failed
on 0 of 833 sites in o4c and 4 of 1,459 in repomix — so following re-exports through barrel files,
which was the obvious next refinement, is worth approximately nothing and is not being built. And
the dominant case, by an order of magnitude, is that **the name was never imported**.

### What the residual was, and what was done about it

Method dispatch through a receiver. The misses sampled after the import change read almost
entirely like this:

```
src/test/mcpIntegration.test.ts:122  status       truth src/mcp/host.ts:119
src/test/mcpHost.test.ts:102         execute      truth src/tools/types.ts:52
src/cli/actions/defaultAction.ts:151 start        truth src/cli/cliSpinner.ts:14
src/cli/cliRun.ts:349                setLogLevel  truth src/shared/logger.ts:26
```

Every one of those is `receiver.method()`. What the file imported is the *class, factory or type*;
the name at the call site is a property on the receiver, and no import statement mentions it. An
import query cannot reach these, and neither can any amount of module resolution. Worse, the index
could not tell them apart from plain calls at all: the TypeScript query captured both `f()` and
`o.f()` as `name.reference.call`, so `refs` held no record of which shape a reference had.

That is what the second change addresses, and it is measured in the next section.

### The same-file rule and import evidence never disagreed

Across both repositories, the number of call sites where the referencing file had exactly one
same-file definition **and** an import of the same name pointing at a different file was **0 of
2,292 ambiguous sites**. The order they are consulted in is therefore not load-bearing on that
evidence. It is pinned by a test anyway — "never happened in two repositories" is not "cannot
happen".

---

## Telling `f()` from `o.f()`

A member call is now captured as `name.reference.method` rather than `name.reference.call`, and
resolution excludes the one kind each shape cannot reach: a member call cannot reach a top-level
`function`, and a plain call cannot reach a `method`. Like the import rule it is positive-only —
if the exclusion would empty the candidate list, the whole list is kept.

| Cell | Precision | Recall | |
|---|---|---|---|
| o4c, with tests | 99.7% → 99.7% | 91.1% → **93.0%** | +1.9 |
| o4c, without tests | 99.4% → 99.3% | 93.3% → **93.7%** | +0.4 |
| repomix, with tests | 99.6% → **99.7%** | 90.6% → **91.8%** | +1.2 |
| repomix, without tests | 99.6% → **99.7%** | 93.2% → **94.5%** | +1.3 |

*(The o4c rows span a tree that also gained two test files, so their recall deltas are not exact;
the repomix rows are.)* Recall rose in all four cells, precision rose in two and fell by 0.1 point
in one. It also made the same-file rule slightly *safer* — its wrong answers fell from 19 to 15 —
because a same-file candidate the call shape cannot reach is now excluded before that rule sees it.

The two rules turn out to be **complementary across repositories**, which is the variance finding
again from the inside:

| Resolved only because of… | o4c | repomix |
|---|---|---|
| an import statement | 46 | 360 |
| the call's shape | **185** | 66 |

### It took three kinds, and two of them was actively worse

The first attempt sorted definitions into `function` and `method` and narrowed on that. Measured,
it bought recall (93.5% in the largest cell) and **cost precision in every cell** — 99.4% → 98.1%
in o4c without tests, tripling that cell's wrong answers from 7 to 23. Nine of the new errors were
one shape:

```
src/ui/App.tsx:1109  confirmDialog.resolve(...)
  said   src/session/configStore.ts:104   async resolve() { … }
  truth  src/ui/App.tsx:819               resolve: (id: string | undefined) => void;
```

The real target is a function-typed property on the dialog's own interface — which the query filed
under `function`, a kind the rule had just declared unreachable by member calls. So the narrowing
deleted the right answer and left exactly one wrong one, converting honest declines into confident
errors. That is the precise failure this whole component is built to avoid, and it was caused by a
taxonomy, not by a threshold.

The fix is a third kind. `field` — a function held in a property or a parameter — is reachable
**either** way and is excluded by neither shape:

| kind | written as | reachable by |
|---|---|---|
| `function` | `function f(){}`, `const f = () => {}` | `f()` |
| `method` | `f(){}` in a class or interface | `o.f()` |
| `field` | `f: () => void` on a property or parameter | both |

With that, precision held everywhere and the recall gain survived. The lesson is not subtle and is
worth keeping: a narrowing rule is only as honest as the categories it narrows over, and this one
was measured against an oracle precisely so that a plausible-looking rule could be caught costing
accuracy rather than shipped on the strength of its recall column.

---

## Where the remaining error is

**Nothing is lost to extraction.** `missedByExtraction` is 0 in all four cells: every oracle edge
the graph failed to recover was at a call site the graph *did* see.

**The limit is ambiguity, not blindness.** Of the 441 misses in the largest cell, 355 (80.5%) had
the correct target sitting in the candidate list and were declined because the evidence available
could not choose. The graph refused to guess, which is the designed behaviour —
`resolveCallEdges` emits `call_reference` for those, and `isAssertedCall` keeps them out of any
precision figure. The proportion has fallen from 84.4% as the two new rules took the decidable
cases, which is the direction it should move in: what is left is more purely undecidable by
syntax.

### The same-file preference earns its place

`resolve.ts` prefers a definition in the referencing file when a name is shared, and its own
comment said the acceptance test would decide whether that was justified. Measured across the four
cells it was **right 1,875 times and wrong 15** — a ratio of 125 to 1. It keeps.

That is 1,875 answers that would otherwise have been declined as `low_confidence`, bought for 15
wrong ones. The ratio improved without the rule changing, because the call-shape exclusion now
removes some wrong same-file candidates before this rule can prefer them. Note it is a ratio, not a free win: the 19 are real errors, and they are concentrated
in exactly the case the next section describes.

Worth recording how nearly I got this backwards: reading the sampled false positives, the same-file
rule looked like the main culprit, because several of them were exactly that. But a sample drawn
from failures contains only failures, and cannot be used to judge a heuristic's net value. The
counts settled it in the opposite direction.

### The false positives in the largest cell — a census, not a sample

Precision is high enough that the sample now covers the whole population: there are 16. They split
exactly two ways, and the split matches two counters recorded independently of each other
(`sameFilePreferenceLost` = 10, `crossFileWrong` = 6):

- **10 are the same-file rule preferring a local function-typed property or parameter** over the
  method the compiler resolves to — `host.status()` answered with the `status` field of the
  `McpSession` interface declared in the calling file, rather than with `McpHost.status`. Several
  are defensible disagreements rather than errors: for someone reading `startup.ts`, the property
  in front of them is arguably the more useful answer. They are still counted as wrong, because the
  measurement does not get to grade itself generously.
- **6 are genuinely wrong cross-file picks** — a name shared across files, no local evidence to
  break the tie, and the wrong one chosen. One of those six is unwinnable by any name-based
  method: the oracle's answer for `read(...)` in `indexer.ts` is a declaration named `readSource`,
  so the correct target was never a candidate for the name `read` in the first place.

Of the 20 sampled false negatives, 14 carried the right target among their ambiguous candidates,
which is a weak check that the sampling is not skewed relative to the aggregate.

*(The 2026-10-18 classification of that run's 20 false positives — ~5 interface-typed
disagreements, ~4 genuinely wrong, the rest one since-fixed defect — is superseded by the census
above, and is not reproduced because the defect it described is fixed and that sample no longer
exists.)*

---

## Three extraction defects this measurement found

All three were found by measuring rather than by reading the queries. The first two are in
`grammars/queries/typescript.scm` and `tsx.scm`, and were fixed on 2026-10-18.

**1. Callback-typed properties and parameters were invisible.** `emit()`, `onEntry()`,
`toolPolicy()`, `resolve()` and `onToken()` are called through a property or a parameter holding a
function. With no pattern for those, the only candidate left was an unrelated top-level definition
sharing the name, so the graph answered confidently and wrongly. Three patterns added, restricted
to `function_type` — capturing *every* property would bury the definition table in field names and
create more ambiguity than it resolved.

**2. My own HOC pattern was too broad, and was the largest remaining error source.** One step
earlier I had added `const f = <call with an arrow-function argument>` to catch
`const f = useCallback(() => {}, [])`. It also matched
`const uninstall = installGcWatchdog(500, () => {}, deps)` and `const call = rows.find((e) => ...)`
— both of which bind a *value* — and then attributed every `uninstall()` in the repository to that
local const. Narrowed to the named wrappers `useCallback`, `useMemo`, `memo` and `forwardRef`.

Effect of the two fixes, measured at the time:

| Cell | Precision | Recall | Cross-file wrong answers |
|---|---|---|---|
| o4c, with tests | 98.9% → 99.5% → 99.7% | 88.6% → 89.8% → 90.8% | 44 → 17 → 5 |
| o4c, without tests | 97.0% → 99.2% → 99.4% | 87.6% → 92.1% → 92.5% | 26 → 3 → 2 |
| repomix, with tests | 99.4% → 99.6% → 99.6% | 81.5% → 81.8% → 81.8% | 17 → 12 → 12 |
| repomix, without tests | 99.2% → 99.6% → 99.6% | 91.6% → 92.6% → 92.6% | 7 → 3 → 3 |

Both fixes improved precision *and* recall in every cell, which is unusual enough to be worth
noting — the two normally trade against each other. repomix barely moved on the second fix, which
is the expected result for a codebase that is not React.

**3. A plain call and a method call were stored identically** — found by this run and fixed in it.
Both were `name.reference.call`, so nothing downstream could prefer a function for `f()` and a
method for `o.f()`. Fixed by capturing a member call as `name.reference.method` and by splitting
the definition kinds three ways; measured in "Telling `f()` from `o.f()`" above. The *receiver's*
identity is still not carried through to resolution, which is what the remaining receiver-dispatch
misses would need.

*(The transition figures above are prose, not guarded: only the final column is in the figures
block. They are reproducible by reverting either query patch and re-running the script.)*

---

## What this does **not** show

The numbers above are much higher than the recall figures in the code-graph literature, and that
is not a refutation of them. It is a narrower question:

- **TypeScript only.** Nothing here says anything about the other 14 bundled languages, and that
  now includes both new rules: only the ECMAScript family has an import query, and only its tag
  queries distinguish `f()` from `o.f()`, so Python, Go and Rust resolve exactly as they did
  before. Both rules are gated on that explicitly rather than assumed — Java's query calls every
  invocation a `method` and Python's calls every one a `call`, so reading a shape out of either
  would be narrowing by a distinction the query never made. The per-language precision figures
  in the independent-grading review — 0.86 for Go, 0.82 for TypeScript, 0.48 for Rust under
  bare-name resolution — remain the best available estimate for those.
- **A restricted call universe.** No constructors, no computed calls, in-repo targets only. The
  published low figures generally measure whole call graphs including dynamic dispatch.
- **Two repositories, both TypeScript, one of them our own.** Two points do not establish a range,
  and the variance finding in the literature is specifically that the range is wide — which these
  two changes have now demonstrated from the inside, each one carrying a repository the other
  barely touched.
- **Nothing about ranking.** This grades resolution. Whether the ranker surfaces the *right* files
  inside a token budget is a different measurement that has not been made.

What it does establish is narrow and worth having: on TypeScript, at the call sites the graph
claims to cover, **it is almost never wrong when it answers** (precision 99.4–99.7%), it answers
most of the time (recall 91.8–94.5%), and what it now misses it misses by **declining to choose**
between a method name's many owners rather than by failing to see the call.
