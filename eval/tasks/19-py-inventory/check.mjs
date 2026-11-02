import assert from 'node:assert/strict';
import { check, finish, python } from '../../lib/check.mjs';

const pre = 'from inventory import Inventory\ninv = Inventory()\ninv.add("apple", 5)\n';
await check('partial remove', () => assert.equal(python(pre + 'inv.remove("apple", 2)\nprint(inv.quantity("apple"))'), '3'));
await check('reaching 0 deletes', () => assert.equal(python(pre + 'inv.remove("apple", 5)\nprint("apple" in inv.items)'), 'False'));
await check('too many raises, stock unchanged', () =>
  assert.equal(python(pre + 'try:\n    inv.remove("apple", 6)\n    print("no error")\nexcept ValueError:\n    print(inv.quantity("apple"))'), '5'));
await check('unknown item raises', () =>
  assert.equal(python(pre + 'try:\n    inv.remove("pear", 1)\n    print("no error")\nexcept ValueError:\n    print("pear" in inv.items)'), 'False'));
finish();
