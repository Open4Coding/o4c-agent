// Replays a recorded o4c session against a llama-server and measures it (plan 0006 A3).
//
// Every speed change in plan 0006 - request shaping (A5-A10) and server flags (A4, A15, A16) - needs
// the same question answered: on a real session, how much prompt was re-processed, how long did it
// take, how fast was decoding, how many drafts were accepted? A live session cannot be repeated;
// a recorded one can. The FULLCONTEXT log (one file per run, `.o4c/logs/*.FULLCONTEXT.jsonl`) holds
// every request exactly: a `provider_call` row with the full request, then `provider_call_delta`
// rows with only the new messages (plus the system prompt / tool list when they changed). This
// rebuilds each request and sends it again through o4c's own LocalProvider, so the bytes on the
// wire are what o4c sends.
//
// `--transform <name>` applies a new request shaping to the recorded history first, so a shaping
// change can be measured on old sessions before it lands. Items add their transforms below.
//
// Usage: npm run build && node scripts/replay-bench.mjs <log.jsonl> [--base-url URL]
//        [--max-tokens N] [--limit N] [--transform none] [--csv out.csv]
// The server and key come from ~/.o4c/config.json / config.local.json unless given (the key is
// never printed).

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const O4C = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { LocalProvider } = await import(pathToFileURL(join(O4C, 'dist', 'providers', 'local.js')).href);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const logPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!logPath) {
  console.error('usage: node scripts/replay-bench.mjs <log.FULLCONTEXT.jsonl> [--base-url URL] [--max-tokens N] [--limit N] [--transform name] [--csv file]');
  process.exit(2);
}

function readConfig(name) {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.o4c', name), 'utf-8'));
  } catch {
    return {};
  }
}
const config = { ...readConfig('config.json'), ...readConfig('config.local.json') };
const baseUrl = flag('base-url', config.baseUrl ?? 'http://localhost:8080');
const apiKey = process.env.O4C_LOCAL_API_KEY ?? config.localApiKey;
const maxTokensCap = flag('max-tokens') ? Number(flag('max-tokens')) : undefined;
const limit = flag('limit') ? Number(flag('limit')) : Infinity;
const transformName = flag('transform', 'none');
const csvPath = flag('csv');

/** Rebuilds every main request, in order, from full and delta rows. */
export function rebuildRequests(rows) {
  const requests = [];
  let current;
  for (const row of rows) {
    if (row.type === 'provider_call') {
      current = { ...row.request };
    } else if (row.type === 'provider_call_delta' && current) {
      current = {
        ...current,
        ...(row.systemPrompt !== undefined ? { systemPrompt: row.systemPrompt } : {}),
        ...(row.tools !== undefined ? { tools: row.tools } : {}),
        messages: [...current.messages, ...row.messages],
      };
    } else {
      continue;
    }
    requests.push({ request: current, recorded: row.response?.usage });
  }
  return requests;
}

/** Request shapings to A/B on recorded history. `none` replays exactly what was sent. */
const TRANSFORMS = {
  none: (requests) => requests,
};

const rows = readFileSync(logPath, 'utf-8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const transform = TRANSFORMS[transformName];
if (!transform) {
  console.error(`unknown transform "${transformName}" - known: ${Object.keys(TRANSFORMS).join(', ')}`);
  process.exit(2);
}
const plan = transform(rebuildRequests(rows)).slice(0, limit);

const provider = new LocalProvider({ baseUrl, apiKey, maxTokens: maxTokensCap ?? 4096 });
const results = [];
console.log(`replaying ${plan.length} requests from ${logPath} against ${baseUrl} (transform: ${transformName})`);
for (const [i, { request, recorded }] of plan.entries()) {
  // Decode is capped at what the original produced (or --max-tokens), so prefill differences are
  // not drowned out by a different-length answer.
  const maxTokens = maxTokensCap ?? Math.max(16, recorded?.outputTokens ?? 512);
  const started = Date.now();
  let usage;
  try {
    const response = await provider.complete({ ...request, maxTokens, signal: undefined, onToken: undefined, onToolProgress: undefined });
    usage = response.usage ?? {};
  } catch (err) {
    console.error(`request ${i}: ${err instanceof Error ? err.message : String(err)}`);
    usage = {};
  }
  const row = {
    i,
    prompt: usage.inputTokens ?? 0,
    cached: usage.cachedTokens ?? 0,
    processed: usage.processedPromptTokens ?? 0,
    prefillMs: Math.round(usage.prefillMs ?? 0),
    output: usage.outputTokens ?? 0,
    tps: usage.tokensPerSecond ?? 0,
    draftN: usage.draftTokens ?? 0,
    draftAccepted: usage.draftAccepted ?? 0,
    wallMs: Date.now() - started,
  };
  results.push(row);
  console.log(`  ${String(i).padStart(3)} prompt ${row.prompt} cached ${row.cached} processed ${row.processed} prefill ${row.prefillMs} ms, ${row.output} out @ ${row.tps.toFixed(1)} t/s`);
}

const sum = (k) => results.reduce((a, r) => a + r[k], 0);
const decodeS = results.reduce((a, r) => a + (r.tps > 0 ? r.output / r.tps : 0), 0);
const summary = {
  requests: results.length,
  prefillS: +(sum('prefillMs') / 1000).toFixed(1),
  decodeS: +decodeS.toFixed(1),
  tps: decodeS > 0 ? +(sum('output') / decodeS).toFixed(1) : 0,
  cacheHitPct: sum('cached') + sum('processed') > 0 ? +((100 * sum('cached')) / (sum('cached') + sum('processed'))).toFixed(1) : 0,
  mtpAcceptPct: sum('draftN') > 0 ? +((100 * sum('draftAccepted')) / sum('draftN')).toFixed(1) : 0,
  processedTokens: sum('processed'),
  wallS: +(sum('wallMs') / 1000).toFixed(1),
};
console.log(`\nsummary: prefill ${summary.prefillS} s, decode ${summary.decodeS} s, ${summary.tps} t/s, cache hit ${summary.cacheHitPct}%, MTP accepted ${summary.mtpAcceptPct}%, processed ${summary.processedTokens} tokens, wall ${summary.wallS} s`);
console.log(`JSON ${JSON.stringify(summary)}`);
if (csvPath) {
  const header = Object.keys(results[0] ?? { i: 0 }).join(',');
  writeFileSync(csvPath, `${header}\n${results.map((r) => Object.values(r).join(',')).join('\n')}\n`);
}
