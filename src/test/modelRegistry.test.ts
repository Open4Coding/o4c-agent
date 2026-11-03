import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costOf, describeModel, modelEntry, parseModelArgs, readModels, setModelFields } from '../session/modelRegistry.js';
import { formatStats } from '../ui/statsReport.js';

test('parseModelArgs reads quoted and bare values, clears with key=, and refuses bad ones by name', () => {
  const ok = parseModelArgs('name="Qwen 27B" context=229376 think=med price_in=0.3 price_out=1.2 comment=');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.fields, { name: 'Qwen 27B', contextWindow: 229376, thinkLevel: 'med', price: { inputPerM: 0.3, outputPerM: 1.2 }, comment: undefined });
  const bad = parseModelArgs('context=lots think=max price_in=1 colour=red');
  assert.equal(bad.errors.length, 4);
  assert.match(bad.errors.join('\n'), /context=lots/);
  assert.match(bad.errors.join('\n'), /price_in and price_out together/);
  assert.match(bad.errors.join('\n'), /Unknown field "colour"/);
  assert.deepEqual(parseModelArgs('').errors, ['Nothing to set.']);
});

test('setModelFields merges per model, clears undefined fields, and modelEntry drops malformed values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-models-'));
  try {
    const file = join(dir, 'models.json');
    assert.equal(modelEntry('m', file), undefined);
    setModelFields('m', { name: 'M', contextWindow: 32768 }, file);
    setModelFields('other', { comment: 'keep me' }, file);
    setModelFields('m', { name: undefined, thinkLevel: 'low' }, file);
    assert.deepEqual(modelEntry('m', file), { contextWindow: 32768, thinkLevel: 'low' });
    assert.equal(readModels(file).other?.comment, 'keep me');
    writeFileSync(file, JSON.stringify({ m: { contextWindow: 'big', thinkLevel: 'max', price: { inputPerM: 1 } } }));
    assert.deepEqual(modelEntry('m', file), {});
    writeFileSync(file, 'not json');
    assert.deepEqual(readModels(file), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('costOf prices a spend per million tokens, and /stats shows it', () => {
  const entry = { price: { inputPerM: 0.5, outputPerM: 2 } };
  assert.equal(costOf({ input: 2_000_000, output: 500_000 }, entry), 2);
  assert.equal(costOf({ input: 1, output: 1 }, {}), undefined);
  const session = { input: 0, output: 0, requests: 0, activeMs: 0, cached: 0, processed: 0, prefillMs: 0, draftN: 0, draftAccepted: 0 };
  assert.match(formatStats({ session, turns: 0, toolCalls: 0, cost: { session: 0.0123, model: 'qwen' } }).join('\n'), /Cost: {5}about \$0\.0123 this session/);
});

test('describeModel shows the entry beside what was detected', () => {
  const text = describeModel('qwen', { name: 'Qwen', contextWindow: 100000 }, { provider: 'local', contextWindow: 229376, thinkCaps: '{"supportsBudget":true}' }).join('\n');
  assert.match(text, /Model qwen \(local\)/);
  assert.match(text, /name {12}Qwen/);
  assert.match(text, /context {9}100,000/);
  assert.match(text, /Detected:\n {2}context {9}229,376/);
  assert.match(text, /comment {9}-/);
});
