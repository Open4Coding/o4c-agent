import { extractTagsForPath } from '../graph/tags.js';
import { languageForPath } from '../graph/languages.js';
import { contentHash, entityUid, kindFromCapture } from '../graph/entityId.js';
import type { TaskEntityRow } from './infiniteContextStore.js';

/**
 * Which definitions a write changed - the history side of the Code Graph link (brief 0004, Q9;
 * checklist A4).
 *
 * Identity is the graph's own (`entityUid` over language, path, kind and name, exactly as
 * `GraphStore.indexFile` computes it), so a `task_entities` row joins straight onto `defs`. The
 * fingerprint is **not** the graph's: the graph hashes only a definition's declaring line, because
 * a tag carries no node range yet, so a change inside a function body is invisible to it. Here a
 * definition's span is its own line up to the line before the next definition, which does see a
 * body change. It is an approximation - a definition nested inside another splits its parent's
 * span - but it errs toward reporting a change, never toward hiding one.
 */

/** One definition in one version of a file. */
export interface EntitySnapshot {
  readonly uid: string;
  readonly name: string;
  readonly kind: string;
  readonly hash: string;
}

/**
 * The definitions in `source`, or `undefined` when its language is not charted (or its grammar
 * will not load) - the third state the graph keeps too, which the caller records as a file-level
 * link only.
 */
export async function snapshotEntities(source: string, repoPath: string): Promise<EntitySnapshot[] | undefined> {
  const language = languageForPath(repoPath);
  if (!language) return undefined;
  let tags;
  try {
    tags = await extractTagsForPath(source, repoPath);
  } catch {
    return undefined;
  }
  if (!tags) return undefined;

  const defs = tags.filter((t) => t.kind === 'def').sort((a, b) => a.line - b.line);
  const lines = source.split('\n');
  return defs.map((def) => {
    const next = defs.find((d) => d.line > def.line);
    const end = next ? next.line - 1 : lines.length;
    const kind = kindFromCapture(def.capture);
    // The definition's own name is blanked before fingerprinting: it sits on the declaring line, so
    // without this a renamed function never fingerprints the same and `diffEntities` reports it as
    // deleted + added. Found live on 2026-10-31 (greetUser -> welcomeUser) - the unit test had
    // supplied equal hashes directly and so never exercised it.
    const span = lines.slice(def.line - 1, end).join('\n');
    return {
      uid: entityUid({ language: language.id, path: repoPath, kind, name: def.name }),
      name: def.name,
      kind,
      hash: contentHash(span.replace(new RegExp(`\\b${escapeRegExp(def.name)}\\b`, 'g'), '\u0000')),
    };
  });
}

/** A change to one definition, before it is filed under a task. */
export type EntityChange = Omit<TaskEntityRow, 'task_id' | 'path'>;

/**
 * Compares two snapshots. Same identity with a new fingerprint is **modified**; an identity that
 * vanished while one with the same fingerprint appeared is **renamed** (filed under the new
 * identity - the equal fingerprint is what lets a later query follow it back); anything else that
 * appeared or vanished is **added** or **deleted**.
 */
export function diffEntities(before: readonly EntitySnapshot[], after: readonly EntitySnapshot[]): EntityChange[] {
  const was = new Map(before.map((e) => [e.uid, e]));
  const now = new Map(after.map((e) => [e.uid, e]));
  const changes: EntityChange[] = [];

  for (const [uid, entity] of now) {
    const old = was.get(uid);
    if (old && old.hash !== entity.hash) {
      changes.push({ entity_uid: uid, name: entity.name, kind: entity.kind, change: 'modified', hash_before: old.hash, hash_after: entity.hash });
    }
  }

  const gone = [...was.values()].filter((e) => !now.has(e.uid));
  const appeared = [...now.values()].filter((e) => !was.has(e.uid));
  for (const entity of appeared) {
    const source = gone.findIndex((g) => g.hash === entity.hash);
    if (source >= 0) {
      gone.splice(source, 1);
      changes.push({ entity_uid: entity.uid, name: entity.name, kind: entity.kind, change: 'renamed', hash_before: entity.hash, hash_after: entity.hash });
    } else {
      changes.push({ entity_uid: entity.uid, name: entity.name, kind: entity.kind, change: 'added', hash_before: null, hash_after: entity.hash });
    }
  }
  for (const entity of gone) {
    changes.push({ entity_uid: entity.uid, name: entity.name, kind: entity.kind, change: 'deleted', hash_before: entity.hash, hash_after: null });
  }
  return changes;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
