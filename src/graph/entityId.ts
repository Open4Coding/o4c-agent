/**
 * Entity identity for the Code Graph and the infinite-context store.
 *
 * This module is deliberately owned by **neither** of them. The history store's unit is an
 * entity-level change record, so it is keyed on the same identities the graph produces; if
 * either side owned the scheme the other would depend on its internals. Settled during build
 * step 2 precisely because item 13's rows cannot be written before it exists without needing a
 * migration later.
 *
 * ## Two hashes, answering two different questions
 *
 * **`entityUid` - logical identity.** What *is* this thing, independent of where it sits in the
 * file. Derived from language, kind, name and enclosing scope. Survives everything that moves
 * code without changing it: an unrelated edit higher up the file, a reformat, a reordering of
 * declarations.
 *
 * **`contentHash` - fingerprint.** What this thing's source text *was*. Changes whenever the
 * body changes, and is identical for two copies of the same code anywhere.
 *
 * Together they classify a change without storing a diff, which is the whole point:
 *
 * | uid | contentHash | meaning |
 * |---|---|---|
 * | same | same | untouched (possibly moved within the file) |
 * | same | different | **modified in place** |
 * | different | same | **moved or renamed** - the body is identical |
 * | different | different | unrelated entities |
 *
 * ## Why not `path:line`
 *
 * Line numbers drift. Adding an import at the top of a file renumbers every entity below it,
 * so a `path:line` key would record the entire file as changed after a one-line edit, and any
 * history built on it would be mostly noise. Graft, sem and SCIP all arrive at this
 * independently (`docs/research/code-graph/0000.DECISION.md`). Lines are still carried on a tag
 * for *citation* - showing the user where something is - but never as identity.
 *
 * A rename deliberately produces a new `entityUid`. A renamed function is a different logical
 * entity, and the equal `contentHash` is what lets a caller recognise the rename rather than
 * having identity silently paper over it.
 */

import { createHash } from 'node:crypto';

/** Field separator. A NUL cannot occur in any of the parts, so no part can forge a boundary. */
const SEP = '\0';

/** Truncation length for stored ids. 128 bits of SHA-256, hex-encoded. */
const UID_HEX_LENGTH = 32;

/** The inputs that decide what an entity *is*. */
export interface EntityIdentity {
  /** Language id, so `foo` in Python and `foo` in Go are never the same entity. */
  readonly language: string;
  /** Repository-relative path with forward slashes. */
  readonly path: string;
  /** The capture kind, e.g. `function`, `class`, `method` - from the tag's capture name. */
  readonly kind: string;
  /** The entity's own name. */
  readonly name: string;
  /**
   * Enclosing named scopes, outermost first - e.g. `['Circle']` for a method of `Circle`.
   * Distinguishes two same-named methods on different classes in one file. Empty at top level.
   */
  readonly scope?: readonly string[];
}

/**
 * Content-addressed logical identity: stable across line drift, distinct per language, path,
 * kind, scope and name.
 *
 * The path is part of identity on purpose. Two identically-named helpers in different files are
 * different entities, and treating them as one would merge their histories. The cost is that a
 * file rename re-identifies everything in it - detectable via `contentHash`, and a file-level
 * rename is a single event rather than a per-entity one.
 */
export function entityUid(identity: EntityIdentity): string {
  const parts = [
    identity.language,
    normalisePath(identity.path),
    identity.kind,
    ...(identity.scope ?? []),
    identity.name,
  ];
  return createHash('sha256').update(parts.join(SEP)).digest('hex').slice(0, UID_HEX_LENGTH);
}

/**
 * Fingerprint of an entity's source text, with trailing whitespace per line and surrounding
 * blank lines removed so that a reformat that changes nothing semantically does not read as a
 * modification. Indentation is *kept* - in Python it is semantic, and guessing per language here
 * would be worse than being consistent.
 */
export function contentHash(source: string): string {
  const normalised = source
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return createHash('sha256').update(normalised).digest('hex').slice(0, UID_HEX_LENGTH);
}

/**
 * Fingerprint of a whole file's bytes, used for index freshness.
 *
 * Deliberately hashes the **working-tree bytes**, not git state: a file edited and not committed
 * is the file the model is about to read, and an index keyed on commits would call it fresh while
 * being wrong about it.
 */
export function fileHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, UID_HEX_LENGTH);
}

/** Repo-relative, forward slashes, no leading `./` - so Windows and POSIX agree on identity. */
export function normalisePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The kind suffix of a capture name: `name.definition.function` -> `function`.
 * Returns `unknown` for a capture that does not carry one, rather than throwing - a query file
 * is third-party input and an odd capture must not take down an index run.
 */
export function kindFromCapture(capture: string): string {
  const parts = capture.split('.');
  return parts.length >= 3 ? parts.slice(2).join('.') : 'unknown';
}
