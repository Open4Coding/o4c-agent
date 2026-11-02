// Exact token counting check (plan 0006 A14): rebuild every request in FULLCONTEXT logs, ask the
// server for its exact size (LocalProvider.countTokens), and compare with the prompt_tokens the
// server reported when the request was really sent.
// Usage: npm run build && node scripts/count-check.mjs <log.jsonl> [more logs...]

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
const provider = new LocalProvider({ baseUrl: config.baseUrl, apiKey: process.env.O4C_LOCAL_API_KEY ?? config.localApiKey });

let equal = 0;
let total = 0;
for (const log of process.argv.slice(2)) {
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
    const recorded = row.response?.usage?.inputTokens;
    const counted = await provider.countTokens(current);
    total += 1;
    if (counted === recorded) equal += 1;
    else console.log(`${log.split(/[\\/]/).pop()} #${total}: counted ${counted} recorded ${recorded}`);
  }
}
console.log(`JSON ${JSON.stringify({ equal, total })}`);
