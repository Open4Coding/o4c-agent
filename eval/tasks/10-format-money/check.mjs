import assert from 'node:assert/strict';
import { check, finish, load, read } from '../../lib/check.mjs';

const m = () => load('src/report.js');
const items = [{ name: 'tea', cents: 450 }, { name: 'cake', cents: 1205 }, { name: 'credit', cents: -2000 }];
await check('formatMoney', async () => {
  const { formatMoney } = await m();
  assert.equal(formatMoney(12345), '$123.45');
  assert.equal(formatMoney(-5), '-$0.05');
  assert.equal(formatMoney(0), '$0.00');
});
await check('invoiceLine unchanged', async () => {
  const { invoiceLine } = await m();
  assert.equal(invoiceLine(items[0]), 'tea: $4.50');
  assert.equal(invoiceLine(items[2]), 'credit: -$20.00');
});
await check('totalLine unchanged', async () => assert.equal((await m()).totalLine(items), 'Total: -$3.45'));
await check('refundLine unchanged', async () => assert.equal((await m()).refundLine(items[1]), 'Refund cake: -$12.05'));
await check('formatting written once', () => assert.equal(read('src/report.js').split('toFixed').length - 1, 1));
finish();
