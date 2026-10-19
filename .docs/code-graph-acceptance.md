# Code Graph acceptance test

**Measured 2026-10-18.** Reproduce with `npm run build && node scripts/graph-grade.mjs`.

Every percentage in the figures block below is re-derived from `.docs/code-graph-acceptance.json`
by `src/test/codeGraphAcceptance.test.ts`, which also rejects any percentage in that block that
the stored counts do not produce. Editing a number here by hand fails the suite. That guard
exists because earlier in this project I quoted a recall figure from the literature that was a
single cell of a table whose author forbade reading it that way, and it reached a design document
and a memory file before being caught.

---

## What is being measured, and against what

The graph resolves call sites by **name**. The TypeScript compiler resolves them by **type**, with
full module resolution, and it is the thing the language is defined by — so for TypeScript it is
an oracle in the strict sense, not a second heuristic. `scripts/graph-oracle.mjs` walks a
`ts.Program`, takes `checker.getResolvedSignature(call).declaration` for every call site, and
emits ground-truth `caller → callee` edges.

**Two repositories**, because the independent-grading review found call-graph recall in this field
varying from 0.026 to 0.967 *across repositories*, with no signal available at query time to say
which case you are in. A figure from one repository is not a property of a tool.

**Each reported with and without its test files**, because o4c's own call sites are dominated by
`assert.equal` and friends, and a figure propped up by test code would not survive contact with a
real codebase. The oracle program is identical across the two cells of a repository; only the
reporting filter on the caller's path changes, so the cells differ by exactly one thing.

### What the universe excludes, and why

| Excluded | Count (o4c / repomix) | Why |
|---|---|---|
| `new X()` | 567 / 651 | The TypeScript query captures it as `name.reference.class`, which `isAssertedCall` already excludes. Grading it would measure a claim the graph does not make. |
| `a["b"]()`, `(f ?? g)()` | 46 / 144 | No query pattern captures these shapes, so they are not claims either. |
| Targets outside the repository | 9,036 / 16,011 | A call into `node_modules` or the standard library is not something the graph is wrong about; it is outside what the graph indexes. These are the `outOfUniverse` bucket — counted as neither right nor wrong. |

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

---

<!-- figures:start -->

## Figures

| Cell | Precision | Recall | Recall incl. constructors | F1 |
|---|---|---|---|---|
| o4c-agent, with tests | **99.7%** (5526/5541, 95% CI 99.6%-99.8%) | **90.8%** (5526/6088, 95% CI 90.0%-91.5%) | 86.0% (5526/6428) | 0.950 |
| o4c-agent, without tests | **99.4%** (1082/1089, 95% CI 98.7%-99.7%) | **92.5%** (1082/1170, 95% CI 90.8%-93.9%) | 90.8% (1082/1191) | 0.958 |
| repomix, with tests | **99.6%** (3246/3260, 95% CI 99.3%-99.7%) | **81.8%** (3246/3966, 95% CI 80.6%-83.0%) | 77.9% (3246/4166) | 0.898 |
| repomix, without tests | **99.6%** (1129/1134, 95% CI 99.0%-99.8%) | **92.6%** (1129/1219, 95% CI 91.0%-94.0%) | 81.3% (1129/1388) | 0.960 |

Precision is over *graded* edges — those whose call site the oracle ruled on. Recall is over every
in-repo oracle edge, and its denominator includes edges the graph answered **wrongly**, so a wrong
answer is penalised twice: once in precision and once in recall.

Target line numbers agree on 100.0% (5524/5526), 99.8% (1080/1082), 100.0% (3245/3246) and
99.9% (1128/1129) of the recovered edges respectively. That is not a headline figure but it is
useful corroboration: if the two sides were accidentally agreeing on files for some structural
reason, line numbers would not line up as well.

<!-- figures:end -->

---

## Where the remaining error is

**Nothing is lost to extraction any more.** `missedByExtraction` is 0 in all four cells: every
oracle edge the graph failed to recover was at a call site the graph *did* see.

