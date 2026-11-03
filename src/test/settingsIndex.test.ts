import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../session/configStore.js';
import { parseBlockGap, SETTINGS, settingLabel, settingValues } from '../ui/settingsIndex.js';
import { commandForHelpTarget } from '../ui/slashCommand.js';

test('every setting listed is a real command', () => {
  for (const s of SETTINGS) assert.ok(commandForHelpTarget(s.command.slice(1)), `${s.command} is not registered`);
});

test('settingValues shows the effective value and the scope it comes from', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o4c-settings-'));
  try {
    const home = join(root, 'home');
    const project = join(root, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, '.o4c'), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ shell: 'pwsh', notify: 'toast', thinkLevelByModel: { qwen: 'high', other: 'low' } }));
    writeFileSync(join(project, '.o4c', 'config.json'), JSON.stringify({ shell: 'bash', mouse: true, pinnedCommands: ['/set-shell', '/undo'] }));
    const values = await settingValues(new ConfigStore(project, home, [], null), 'qwen');
    const byCommand = Object.fromEntries(values.map((v) => [v.command, settingLabel(v)]));
    assert.equal(byCommand['/set-shell'], '/set-shell - bash (local)');
    assert.equal(byCommand['/set-notify'], '/set-notify - toast (global)');
    assert.equal(byCommand['/set-think'], '/set-think - high (global)');
    assert.equal(byCommand['/set-mouse'], '/set-mouse - on (local)');
    assert.equal(byCommand['/set-pinnedcommands'], '/set-pinnedcommands - /set-shell, /undo (local)');
    assert.equal(byCommand['/set-blockgap'], '/set-blockgap - 1 (default)');
    assert.equal(byCommand['/config-model'], '/config-model - see /view-model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseBlockGap allows 0, 1 and 2 and defaults to 1', () => {
  assert.deepEqual([0, 1, 2, 3, undefined, '2'].map(parseBlockGap), [0, 1, 2, 1, 1, 1]);
});
