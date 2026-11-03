import { dirname, resolve } from 'node:path';
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

/** True in the single-executable build (the files came out of the executable). */
export function isUnpackedRuntime(): boolean {
  return Boolean(process.env[ENV]);
}
