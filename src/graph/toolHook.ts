/**
 * The tool-dispatch hook - build step 4 of `docs/research/code-graph/0000.DECISION.md`, and the
 * first thing that makes the Code Graph visible inside o4c.
 *
 * Registers on the core seam (`src/agent/coreSeam.ts`), which exists for exactly this: a
 * component that needs to change what a tool call returns, which MCP structurally cannot express.
 * `CoreRegistry.runTool` is reached only for a call the mode and the user already allowed, so
 * nothing here can become a route around the approval gate.
 *
 * ## Two findings that shaped this, both against the original plan
 *
 * **It annotates; it does not answer instead.** The decision document describes the index
 * answering `grep`-class calls directly. It cannot: the index holds identifiers, not lines, so an
 * index-backed `grep` would silently be a subset of a real one. `projection.ts` has the full
 * argument. The real tool runs, its answer stands, and the graph adds the structural claim the
 * model was using `grep` to approximate.
 *
 * **The index gets fresher as a side effect of being used.** `read_file` and `write_file` both
 * hand over the file's bytes - one has just read them, the other has just written them - so
 * reindexing that file costs no I/O and no race: the bytes indexed are provably the bytes the
 * model saw. This is what makes `fresh` an honest word to print here before Merkle freshness
 * (step 5) exists.
 *
 * ## Pull, not push
 *
 * `19.Graft.md`'s controlled sweep measured the pull variant at 98% correctness against 93% for a
 * pushed context bundle, so nothing here inflates the request prefix. There are two surfaces and
 * both are reactive: the `code_graph` tool, which the model calls when it wants to know (one verb,
 * not twelve - see `src/tools/codeGraph.ts`), and these annotations, which exist so the graph is
 * discoverable without the model having to know it is there.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CoreComponent, ToolCallContext } from '../agent/coreSeam.js';
import { estimateTextTokens } from '../agent/contextEntry.js';
import { isCallable, resolveName } from './resolve.js';
import { currentHead, mineCochange } from './cochange.js';
import { fitToBudget, rankDefinitions } from './ranker.js';
import type { DefinitionRow, GraphStore } from './graphStore.js';
import { indexSource, repoRelative, type IndexRunResult } from './indexer.js';
import { runIndexPassInProcess, type RunIndexPass } from './indexPass.js';
import {
  nameProjection,
  PROJECTION_PREFIX,
  renderFileProjection,
  renderNameProjection,
  type ProjectionFreshness,
} from './projection.js';

export const CODE_GRAPH_COMPONENT_NAME = 'code-graph';

/**
 * Output prefixes of the built-in tools this hook has to recognise.
 *
 * A deliberate coupling to `src/tools/readFile.ts` and `src/tools/writeFile.ts`, because the
 * alternatives are worse: annotating an error message as though it were a file, or - for a write -
 * indexing content that a failed write never put on disk, which would leave the index confidently
 * wrong. `codeGraphToolHook.test.ts` pins all three against the real tools, so a change over
 * there fails a test instead of quietly degrading this.
 */
const READ_RANGE_PREFIX = '[read_file:';
const READ_ERROR_PREFIX = 'Error reading file "';
const WRITE_ERROR_PREFIX = 'Error writing file "';

/** Built-in tool names. Matched exactly; an MCP tool is namespaced and so cannot collide. */
const GREP_TOOL = 'grep_files';
const READ_TOOL = 'read_file';
const WRITE_TOOL = 'write_file';
const EDIT_TOOL = 'edit_file';
const EDIT_ERROR_PREFIX = 'Error editing file "';
const SHELL_TOOL = 'run_shell';

/**
 * A `grep` pattern that is just a name, optionally word-anchored.
 *
 * Anything else - a character class, an alternation, a partial word - is a question the index
 * cannot answer, and guessing an identifier out of a larger regex would produce an annotation
 * about a different question than the one asked. `\b` on either side is allowed because it is how
 * a model usually writes "this exact name" and it does not change which name is meant.
 */
const BARE_IDENTIFIER = /^(?:\\b)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\\b)?$/;

/**
 * Where the index stands.
 *
 * `failed` does not suppress the graph. A pass that threw leaves real rows behind, and a
 * definition that is in the index is in the index - what it cannot support is an *absence* claim,
 * and that is handled by reporting `incomplete` to the resolver rather than by going silent.
 */
export type IndexPhase = 'building' | 'ready' | 'failed';

