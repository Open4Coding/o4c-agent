import assert from 'node:assert/strict';
import { check, finish, python } from '../../lib/check.mjs';

await check('round trip 1..3999', () =>
  assert.equal(python('from roman import to_roman, from_roman\nprint(all(from_roman(to_roman(n)) == n for n in range(1, 4000)))'), 'True'));
await check('examples', () => assert.equal(python('from roman import from_roman\nprint(from_roman("MCMXCIV"), from_roman("XLII"))'), '1994 42'));
await check('invalid numerals raise', () =>
  assert.equal(
    python('from roman import from_roman\nbad = 0\nfor t in ["IIII", "VX", "IC", "ABC", "", "MMMM", "XM"]:\n    try:\n        from_roman(t)\n    except ValueError:\n        bad += 1\nprint(bad)'),
    '7',
  ));
finish();
