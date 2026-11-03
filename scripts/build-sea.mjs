// Builds o4c as a single executable for this OS (plan 0006 I1): `node scripts/build-sea.mjs`.
//
// Needs Node 25.5+ for `--build-sea` (26 for an ESM main with top-level await, which o4c has): the
// node running this script if it is new enough, else O4C_SEA_NODE=<path to node 26>. Steps:
//   1. tsc build (dist/), then esbuild bundles dist/cli.js and the code-graph worker into one file each
//   2. o4c's data files become SEA assets, listed in manifest.json (sea.ts unpacks them on first run)
//   3. node --build-sea writes dist-sea/o4c-<platform>-<arch>[.exe]
// The pty tool's native packages are not bundled; in the single executable that tool says so.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'dist-sea');
const node = process.env.O4C_SEA_NODE ?? process.execPath;
const nodeVersion = execFileSync(node, ['--version'], { encoding: 'utf-8' }).trim();
const [major, minor] = nodeVersion.slice(1).split('.').map(Number);
if (major < 26) {
  console.error(`build-sea needs Node 26+ (found ${nodeVersion} at ${node}); set O4C_SEA_NODE to a Node 26 executable.`);
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

writeFileSync(join(out, 'devtools-stub.mjs'), 'export default { connectToDevTools() {} };\nexport function connectToDevTools() {}\n');
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  external: ['@lydell/node-pty', '@xterm/headless'],
  alias: { 'react-devtools-core': join(out, 'devtools-stub.mjs') },
  banner: { js: "import { createRequire as __o4cRequire } from 'node:module'; const require = __o4cRequire(import.meta.url);" },
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [join(root, 'dist', 'cli.js')], outfile: join(out, 'o4c.mjs') });
await build({ ...common, entryPoints: [join(root, 'dist', 'graph', 'indexWorker.js')], outfile: join(out, 'assets', 'indexWorker.mjs') });

// The data files, with the paths packageRoot() expects under the unpacked runtime folder.
function addTree(from, to) {
  cpSync(from, join(out, 'assets', to), { recursive: true });
}
addTree(join(root, 'grammars'), 'grammars');
addTree(join(root, '.docs'), '.docs');
addTree(join(root, 'skills'), 'skills');
addTree(join(root, 'node_modules', 'highlight.js'), join('node_modules', 'highlight.js'));
cpSync(join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'), join(out, 'assets', 'web-tree-sitter.wasm'));
writeFileSync(join(out, 'assets', 'package.json'), JSON.stringify({ name: 'o4c-runtime', version, private: true }));

function list(dir) {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? list(join(dir, n)) : [join(dir, n)]));
}
const files = list(join(out, 'assets')).map((f) => relative(join(out, 'assets'), f).split('\\').join('/'));
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version, files }));
const assets = Object.fromEntries([['manifest.json', join(out, 'manifest.json')], ...files.map((f) => [f, join(out, 'assets', ...f.split('/'))])]);

const exe = join(out, `o4c-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
writeFileSync(join(out, 'sea.json'), JSON.stringify({ main: join(out, 'o4c.mjs'), mainFormat: 'module', output: exe, assets, useCodeCache: false, disableExperimentalSEAWarning: true }, null, 2));
execFileSync(node, ['--build-sea', join(out, 'sea.json')], { stdio: 'inherit' });
console.log(`\n${exe} (${(statSync(exe).size / 1e6).toFixed(0)} MB, ${files.length} files embedded, o4c ${version}, ${nodeVersion})`);
