import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.js';

test('lower case and hyphens', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('runs collapse', () => assert.equal(slugify('a  --  b'), 'a-b'));
test('no edge hyphens', () => assert.equal(slugify('  !hi!  '), 'hi'));
test('accents stripped', () => assert.equal(slugify('Crème Brûlée'), 'creme-brulee'));
