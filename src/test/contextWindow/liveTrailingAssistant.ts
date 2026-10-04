// Live check, run by hand (not part of npm test): does llama-server continue a trailing assistant
// message, or does it treat that turn as finished? Both LocalProvider and the loop send a cut-off
// response this way after a max_tokens cutoff (see the phase-1 status in docs/plans/0003).
//
// Usage: npx tsx src/test/contextWindow/liveTrailingAssistant.ts [baseUrl]
// The API key is read from O4C_LOCAL_API_KEY and is never printed.

const baseUrl = process.argv[2] ?? 'http://localhost:8080';
const apiKey = process.env.O4C_LOCAL_API_KEY;
const RUNS = 3;

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const system: Message = { role: 'system', content: 'You are a helpful assistant.' };
const question: Message = { role: 'user', content: 'Give three facts about the Moon as a numbered list.' };
const cutOff: Message = {
  role: 'assistant',
  content: 'Here are three facts about the Moon:\n1. The Moon is about',
};

const variants: Record<string, Message[]> = {
  'A trailing assistant (what the loop sends now)': [system, question, cutOff],
  'B same, plus a user "continue" turn': [
    system,
    question,
    cutOff,
    { role: 'user', content: 'Continue with the task.' },
  ],
};

interface Result {
  finishReason: string;
  content: string;
  reasoningChars: number;
  completionTokens: number;
}

async function complete(messages: Message[]): Promise<Result> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ messages, max_tokens: 200, stream: false }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as {
    choices: Array<{
      finish_reason: string;
      message: { content: string | null; reasoning_content?: string | null };
    }>;
    usage?: { completion_tokens?: number };
  };
  const choice = body.choices[0];
  return {
    finishReason: choice.finish_reason,
    content: choice.message.content ?? '',
    reasoningChars: (choice.message.reasoning_content ?? '').length,
    completionTokens: body.usage?.completion_tokens ?? -1,
  };
}

console.log(`server: ${baseUrl}  key: ${apiKey ? 'set' : 'not set'}  runs per variant: ${RUNS}\n`);

for (const [label, messages] of Object.entries(variants)) {
  console.log(label);
  for (let run = 1; run <= RUNS; run++) {
    try {
      const r = await complete(messages);
      const preview = r.content.replace(/\s+/g, ' ').slice(0, 140);
      console.log(
        `  run ${run}: finish=${r.finishReason} tokens=${r.completionTokens} ` +
          `reasoningChars=${r.reasoningChars} contentChars=${r.content.length}`,
      );
      console.log(`         "${preview}"`);
    } catch (err) {
      console.log(`  run ${run}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log('');
}

console.log(
  'Reading it: a continuation starts mid-sentence ("...is about 384,400 km away"). ' +
    'A closed turn gives finish=stop with tiny or empty content, or a new unrelated opening.',
);
