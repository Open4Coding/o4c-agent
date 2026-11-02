// Reasoning soft landing and the "answer now" control (plan 0006 A17), against the real server.
// 1) N prompts known to send Qwen into endless thinking, at a bounded level: each must still end
//    with a non-empty answer. 2) An unbounded request: after a few seconds of reasoning, endReasoning()
//    is called and the first answer token must follow quickly.
// Usage: npm run build && node scripts/reasoning-probe.mjs [n=10] [level=low]

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
const n = Number(process.argv[2] ?? 10);
const level = process.argv[3] ?? 'low';
const prompts = [
  'Write a complete standard HTML5 boilerplate page with a header, nav, main and footer.',
  'Implement a thread-safe LRU cache in Python with O(1) get and put, with a docstring.',
  'Write a bash script that backs up a directory to a dated tar.gz and keeps the last 7.',
  'Design a REST API for a todo app: list the endpoints and their JSON bodies.',
  'Write a TypeScript debounce function with proper generic types and a test.',
  'Explain the difference between a mutex and a semaphore with a short code example.',
  'Write a SQL schema for a library: books, authors, loans, members, with keys.',
  'Write a Python function that parses ISO 8601 durations like P3DT4H into seconds.',
  'Create a minimal Express server with one GET and one POST route and error handling.',
  'Write a regex that validates IPv4 addresses and explain each part.',
];
const provider = new LocalProvider({ baseUrl: config.baseUrl, apiKey: process.env.O4C_LOCAL_API_KEY ?? config.localApiKey, maxTokens: 6000 });

let answered = 0;
for (const prompt of prompts.slice(0, n)) {
  let thinkChars = 0;
  const r = await provider.complete({
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    thinkLevel: level,
    maxTokens: 6000,
    onToken: (d, kind) => {
      if (kind === 'think') thinkChars += d.length;
    },
  });
  const ok = r.content.trim().length > 0;
  answered += ok ? 1 : 0;
  console.log(`${ok ? 'answer' : 'EMPTY '} think ${thinkChars} chars, answer ${r.content.length} chars - ${prompt.slice(0, 50)}`);
}

// 2) the control
let sawThink = 0;
let ended = false;
let endedAt = 0;
let firstAnswerAt = 0;
const t0 = Date.now();
const done = provider.complete({
  messages: [{ role: 'user', content: 'Prove that there are infinitely many primes, then list the first 40 primes with a check of each.' }],
  tools: [],
  thinkLevel: 'xhigh',
  maxTokens: 12000,
  onToken: (d, kind) => {
    if (kind === 'think') {
      sawThink += d.length;
      if (!ended && Date.now() - t0 > 6000) {
        ended = true;
        endedAt = Date.now();
        void provider.endReasoning().then((okEnd) => console.log(`control accepted: ${okEnd}`));
      }
    } else if (!firstAnswerAt && d.trim()) firstAnswerAt = Date.now();
  },
});
const r = await done;
console.log(`control: thought ${sawThink} chars, first answer token ${firstAnswerAt && endedAt ? ((firstAnswerAt - endedAt) / 1000).toFixed(1) + ' s after the control' : 'n/a'}, answer ${r.content.length} chars`);
console.log(`JSON ${JSON.stringify({ answered: `${answered}/${n}`, controlLatencyS: firstAnswerAt && endedAt ? +((firstAnswerAt - endedAt) / 1000).toFixed(1) : null })}`);
