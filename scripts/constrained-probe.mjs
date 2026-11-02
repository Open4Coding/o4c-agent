// Constrained side calls against the real server (plan 0006 A12): N compaction calls with
// SUMMARY_SCHEMA must all parse as real JSON, and M curated pick calls with PICK_GRAMMAR must stay
// tiny. Usage: npm run build && node scripts/constrained-probe.mjs [compactions=30] [picks=20]

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const O4C = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(O4C, 'dist', p)).href);
const { LocalProvider } = await imp('providers/local.js');
const { SUMMARY_SCHEMA, parseSummary } = await imp('agent/compaction.js');
const { PICK_GRAMMAR } = await imp('session/curated.js');

const cfg = (n) => {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.o4c', n), 'utf-8'));
  } catch {
    return {};
  }
};
const config = { ...cfg('config.json'), ...cfg('config.local.json') };
const provider = new LocalProvider({ baseUrl: config.baseUrl, apiKey: process.env.O4C_LOCAL_API_KEY ?? config.localApiKey, maxTokens: 1500 });
const nCompact = Number(process.argv[2] ?? 30);
const nPick = Number(process.argv[3] ?? 20);

const files = readdirSync(join(O4C, 'src', 'agent')).filter((f) => f.endsWith('.ts')).map((f) => join(O4C, 'src', 'agent', f));
let parsed = 0;
for (let i = 0; i < nCompact; i++) {
  const src = readFileSync(files[i % files.length], 'utf-8').slice(0, 6000);
  const response = await provider.complete({
    systemPrompt: 'You produce structured JSON summaries of coding-agent conversation history for context compaction. Output only the JSON object, nothing else.',
    messages: [{ role: 'user', content: `Summarize this work session as JSON (user_intent, files, current_work, next_step):\n[User]: explain and fix this file\n[Tool result]: ${src}` }],
    tools: [],
    responseSchema: SUMMARY_SCHEMA,
    thinkLevel: 'nothink',
    maxTokens: 1500,
  });
  const s = parseSummary(response.content);
  const real = s && typeof s === 'object' && !(Object.keys(s).length === 1 && 'current_work' in s && !response.content.trim().startsWith('{'));
  try {
    JSON.parse(response.content);
    if (real) parsed += 1;
  } catch {
    console.log(`compaction ${i}: not JSON: ${response.content.slice(0, 80)}`);
  }
}
let small = 0;
const outs = [];
for (let i = 0; i < nPick; i++) {
  const response = await provider.complete({
    systemPrompt: 'Pick which earlier tasks are relevant to the new request. Reply with their numbers like "#12, #40", or "none".',
    messages: [{ role: 'user', content: `New request:\nfix the ${['build', 'tests', 'docs', 'login', 'parser'][i % 5]} problem\n\nEarlier tasks:\n#${10 + i} fixed the build script\n#${30 + i} wrote docs for the API\n#${50 + i} parser crash on empty input\n#${70 + i} login page styles` }],
    tools: [],
    grammar: PICK_GRAMMAR,
    thinkLevel: 'nothink',
    maxTokens: 100,
  });
  outs.push(response.content);
  if ((response.usage?.outputTokens ?? 999) < 20) small += 1;
}
console.log(`picks: ${outs.slice(0, 6).map((o) => JSON.stringify(o)).join(' ')} ...`);
console.log(`JSON ${JSON.stringify({ compactionParsed: `${parsed}/${nCompact}`, picksUnder20Tokens: `${small}/${nPick}` })}`);
