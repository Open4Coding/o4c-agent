import type { DatabaseSync } from 'node:sqlite';

/**
 * Plans and their checklists, stored in `history.db` - brief `0005.PlansInSqlite`, checklist P1.
 *
 * SQLite is the source of truth (brief, Q1); the `.o4c/plans/*.md` files are only exports. A
 * checklist is rows, not a file, so ticking an item is an update rather than the model rewriting a
 * document, each item can name the history tasks that worked on it, and plans are searchable.
 *
 * Lives beside `InfiniteContextStore` on the same connection rather than inside it: same file
 * (one writer per database is a WAL rule, and plans are written mid-turn like tasks are), separate
 * module so the task store does not keep growing. `InfiniteContextStore.plans()` hands one out.
 *
 * Rules that must hold whoever edits a plan - the model through `update_plan` or the user through
 * `/view-plan` - are enforced here, not in either caller: `done` needs a verification note
 * (brief, Q5), and a session has at most one active plan (brief, Q7).
 */

export const PLANS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'plan',
  status TEXT NOT NULL DEFAULT 'open',
  goal TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  active_session TEXT,
  session_id TEXT,
  task_id INTEGER,
  source_file TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_active ON plans(active_session) WHERE active_session IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  checks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  notes TEXT NOT NULL DEFAULT '',
  verification TEXT NOT NULL DEFAULT '',
  done_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id, position);