export interface CodeGraphStatus {
  readonly phase: IndexPhase;
  /** The last completed pass, for `/context`-style reporting. */
  readonly lastRun?: IndexRunResult;
  readonly lastError?: string;
}

/** What `src/tools/codeGraph.ts` needs, so the tool itself knows nothing about indexing. */
export interface CodeGraphLookup {
  describeName(name: string, fromPath?: string): string;
  describeFile(path: string): Promise<string>;
  /** The definition's own lines, read fresh from disk (plan 0006 B12). */
  describeSource(name: string, fromPath?: string): Promise<string>;
}

/** Lines of one definition shown by `code_graph` with `source`, before it points at read_file. */
const MAX_SOURCE_LINES = 150;

export class CodeGraphComponent implements CoreComponent, CodeGraphLookup {
  readonly name = CODE_GRAPH_COMPONENT_NAME;

  private phase: IndexPhase = 'building';
  private lastRun: IndexRunResult | undefined;
  private lastError: string | undefined;
  /** The in-flight full pass, so a second request coalesces instead of running concurrently. */
  private running: Promise<void> | undefined;
  private rerunRequested = false;
  /**
   * Whether the model sees the graph at all - the `/graph` switch.
   *
   * Off means no annotations here and no `code_graph` tool (startup.ts removes it). It does **not**
   * stop indexing: writes, shell calls and whole-file reads still keep the index level, so turning
   * it back on gives a fresh index rather than one that went stale while it was hidden. That is
   * also what makes an on/off comparison fair - only what the model is shown differs.
   */
  private exposed = true;

  /**
   * `runPass` is how a full pass gets off the UI thread.
   *
   * Injected rather than chosen here, so that the component stays testable without spawning a
   * worker per test - and so the production wiring (`startup.ts`) is the one place that decides.
   * The default is in-process, which is both the fallback and what every test gets unless it asks
   * for otherwise. Single-file indexing after a read or a write is never handed to a worker: it is
   * one parse, and it has to be finished before the tool's output is returned.
   */
  constructor(
    private readonly store: GraphStore,
    private readonly root: string,
    private readonly runPass: RunIndexPass = runIndexPassInProcess,
  ) {}

  status(): CodeGraphStatus {
    return { phase: this.phase, lastRun: this.lastRun, lastError: this.lastError };
  }

  isExposed(): boolean {
    return this.exposed;
  }

  /**
   * Whether a definition with this identity exists right now - for the history's staleness flag
   * (brief 0004, Q9). `undefined` while the index cannot support a claim of absence, the same rule
   * `resolveName` follows: a task is never called stale because the first pass has not landed.
   */
  entityExists(entityUid: string): boolean | undefined {
    if (this.indexStatus() !== 'fresh') return undefined;
    return this.store.hasEntity(entityUid);
  }

  setExposed(on: boolean): void {
    this.exposed = on;
  }

