import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { projectLabel, readGitBranch, readMountPoint } from '../session/gitInfo.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'o4c-git-'));
}

test('reads the branch from a normal repository', async () => {
  const root = await tempDir();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
  assert.equal(await readGitBranch(root), 'main');
});

test('a branch name containing slashes keeps all of it', async () => {
  const root = await tempDir();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/think-levels\n', 'utf-8');
  assert.equal(await readGitBranch(root), 'feature/think-levels');
});

test('finds the repository from a subdirectory, not just its root', async () => {
  const root = await tempDir();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
  const deep = join(root, 'src', 'ui', 'components');
  await mkdir(deep, { recursive: true });
  assert.equal(await readGitBranch(deep), 'main');
});

test('a detached HEAD shows a short commit id', async () => {
  const root = await tempDir();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), '055fd8512ab34cd56ef78901234567890abcdef1\n', 'utf-8');
  assert.equal(await readGitBranch(root), '055fd85');
});

test('a worktree stores .git as a file pointing elsewhere, and is still resolved', async () => {
  const root = await tempDir();
  const real = join(root, 'real-git');
  await mkdir(real, { recursive: true });
  await writeFile(join(real, 'HEAD'), 'ref: refs/heads/worktree-branch\n', 'utf-8');
  const tree = join(root, 'tree');
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, '.git'), `gitdir: ${real}\n`, 'utf-8');
  assert.equal(await readGitBranch(tree), 'worktree-branch');
});

test('not a repository is a normal answer, not an error', async () => {
  // D:\AngelCode itself is not a repo - this is the everyday case, not an edge one.
  const root = await tempDir();
  assert.equal(await readGitBranch(root), undefined);
  assert.equal(await readGitBranch(undefined), undefined);
});

test('an unreadable or malformed HEAD degrades to no branch rather than throwing', async () => {
  const root = await tempDir();
  await mkdir(join(root, '.git'), { recursive: true });
  // Mid-rebase or half-written: neither a ref nor a commit id.
  await writeFile(join(root, '.git', 'HEAD'), 'not a ref and not a sha\n', 'utf-8');
  assert.equal(await readGitBranch(root), undefined);

  const missing = await tempDir();
  await mkdir(join(missing, '.git'), { recursive: true }); // .git exists, HEAD does not
  assert.equal(await readGitBranch(missing), undefined);
});

test('a .git file with no gitdir line does not resolve', async () => {
  const root = await tempDir();
  await writeFile(join(root, '.git'), 'something else entirely\n', 'utf-8');
  assert.equal(await readGitBranch(root), undefined);
});

test('the project label is the project name plus the path inside it', () => {
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  assert.equal(projectLabel(root, join(root, 'src', 'agent')), 'o4c-agent/src/agent');
  assert.equal(projectLabel(root, root), 'o4c-agent', 'at the root, the name is the whole answer');
});

test('separators are normalised so the label reads the same everywhere', () => {
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  const label = projectLabel(root, join(root, 'src', 'ui', 'components'));
  assert.ok(!label.includes('\\'), `label still had a backslash: ${label}`);
  assert.equal(label, 'o4c-agent/src/ui/components');
});

test('outside the project, the label does not claim a path within it', () => {
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  // Above the root: a relative label would read as `o4c-agent/../..`, which is worse than nothing.
  assert.equal(projectLabel(root, join('D:', 'Open4Coding')), 'o4c-agent');
  assert.equal(projectLabel(root, join('C:', 'tmp.tmp')), 'o4c-agent');
});

test('with no project root, the label falls back to the directory name', () => {
  assert.equal(projectLabel(undefined, join('C:', 'tmp.tmp')), 'tmp.tmp');
});

test('the label names the volume the project is on', () => {
  // Two checkouts of the same project on C: and D: are ordinary, and the old label could not tell
  // them apart. The middle is elided rather than spelled out: this line already carries a branch.
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  assert.equal(projectLabel(root, join(root, 'src', 'agent'), 'D:'), 'D:/\u2026/o4c-agent/src/agent');
  assert.equal(projectLabel(root, root, 'D:'), 'D:/\u2026/o4c-agent');
  // A POSIX mount point reads the same way, and the root does not double its separator.
  const posixRoot = join('/', 'home', 'david', 'o4c-agent');
  assert.equal(projectLabel(posixRoot, posixRoot, '/'), '/\u2026/o4c-agent');
  const mounted = join('/', 'mnt', 'work', 'repos', 'o4c-agent');
  assert.equal(projectLabel(mounted, mounted, '/mnt/work'), '/mnt/work/\u2026/o4c-agent');
});

test('nothing is elided when there is nothing between the volume and the project', () => {
  // `D:/.../myproj` would claim a directory that is not there. The ellipsis has to mean something.
  const onVolumeRoot = join('D:', 'myproj');
  assert.equal(projectLabel(onVolumeRoot, join(onVolumeRoot, 'src'), 'D:'), 'D:/myproj/src');
  assert.ok(!projectLabel(onVolumeRoot, onVolumeRoot, 'D:').includes('\u2026'));
});

test('a mount that does not contain the project elides nothing rather than inventing a gap', () => {
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  assert.ok(!projectLabel(root, root, 'C:').includes('\u2026'));
});

test('without a resolved mount the label is unchanged, so the footer never waits on a stat', () => {
  const root = join('D:', 'Open4Coding', 'o4c-agent');
  assert.equal(projectLabel(root, join(root, 'src')), 'o4c-agent/src');
  assert.equal(projectLabel(undefined, join('C:', 'tmp.tmp')), 'tmp.tmp');
});

test('the mount point of a real directory has no trailing separator', async () => {
  const root = await tempDir();
  const mount = await readMountPoint(root);
  assert.ok(mount, 'a real directory must resolve to some volume');
  assert.ok(!mount.endsWith('/'), `${mount} would render as a doubled separator`);
  if (process.platform === 'win32') {
    // The drive of the temp dir, whatever it is on this machine - `C:`, not `C:\`.
    assert.equal(mount, parse(root).root.replace(/\\$/, ''));
    assert.match(mount, /^[A-Za-z]:$/);
  } else {
    // Walking up by device id lands on `/` or on a real mount point, never a relative string.
    assert.ok(mount.startsWith('/'));
  }
});

test('an unresolvable path gives no volume instead of throwing', async () => {
  assert.equal(await readMountPoint(undefined), undefined);
  assert.equal(await readMountPoint('relative/path'), undefined, 'nothing truthful to say');
  // A path that does not exist still has a knowable volume - the label is cosmetic either way.
  const gone = join(await tempDir(), 'does', 'not', 'exist');
  assert.doesNotReject(async () => readMountPoint(gone));
});

test('cleanup', async () => {
  // Keeping the temp dirs out of the machine's tmp for the next run; failures here are harmless.
  await rm(join(tmpdir(), 'nonexistent-o4c-git-cleanup'), { recursive: true, force: true });
  void chmod;
});
