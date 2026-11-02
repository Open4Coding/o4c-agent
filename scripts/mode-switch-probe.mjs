// Does a mode switch still cost a full re-process? (plan 0006 A5)
//
// Builds a long session (one big first message), then sends five short turns alternating between
// Plan and Auto mode instructions, through o4c's real AgentLoop and LocalProvider, and prints how
// many prompt tokens the server actually processed for each. Before A5 the mode instruction was
// part of the system prompt, so every switch re-processed the whole session.
//
// Usage: npm run build && node scripts/mode-switch-probe.mjs [approxTokens=100000]

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const O4C = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(O4C, 'dist', p)).href);
const { LocalProvider } = await imp('providers/local.js');
const { AgentLoop } = await imp('agent/loop.js');
const { modeSystemPrompt } = await imp('ui/modePolicy.js');

const cfg = (n) => {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.o4c', n), 'utf-8'));
  } catch {
    return {};
  }
};
const config = { ...cfg('config.json'), ...cfg('config.local.json') };
const tokens = Number(process.argv[2] ?? 100000);

let text = '';
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (text.length > tokens * 3.6) return;
    if (e.isDirectory()) walk(join(d, e.name));
    else if (e.name.endsWith('.ts')) text += `\n// FILE ${e.name}\n${readFileSync(join(d, e.name), 'utf-8')}`;
  }
};
walk(join(O4C, 'src'));

const provider = new LocalProvider({ baseUrl: config.baseUrl, apiKey: process.env.O4C_LOCAL_API_KEY ?? config.localApiKey, maxTokens: 64 });
const loop = new AgentLoop(provider, [], 'You are a terse assistant.');
const rows = [];
const run = async (label, prompt, mode) => {
  await loop.run(prompt, { modeInstruction: mode ? modeSystemPrompt(mode) : undefined, thinkLevel: 'nothink' });
  const u = loop.getUsage().last ?? {};
  rows.push({ label, prompt: u.inputTokens, cached: u.cachedTokens, processed: u.processedPromptTokens, prefillMs: Math.round(u.prefillMs ?? 0) });
  console.log(`${label.padEnd(14)} prompt ${u.inputTokens} cached ${u.cachedTokens} processed ${u.processedPromptTokens} prefill ${Math.round(u.prefillMs ?? 0)} ms`);
};

// o4c caps one user message at ~10% of the window, so the long session is built from four messages.
const quarter = Math.ceil(text.length / 4);
for (let i = 0; i < 4; i++) await run(`setup ${i + 1}`, `${text.slice(i * quarter, (i + 1) * quarter)}\n\nReply with OK.`, 'manual');
const modes = ['plan', 'auto', 'plan', 'auto', 'plan'];
for (const [i, m] of modes.entries()) await run(`switch ${i + 1} (${m})`, 'Reply with OK.', m);
const worst = Math.max(...rows.slice(4).map((r) => r.processed ?? Infinity));
console.log(`JSON ${JSON.stringify({ sessionPrompt: rows[3].prompt, worstProcessedAfterSwitch: worst, pass: worst <= 2000 })}`);
