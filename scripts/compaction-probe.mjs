// Does the compaction call reuse the server's cache? (plan 0006 A11)
//
// Runs o4c's real AgentLoop against the configured local server with a deliberately small context
// window, feeding it chunks of source until compaction fires, and reports the compaction call's
// prompt figures: with the cache-sharing request it should reuse nearly all of the conversation
// (cached ~ the previous main prompt) and process only the instruction.
//
// Usage: npm run build && node scripts/compaction-probe.mjs [window=32768]

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const O4C = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(O4C, 'dist', p)).href);
const { LocalProvider } = await imp('providers/local.js');
const { AgentLoop } = await imp('agent/loop.js');
const { SHARED_COMPACTION_MARK, SUMMARY_PROMPT_PREFIX } = await imp('agent/compaction.js').then((m) => ({ ...m, SUMMARY_PROMPT_PREFIX: 'You produce structured JSON summaries' }));

const cfg = (n) => {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.o4c', n), 'utf-8'));
  } catch {
    return {};
  }
};
const config = { ...cfg('config.json'), ...cfg('config.local.json') };
const contextWindow = Number(process.argv[2] ?? 32768);

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name));
    else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
  }
};
walk(join(O4C, 'src'));

const provider = new LocalProvider({ baseUrl: config.baseUrl, apiKey: process.env.O4C_LOCAL_API_KEY ?? config.localApiKey, maxTokens: 64 });
const loop = new AgentLoop(provider, [], 'You are a terse assistant.');
let lastMainPrompt = 0;
const found = [];
const onProviderCall = ({ request, response }) => {
  const last = request.messages[request.messages.length - 1];
  const u = response.usage ?? {};
  if (last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith(SHARED_COMPACTION_MARK)) {
    found.push({ kind: 'shared', prompt: u.inputTokens, cached: u.cachedTokens, processed: u.processedPromptTokens, prefillMs: Math.round(u.prefillMs ?? 0), previousMain: lastMainPrompt });
  } else if (request.systemPrompt?.startsWith(SUMMARY_PROMPT_PREFIX)) {
    found.push({ kind: 'standalone', prompt: u.inputTokens, cached: u.cachedTokens, processed: u.processedPromptTokens, prefillMs: Math.round(u.prefillMs ?? 0), previousMain: lastMainPrompt });
  } else {
    lastMainPrompt = u.inputTokens ?? lastMainPrompt;
  }
};

let i = 0;
let text = '';
for (const f of files) {
  text = readFileSync(f, 'utf-8').slice(0, 14000);
  await loop.run(`File ${i}:\n${text}\n\nReply with OK.`, { contextWindow, onProviderCall, thinkLevel: 'nothink' });
  i += 1;
  if (found.length > 0 || i > 40) break;
}
for (const c of found) console.log(`${c.kind} compaction: prompt ${c.prompt} cached ${c.cached} processed ${c.processed} prefill ${c.prefillMs} ms (previous main prompt ${c.previousMain})`);
console.log(`JSON ${JSON.stringify(found)}`);
