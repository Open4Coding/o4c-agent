import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findProjectRoot,
  ensureTrusted,
  resolveO4cMd,
  resolveSettings,
  sessionsDirFor,
  logsDirFor,
} from '../session/projectContext.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'o4c-project-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('findProjectRoot returns undefined when no .o4c exists anywhere above cwd', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await findProjectRoot(dir), undefined);
  });
});

test('findProjectRoot finds .o4c at cwd itself', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, '.o4c'), { recursive: true });
    assert.equal(await findProjectRoot(dir), dir);
  });
});

test('findProjectRoot finds .o4c at an ancestor when cwd is a nested subdirectory', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, '.o4c'), { recursive: true });
    const nested = join(dir, 'packages', 'foo');
    await mkdir(nested, { recursive: true });
    assert.equal(await findProjectRoot(nested), dir);
  });
});

test('ensureTrusted reports trusted immediately when .o4c already exists, without prompting', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, '.o4c'), { recursive: true });
    let promptCalled = false;
    const result = await ensureTrusted(dir, async () => {
      promptCalled = true;
      return 'yes';
    });
    assert.deepEqual(result, { trusted: true, projectRoot: dir });
    assert.equal(promptCalled, false);
  });
});

test('ensureTrusted does not prompt and stays untrusted when stdin is not a TTY', async () => {
  await withTempDir(async (dir) => {
    const original = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      let promptCalled = false;
      const result = await ensureTrusted(dir, async () => {
        promptCalled = true;
        return 'yes';
      });
      assert.deepEqual(result, { trusted: false, projectRoot: undefined });
      assert.equal(promptCalled, false);
    } finally {
      process.stdin.isTTY = original;
    }
  });
});

test('ensureTrusted creates .o4c and trusts on a "yes" answer, and never asks again after', async () => {
  await withTempDir(async (dir) => {
    const original = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      const result = await ensureTrusted(dir, async () => 'y');
      assert.deepEqual(result, { trusted: true, projectRoot: dir });

      let promptCalledAgain = false;
      const second = await ensureTrusted(dir, async () => {
        promptCalledAgain = true;
        return 'yes';
      });
      assert.deepEqual(second, { trusted: true, projectRoot: dir });
      assert.equal(promptCalledAgain, false);
    } finally {
      process.stdin.isTTY = original;
    }
  });
});

test('ensureTrusted leaves the project untrusted on a "no" answer, and does not create .o4c', async () => {
  await withTempDir(async (dir) => {
    const original = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      const result = await ensureTrusted(dir, async () => 'no');
      assert.deepEqual(result, { trusted: false, projectRoot: undefined });
      assert.equal(await findProjectRoot(dir), undefined);
    } finally {
      process.stdin.isTTY = original;
    }
  });
});

test('resolveO4cMd returns an empty string when no o4c.md exists at any level', async () => {
  await withTempDir(async (globalDir) => {
    await withTempDir(async (projectRoot) => {
      assert.equal(await resolveO4cMd(projectRoot, projectRoot, globalDir), '');
    });
  });
});

test('resolveO4cMd includes only the global file when that is all that exists', async () => {
  await withTempDir(async (globalDir) => {
    await writeFile(join(globalDir, 'o4c.md'), 'global notes');
    await withTempDir(async (projectRoot) => {
      const result = await resolveO4cMd(projectRoot, projectRoot, globalDir);
      assert.match(result, /global notes/);
    });
  });
});

test('resolveO4cMd concatenates global, project, and subproject levels in broadest-first order', async () => {
  await withTempDir(async (globalDir) => {
    await writeFile(join(globalDir, 'o4c.md'), 'GLOBAL_MARKER');
    await withTempDir(async (projectRoot) => {
      await writeFile(join(projectRoot, 'o4c.md'), 'PROJECT_MARKER');
      const subdir = join(projectRoot, 'packages', 'foo');
      await mkdir(subdir, { recursive: true });
      await writeFile(join(subdir, 'o4c.md'), 'SUBPROJECT_MARKER');

      const result = await resolveO4cMd(subdir, projectRoot, globalDir);
      const globalIdx = result.indexOf('GLOBAL_MARKER');
      const projectIdx = result.indexOf('PROJECT_MARKER');
      const subIdx = result.indexOf('SUBPROJECT_MARKER');
      assert.ok(globalIdx >= 0 && projectIdx > globalIdx && subIdx > projectIdx);
    });
  });
});

test('resolveO4cMd skips intermediate levels that have no o4c.md of their own', async () => {
  await withTempDir(async (globalDir) => {
    await withTempDir(async (projectRoot) => {
      await writeFile(join(projectRoot, 'o4c.md'), 'PROJECT_MARKER');
      // No o4c.md in the intermediate "packages" dir or in "foo" itself.
      const subdir = join(projectRoot, 'packages', 'foo');
      await mkdir(subdir, { recursive: true });

      const result = await resolveO4cMd(subdir, projectRoot, globalDir);
      assert.match(result, /PROJECT_MARKER/);
      assert.equal(result.split('--- o4c.md (').length - 1, 1); // exactly one section
    });
  });
});

test('resolveSettings deep-merges local over global, local winning on conflicting keys', async () => {
  await withTempDir(async (globalDir) => {
    await writeFile(
      join(globalDir, 'settings.json'),
      JSON.stringify({ provider: 'anthropic', nested: { a: 1, b: 1 } }),
    );
    await withTempDir(async (projectRoot) => {
      await mkdir(join(projectRoot, '.o4c'), { recursive: true });
      await writeFile(
        join(projectRoot, '.o4c', 'settings.json'),
        JSON.stringify({ nested: { b: 2 } }),
      );

      const result = await resolveSettings(projectRoot, globalDir);
      assert.deepEqual(result, { provider: 'anthropic', nested: { a: 1, b: 2 } });
    });
  });
});

test('resolveSettings returns {} when neither global nor local settings.json exists', async () => {
  await withTempDir(async (globalDir) => {
    await withTempDir(async (projectRoot) => {
      assert.deepEqual(await resolveSettings(projectRoot, globalDir), {});
    });
  });
});

test('sessionsDirFor and logsDirFor point into .o4c/ under the project root when trusted', () => {
  const root = join(tmpdir(), 'fake-project');
  assert.equal(sessionsDirFor(root), join(root, '.o4c', 'sessions'));
  assert.equal(logsDirFor(root), join(root, '.o4c', 'logs'));
});

test('sessionsDirFor and logsDirFor fall back to the global dirs when untrusted', () => {
  assert.ok(sessionsDirFor(undefined).endsWith(join('.o4c', 'sessions')));
  assert.ok(logsDirFor(undefined).endsWith(join('.o4c', 'logs')));
});