CREATE TABLE IF NOT EXISTS plan_item_tasks (
  item_id INTEGER NOT NULL REFERENCES plan_items(id),
  task_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, task_id)
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS plans_fts USING fts5(
  name, goal, summary, body, content='plans', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS plans_ai AFTER INSERT ON plans BEGIN
  INSERT INTO plans_fts(rowid, name, goal, summary, body) VALUES (new.id, new.name, new.goal, new.summary, new.body);
END;
CREATE TRIGGER IF NOT EXISTS plans_ad AFTER DELETE ON plans BEGIN
  INSERT INTO plans_fts(plans_fts, rowid, name, goal, summary, body)
  VALUES ('delete', old.id, old.name, old.goal, old.summary, old.body);
END;
CREATE TRIGGER IF NOT EXISTS plans_au AFTER UPDATE OF name, goal, summary, body ON plans BEGIN
  INSERT INTO plans_fts(plans_fts, rowid, name, goal, summary, body)
  VALUES ('delete', old.id, old.name, old.goal, old.summary, old.body);
  INSERT INTO plans_fts(rowid, name, goal, summary, body) VALUES (new.id, new.name, new.goal, new.summary, new.body);
END;
`;

export type PlanKind = 'plan' | 'ultraplan';
/** `open` while being worked, `done` when every item is done or skipped and the user closes it,
 * `dropped` when abandoned. Whether it is the one being worked *now* is `active_session`. */
export type PlanStatus = 'open' | 'done' | 'dropped';
export type PlanItemStatus = 'open' | 'doing' | 'done' | 'skipped';

export interface PlanRow {
  id: number;
  /** Shown as `0005`, like the file convention; unique per project. */
  number: number;
  name: string;
  kind: PlanKind;
  status: PlanStatus;
  /** What was asked for - the `/plan <goal>` text. */
  goal: string;
  /** A few lines: the default `/view-plan` shows this above the checklist (brief, Q3). */
  summary: string;
  /** The whole plan text: the full view and the `.plan.md` export. */
  body: string;
  /** The session this plan is active in, if any - at most one per session (brief, Q7). */
  active_session: string | null;
  session_id: string | null;
  task_id: number | null;
  /** The `.o4c/plans/` file it was imported from (brief, Q2), so a second import skips it. */
  source_file: string | null;
  created_at: number;
  updated_at: number;
}

export interface PlanItemRow {
  id: number;
  plan_id: number;
  /** 1-based order within the plan, kept dense: item 3 is always `position = 3`. */
  position: number;
  text: string;
  /** The item's sub-checks, one per line - shown below the current item. */
  checks: string;
  status: PlanItemStatus;
  notes: string;
  /** How `done` was verified (what was run, the result). Required for `done` (brief, Q5). */
  verification: string;
  done_at: number | null;
}

export interface NewPlanItem {
  text: string;
  checks?: string;
}

export interface NewPlan {
  name: string;
  kind?: PlanKind;
  goal?: string;
  summary?: string;
  body?: string;
  items?: readonly NewPlanItem[];
  session_id?: string;
  task_id?: number;
  source_file?: string;
  /** Imports keep the file's number; new plans take the next free one. */
  number?: number;
}

/** A rule a plan edit broke - the message is meant to be shown as-is, to the model or the user. */
export class PlanRuleError extends Error {}

export class PlanStore {
  constructor(private readonly db: DatabaseSync) {}

  createPlan(plan: NewPlan, now = Date.now()): PlanRow {
    const number = plan.number ?? this.nextNumber();
    if (this.getPlanByNumber(number)) throw new PlanRuleError(`Plan ${formatPlanNo(number)} already exists.`);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO plans (number, name, kind, goal, summary, body, session_id, task_id, source_file, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          number,
          plan.name.trim(),
          plan.kind ?? 'plan',
          plan.goal ?? '',
          plan.summary ?? '',
          plan.body ?? '',
          plan.session_id ?? null,
          plan.task_id ?? null,
          plan.source_file ?? null,
          now,
          now,
        );
      const id = Number(result.lastInsertRowid);
      const insert = this.db.prepare(`INSERT INTO plan_items (plan_id, position, text, checks) VALUES (?, ?, ?, ?)`);
      (plan.items ?? []).forEach((item, i) => insert.run(id, i + 1, item.text.trim(), item.checks?.trim() ?? ''));
      return this.getPlan(id)!;
    });
  }

  nextNumber(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(number), 0) AS n FROM plans`).get() as { n: number };
    return row.n + 1;
  }

  getPlan(id: number): PlanRow | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE id = ?`).get(id) as PlanRow | undefined;
  }

  getPlanByNumber(number: number): PlanRow | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE number = ?`).get(number) as PlanRow | undefined;
  }

  getPlanBySourceFile(file: string): PlanRow | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE source_file = ?`).get(file) as PlanRow | undefined;
  }

  /** Newest first - the order the `/view-plan` picker shows. */
  listPlans(): PlanRow[] {
    return this.db.prepare(`SELECT * FROM plans ORDER BY updated_at DESC, number DESC`).all() as unknown as PlanRow[];
  }

  /** FTS5 over name, goal, summary and body. `match` must already be a safe MATCH expression. */
  searchPlans(match: string, limit = 20): PlanRow[] {
    return this.db
      .prepare(
        `SELECT p.* FROM plans_fts JOIN plans p ON p.id = plans_fts.rowid
         WHERE plans_fts MATCH ? ORDER BY bm25(plans_fts, 4.0, 2.0, 1.0, 1.0) LIMIT ?`,
      )
      .all(match, limit) as unknown as PlanRow[];
  }

  updatePlan(id: number, fields: Partial<Pick<PlanRow, 'name' | 'goal' | 'summary' | 'body' | 'status'>>, now = Date.now()): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE plans SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]!), now, id);
  }

  items(planId: number): PlanItemRow[] {
    return this.db
      .prepare(`SELECT * FROM plan_items WHERE plan_id = ? ORDER BY position`)
      .all(planId) as unknown as PlanItemRow[];
  }

  getItem(planId: number, position: number): PlanItemRow | undefined {
    return this.db
      .prepare(`SELECT * FROM plan_items WHERE plan_id = ? AND position = ?`)
      .get(planId, position) as PlanItemRow | undefined;
  }

  /** The item being worked: the first `doing`, else the first `open`; none when all are finished. */
  currentItem(planId: number): PlanItemRow | undefined {
    const items = this.items(planId);
    return items.find((i) => i.status === 'doing') ?? items.find((i) => i.status === 'open');
  }

  /** Adds an item after `afterPosition` (0 = first; omitted = last). Returns its position. */
  addItem(planId: number, item: NewPlanItem, afterPosition?: number): number {
    const count = this.items(planId).length;
    const position = Math.min(Math.max(afterPosition ?? count, 0), count) + 1;
    this.transaction(() => {
      this.shift(planId, position, 1);
      this.db
        .prepare(`INSERT INTO plan_items (plan_id, position, text, checks) VALUES (?, ?, ?, ?)`)
        .run(planId, position, item.text.trim(), item.checks?.trim() ?? '');
      this.touch(planId);
    });
    return position;
  }

  removeItem(planId: number, position: number): void {
    const item = this.requireItem(planId, position);
    this.transaction(() => {
      this.db.prepare(`DELETE FROM plan_item_tasks WHERE item_id = ?`).run(item.id);
      this.db.prepare(`DELETE FROM plan_items WHERE id = ?`).run(item.id);
      this.shift(planId, position + 1, -1);
      this.touch(planId);
    });
  }

  /** Moves the item at `from` to position `to`, the others closing up around it. */
  moveItem(planId: number, from: number, to: number): void {
    const item = this.requireItem(planId, from);
    const count = this.items(planId).length;
    const target = Math.min(Math.max(to, 1), count);
    if (target === from) return;
    this.transaction(() => {
      // Parked at 0 while the rest shift, so no two rows ever share a position mid-move.
      this.db.prepare(`UPDATE plan_items SET position = 0 WHERE id = ?`).run(item.id);
      if (target > from) {
        this.db
          .prepare(`UPDATE plan_items SET position = position - 1 WHERE plan_id = ? AND position > ? AND position <= ?`)
          .run(planId, from, target);
      } else {
        this.db
          .prepare(`UPDATE plan_items SET position = position + 1 WHERE plan_id = ? AND position >= ? AND position < ?`)
          .run(planId, target, from);
      }
      this.db.prepare(`UPDATE plan_items SET position = ? WHERE id = ?`).run(target, item.id);
      this.touch(planId);
    });
  }

  rewordItem(planId: number, position: number, text: string, checks?: string): void {
    const item = this.requireItem(planId, position);
    if (!text.trim()) throw new PlanRuleError('An item needs text.');
    this.db
      .prepare(`UPDATE plan_items SET text = ?, checks = ? WHERE id = ?`)
      .run(text.trim(), checks === undefined ? item.checks : checks.trim(), item.id);
    this.touch(planId);
  }

  /**
   * Moves an item to `status`. `done` needs a verification note - given here or already on the
   * item - so an Auto-mode run can be audited afterwards (brief, Q5). `doing` makes this the one
   * current item: any other `doing` item in the plan goes back to `open`.
   */
  setItemStatus(planId: number, position: number, status: PlanItemStatus, detail: { verification?: string; note?: string } = {}, now = Date.now()): void {
    const item = this.requireItem(planId, position);
    const verification = detail.verification?.trim() || item.verification;
    if (status === 'done' && !verification) {
      throw new PlanRuleError(`Item ${position} cannot be marked done without a verification note: say what was run or checked, and the result.`);
    }
    this.transaction(() => {
      if (status === 'doing') {
        this.db.prepare(`UPDATE plan_items SET status = 'open' WHERE plan_id = ? AND status = 'doing' AND id <> ?`).run(planId, item.id);
      }
      this.db
        .prepare(`UPDATE plan_items SET status = ?, verification = ?, done_at = ? WHERE id = ?`)
        .run(status, verification, status === 'done' ? now : null, item.id);
      if (detail.note?.trim()) this.appendNote(item.id, detail.note);
      this.touch(planId, now);
    });
  }

  addItemNote(planId: number, position: number, note: string): void {
    this.appendNote(this.requireItem(planId, position).id, note);
    this.touch(planId);
  }

  /** Records that a history task worked on this item. */
  linkTask(planId: number, position: number, taskId: number): void {
    const item = this.requireItem(planId, position);
    this.db.prepare(`INSERT INTO plan_item_tasks (item_id, task_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(item.id, taskId);
  }

  itemTasks(itemId: number): number[] {
    return (this.db.prepare(`SELECT task_id FROM plan_item_tasks WHERE item_id = ? ORDER BY task_id`).all(itemId) as { task_id: number }[]).map(
      (r) => r.task_id,
    );
  }

  /** Makes `planId` the session's one active plan, parking whichever was active before. */
  activate(planId: number, sessionId: string): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE plans SET active_session = NULL WHERE active_session = ?`).run(sessionId);
      this.db.prepare(`UPDATE plans SET active_session = ? WHERE id = ?`).run(sessionId, planId);
    });
  }

  park(planId: number): void {
    this.db.prepare(`UPDATE plans SET active_session = NULL WHERE id = ?`).run(planId);
  }

  activePlan(sessionId: string): PlanRow | undefined {
    return this.db.prepare(`SELECT * FROM plans WHERE active_session = ?`).get(sessionId) as PlanRow | undefined;
  }

  private appendNote(itemId: number, note: string): void {
    const line = note.trim();
    if (!line) return;
    const row = this.db.prepare(`SELECT notes FROM plan_items WHERE id = ?`).get(itemId) as { notes: string };
    this.db.prepare(`UPDATE plan_items SET notes = ? WHERE id = ?`).run(row.notes ? `${row.notes}\n${line}` : line, itemId);
  }

  private requireItem(planId: number, position: number): PlanItemRow {
    const item = this.getItem(planId, position);
    if (!item) {
      const count = this.items(planId).length;
      throw new PlanRuleError(`There is no item ${position}; the plan has ${count} item${count === 1 ? '' : 's'}.`);
    }
    return item;
  }

  /** Shifts every item at or after `from` by `delta`, in the order that never collides. */
  private shift(planId: number, from: number, delta: 1 | -1): void {
    const rows = this.db
      .prepare(`SELECT id, position FROM plan_items WHERE plan_id = ? AND position >= ? ORDER BY position ${delta > 0 ? 'DESC' : 'ASC'}`)
      .all(planId, from) as { id: number; position: number }[];
    const update = this.db.prepare(`UPDATE plan_items SET position = ? WHERE id = ?`);
    for (const row of rows) update.run(row.position + delta, row.id);
  }

  private touch(planId: number, now = Date.now()): void {
    this.db.prepare(`UPDATE plans SET updated_at = ? WHERE id = ?`).run(now, planId);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** `5` -> `0005`, the number as plans are named everywhere. */
export function formatPlanNo(number: number): string {
  return String(number).padStart(4, '0');
}
