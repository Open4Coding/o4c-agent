// Where did the prompt cache break? (plan 0006 A14)
//
// Renders two consecutive requests from a FULLCONTEXT log through the server's own chat template
// (`/apply-template`, via LocalProvider.renderPrompt) and prints the first character where the
// earlier rendering stops being a prefix of the later one, with context on both sides. A clean
// append prints "prefix holds". This is how an `unknown` cache break gets explained.
//
// Usage: npm run build && node scripts/cache-diff.mjs <log.jsonl> [requestNumber]
//        (requestNumber = the later request, 1-based; default: every pair)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const O4C = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { LocalProvider } = await import(pathToFileURL(join(O4C, 'dist', 'providers', 'local.js')).href);
const cfg = (n) => {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.o4c', n), 'utf-8'));
  } catch {
    return {};
  }
};
const config = { ...cfg('config.json'), ...cfg('config.local.json') };
const provider = new LocalProvider({
  baseUrl: config.baseUrl,
  apiKey: process.env.O4C_LOCAL_API_KEY ?? config.localApiKey,
  reasoningReplay: config.localReasoningReplay,
});

const [log, only] = process.argv.slice(2);
const requests = [];
let current;
for (const line of readFileSync(log, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.type === 'provider_call') current = { ...row.request };
  else if (row.type === 'provider_call_delta' && current) {
    current = {
      ...current,
      ...(row.systemPrompt !== undefined ? { systemPrompt: row.systemPrompt } : {}),
      ...(row.tools !== undefined ? { tools: row.tools } : {}),
      messages: [...current.messages, ...row.messages],
    };
  } else continue;
  requests.push(current);
}

const show = (s) => JSON.stringify(s).slice(1, -1);
const pairs = only ? [Number(only) - 1] : requests.map((_, i) => i).slice(1);
for (const i of pairs) {
  const [a, b] = await Promise.all([provider.renderPrompt(requests[i - 1]), provider.renderPrompt(requests[i])]);
  if (a === undefined || b === undefined) {
    console.log(`#${i + 1}: server could not render`);
    continue;
  }
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  if (at === a.length) console.log(`#${i + 1}: prefix holds (${a.length} -> ${b.length} chars)`);
  else console.log(`#${i + 1}: differs at char ${at} of ${a.length}\n  before: ...${show(a.slice(Math.max(0, at - 80), at + 80))}\n  after:  ...${show(b.slice(Math.max(0, at - 80), at + 80))}`);
}
