import assert from 'node:assert/strict';
import { check, finish, original, python, read } from '../../lib/check.mjs';

await check('tests unchanged', () => assert.equal(read('test_shapes.py'), original(import.meta.url, 'test_shapes.py')));
await check('unittest passes', () => python('import unittest, sys\nr = unittest.main(module="test_shapes", exit=False, argv=["x"]).result\nsys.exit(0 if r.wasSuccessful() else 1)'));
await check('one base class holds the shared methods', () =>
  assert.equal(
    python('from shapes import Shape, Circle, Square, Rect\nprint(all(issubclass(c, Shape) for c in (Circle, Square, Rect)), "describe" in Shape.__dict__ and "scaled" in Shape.__dict__, any("describe" in c.__dict__ or "scaled" in c.__dict__ for c in (Circle, Square, Rect)))'),
    'True True False',
  ));
await check('written once', () => assert.equal(read('shapes.py').split('def describe').length - 1, 1));
finish();
