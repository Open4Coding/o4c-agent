import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InfiniteContextStore, INFINITE_CONTEXT_DB_FILENAME } from '../session/infiniteContextStore.js';
import { DB_BROWSER_ROWS, listDatabases, openReadOnly, recordDetail, recordRows, rowsTitle, schemaDetail, tableRows } from '../ui/dbBrowser.js';

/** `/view-db`: the generic read-only look into every `.o4c/db` database and table. */

test('databases, tables (FTS shadow tables left out), newest rows first, a row and the schema in full', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-dbbrowser-test-'));
  const store = new InfiniteContextStore(join(dir, INFINITE_CONTEXT_DB_FILENAME));
  try {
    await writeFile(join(dir, 'notes.txt'), 'not a database');
    const plans = store.plans();
    plans.createPlan({ name: 'First', summary: 'line one\nline two', items: [{ text: 'a' }] });
    plans.createPlan({ name: 'Second' });
    assert.deepEqual(listDatabases(dir), ['history.db']);
    assert.deepEqual(listDatabases(undefined), []);

    const db = openReadOnly(dir, 'history.db');
    try {
      const tables = tableRows(db).map((r) => r.key);
      assert.ok(tables.includes('plans') && tables.includes('plans_fts'), tables.join());
      assert.ok(!tables.some((t) => /^plans_fts_(data|idx|content|docsize|config)$/.test(t)), 'no FTS shadow tables');
      assert.match(tableRows(db).find((r) => r.key === 'plans')!.label, /^plans - 2 rows - id, /);

      assert.equal(rowsTitle(db, 'plans'), 'plans - 2 rows (↑/↓ to choose, Enter to open, Esc to cancel):');
      const rows = recordRows(db, 'plans');
      assert.equal(rows[0]!.key, '__schema');
      assert.deepEqual(rows.slice(1).map((r) => r.key), ['2', '1'], 'newest first');
      assert.match(rows[2]!.label, /^#1 .*name=First.*summary=line one line two/);

      const detail = recordDetail(db, 'plans', '1');
      assert.equal(detail[0], 'plans #1');
      assert.ok(detail.includes('name: First'));
      assert.ok(detail.includes('summary:') && detail.includes('  line two'), 'multi-line values indented under the column');
      assert.deepEqual(recordDetail(db, 'plans', '99'), ['plans: that row is gone.']);
      assert.match(schemaDetail(db, 'plans').join('\n'), /^plans - 2 rows\nCREATE TABLE/);
    } finally {
      db.close();
    }
    assert.ok(DB_BROWSER_ROWS >= 10);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
