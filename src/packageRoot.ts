import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where o4c's own files are - grammars/, .docs/, skills/, highlight.js's languages, the code-graph
 * worker (plan 0006 I1). Normally the package itself: one level up from this file in src/ or dist/.
 * In the single-executable build there is no package on disk, so `sea.ts` unpacks those files once
 * into ~/.o4c/runtime/<version>/ and points this at it before anything else runs. The answer also
 * goes into O4C_PACKAGE_ROOT, because the code-graph worker is a separate thread with its own copy
 * of every module (and a copy of the environment, which is how it learns the same thing).
 */
const ENV = 'O4C_PACKAGE_ROOT';

export function setPackageRoot(dir: string): void {
  process.env[ENV] = dir;
}

export function packageRoot(): string {
  return process.env[ENV] || resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

let version: string | undefined;

/**
 * o4c's version, from its own package.json - the one place it is written, so `o4c --version`, the
 * MCP client info and the ACP agent info cannot drift from what was published (they all said 0.0.1
 * until the 0.1.0 release). The single-executable build unpacks a package.json carrying the same
 * version, so this works there too - but only after `prepareSea()`, which is why callers ask late.
 */
export function packageVersion(): string {
  if (version) return version;
  try {
    version = String((JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf-8')) as { version?: unknown }).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
  return version;
}

/** True in the single-executable build (the files came out of the executable). */
export function isUnpackedRuntime(): boolean {
  return Boolean(process.env[ENV]);
}
