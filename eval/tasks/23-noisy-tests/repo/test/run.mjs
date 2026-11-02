// A tiny verbose test runner: prints every case. Run: node test/run.mjs
import { addTax, format, split } from '../src/money.js';

let failed = 0;
let n = 0;
function eq(name, actual, expected) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'not ok'} ${n} - ${name}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
}

for (let c = 0; c < 200; c++) eq(`format ${c}`, format(c * 100), `$${c}.00`);
for (let c = 0; c < 150; c++) eq(`addTax zero rate ${c}`, addTax(c, 0), c);
eq('addTax rounds half up', addTax(1005, 0.2), 1206);
for (let p = 1; p <= 40; p++) eq(`split even ${p}`, split(p * 10, p).reduce((a, b) => a + b, 0), p * 10);
eq('split uneven', split(100, 3), [34, 33, 33]);
for (let c = 0; c < 30; c++) eq(`format cents ${c}`, format(c), `$0.${String(c).padStart(2, '0')}`);
console.log(`\n${n - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
