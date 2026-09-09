#!/usr/bin/env node
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from './providers/anthropic.js';
import { LocalProvider } from './providers/local.js';
import { MockProvider } from './providers/mock.js';
import type { LLMProvider } from './providers/types.js';
import { defaultTools } from './tools/index.js';
import { AgentLoop, type AgentEvent } from './agent/loop.js';

const SYSTEM_PROMPT = `You are o4c, the open4coding programming harness. You help the user with
software engineering tasks in their current directory. You have tools to read files, write files,
and run shell commands. Use them as needed to complete the user's request, then give a clear final answer.`;

function printEvent(event: AgentEvent): void {
  if (event.type === 'text' && event.text) {
    process.stdout.write(`\n${event.text}\n`);
  } else if (event.type === 'tool_call') {
    process.stdout.write(`\n[tool] ${event.toolName}(${JSON.stringify(event.toolInput)})\n`);
  } else if (event.type === 'tool_result') {
    const preview = (event.toolOutput ?? '').slice(0, 200);
    process.stdout.write(`[result] ${preview}${(event.toolOutput ?? '').length > 200 ? '...' : ''}\n`);
  }
}

function printError(err: unknown): void {
  if (err instanceof Anthropic.APIError) {
    console.error(`\nAnthropic API error (status ${err.status ?? 'unknown'}): ${err.message}`);
  } else {
    console.error(`\nUnexpected error: ${(err as Error).message}`);
  }
}

async function runRepl(loop: AgentLoop, initialImage?: string): Promise<void> {
  process.stdout.write(
    'o4c interactive session. Type your request, or /reset to clear history, /exit to quit.\n',
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write('\n> ');

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      process.stdout.write('\n> ');
      continue;
    }
    if (input === '/exit' || input === '/quit') break;
    if (input === '/reset') {
      loop.reset();
      process.stdout.write('History cleared.\n\n> ');
      continue;
    }

    try {
      const finalAnswer = await loop.run(input, {
        images: initialImage ? [initialImage] : undefined,
        onEvent: printEvent,
      });
      process.stdout.write(`\n--- final ---\n${finalAnswer}\n`);
    } catch (err) {
      printError(err);
    }
    process.stdout.write('\n> ');
  }

  rl.close();
}

const program = new Command();

program
  .name('o4c')
  .description('open4coding programming harness')
  .version('0.0.1')
  .argument('[prompt...]', 'the task to ask the harness to perform; omit to start an interactive session')
  .option('-m, --model <model>', 'model to use', 'claude-opus-5')
  .option(
    '-p, --provider <name>',
    'LLM provider to use: "anthropic" (real, costs money), "local" (self-hosted llama-server), or "mock" (free, no API key, for development)',
    'anthropic',
  )
  .option('--base-url <url>', 'base URL for the "local" provider', 'http://localhost:8080')
  .option('--image <path>', 'path to an image file to attach (vision-capable providers only)')
  .action(async (promptParts: string[], opts: { model: string; provider: string; baseUrl: string; image?: string }) => {
    const prompt = promptParts.join(' ');

    let provider: LLMProvider;
    if (opts.provider === 'mock') {
      provider = new MockProvider();
    } else if (opts.provider === 'local') {
      provider = new LocalProvider({ baseUrl: opts.baseUrl });
    } else if (opts.provider === 'anthropic') {
      try {
        provider = new AnthropicProvider({ model: opts.model });
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
    } else {
      console.error(`Unknown provider "${opts.provider}". Use "anthropic", "local", or "mock".`);
      process.exitCode = 1;
      return;
    }

    const loop = new AgentLoop(provider, defaultTools, SYSTEM_PROMPT);

    if (!prompt) {
      await runRepl(loop, opts.image);
      return;
    }

    try {
      const finalAnswer = await loop.run(prompt, {
        images: opts.image ? [opts.image] : undefined,
        onEvent: printEvent,
      });

      process.stdout.write(`\n--- final ---\n${finalAnswer}\n`);
    } catch (err) {
      printError(err);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
