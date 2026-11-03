import type { DatabaseSync } from 'node:sqlite';
import type { PendingSpan } from '../agent/tracer.js';

/**
 * The `spans` table (plan 0006 K3, R06 #49): one row per traced turn, model call, tool call and
 * compaction, in history.db beside the tasks they belong to. Written once per turn by the loop's
 * `TurnTracer`; read by `/trace` (the last turn) and `/view-trace` (any recent one), and by
 * `/view-db` like every other table.
 *
 * Local only and never sent anywhere - an OTLP export, if it ever comes, is off and opt-in.
 */
export const SPANS_SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER,
  session_id TEXT NOT NULL,
  -- The turn span this one belongs to (its own id for a turn).
  turn_id INTEGER,
  -- turn, model, tool or compaction
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  dur_ms REAL NOT NULL,
  -- JSON: prompt_tokens, cached_tokens, processed_tokens, gen_tokens, tok_s (model); bytes, error (tool)
  attrs TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS idx_spans_turn ON spans(turn_id);
CREATE INDEX IF NOT EXISTS idx_spans_kind ON spans(kind, id);
`;

/** Spans older than this are pruned when the store opens. */
export const SPAN_RETENTION_DAYS = 14;

export interface SpanRow {
  id: number;
  parent_id: number | null;
  session_id: string;
  turn_id: number | null;
  kind: string;
  name: string;
  started_at: number;
  dur_ms: number;
  attrs: string;
}

export class SpanStore {
  constructor(private readonly db: DatabaseSync) {}

  /** One finished turn, in one transaction. Parents are mapped from the tracer's keys to row ids. */
  writeTurn(sessionId: string, spans: readonly PendingSpan[]): void {
    const insert = this.db.prepare(
      `INSERT INTO spans (parent_id, session_id, turn_id, kind, name, started_at, dur_ms, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const setTurn = this.db.prepare(`UPDATE spans SET turn_id = ? WHERE id = ?`);
    const ids = new Map<number, number>();
    this.db.exec('BEGIN');
    try {
      let turnId: number | null = null;
      // Parents before children: a span's parent is always started first, so key order is enough.
      for (const s of [...spans].sort((a, b) => a.key - b.key)) {
        const parent = s.parent === undefined ? null : (ids.get(s.parent) ?? null);
        const id: number = Number(insert.run(parent, sessionId, turnId, s.kind, s.name, s.startedAt, s.durMs, JSON.stringify(s.attrs)).lastInsertRowid);
        ids.set(s.key, id);
        if (s.kind === 'turn' && turnId === null) {
          turnId = id;
          setTurn.run(id, id);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  prune(now = Date.now(), days = SPAN_RETENTION_DAYS): number {
    return Number(this.db.prepare(`DELETE FROM spans WHERE started_at < ?`).run(now - days * 86_400_000).changes);
  }
}

/** The newest turns, newest first - `/view-trace`'s list. */
export function recentTurns(db: DatabaseSync, limit = 50): SpanRow[] {
  return db.prepare(`SELECT * FROM spans WHERE kind = 'turn' ORDER BY id DESC LIMIT ?`).all(limit) as unknown as SpanRow[];
}

/** One turn and everything under it, in start order. */
export function turnSpans(db: DatabaseSync, turnId: number): SpanRow[] {
  return db.prepare(`SELECT * FROM spans WHERE turn_id = ? ORDER BY started_at, id`).all(turnId) as unknown as SpanRow[];
}

function attrsOf(row: SpanRow): Record<string, unknown> {
  try {
    return JSON.parse(row.attrs) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const secs = (ms: number) => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/** A model span's generation time: generated tokens over the server's own decode rate. */
function generationMs(attrs: Record<string, unknown>, durMs: number): number | undefined {
  const gen = num(attrs.gen_tokens);
  const rate = num(attrs.tok_s);
  if (gen === undefined || !rate) return undefined;
  return Math.min(durMs, (gen / rate) * 1000);
}

function detail(row: SpanRow): string {
  const a = attrsOf(row);
  if (row.kind === 'model') {
    const parts: string[] = [];
    const prompt = num(a.prompt_tokens);
    if (prompt !== undefined) {
      const cached = num(a.cached_tokens);
      parts.push(`prompt ${prompt.toLocaleString('en-US')}${cached !== undefined ? ` (cached ${cached.toLocaleString('en-US')})` : ''}`);
    }
    const gen = num(a.gen_tokens);
    const rate = num(a.tok_s);
    if (gen !== undefined) parts.push(`gen ${gen.toLocaleString('en-US')}${rate ? ` @ ${rate.toFixed(1)} tok/s` : ''}`);
    if (typeof a.error === 'string') parts.push(`error: ${a.error}`);
    return parts.join(' · ');
  }
  if (row.kind === 'tool') {
    const bytes = num(a.bytes);
    return [bytes !== undefined ? `${bytes.toLocaleString('en-US')} chars` : '', a.error ? 'error' : ''].filter(Boolean).join(' · ');
  }
  return typeof a.error === 'string' ? `error: ${a.error}` : '';
}

export interface TimeShares {
  total: number;
  prefill: number;
  generation: number;
  /** Model time with no decode rate to split it by. */
  model: number;
  tools: number;
  compaction: number;
  other: number;
}

/** How the turn's time divides between kinds of work - "where did the time go". */
export function timeShares(spans: readonly SpanRow[]): TimeShares {
  const turn = spans.find((s) => s.kind === 'turn');
  const total = turn?.dur_ms ?? spans.reduce((t, s) => t + s.dur_ms, 0);
  const t: TimeShares = { total, prefill: 0, generation: 0, model: 0, tools: 0, compaction: 0, other: 0 };
  for (const s of spans) {
    if (s.kind === 'model') {
      const gen = generationMs(attrsOf(s), s.dur_ms);
      if (gen === undefined) t.model += s.dur_ms;
      else {
        t.generation += gen;
        t.prefill += s.dur_ms - gen;
      }
    } else if (s.kind === 'tool') t.tools += s.dur_ms;
    else if (s.kind === 'compaction') t.compaction += s.dur_ms;
  }
  t.other = Math.max(0, total - t.prefill - t.generation - t.model - t.tools - t.compaction);
  return t;
}

/** A turn as an indented timeline with a "where the time went" line - what `/trace` shows. */
export function formatTrace(spans: readonly SpanRow[]): string[] {
  const turn = spans.find((s) => s.kind === 'turn');
  if (!turn) return ['No trace for that turn.'];
  const depth = new Map<number, number>([[turn.id, 0]]);
  const lines = [`Turn "${turn.name}" - ${secs(turn.dur_ms)}, ${new Date(turn.started_at).toLocaleString()}`];
  for (const s of spans) {
    if (s === turn) continue;
    const d = (s.parent_id !== null ? (depth.get(s.parent_id) ?? 0) : 0) + 1;
    depth.set(s.id, d);
    const offset = `+${((s.started_at - turn.started_at) / 1000).toFixed(1)}s`;
    const label = s.kind === 'tool' ? `tool ${s.name}` : s.kind;
    const extra = detail(s);
    lines.push(`${'  '.repeat(d)}${offset.padEnd(8)} ${label.padEnd(18)} ${secs(s.dur_ms).padStart(6)}${extra ? `  ${extra}` : ''}`);
  }
  const t = timeShares(spans);
  const pct = (ms: number) => `${t.total > 0 ? Math.round((ms / t.total) * 100) : 0}%`;
  const parts: string[] = [];
  if (t.prefill + t.generation > 0) parts.push(`model prefill ${pct(t.prefill)}`, `generation ${pct(t.generation)}`);
  if (t.model > 0) parts.push(`model ${pct(t.model)}${t.prefill + t.generation > 0 ? ' (no rate reported)' : ''}`);
  parts.push(`tools ${pct(t.tools)}`, `compaction ${pct(t.compaction)}`, `other ${pct(t.other)}`);
  lines.push(`Where the time went: ${parts.join(' · ')}`);
  if (t.prefill + t.generation > 0) lines.push('(Prefill and generation are split by the generated tokens over the server-reported decode rate.)');
  return lines;
}

/** One `/view-trace` list row: when, how long, how many calls, what was asked. */
export function turnSummary(db: DatabaseSync, turn: SpanRow): string {
  const counts = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM spans WHERE turn_id = ? AND kind != 'turn' GROUP BY kind`)
    .all(turn.id) as Array<{ kind: string; n: number }>;
  const of = (k: string) => counts.find((c) => c.kind === k)?.n ?? 0;
  const compactions = of('compaction');
  return (
    `${new Date(turn.started_at).toLocaleString()} · ${secs(turn.dur_ms)} · ${of('model')} model, ${of('tool')} tool` +
    `${compactions ? `, ${compactions} compaction` : ''} · ${turn.name}`
  );
}
