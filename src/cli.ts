#!/usr/bin/env node
import 'dotenv/config';
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { AnthropicProvider } from './providers/anthropic.js';
import { LocalProvider } from './providers/local.js';
import { MockProvider } from './providers/mock.js';
import type { LLMProvider } from './providers/types.js';
import { defaultTools } from './tools/index.js';
import { AgentLoop, type AgentEvent } from './agent/loop.js';
import { App } from './ui/App.js';
import { formatEvent } from './ui/formatEvent.js';
import { formatError } from './ui/formatError.js';

const SYSTEM_PROMPT = `You are o4c, the open4coding programming harness. You help the user with
software engineering tasks in their current directory. You have tools to read files, write files,
and run shell commands. Use them as needed to complete the user's request, then give a clear final answer.`;

function printEvent(event: AgentEvent): void {
  const line = formatEvent(event);
  if (!line) return;
  // tool_result prints directly under its tool_call, no separating blank line.
  process.stdout.write(event.type === 'tool_result' ? `${line}\n` : `\n${line}\n`);
}

function printError(err: unknown): void {
  console.error(`\n${formatError(err)}`);
}

async function runRepl(loop: AgentLoop, initialImage?: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(
      'Interactive mode requires a real terminal (TTY) - stdin appears to be piped or redirected.\n' +
        'Run this directly in a terminal, or pass a prompt for one-shot mode instead: o4c "your task"',
    );
    process.exitCode = 1;
    return;
  }
  const { waitUntilExit } = render(React.createElement(App, { loop, initialImage }));
  await waitUntilExit();
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
