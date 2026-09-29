#!/usr/bin/env node
import 'dotenv/config';
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { AnthropicProvider } from './providers/anthropic.js';
import { LocalProvider, fetchLocalModelId, fetchLocalContextWindow } from './providers/local.js';
import { MockProvider } from './providers/mock.js';
import type { LLMProvider, Message } from './providers/types.js';
import { defaultTools } from './tools/index.js';
import { AgentLoop, type AgentEvent } from './agent/loop.js';
import { toWireMessages } from './agent/contextEntry.js';
import { SessionStore } from './session/sessionStore.js';
import { RunLogger } from './session/runLog.js';
import { ensureTrusted, resolveO4cMd, sessionsDirFor, logsDirFor } from './session/projectContext.js';
import { ConfigStore } from './session/configStore.js';
import { App } from './ui/App.js';
import { installResizeReflowFix } from './ui/resizeReflowFix.js';
import { theme } from './ui/theme.js';
import { formatEvent } from './ui/formatEvent.js';
import { formatError } from './ui/formatError.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultLogsDir } from './session/runLog.js';

/**
 * Installed at module load, before anything else runs, so it's live for the entire process
 * lifetime - including startup work before a project/logs directory is even known. Writes to a
 * single fixed, always-discoverable file (not the per-run timestamped convention runLogger/
 * fullContextLogger use - a crash is rare enough that one persistent, append-only file is more
 * useful than hunting across timestamped ones), independent of node_modules/self-contained (no
 * RunLogger dependency) so this can't itself fail the way it exists to catch.
 *
 * unhandledRejection: does NOT exit - per Node's own docs, a rejection alone doesn't corrupt
 * process state the way a thrown exception can, so continuing is safe and is exactly what every
 * `void logger.log(...)` fire-and-forget call in this codebase already assumes. Logged here as a
 * last-resort net for anything that manages to escape the try/catch RunLogger.log() itself now
 * has (see its own doc comment) or any other future fire-and-forget call.
 *
 * uncaughtException: DOES exit after logging - Node's own guidance is that continuing after an
 * uncaught exception is unsafe (unknown/partial state), so this only buys a chance to record
 * what happened before the process goes down anyway, not a way to survive it.
 */
function logCrash(kind: string, err: unknown): Promise<void> {
  return (async () => {
    try {
      const dir = defaultLogsDir();
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        type: kind,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await appendFile(join(dir, 'crash.log'), `${line}\n`, 'utf-8');
    } catch {
      // Truly nothing left to do - this function exists to catch failures, it can't itself have
      // a failure path that matters.
    }
  })();
}

