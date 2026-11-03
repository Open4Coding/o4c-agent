import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../packageRoot.js';

/**
 * `o4c --check-update` and `/update` (plan 0006 I3): is there a newer o4c? Manual only - o4c never
 * looks on its own ("no telemetry, ever"), and in secure mode it does not look at all. It asks the
 * npm registry and the GitHub releases, says what it found, and how to update; it installs nothing.
 */
export const NPM_PACKAGE = '@open4coding/o4c-agent';
export const GITHUB_REPO = 'Open4Coding/o4c-agent';

export function installedVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf-8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** -1, 0 or 1, comparing x.y.z (a prerelease sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2) as [string, string | undefined];
    return { nums: main.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return x.pre && y.pre ? Math.sign(x.pre.localeCompare(y.pre)) : 0;
}

export interface UpdateInfo {
  installed: string;
  npm?: string;
  github?: string;
  problems: string[];
}

export async function checkForUpdate(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<UpdateInfo> {
  const info: UpdateInfo = { installed: installedVersion(), problems: [] };
  const get = async (url: string) => {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'o4c' }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  try {
    const j = await get(`https://registry.npmjs.org/${NPM_PACKAGE.replace('/', '%2f')}/latest`);
    if (typeof j?.version === 'string') info.npm = j.version;
  } catch (err) {
    info.problems.push(`npm: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const j = await get(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (typeof j?.tag_name === 'string') info.github = j.tag_name.replace(/^v/, '');
  } catch (err) {
    info.problems.push(`GitHub: ${err instanceof Error ? err.message : String(err)}`);
  }
  return info;
}

export function describeUpdate(info: UpdateInfo): string[] {
  const newest = [info.npm, info.github].filter((v): v is string => Boolean(v)).sort(compareVersions).at(-1);
  const lines = [`o4c ${info.installed} is installed.`];
  if (!newest) {
    lines.push(info.problems.length ? 'Could not find out what the latest version is.' : 'No released version found yet (npm and GitHub have none).');
  } else if (compareVersions(newest, info.installed) > 0) {
    lines.push(`o4c ${newest} is available.`);
    if (info.npm) lines.push(`  npm:    npm install -g ${NPM_PACKAGE}@latest`);
    if (info.github) lines.push(`  binary: https://github.com/${GITHUB_REPO}/releases/latest`);
  } else {
    lines.push(`That is the latest (${newest}).`);
  }
  for (const p of info.problems) lines.push(`  (${p})`);
  return lines;
}

export const SECURE_UPDATE_REFUSAL = 'Secure mode is on, so o4c does not contact npm or GitHub. Check for updates from a machine that may.';
