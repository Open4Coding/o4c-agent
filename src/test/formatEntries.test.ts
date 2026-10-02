import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiResponseEntry,
  aiThinkEntry,
  aiToolCallEntry,
  aiToolCallResponseEntry,
  userInputEntry,
  type ContextEntry,
} from '../agent/contextEntry.js';
import {
  MAX_VISIBLE_TOOL_EVENTS_PER_TURN,
  NARRATION_PREVIEW_CHARS,
  FULL_ENTRY_CAP_CHARS,
  THINK_PREVIEW_CHARS,
  TOOL_CALL_PREVIEW_CHARS,
  formatEntries,
  parseSessionView,
} from '../ui/formatEntries.js';

function toolPair(id: string, name: string, output: string): ContextEntry[] {
  return [aiToolCallEntry({ id, name, input: { n: id } }, false), aiToolCallResponseEntry(id, output, false)];
}

test('formatEntries repaints a turn in live order: user, [think], tool lines, final answer', () => {
  const lines = formatEntries([
    userInputEntry('build it'),
    aiThinkEntry('plan the work'),
    aiResponseEntry('starting now'),
    ...toolPair('t1', 'run_shell', 'ok'),
    aiResponseEntry('All done.'),
  ]);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.text]),
    [
      ['user', '> build it'],
      ['system', '[think] plan the work'],
      ['system', 'starting now'],
      ['tool_call', '[tool] run_shell({"n":"t1"})'],
      ['tool_result', '[result] ok'],
      ['final', 'All done.'],
    ],
  );
});

test('formatEntries collapses tool events past the per-turn limit into one running [scan] line', () => {
  const entries = [userInputEntry('go')];
  for (let i = 0; i < 8; i++) entries.push(...toolPair('t' + i, 'read_file', 'x'));
  entries.push(aiResponseEntry('finished'));
  const lines = formatEntries(entries, 'LOGFILE');
  const toolLines = lines.filter((l) => l.kind === 'tool_call' || l.kind === 'tool_result');
  assert.equal(toolLines.length, MAX_VISIBLE_TOOL_EVENTS_PER_TURN);
  const scans = lines.filter((l) => l.text.startsWith('[scan]'));
  assert.equal(scans.length, 1);
  assert.equal(scans[0].text, '[scan] 6 more tool calls collapsed - full detail in LOGFILE.');
});

test('formatEntries resets the tool-event budget at every new user input', () => {
  const entries = [userInputEntry('one'), ...toolPair('a', 'x', '1'), userInputEntry('two'), ...toolPair('b', 'x', '2')];
  const lines = formatEntries(entries);
  assert.equal(lines.filter((l) => l.text.startsWith('[scan]')).length, 0);
  assert.equal(lines.filter((l) => l.kind === 'tool_call').length, 2);
});

test('formatEntries only treats the last response of a turn as the final answer', () => {
  const lines = formatEntries([
    userInputEntry('q'),
    aiResponseEntry('narration before a tool'),
    ...toolPair('t1', 'x', 'r'),
    aiResponseEntry('the real answer'),
  ]);
  assert.deepEqual(lines.filter((l) => l.kind === 'final').map((l) => l.text), ['the real answer']);
});

test('formatEntries skips empty responses, hidden entries and non-ai bookkeeping', () => {
  const hidden = { ...aiResponseEntry('hidden'), user_visible: false };
  const lines = formatEntries([userInputEntry('q'), aiResponseEntry(''), hidden]);
  assert.deepEqual(lines.map((l) => l.text), ['> q']);
});

test('formatEntries notes attached images under the user line', () => {
  const lines = formatEntries([userInputEntry('look', ['a.png', 'b.png'])]);
  assert.deepEqual(lines.map((l) => l.text), ['> look', '  (attached: a.png, b.png)']);
});

