#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from './providers/anthropic.js';
import { MockProvider } from './providers/mock.js';
import type { LLMProvider } from './providers/types.js';
import { defaultTools } from './tools/index.js';
import { AgentLoop } from './agent/loop.js';

const SYSTEM_PROMPT = `You are o4c, the open4coding programming harness. You help the user with
software engineering tasks in their current directory. You have tools to read files, write files,
and run shell commands. Use them as needed to complete the user's request, then give a clear final answer.`;

const program = new Command();

program
  .name('o4c')
  .description('open4coding programming harness')
  .version('0.0.1')
  .argument('<prompt...>', 'the task to ask the harness to perform')
  .option('-m, --model <model>', 'model to use', 'claude-opus-5')
  .option(
    '-p, --provider <name>',
    'LLM provider to use: "anthropic" (real, costs money) or "mock" (free, no API key, for development)',
    'anthropic',
  )
  .action(async (promptParts: string[], opts: { model: string; provider: string }) => {
    const prompt = promptParts.join(' ');

    let provider: LLMProvider;
    if (opts.provider === 'mock') {
      provider = new MockProvider();
    } else if (opts.provider === 'anthropic') {
      try {
        provider = new AnthropicProvider({ model: opts.model });
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
    } else {
      console.error(`Unknown provider "${opts.provider}". Use "anthropic" or "mock".`);
      process.exitCode = 1;
      return;
    }

    const loop = new AgentLoop(provider, defaultTools, SYSTEM_PROMPT);

    try {
      const finalAnswer = await loop.run(prompt, {
        onEvent: (event) => {
          if (event.type === 'text' && event.text) {
            process.stdout.write(`\n${event.text}\n`);
          } else if (event.type === 'tool_call') {
            process.stdout.write(`\n[tool] ${event.toolName}(${JSON.stringify(event.toolInput)})\n`);
          } else if (event.type === 'tool_result') {
            const preview = (event.toolOutput ?? '').slice(0, 200);
            process.stdout.write(`[result] ${preview}${(event.toolOutput ?? '').length > 200 ? '...' : ''}\n`);
          }
        },
      });

      process.stdout.write(`\n--- final ---\n${finalAnswer}\n`);
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        console.error(`\nAnthropic API error (status ${err.status ?? 'unknown'}): ${err.message}`);
      } else {
        console.error(`\nUnexpected error: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
