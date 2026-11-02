
// Shared helpers for the eval pass scripts (plan 0006 J1). A pass script runs with its cwd set to the
// task's working copy and exits 0 when every check passed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const cwd = process.cwd();
let failures = 0;
let loads = 0;

/** Imports a module from the working copy, fresh each time. */
export function load(rel) {
  return import(`${pathToFileURL(join(cwd, rel)).href}?v=${++loads}`);
}

export async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${String(err?.message ?? err).split('\n').slice(0, 6).join(' | ')}`);
  }
}

export function finish() {
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

export const exists = (rel) => existsSync(join(cwd, rel));
export const read = (rel) => readFileSync(join(cwd, rel), 'utf-8');

/** A file as the task started - from the task's own repo/, which the agent never saw. */
export function original(checkUrl, rel) {
  return readFileSync(join(dirname(fileURLToPath(checkUrl)), 'repo', rel), 'utf-8');
}

export function run(command, args, input) {
  return spawnSync(command, args, { cwd, encoding: 'utf-8', input, timeout: 60000 });
}

export function nodeTest(rel) {
  return run(process.execPath, ['--test', rel]);
}

/** Every file under a directory of the working copy, as relative paths with forward slashes. */
export function files(rel) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(cwd, dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(cwd, path)).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(rel);
  return out;
}

/** Runs fn with one file's text replaced, then restores it. Throws if `from` is not in the file. */
export function mutate(rel, from, to, fn) {
  const before = read(rel);
  if (!before.includes(from)) throw new Error(`mutant source not found in ${rel}: ${from}`);
  writeFileSync(join(cwd, rel), before.replace(from, to));
  try {
    return fn();
  } finally {
    writeFileSync(join(cwd, rel), before);
  }
}

let pythonCmd;
/** Runs Python code in the working copy; throws with its stderr when it fails. */
export function python(code) {
  if (!pythonCmd) {
    pythonCmd = ['python', 'python3', 'py'].find((c) => spawnSync(c, ['--version'], { encoding: 'utf-8' }).status === 0);
    if (!pythonCmd) throw new Error('no Python interpreter found');
  }
  const r = run(pythonCmd, ['-c', code]);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | '));
  return r.stdout.trim();
}
