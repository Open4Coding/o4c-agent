import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setPackageRoot } from './packageRoot.js';

/**
 * The single-executable build (plan 0006 I1): o4c as one file per OS, Node included, built with
 * Node's own `--build-sea` (Node 25.5+; ESM main with top-level await works from Node 26 - the
 * reason it failed on Node 24). See scripts/build-sea.mjs.
 *
 * The executable carries o4c's data files as SEA assets, listed in the `manifest.json` asset. On
 * first start of a given version they are written to ~/.o4c/runtime/<version>/ (a `.complete` marker
 * says the copy finished - an interrupted one is redone), and `packageRoot()` points there. Outside
 * a SEA this does nothing.
 */
export async function prepareSea(): Promise<void> {
  let sea: { isSea(): boolean; getAsset(key: string, encoding?: string): string | ArrayBuffer; getRawAsset(key: string): ArrayBuffer } | undefined;
  try {
    sea = (await import('node:sea')) as unknown as NonNullable<typeof sea>;
  } catch {
    return;
  }
  if (!sea?.isSea()) return;
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8') as string) as { version: string; files: string[] };
  const dir = join(homedir(), '.o4c', 'runtime', manifest.version);
  if (!existsSync(join(dir, '.complete'))) {
    rmSync(dir, { recursive: true, force: true });
    for (const key of manifest.files) {
      const target = join(dir, ...key.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(sea.getRawAsset(key)));
    }
    writeFileSync(join(dir, '.complete'), new Date().toISOString());
  }
  setPackageRoot(dir);
}