test('formatEntries shows far more think/narration than the live preview, but still bounds every field', () => {
  const long = 'z'.repeat(9000);
  const lines = formatEntries([
    userInputEntry('q'),
    aiThinkEntry(long),
    aiResponseEntry(long),
    aiToolCallEntry({ id: 't', name: 'write_file', input: { path: 'a.html', content: long } }, false),
    aiToolCallResponseEntry('t', long, false),
    aiResponseEntry('end'),
  ]);
  const think = lines.find((l) => l.text.startsWith('[think]'))!.text;
  assert.ok(think.length > 1000 && think.length < THINK_PREVIEW_CHARS + 20);
  const narration = lines.find((l) => l.kind === 'system' && l.text.startsWith('zzz'))!.text;
  assert.ok(narration.length > 3000 && narration.length < NARRATION_PREVIEW_CHARS + 20);
  const call = lines.find((l) => l.kind === 'tool_call')!.text;
  assert.ok(call.startsWith('[tool] write_file(') && call.length < TOOL_CALL_PREVIEW_CHARS + 60);
  assert.ok(lines.find((l) => l.kind === 'tool_result')!.text.length < 230);
});

test('parseSessionView accepts only "full"; anything else (missing, wrong type, typo) is compact', () => {
  assert.equal(parseSessionView('full'), 'full');
  assert.equal(parseSessionView('compact'), 'compact');
  for (const bad of [undefined, null, 'FULL', 'ful', 3, {}]) assert.equal(parseSessionView(bad), 'compact');
});

test('the full view shows the whole think, narration, tool arguments and result - nothing cut', () => {
  const big = 'z'.repeat(9000);
  const lines = formatEntries(
    [
      userInputEntry('q'),
      aiThinkEntry(big),
      aiResponseEntry(big),
      aiToolCallEntry({ id: 't', name: 'write_file', input: { path: 'a.html', content: big } }, false),
      aiToolCallResponseEntry('t', big, false),
      aiResponseEntry('end'),
    ],
    'the run log',
    { view: 'full' },
  );
  assert.ok(lines.find((l) => l.text.startsWith('[think]'))!.text.length > 9000);
  assert.ok(lines.find((l) => l.kind === 'system' && l.text.startsWith('zzz'))!.text.length === 9000);
  assert.ok(lines.find((l) => l.kind === 'tool_call')!.text.length > 9000);
  assert.ok(lines.find((l) => l.kind === 'tool_result')!.text.length > 9000);
});

test('the full view shows every tool event instead of collapsing past the limit into [scan]', () => {
  const entries = [userInputEntry('go')];
  for (let i = 0; i < 12; i++) entries.push(...toolPair('t' + i, 'read_file', 'x'));
  entries.push(aiResponseEntry('finished'));
  const lines = formatEntries(entries, 'the run log', { view: 'full' });
  assert.equal(lines.filter((l) => l.kind === 'tool_call' || l.kind === 'tool_result').length, 24);
  assert.equal(lines.filter((l) => l.text.startsWith('[scan]')).length, 0);
});

test('the full view still has a safety cap per entry, with a note saying how much was left out', () => {
  const huge = 'q'.repeat(FULL_ENTRY_CAP_CHARS + 5000);
  const lines = formatEntries([userInputEntry('q'), aiThinkEntry(huge), aiResponseEntry('end')], 'the run log', { view: 'full' });
  const think = lines.find((l) => l.text.startsWith('[think]'))!.text;
  assert.ok(think.length < FULL_ENTRY_CAP_CHARS + 200);
  assert.ok(think.includes('(+5,000 more characters, full text in the session file)'));
});

test('compact is the default and is unchanged by the new option', () => {
  const entries = [userInputEntry('q'), aiThinkEntry('z'.repeat(9000)), aiResponseEntry('end')];
  assert.deepEqual(formatEntries(entries), formatEntries(entries, 'the run log', { view: 'compact' }));
  assert.ok(formatEntries(entries)[1].text.length < THINK_PREVIEW_CHARS + 20);
});