  /**
   * Starts (or re-requests) a full pass over the project.
   *
   * Returns the pass's promise so a test can await it; callers in the app do not, because startup
   * must not wait on indexing. While a pass is in flight every projection reports `incomplete`,
   * so the window is visible rather than papered over.
   */
  reindex(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.phase = 'building';
    this.running = this.runPasses().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runPasses(): Promise<void> {
    do {
      this.rerunRequested = false;
      try {
        this.lastRun = await this.runPass(this.store, this.root);
        this.lastError = undefined;
        this.phase = 'ready';
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.phase = 'failed';
        // Not retried on failure: a pass that threw will almost certainly throw again, and a
        // retry loop here would be an invisible busy loop on a broken project.
        return;
      }
    } while (this.rerunRequested);
  }

  /**
   * Whether the index can currently support a claim of absence.
   *
   * `resolveName` turns `absent` into `degraded` when this says `incomplete`, which is the whole
   * point: **`absent` must never be asserted over an index that might be behind.**
   */
  private indexStatus(): 'fresh' | 'incomplete' {
    return this.phase === 'ready' ? 'fresh' : 'incomplete';
  }

  // ---------------------------------------------------------------- the seam

  async aroundTool(call: ToolCallContext, next: () => Promise<string>): Promise<string> {
    // The real tool always runs, and runs first. Nothing below can prevent or replace it.
    const output = await next();

    // Never touch a proxied tool. MCP names are `mcp__<server>__<tool>` so a collision is not
    // actually reachable, but the question "is this ours?" has an honest answer on the Tool and
    // this is a place that should be asking it.
    if (call.tool.mcp) return output;

    try {
      switch (call.tool.name) {
        case GREP_TOOL:
          return this.exposed ? this.annotateGrep(call.input, output) : output;
        case READ_TOOL:
          if (!this.exposed) {
            await this.absorbRead(call.input, output);
            return output;
          }
          return await this.annotateRead(call.input, output);
        case WRITE_TOOL:
          return output + (await this.absorbWrite(call.input, output));
        case EDIT_TOOL:
          return output + (await this.absorbEdit(call.input, output));
        case SHELL_TOOL:
          // A shell command can change anything, including files this process never saw, so the
          // only honest response is to treat the whole index as behind and rebuild it. Fire and
          // forget: the turn must not wait, and until it lands every projection says `incomplete`.
          void this.reindex();
          return output;
        default:
          return output;
      }
    } catch {
      // A failed annotation must cost the annotation and nothing else. `CoreRegistry.runTool`
      // deliberately does not catch (re-running a mutating tool would be worse than a crash), so
      // the catch belongs here, around work that is purely additive.
      return output;
    }
  }

  // ---------------------------------------------------------------- annotations

  /**
   * Prepends the structural answer to a `grep` result.
   *
   * Prepended rather than appended because `grep_files` truncates at 200 matches and
   * `AgentLoop.boundToolOutput` may truncate again by window size - both from the end. The one
   * line that says *where the thing is defined* should not be the line that gets cut.
   */
  private annotateGrep(input: Record<string, unknown>, output: string): string {
    const match = BARE_IDENTIFIER.exec(String(input.pattern ?? ''));
    if (!match) return output;

    const { verdict, text } = nameProjection(this.store, match[1], {
      indexStatus: this.indexStatus(),
    });
    // `grep` has already given an exhaustive answer, so a note that adds no structure is pure
    // cost. Dropped here rather than in the renderer, because the `code_graph` tool - where the
    // model asked the question - must still get `absent` and `degraded` in full.
    if (verdict === 'absent' || verdict === 'degraded') return output;

    // `grep_files` reports paths relative to its own `path` argument, and the graph only ever
    // knows project-relative ones. When those two roots differ the result would carry two path
    // systems with nothing saying so, and `graph/resolve.ts` next to `src/graph/resolve.ts` is
    // exactly the kind of difference that is read as two files. Said only when it is true, so the
    // ordinary whole-project grep pays nothing for it.
    const base = String(input.path ?? '');
    const rebased = base && base !== '.' ? repoRelative(this.root, base) : undefined;
    const caveat = rebased ? '\n  (graph paths are relative to the project root)' : '';

    return `${text}${caveat}\n\n${output}`;
  }

  /**
   * Appends a file outline to a `read_file` result, and reindexes the file while it is here.
   *
   * Appended, not prepended: the file's own contents are what was asked for and must start at the
   * top, byte-identical to disk for an unranged read - `readFile.ts` goes out of its way to
   * guarantee that and an annotation in front of it would undo it.
   */
  private async annotateRead(input: Record<string, unknown>, output: string): Promise<string> {
    if (output.startsWith(READ_ERROR_PREFIX)) return output;

    const rel = repoRelative(this.root, String(input.path ?? ''));
    if (!rel) return output;

    let freshness: ProjectionFreshness;
    if (isWholeFileRead(input, output)) {
      // The bytes in hand are the file. Reindex if they have moved on, then say `fresh` and mean
      // it - which is the only reason this can print that word before step 5's Merkle freshness.
      if (this.store.freshness(rel, output) !== 'fresh') await indexSource(this.store, rel, output);
      freshness = this.store.freshness(rel, output);
    } else {
      freshness = this.store.indexedFile(rel) ? 'unknown' : 'absent';
    }

    // An indexed file that defines nothing has nothing to volunteer, so the header alone is pure
    // cost - the same judgement that drops `absent` from a `grep` annotation. The `code_graph`
    // tool still reports it, because there the model asked and "it defines nothing" is the answer.
    // Note this is *not* applied to a file the index does not hold: "excluded as generated, or
    // extraction failed" explains why the graph is quiet, and that is worth a line.
    if (freshness !== 'absent' && (this.store.indexedFile(rel)?.defCount ?? 0) === 0) return output;

    const projection = renderFileProjection(this.store, rel, freshness, {
      indexStatus: this.indexStatus(),
    });
    return projection ? `${output}\n\n${projection}` : output;
  }

  /** `annotateRead`'s reindex without its annotation, for when the graph is switched off. */
  private async absorbRead(input: Record<string, unknown>, output: string): Promise<void> {
    if (output.startsWith(READ_ERROR_PREFIX) || !isWholeFileRead(input, output)) return;
    const rel = repoRelative(this.root, String(input.path ?? ''));
    if (rel && this.store.freshness(rel, output) !== 'fresh') await indexSource(this.store, rel, output);
  }

  /** Keeps the index level with a successful write, from the content the write already carried. */
  private async absorbWrite(input: Record<string, unknown>, output: string): Promise<string> {
    if (output.startsWith(WRITE_ERROR_PREFIX)) return '';
    const rel = repoRelative(this.root, String(input.path ?? ''));
    if (!rel) return '';
    const before = this.store.definitionsIn(rel);
    await indexSource(this.store, rel, String(input.content ?? ''));
    return this.signatureNotice(rel, before);
  }

  /**
   * When a change altered a function's or method's signature, the call sites elsewhere that may now
   * be wrong (plan 0006 D9) - from the index, before the model finds out from a failing build.
   * Only for a name with one callable definition, so the call sites are attributable.
   */
  private signatureNotice(rel: string, before: readonly DefinitionRow[]): string {
    const after = this.store.definitionsIn(rel);
    const notes: string[] = [];
    for (const now of after) {
      if (!isCallable(now) || !now.signature) continue;
      const was = before.find((b) => b.name === now.name && b.kind === now.kind);
      if (!was?.signature || was.signature === now.signature) continue;
      if (this.store.definitionsOf(now.name).filter(isCallable).length !== 1) continue;
      const sites = this.store.referencesTo(now.name, true).filter((r) => !(r.path === rel && r.line >= now.line && r.line <= now.endLine));
      if (sites.length === 0) continue;
      const shown = sites.slice(0, 8).map((r) => `${r.path}:${r.line}`).join(', ');
      notes.push(`${now.name} changed from \`${was.signature}\` to \`${now.signature}\` - ${sites.length} call site(s) may need updating: ${shown}${sites.length > 8 ? ` (+${sites.length - 8} more)` : ''}`);
    }
    notes.push(...this.relatedNotes(rel, after));
    return notes.length ? `\n${PROJECTION_PREFIX} ${notes.join('\n')}` : '';
  }

  /** Files already given a co-change / test note this process (D10) - once each, not every edit. */
  private relatedShown = new Set<string>();

  /**
   * After a change (D10): files that git history says usually change with this one, and test
   * files that reference what it defines - the two things a model forgets before saying "done".
   */
  private relatedNotes(rel: string, defs: readonly DefinitionRow[]): string[] {
    if (this.relatedShown.has(rel)) return [];
    this.relatedShown.add(rel);
    const notes: string[] = [];
    try {
      this.ensureCochange();
      const together = this.store.cochangeFor(rel).filter((c) => c.of > 0 && c.commits / c.of >= 0.5).slice(0, 3);
      if (together.length) notes.push(`Usually changed together with ${rel}: ${together.map((c) => `${c.path} (${c.commits} of ${c.of} commits)`).join(', ')}`);
    } catch {
      // no git, or no history: nothing to say
    }
    const tests = new Set<string>();
    for (const name of new Set(defs.map((d) => d.name))) {
      for (const ref of this.store.referencesTo(name)) {
        if (ref.path !== rel && /(^|[\/._-])(test|tests|spec|__tests__)([\/._-]|$)/i.test(ref.path)) tests.add(ref.path);
      }
      if (tests.size >= 5) break;
    }
    if (tests.size) notes.push(`Tests that use what ${rel} defines: ${[...tests].slice(0, 5).join(', ')} - run them before calling this done`);
    return notes;
  }

  /** Mines git history into the co-change tables when HEAD has moved since the last time. */
  private ensureCochange(): void {
    const head = currentHead(this.root);
    if (!head || head === this.store.cochangeHead()) return;
    const mined = mineCochange(this.root);
    if (mined) this.store.replaceCochange(mined.head, mined.files, mined.pairs);
  }

  /**
   * `edit_file` changes part of a file, so unlike a write the new bytes are not in the call - read
   * the file back and index that. Without this an edited file kept its old line numbers in the
   * graph until something read it again (found 2026-11-02, research report 08's side finding).
   */
  private async absorbEdit(input: Record<string, unknown>, output: string): Promise<string> {
    if (output.startsWith(EDIT_ERROR_PREFIX)) return '';
    const rel = repoRelative(this.root, String(input.path ?? ''));
    if (!rel) return '';
    const before = this.store.definitionsIn(rel);
    await indexSource(this.store, rel, await readFile(join(this.root, rel), 'utf-8'));
    return this.signatureNotice(rel, before);
  }

  // ---------------------------------------------------------------- the one verb

  /**
   * The ranked definition map for a focus, fitted to `maxTokens` - `/ultraplan`'s research step
   * (brief 0005, Q6). Undefined until the first index pass is ready, or when nothing ranks.
   */
  rankedMap(focus: { idents: readonly string[]; files: readonly string[] }, maxTokens: number): string | undefined {
    if (this.status().phase !== 'ready') return undefined;
    const ranking = rankDefinitions(this.store, { mentionedIdents: focus.idents, mentionedFiles: focus.files });
    const fitted = fitToBudget(ranking.definitions, { maxTokens, countTokens: estimateTextTokens });
    return fitted.used > 0 ? fitted.text : undefined;
  }

  describeName(name: string, fromPath?: string): string {
    return renderNameProjection(this.store, name, {
      fromPath,
      indexStatus: this.indexStatus(),
    });
  }

  /**
   * The source of a definition, for `code_graph` with `source: true` - reading a function by name
   * instead of reading its whole file (plan 0006 B12). Only when the name resolves to one
   * definition; the lines come from disk now, and a line that no longer holds the name means the
   * file moved under the index, which is said rather than guessed around.
   */
  async describeSource(name: string, fromPath?: string): Promise<string> {
    const resolution = resolveName(this.store, name, fromPath, { indexStatus: this.indexStatus() });
    const def = resolution.definitions.length === 1 || resolution.verdict === 'ok' ? resolution.definitions[0] : undefined;
    if (!def) {
      return resolution.definitions.length > 1
        ? `  (no source shown: ${resolution.definitions.length} definitions - pass "from", or read one with read_file)`
        : '  (no source shown: no definition found)';
    }
    let text: string;
    try {
      text = await readFile(join(this.root, def.path), 'utf-8');
    } catch {
      return `  (no source shown: ${def.path} could not be read)`;
    }
    const lines = text.split('\n');
    if (!(lines[def.line - 1] ?? '').includes(name)) {
      return `  (no source shown: ${def.path} changed since it was indexed - read it with read_file)`;
    }
    const end = Math.min(def.endLine, def.line - 1 + MAX_SOURCE_LINES);
    const body = lines.slice(def.line - 1, end).map((l, i) => `${String(def.line + i).padStart(5)}  ${l.replace(/\r$/, '')}`);
    const more = def.endLine > end ? `\n  (+${def.endLine - end} more lines: read_file ${def.path} offset ${end + 1})` : '';
    return `${def.path}:${def.line}-${def.endLine}\n${body.join('\n')}${more}`;
  }

  /**
   * The file outline, for a path the model named.
   *
   * Reads the file, unlike the `read_file` annotation, because here there are no bytes in hand -
   * and one read is the price of being able to say `fresh` rather than `unknown`.
   */
  async describeFile(path: string): Promise<string> {
    const rel = repoRelative(this.root, path);
    if (!rel) {
      return `[code graph] ${path} · outside the project · the graph only covers files under ${this.root}.`;
    }

    let source: string | undefined;
    try {
      source = await readFile(join(this.root, rel), 'utf-8');
    } catch {
      source = undefined;
    }

    let freshness: ProjectionFreshness;
    if (source === undefined) {
      freshness = this.store.indexedFile(rel) ? 'unknown' : 'absent';
    } else {
      if (this.store.freshness(rel, source) !== 'fresh') await indexSource(this.store, rel, source);
      freshness = this.store.freshness(rel, source);
    }

    const projection = renderFileProjection(this.store, rel, freshness, {
      indexStatus: this.indexStatus(),
      skeleton: true,
    });
    return (
      projection ??
      `[code graph] ${rel} · degraded · no bundled grammar claims this extension, so the graph cannot describe it.`
    );
  }
}

/**
 * Whether a `read_file` result is the file's exact bytes.
 *
 * True only for an unranged read that came back without the range header, which is precisely when
 * `readFile.ts` returns `content` untouched. Conservative on purpose: a false negative costs the
 * word `fresh`, while a false positive would hash a slice and mark the whole file stale forever.
 */
function isWholeFileRead(input: Record<string, unknown>, output: string): boolean {
  if (input.offset !== undefined || input.limit !== undefined) return false;
  return !output.startsWith(READ_RANGE_PREFIX);
}