process.on('unhandledRejection', (reason) => {
  void logCrash('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  void logCrash('uncaughtException', err).finally(() => process.exit(1));
});

interface RestartableOpts {
  model: string;
  provider: string;
  baseUrl: string;
  image?: string;
}

/**
 * /clear and /resume both hand off to a brand-new process instead of resetting state
 * in-place - the only way to get a genuinely clear screen. A real ESC[2J mid-session was tried
 * and rejected (see resizeReflowFix.ts's doc comment): on Windows Terminal it scrolls the stale
 * frame into scrollback instead of erasing it. Done once at a fresh process's cold start, before
 * Ink ever renders, there's no live frame to corrupt - it's the same "scroll old content out of
 * view" every `clear`/`cls` does.
 *
 * Blocking (spawnSync), not fire-and-forget: an async spawn() followed immediately by
 * process.exit() races the OS on Windows - this process can exit before CreateProcess finishes
 * duplicating the inherited stdio handles into the child, so the child silently never starts and
 * control just falls back to the shell. Blocking until the child itself exits (recursively, if
 * IT restarts too) has no such race and costs nothing - this process has nothing left to do but
 * wait anyway.
 */
function spawnRestart(opts: RestartableOpts, resumeId: string | undefined): number {
  const args = ['-m', opts.model, '-p', opts.provider, '--base-url', opts.baseUrl];
  if (opts.image) args.push('--image', opts.image);
  if (resumeId) args.push('--resume', resumeId);
  const result = spawnSync(process.execPath, [process.argv[1], ...args], {
    stdio: 'inherit',
    env: { ...process.env, O4C_FRESH_SCREEN: '1' },
  });
  return result.status ?? 0;
}

const SYSTEM_PROMPT = `You are o4c, the open4coding programming harness. You help the user with
software engineering tasks in their current directory. You have tools to read files, write files,
and run shell commands. Use them as needed to complete the user's request, then give a clear final answer.`;

function printEvent(event: AgentEvent): void {
  // Raw streamed text, written as-is with no line wrapping - the natural way to show streaming
  // output in a plain terminal. 'think'/'text' (the same content, but complete and formatted)
  // are skipped below since this already printed it live, character by character.
  if (event.type === 'delta') {
    if (event.text) process.stdout.write(event.text);
    return;
  }
  // Only skipped when this call's content actually streamed live via 'delta' - see App.tsx's
  // identical fallback reasoning for why `streamed` (not just the event type) gates this.
  if ((event.type === 'think' || event.type === 'text') && event.streamed) return;

  const line = formatEvent(event);
  if (!line) return;
  // tool_result prints directly under its tool_call, no separating blank line.
  process.stdout.write(event.type === 'tool_result' ? `${line}\n` : `\n${line}\n`);
}

function printError(err: unknown): void {
  console.error(`\n${formatError(err)}`);
}

async function runRepl(
  loop: AgentLoop,
  projectRoot: string | undefined,
  sessionStore: SessionStore,
  opts: RestartableOpts,
  contextWindow: number | undefined,
  highlightColor: string,
  maxIterations: number | undefined,
  initialSession?: { id: string; title: string; messages: Message[]; inputHistory?: string[] },
): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(
      'Interactive mode requires a real terminal (TTY) - stdin appears to be piped or redirected.\n' +
        'Run this directly in a terminal, or pass a prompt for one-shot mode instead: o4c "your task"',
    );
    process.exitCode = 1;
    return;
  }
  // Set only by spawnRestart, on the process it just spawned - cleared immediately so it doesn't
  // survive into anything this process itself spawns later.
  if (process.env.O4C_FRESH_SCREEN === '1') {
    delete process.env.O4C_FRESH_SCREEN;
    process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
  }
  const runLogger = new RunLogger(logsDirFor(projectRoot));
  // Per-session wire-level transcript - every full request sent to the provider and every full
  // response, plus tool calls/results - distinct from runLogger's own already-derived AgentEvent
  // stream above. Same one-file-per-run directory/timestamp convention, just suffixed so it never
  // collides with runLogger's own file.
  const fullContextLogger = new RunLogger(logsDirFor(projectRoot), 'FULLCONTEXT');
  // Must be installed before render() so it sees Ink's very first frame - see the module's own
  // doc comment for the bug this works around.
  installResizeReflowFix(process.stdout);
  let pendingRestart: { resumeId: string | undefined } | undefined;
  const restart = (resumeId?: string) => {
    pendingRestart = { resumeId };
  };
  const { waitUntilExit } = render(
    React.createElement(App, {
      loop,
      initialImage: opts.image,
      sessionStore,
      runLogger,
      fullContextLogger,
      initialSession,
      restart,
      projectRoot,
      model: opts.model,
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      contextWindow,
      maxIterations,
      initialHighlightColor: highlightColor,
    }),
    {
      // Opt-in, off by default (confirmed in ink's own source: does nothing unless set). 'auto'
      // safely queries the terminal (CSI ? u, 200ms timeout) and only turns the protocol on if
      // it actually answers - harmless no-op on terminals that don't support it. Windows
      // Terminal only answers on Preview 1.25+, not stable, so this may or may not do anything
      // on any given machine. The default 'disambiguateEscapeCodes' flag is exactly what's
      // needed to tell Shift+Tab apart from plain Tab (previously confirmed via raw-byte probe
      // to send identical bytes without this) and, later, Ctrl+Enter/Alt+Enter/Shift+Enter
      // apart from plain Enter for #4a's newline-insertion keybinding.
      kittyKeyboard: { mode: 'auto' },
      // Ink's own graceful Ctrl+C exit is still off - it was landing inconsistently (reports of
      // the process surviving it instead of actually terminating) and collided with a still-
      // running turn's request being in flight with no coordinated cleanup between Ink's own exit
      // path and cli.ts's process.exit() below. /exit and Escape (for a running turn specifically
      // - see App.tsx's handleEscape) remain the graceful ways to stop something. Ctrl+C itself is
      // NOT a no-op though (re-added 2026-09-26, App.tsx's own always-active hook): it's now a
      // hard, unconditional `process.exit()` - the deliberate difference from Ink's removed
      // mechanism is that it doesn't try to shut down gracefully at all, so there's nothing left
      // to race against a still-running turn.
      exitOnCtrlC: false,
    },
  );
  await waitUntilExit();
  if (pendingRestart) {
    process.exit(spawnRestart(opts, pendingRestart.resumeId));
  }
  // Without an explicit exit, a lingering open handle (most likely a keep-alive socket from an
  // in-flight or just-finished fetch to the local model server) can keep the event loop alive
  // well after the UI itself has unmounted, making /exit feel like it needs pressing twice.
  process.exit(process.exitCode ?? 0);
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
  .option(
    '--base-url <url>',
    'base URL for the "local" provider. If that server requires an API key, set O4C_LOCAL_API_KEY in the environment (no CLI flag, to keep it out of process listings)',
    'http://localhost:8080',
  )
  .option('--image <path>', 'path to an image file to attach (vision-capable providers only)')
  .option('--resume <sessionId>', 'resume a saved session by id (used internally by /resume)')
  .option(
    '--profile <name>',
    'named preset (~/.o4c/profiles/<name>.json) to seed this project\'s config.json from on first trust - only has an effect the one time a project is first trusted; ignored on an already-trusted project. See "o4c-agent-design.md" §1.5/§5.',
  )
  .action(async (promptParts: string[], opts: RestartableOpts & { resume?: string; profile?: string }) => {
    const prompt = promptParts.join(' ');

    // The trust gate: a project that has never used o4c before (no .o4c/ anywhere above cwd) gets
    // asked once, interactively, before anything else happens - including before any project-level
    // o4c.md is read, since that content is attacker-controlled text from whoever's repo this is
    // until the user has actually said they trust it. --profile only matters on this first trust;
    // ensureTrusted itself ignores it entirely once a project already has a .o4c/ (returns early,
    // never even looks at the parameter).
    const cwd = process.cwd();
    const { trusted, projectRoot } = await ensureTrusted(cwd, undefined, undefined, opts.profile);
    const projectContext = trusted ? await resolveO4cMd(cwd, projectRoot) : '';
    const systemPrompt = projectContext ? `${SYSTEM_PROMPT}\n\n${projectContext}` : SYSTEM_PROMPT;

    // An explicit CLI flag always wins; otherwise fall back to the resolved config.json (global
    // -> local -> personal, see configStore.ts), and only then to the option's own hardcoded
    // default. getOptionValueSource distinguishes "user typed --model" from "commander filled in
    // the default" - without it there'd be no way to tell an explicit `-p anthropic` apart from
    // config.json quietly wanting `-p local` instead.
    const configStore = new ConfigStore(trusted ? projectRoot : undefined);
    const resolvedConfig = await configStore.resolve();
    function configOr(optName: 'model' | 'provider' | 'baseUrl', cliValue: string): string {
      if (program.getOptionValueSource(optName) !== 'default') return cliValue;
      const configValue = resolvedConfig[optName];
      return typeof configValue === 'string' ? configValue : cliValue;
    }
    opts = {
      ...opts,
      model: configOr('model', opts.model),
      provider: configOr('provider', opts.provider),
      baseUrl: configOr('baseUrl', opts.baseUrl),
    };
    // No CLI flag for this on purpose (same reasoning as O4C_LOCAL_API_KEY - keeps it out of
    // process listings). config.json read here on every launch/restart, so unlike model/provider/
    // baseUrl above it's never frozen into spawnRestart's argv - a key rotated in config.local.json
    // takes effect on the very next run without needing anything re-threaded through opts.
    // config.local.json (personal, always gitignored - see configStore.ts) is the right scope for
    // this, never the shared config.json.
    const localApiKey =
      typeof resolvedConfig.localApiKey === 'string' ? resolvedConfig.localApiKey : undefined;
    // Manually-configured override - still wins over auto-detection below when set (front-end
    // plan item #8's own scope note: proceed with auto-detected-only for now, no override command
    // yet, but a hand-set config value should still take precedence over whatever gets detected).
    const configuredContextWindow =
      typeof resolvedConfig.contextWindow === 'number' ? resolvedConfig.contextWindow : undefined;
    // /config-highlightcolor (+ -local-/-global-, App.tsx) - read fresh on every launch/restart,
    // same "config.json only, re-read each time" shape as localApiKey above. Defaults to the
    // amber theme's own accent rather than an arbitrary color, since that's what the rest of the
    // UI already uses everywhere else.
    const highlightColor =
      typeof resolvedConfig.highlightColor === 'string' ? resolvedConfig.highlightColor : theme.accent;
    // Opt-in only, same "no CLI flag, config.json only" shape as localApiKey/contextWindow above -
    // extended thinking has a real token-cost impact (thinking tokens are billed as output), so
    // this is never turned on silently. Anthropic-only; harmless (just unread) for other providers.
    const validThinkingEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    const anthropicThinkingEffort =
      typeof resolvedConfig.anthropicThinkingEffort === 'string' &&
      (validThinkingEfforts as readonly string[]).includes(resolvedConfig.anthropicThinkingEffort)
        ? (resolvedConfig.anthropicThinkingEffort as (typeof validThinkingEfforts)[number])
        : undefined;
    // Opt-in only, same "no CLI flag, config.json only" shape as the others above. Undefined
    // (unset) falls back to each provider's own default (see local.ts's DEFAULT_CONNECT_TIMEOUT_MS/
    // DEFAULT_IDLE_TIMEOUT_MS, and anthropic.ts's DEFAULT_TIMEOUT_MS) rather than forcing one
    // number everywhere - a local model's real generation speed varies by hardware, a cloud API's
    // mostly doesn't. connectTimeoutMs also doubles as Anthropic's own single request timeout
    // (its SDK-managed stream doesn't need the connect/idle split LocalProvider does - a cloud API
    // doesn't sit behind PHOEBE's own --parallel 1 queuing the way a second local tool would) -
    // except for 0/negative ("no timeout," LocalProvider's own opt-out), which is deliberately
    // NOT forwarded to Anthropic - see the AnthropicProvider construction below for why.
    const connectTimeoutMs =
      typeof resolvedConfig.connectTimeoutMs === 'number' ? resolvedConfig.connectTimeoutMs : undefined;
    const idleTimeoutMs =
      typeof resolvedConfig.idleTimeoutMs === 'number' ? resolvedConfig.idleTimeoutMs : undefined;
    // Opt-in only, same "no CLI flag, config.json only" shape as the others above - see
    // AgentLoop.run()'s own RunOptions.maxIterations doc comment (0/negative = no cap at all).
    // Undefined falls back to AgentLoop's own default (25) unchanged. Real need found via direct
    // user report: a long autonomous research turn against a local model (PHOEBE) hit the default
    // cap ("stopped after 25 iterations without a final answer") well before it was actually done -
    // 25 is a reasonable safety default, not a real ceiling for long, unattended tool-call chains.
    const maxIterations =
      typeof resolvedConfig.maxIterations === 'number' ? resolvedConfig.maxIterations : undefined;
    // Front-end plan item #9: SessionStore's own retention cap (was a hardcoded MAX_SESSIONS=20),
    // now settable via /set-sessionsToSave (+ -local-/-global-, App.tsx) - same
    // "config.json only, re-read fresh on every launch/restart" shape as the others above.
    // Undefined (unset) falls back to SessionStore's own DEFAULT_MAX_SESSIONS, unchanged.
    const sessionsToSave =
      typeof resolvedConfig.sessionsToSave === 'number' ? resolvedConfig.sessionsToSave : undefined;

    // The `-m`/`--model` value means nothing to LocalProvider - it never sends a `model` field
    // at all (llama-server only ever has one model loaded). Without this, the status bar and
    // `/context` would display whatever opts.model happened to default to (the CLI's hardcoded
    // Anthropic default, unrelated to what's actually being talked to) instead of the real
    // served model - real bug, found via direct user report. Best-effort: on any failure to
    // reach the server, opts.model (whatever it already was) is left unchanged rather than
    // blocking startup on it. Run alongside the context-window probe below (Promise.all, not
    // sequential awaits) - two independent, best-effort GETs against the same server, no reason
    // to pay their latency twice at startup.
    let autoContextWindow: number | undefined;
    if (opts.provider === 'local') {
      const [detectedModel, detectedContextWindow] = await Promise.all([
        fetchLocalModelId(opts.baseUrl, localApiKey),
        fetchLocalContextWindow(opts.baseUrl, localApiKey),
      ]);
      if (detectedModel) opts = { ...opts, model: detectedModel };
      autoContextWindow = detectedContextWindow;
    }
    // Front-end plan item #8: auto-detected max context, not a guess or a required manual value -
    // a manually-configured contextWindow (above) still wins when set. Local comes from the real
    // probe just above (confirmed live against PHOEBE's /props); Anthropic has no equivalent query
    // endpoint, so this falls back to the flat 200K every current Claude model actually has
    // (matches cc's own MODEL_CONTEXT_WINDOW_DEFAULT fallback, confirmed directly against its
    // source during this project's own context-window research) rather than guessing per model id.
    // 'mock' gets no default - a test/dev provider has no real window to report.
    const ANTHROPIC_DEFAULT_CONTEXT_WINDOW = 200_000;
    const contextWindow =
      configuredContextWindow ??
      autoContextWindow ??
      (opts.provider === 'anthropic' ? ANTHROPIC_DEFAULT_CONTEXT_WINDOW : undefined);
    // Half the configured context window, not the flat 4096 both providers used to hardcode -
    // that flat cap was unrelated to the model's real budget and silently truncated any turn
    // whose <think> reasoning alone ran past it (real bug, found via direct reproduction against
    // PHOEBE: the turn just ended with an empty answer, no error). Undefined (no contextWindow
    // known at all) falls back to each provider's own pre-existing default.
    const providerMaxTokens = contextWindow ? Math.floor(contextWindow / 2) : undefined;

    let provider: LLMProvider;
    if (opts.provider === 'mock') {
      provider = new MockProvider();
    } else if (opts.provider === 'local') {
      provider = new LocalProvider({
        baseUrl: opts.baseUrl,
        apiKey: localApiKey,
        maxTokens: providerMaxTokens,
        connectTimeoutMs,
        idleTimeoutMs,
      });
    } else if (opts.provider === 'anthropic') {
      try {
        provider = new AnthropicProvider({
          model: opts.model,
          thinkingEffort: anthropicThinkingEffort,
          maxTokens: providerMaxTokens,
          // 0/negative here means "no timeout" to LocalProvider (its own opt-out, see its
          // DEFAULT_*_TIMEOUT_MS comment) - NOT forwarded to the Anthropic SDK, which has no such
          // concept: confirmed directly against its source (validatePositiveInteger in
          // @anthropic-ai/sdk/internal/utils/values.js) that a negative timeout throws outright
          // and 0 arms a near-instant one, neither anything like "disabled." Anthropic just keeps
          // its own sane default (DEFAULT_TIMEOUT_MS in anthropic.ts) in that case instead.
          timeoutMs: connectTimeoutMs && connectTimeoutMs > 0 ? connectTimeoutMs : undefined,
        });
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

    const loop = new AgentLoop(provider, defaultTools, systemPrompt);

    if (!prompt) {
      const sessionStore = new SessionStore(sessionsDirFor(projectRoot), sessionsToSave);
      let initialSession: { id: string; title: string; messages: Message[]; inputHistory?: string[] } | undefined;
      if (opts.resume) {
        const data = await sessionStore.load(opts.resume);
        if (!data) {
          console.error(`Could not find a saved session with id "${opts.resume}".`);
          process.exitCode = 1;
          return;
        }
        loop.loadEntries(data.entries);
        initialSession = {
          id: data.id,
          title: data.title,
          messages: toWireMessages(data.entries),
          inputHistory: data.inputHistory,
        };
      }
      await runRepl(
        loop,
        projectRoot,
        sessionStore,
        opts,
        contextWindow,
        highlightColor,
        maxIterations,
        initialSession,
      );
      return;
    }

    try {
      const finalAnswer = await loop.run(prompt, {
        images: opts.image ? [opts.image] : undefined,
        onEvent: printEvent,
        maxIterations,
      });

      process.stdout.write(`\n--- final ---\n${finalAnswer}\n`);
    } catch (err) {
      printError(err);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