**The limit is now ambiguity, not blindness.** Of the 547 misses in the largest cell, 461 (84.3%)
had the correct target sitting in the candidate list and were declined because the name alone could
not choose. The graph refused to guess, which is the designed behaviour — `resolveCallEdges` emits
`call_reference` for those, and `isAssertedCall` keeps them out of any precision figure. But it
means the next real recall gain is **import-aware disambiguation**: if `startup.ts` calls `start()`
and imports `start` from `./host`, the name is no longer ambiguous. That is one edge type away and
would address roughly four fifths of the remaining misses.

### The same-file preference earns its place

`resolve.ts` prefers a definition in the referencing file when a name is shared, and its own
comment said the acceptance test would decide whether that was justified. Measured across the four
cells it was **right 1,782 times and wrong 19** — a ratio of 94 to 1. It keeps.

That is 1,782 answers that would otherwise have been declined as `low_confidence`, bought for 19
wrong ones. Note it is a ratio, not a free win: the 19 are real errors, and they are concentrated
in exactly the case the next section describes.

Worth recording how nearly I got this backwards: reading the sampled false positives, the same-file
rule looked like the main culprit, because several of them were exactly that. But a sample drawn
from failures contains only failures, and cannot be used to judge a heuristic's net value. The
counts settled it in the opposite direction.

### Hand-check of the sampled failures

20 false positives and 20 false negatives per cell, sampled at a fixed stride over the sorted list
so the sample is deterministic and not drawn from one corner of the repository. Classifying the
largest cell's 20 false positives:

- **~5 are a defensible disagreement, not an error.** `client.getPrompt()` where `client` is
  interface-typed: the compiler resolves to the interface's `method_signature`, the graph points at
  the concrete method in the file being read. For someone reading code the graph's answer is
  arguably the more useful one. It is still counted as wrong here, because the measurement does
  not get to grade itself generously.
- **~4 are genuinely wrong** — a name shared across files with no local evidence to break the tie.
- **The rest were one defect, now fixed.** See below.

Of the 20 sampled false negatives, 18 carried the right target among their ambiguous candidates —
the same finding as the aggregate count, which is a weak check that the sampling is not skewed.

---

## Two extraction defects this found

Both were found by this measurement rather than by reading the queries, and both are in
`grammars/queries/typescript.scm` and `tsx.scm`.

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

Effect of the two fixes, measured:

| Cell | Precision | Recall | Cross-file wrong answers |
|---|---|---|---|
| o4c, with tests | 98.9% → 99.5% → 99.7% | 88.6% → 89.8% → 90.8% | 44 → 17 → 5 |
| o4c, without tests | 97.0% → 99.2% → 99.4% | 87.6% → 92.1% → 92.5% | 26 → 3 → 2 |
| repomix, with tests | 99.4% → 99.6% → 99.6% | 81.5% → 81.8% → 81.8% | 17 → 12 → 12 |
| repomix, without tests | 99.2% → 99.6% → 99.6% | 91.6% → 92.6% → 92.6% | 7 → 3 → 3 |

Both fixes improved precision *and* recall in every cell, which is unusual enough to be worth
noting — the two normally trade against each other. repomix barely moved on the second fix, which
is the expected result for a codebase that is not React.

*(These transition figures are prose, not guarded: only the final column is in the figures block.
They are reproducible by reverting either query patch and re-running the script.)*

---

## What this does **not** show

The numbers above are much higher than the recall figures in the code-graph literature, and that
is not a refutation of them. It is a narrower question:

- **TypeScript only.** Nothing here says anything about the other 14 bundled languages. The
  per-language precision figures in the independent-grading review — 0.86 for Go, 0.82 for
  TypeScript, 0.48 for Rust under bare-name resolution — remain the best available estimate for
  those, and Rust in particular should be expected to be far worse than this.
- **A restricted call universe.** No constructors, no computed calls, in-repo targets only. The
  published low figures generally measure whole call graphs including dynamic dispatch.
- **Two repositories, both TypeScript, one of them our own.** Two points do not establish a range,
  and the variance finding in the literature is specifically that the range is wide.
- **Nothing about ranking.** This grades resolution. Whether the ranker surfaces the *right* files
  inside a token budget is a different measurement that has not been made.

What it does establish is narrow and worth having: on TypeScript, at the call sites the graph
claims to cover, **it is almost never wrong when it answers** (precision 99.4–99.7%), it answers
most of the time (recall 81.8–92.6%), and what it now misses it misses by **declining to choose**
rather than by failing to see.
