import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ChoiceRow } from './planPicker.js';

/**
 * `/view-db`: a read-only look into any of the project's databases (`.o4c/db/*.db`) - database,
 * then table, then a row in full. The standing rule (CLAUDE.md, 2026-11-01) is that every database
 * and table can be looked into from o4c; this browser covers each one generically, including any
 * added later, so a new table is viewable the day it lands. Purpose-built views (`/view-plan`)
 * stay for the cases where raw rows are not enough.
 *
 * Opens its own read-only connection per look and closes it again: the stores keep theirs, and WAL
 * lets a reader see their committed writes without blocking them.
 */

/** Newest rows listed per table; the title says when there are more. */
export const DB_BROWSER_ROWS = 25;
/** A single value shown in a row's detail is cut here - an entry can hold a whole file. */
export const DB_BROWSER_VALUE_CHARS = 2000;
const LABEL_CHARS = 110;

/** FTS5 keeps its index in shadow tables named after the virtual table; they are noise here. */
const FTS_SHADOW = /_(data|idx|content|docsize|config)$/;

export function listDatabases(dbDir: string | undefined): string[] {
  if (!dbDir) return [];
  try {
    return readdirSync(dbDir).filter((name) => name.endsWith('.db')).sort();
  } catch {
    return [];
  }
}

export function openReadOnly(dbDir: string, name: string): DatabaseSync {
  return new DatabaseSync(join(dbDir, name), { readOnly: true });
}

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT count(*) AS n FROM ${quoted(table)}`).get() as { n: number }).n);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as Array<{ name: string }>).map((c) => c.name);
}

export function tableRows(db: DatabaseSync): ChoiceRow[] {
  const tables = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; type: string }>;
  const names = new Set(tables.map((t) => t.name));
  return tables
    .filter((t) => !(FTS_SHADOW.test(t.name) && names.has(t.name.replace(FTS_SHADOW, ''))))
    .map((t) => ({
      key: t.name,
      label: oneLine(`${t.name}${t.type === 'view' ? ' (view)' : ''} - ${count(db, t.name)} rows - ${columns(db, t.name).join(', ')}`),
    }));
}

function oneLine(text: string, max = LABEL_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function shown(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Uint8Array) return `<blob, ${value.byteLength} bytes>`;
  return String(value);
}

/** Newest first by rowid; a view or WITHOUT ROWID table has none, so those come in stored order. */
function fetchRows(db: DatabaseSync, table: string): Array<Record<string, unknown>> {
  try {
    return db.prepare(`SELECT rowid AS __rowid, * FROM ${quoted(table)} ORDER BY rowid DESC LIMIT ${DB_BROWSER_ROWS}`).all() as Array<Record<string, unknown>>;
  } catch {
    return db.prepare(`SELECT * FROM ${quoted(table)} LIMIT ${DB_BROWSER_ROWS}`).all() as Array<Record<string, unknown>>;
  }
}

export function rowsTitle(db: DatabaseSync, table: string): string {
  const total = count(db, table);
  const more = total > DB_BROWSER_ROWS ? `newest ${DB_BROWSER_ROWS} of ${total}` : `${total} rows`;
  return `${table} - ${more} (↑/↓ to choose, Enter to open, Esc to cancel):`;
}

/** "Schema" first, then one row per record: its rowid and its values, flattened onto one line. */
export function recordRows(db: DatabaseSync, table: string): ChoiceRow[] {
  const rows = fetchRows(db, table).map((row, index) => {
    const { __rowid, ...rest } = row;
    const key = __rowid === undefined ? `#${index}` : String(__rowid);
    const values = Object.entries(rest).map(([column, value]) => `${column}=${shown(value)}`);
    return { key, label: oneLine(`${__rowid === undefined ? '' : `#${__rowid} `}${values.join(', ')}`) };
  });
  return [{ key: '__schema', label: 'Schema - the table\'s columns and how it was created' }, ...rows];
}

export function schemaDetail(db: DatabaseSync, table: string): string[] {
  const sql = (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql?: string } | undefined)?.sql;
  return [`${table} - ${count(db, table)} rows`, ...(sql ?? '(no CREATE statement)').split('\n')];
}

/** One record in full: every column on its own line, long or multi-line values indented under it. */
export function recordDetail(db: DatabaseSync, table: string, key: string): string[] {
  const row = key.startsWith('#')
    ? fetchRows(db, table)[Number(key.slice(1))]
    : (db.prepare(`SELECT * FROM ${quoted(table)} WHERE rowid = ?`).get(Number(key)) as Record<string, unknown> | undefined);
  if (!row) return [`${table}: that row is gone.`];
  const lines = [`${table} ${key.startsWith('#') ? 'row' : `#${key}`}`];
  for (const [column, value] of Object.entries(row)) {
    if (column === '__rowid') continue;
    let text = shown(value);
    if (text.length > DB_BROWSER_VALUE_CHARS) text = `${text.slice(0, DB_BROWSER_VALUE_CHARS)}... (${text.length} chars, cut)`;
    if (text.includes('\n') || text.length > 80) lines.push(`${column}:`, ...text.split('\n').map((line) => `  ${line}`));
    else lines.push(`${column}: ${text}`);
  }
  return lines;
}
