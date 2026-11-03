#!/usr/bin/env node
import 'dotenv/config';
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { RESTART_EXIT_CODE, buildRestartArgs, runSupervisor, writeHandoff } from './restartHandoff.js';
import { parseWindowSetting, windowArgFor } from './ui/windowSetting.js';
import { MODES, type Mode } from './ui/modePolicy.js';
import { parseSessionView, type SessionView } from './ui/formatEntries.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { LocalProvider, probeLocalServer, probeThinkCaps, type LocalReasoningReplay, type ServerProbe, type ServerStatus } from './providers/local.js';
import { MockProvider } from './providers/mock.js';
import type { LLMProvider, Message } from './providers/types.js';
import { defaultTools } from './tools/index.js';
import { AgentLoop, type AgentEvent } from './agent/loop.js';
import { toWireMessages, type ContextEntry } from './agent/contextEntry.js';
import { SessionStore } from './session/sessionStore.js';
import { RunLogger, createProviderCallLogger } from './session/runLog.js';
import { buildSystemPrompt, PROMPT_PROFILE_CONFIG_KEY, promptProfileFor } from './agent/systemPrompt.js';
import { registerSecret, setPassKeysToShell } from './session/redact.js';
import { setPinnedCommands } from './ui/slashCommand.js';
import { SHOW_TIPS_KEY, TIP_COUNTER_KEY, tipFor } from './ui/tips.js';
import { defaultProvider } from './session/providerDefault.js';
import { runEvalCli, STATS_MARK } from './eval/evalRunner.js';
import { setSyntaxCheckMode } from './tools/syntaxCheck.js';
import { setShellTimeoutDefault } from './tools/runShell.js';
import { currentShell, setShell, SHELL_CONFIG_KEY, shellPromptLine } from './tools/shell.js';
import { describeJob, killOwnedJobs, setJobsDir, unreportedFinished } from './tools/jobs.js';
import { fileStateComponent, fileStatePath } from './session/fileState.js';
import { checkpointComponent, ShadowGit, type CheckpointHooks } from './session/checkpoints.js';
import { evaluateRules, loadRules } from './session/permissionRules.js';
import { destructiveReason, splitShellSegments } from './tools/interactive.js';
import { loadO4cIgnore, o4cIgnoreComponent } from './tools/o4cIgnore.js';
import { subdirInstructionsComponent } from './session/instructionFiles.js';
import { createRememberTool, memoriesComponent, openGlobalMemories, setActiveMemoryStores, type MemoryStores } from './session/memories.js';
import { setRecentTasksSource } from './session/reflect.js';
import { ensureTrusted, findProjectRootSync, logsDirFor, resolveO4cMd, sessionsDirFor, usageFileFor, toolOutputDirFor } from './session/projectContext.js';
import { recordLifecycle } from './lifecycleLog.js';
import { globalUsageFile, UsageStore } from './session/usageStore.js';
import { latestSession, startupLine } from './session/sessionExtras.js';
import { modelEntry } from './session/modelRegistry.js';
import { RetryingProvider } from './providers/retry.js';
import { CUSTOM_MODE_KEY, parseCustomModes, setCustomModes } from './ui/customModes.js';
import { logRotationSettings, pruneRunLogs } from './session/logRotation.js';
import { loadSkills, setSkills, skillGate, skillListing } from './session/skills.js';
import { createTaskTool, loadProfiles, setTaskPolicy, setTaskRuntime } from './agent/subAgents.js';
import { HistoryRecorder } from './session/historyRecorder.js';
import type { PolicyAnswer } from './agent/loop.js';
import type { Tool } from './tools/types.js';

/** Sets the sub-agents' policy (G4) to the one this run uses, and returns it unchanged. */
function withTaskPolicy(policy: (tool: Tool, input: Record<string, unknown>) => Promise<PolicyAnswer>) {
  setTaskPolicy(policy);
  return policy;
}
import { hasHooks, hookProblems, hooksConfig, parseHooks, postToolHooksComponent, preToolHookVerdict, runHooks, setHooks } from './session/hooks.js';
import { loadCredentials } from './session/credentials.js';
import { parseSearchConfig, setWebOptions } from './tools/web.js';
import { createProvider, parseProviderSpecs } from './providers/factory.js';
import { applyPendingRestore, dbDirsFor } from './session/dbBackup.js';
import { EDITOR_CONFIG_KEY } from './ui/externalEditor.js';
import { setTaskCountSource } from './ui/statsReport.js';
import { ConfigStore } from './session/configStore.js';
import { secureModeFromScopes, secureModeProviderRefusal } from './session/secureMode.js';
import { startMcpSession, type McpSession } from './mcp/startup.js';
import { startCodeGraph, type CodeGraphSession } from './graph/startup.js';
import { startHistory } from './session/historyStartup.js';
import {
  CONTEXT_WINDOW_TYPE_CONFIG_KEY,
  CURATED_RECENT_EXCHANGES,
  CURATED_RECENT_FRACTION,
  contextWindowTypeControl,
  curatedBudgetTokens,
  historySearchAllowed,
  MODEL_INITIATED_SEARCHES_KEY,
  type ContextWindowType,
  type ContextWindowTypeControl,
} from './agent/contextWindowType.js';
import { contextTypeComponent } from './agent/contextTypeComponent.js';
import { HistoryRetrieval } from './session/retrieval.js';
import { createHistoryTool } from './session/historyTool.js';
import { createPlanTool } from './session/planTool.js';
import { importPlanFiles } from './session/planImport.js';
import type { PlanHooks } from './session/planAuthoring.js';
import { gatherUltraplanResearch } from './session/ultraplanResearch.js';
import { planContextComponent } from './session/planContext.js';
import { curatedHistory } from './session/curated.js';
import { markIncorrectCommand, markWorkedCommand, setIncorrectMarker } from './session/workedCommand.js';
import { contextWindowTypeFromConfig } from './ui/contextWindowSetting.js';
import { TAB_HINT_RUNS_KEY, decideTabHint } from './ui/tabHint.js';
import {
  DEFAULT_THINK_LEVEL,
  THINK_LEVEL_CONFIG_KEY,
  savedThinkBudget,
  setThinkBudgetOverride,
  parseThinkLevel,
  type ThinkCaps,
  type ThinkLevel,
} from './agent/thinkLevel.js';

/** `config.json` key caching each model's probed reasoning capabilities, so the startup check
 * runs once per model rather than at every launch. */
const THINK_CAPS_CONFIG_KEY = 'thinkCapsByModel';

/** Validates a cached capability record before trusting it - a hand-edited or stale config must
 * not make every request fail with an effort string the template rejects. */
function isThinkCaps(value: unknown): value is ThinkCaps {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    Array.isArray(c.efforts) &&
    c.efforts.every((e) => typeof e === 'string') &&
    typeof c.supportsEnableThinking === 'boolean' &&
    typeof c.supportsBudget === 'boolean'
  );
}
import { installGcWatchdog } from './session/gcWatchdog.js';
import { App } from './ui/App.js';
import { installResizeReflowFix } from './ui/resizeReflowFix.js';
import { theme } from './ui/theme.js';
import { formatEvent } from './ui/formatEvent.js';
import { formatError } from './ui/formatError.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultLogsDir } from './session/runLog.js';
import { detectCurrentOs, platformPromptLine } from './ui/platform.js';

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
function spawnRestart(
  opts: RestartableOpts,
  resumeId: string | undefined,
  mode: string | undefined,
  window: string | undefined,
): number {
  const args = buildRestartArgs({ ...opts, resumeId, mode, window });
  const result = spawnSync(process.execPath, [process.argv[1], ...args], {
    stdio: 'inherit',
    env: { ...process.env, O4C_FRESH_SCREEN: '1' },
  });
  return result.status ?? 0;
}


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

/** The thinking level a one-shot run uses - the same rule `App.tsx` applies on mount. */
function oneShotThinkLevel(config: Record<string, unknown>, model: string): ThinkLevel {
  const saved = config[THINK_LEVEL_CONFIG_KEY];
  const forModel = saved && typeof saved === 'object' ? (saved as Record<string, unknown>)[model] : undefined;
  return (typeof forModel === 'string' ? parseThinkLevel(forModel) : undefined) ?? DEFAULT_THINK_LEVEL;
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
  thinkCaps: ThinkCaps | undefined,
  usageStore: UsageStore | undefined,
  highlightColor: string,
  maxIterations: number | undefined,
  initialSession?: { id: string; title: string; messages: Message[]; entries?: ContextEntry[]; inputHistory?: string[] },
  initialMode?: Mode,
  sessionView?: SessionView,
  serverHooks?: { status: ServerStatus; probe: () => Promise<ServerProbe>; onRecovered: (probe: ServerProbe) => void },
  showTabHint?: boolean,
  mcp?: McpSession,
  graph?: CodeGraphSession,
  sessionId?: string,
  contextWindowType?: ContextWindowTypeControl,
  markWorked?: (arg: string) => string,
  plans?: PlanHooks,
  checkpoints?: CheckpointHooks,
  tip?: string,
  startup?: string,
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
  const lifecycleDir = logsDirFor(projectRoot);
  // Past this point a hang is visible on screen, so this is the line that separates
  // "never got to the UI" from "the UI itself is stuck".
  recordLifecycle(lifecycleDir, 'render', { uptimeMs: Math.round(process.uptime() * 1000) });
  const runLogger = new RunLogger(logsDirFor(projectRoot));
  // Per-session wire-level transcript - every full request sent to the provider and every full
  // response, plus tool calls/results - distinct from runLogger's own already-derived AgentEvent
  // stream above. Same one-file-per-run directory/timestamp convention, just suffixed so it never
  // collides with runLogger's own file.
  const fullContextLogger = new RunLogger(logsDirFor(projectRoot), 'FULLCONTEXT');
  // Must be installed before render() so it sees Ink's very first frame - see the module's own
  // doc comment for the bug this works around.
  // Resolved once here, at startup, and passed to App - process.platform cannot change for the
  // life of the process, so the value is the same either way, but having one place that decides
  // it means /keyboard and any later OS-conditional behaviour answer from the same fact
  // rather than each calling detectCurrentOs() on its own.
  const startupOs = detectCurrentOs();
  installResizeReflowFix(process.stdout);
  // Save the token counts on the way out, whichever way out it is. `process.on('exit')` is the
  // one hook that catches every path this app has - /exit, the per-turn reload, a restart
  // handoff, the uncaughtException handler's process.exit(1), and a Ctrl+C that ever becomes a
  // hard exit again (today App.tsx's Ctrl+C is a reset, not an exit - see the hint line). It
  // permits no asynchronous work, which is exactly why UsageStore writes synchronously, and
  // `flush()` is idempotent so this backstop cannot double-count the explicit call below.
  // The run logs queue their lines (design §3.7) and write them on a short timer; whatever is
  // still queued is written here, on the same every-path hook.
  const flushOnExit = () => {
    usageStore?.flush();
    runLogger.flush();
    fullContextLogger.flush();
  };
  process.on('exit', flushOnExit);
  // A kill from outside the app (or any terminal that delivers the signal rather than the raw
  // byte) would otherwise skip 'exit' entirely.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      flushOnExit();
      process.exit(0);
    });
  }
  let pendingRestart:
    | { resumeId: string | undefined; mode: Mode | undefined; window: string | undefined }
    | undefined;
  const restart = (resumeId?: string, mode?: Mode) => {
    // The window setting is read from the loop rather than passed in, because it lives there and
    // every `restart()` caller would otherwise have to remember to forward it - which is exactly
    // the kind of thing that gets forgotten and then silently turns the feature off.
    pendingRestart = { resumeId, mode, window: windowArgFor(loop.slidingWindowSettings()) };
  };
  const { waitUntilExit } = render(
    React.createElement(App, {
      loop,
      initialImage: opts.image,
      sessionStore,
      runLogger,
      fullContextLogger,
      initialSession,
      sessionId,
      contextWindowType,
      markWorked,
      plans,
      checkpoints,
      tip,
      startup,
      restart,
      initialMode,
      sessionView,
      showTabHint,
      serverStatus: serverHooks?.status,
      probeServer: serverHooks?.probe,
      onServerRecovered: serverHooks?.onRecovered,
      // Reload the session in a fresh process after a turn that thought or used tools, so the screen
      // is repainted from the full saved history (see App.tsx). O4C_NO_RELOAD=1 turns it off.
      os: startupOs,
      reloadAfterTurn: process.env.O4C_NO_RELOAD !== '1',
      projectRoot,
      model: opts.model,
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      contextWindow,
      thinkCaps,
      usageStore,
      maxIterations,
      initialHighlightColor: highlightColor,
      // The prompt rows are handed over as the promise rather than a value: discovery is still
      // running while this renders, which is the point of `startMcpSession` returning
      // synchronously. The other two are plain calls - `/mcp`'s listing and one prompt expansion.
      mcpPromptCommands: mcp && mcp.ready.then(() => mcp.promptCommands()),
      mcpStatusReport: mcp?.statusReport,
      mcpExtra: mcp && {
        inspect: (id: string) => mcp.inspect(id),
        resources: () => mcp.resources(),
        readResource: (id: string, ref: string) => mcp.readResource(id, ref),
        serverIds: () => mcp.status().map((s) => s.id),
      },
      expandMcpPrompt: mcp?.expandPrompt,
      codeGraph: graph,
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
  // Explicitly, before the restart paths below call process.exit(): the 'exit' backstop would
  // still catch it, but this keeps the ordinary way out off the emergency path.
  usageStore?.flush();
  // Same reasoning for MCP, and the same backstop (`process.on('exit')` in the action below) - but
  // worth attempting properly here, because this also runs on the **per-turn reload**, not only at
  // exit. A SIGKILL per turn would give a stdio server no chance to finish what it was writing,
  // and the first real plugin is an infinite-context store with a database open. Bounded inside
  // `shutdown()` so it cannot make a reload feel slow.
  await mcp?.shutdown();
  if (pendingRestart) {
    const handoffFile = process.env.O4C_HANDOFF_FILE;
    if (handoffFile) {
      // Running under the supervisor (see restartHandoff.ts): hand it the next launch's args and exit
      // with the restart code, so the chain of live processes never grows.
      const handoffArgs = buildRestartArgs({
        ...opts,
        resumeId: pendingRestart.resumeId,
        mode: pendingRestart.mode,
        window: pendingRestart.window,
      });
      recordLifecycle(lifecycleDir, 'handoff', { via: 'supervisor', args: handoffArgs });
      writeHandoff(handoffFile, handoffArgs);
      process.exit(RESTART_EXIT_CODE);
    }
    recordLifecycle(lifecycleDir, 'handoff', { via: 'nested' });
    process.exit(spawnRestart(opts, pendingRestart.resumeId, pendingRestart.mode, pendingRestart.window));
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
    'LLM provider: "local" (self-hosted llama-server), "anthropic" (real, costs money) or "mock" (free, for development). Without this flag: the config.json "provider", else local - unless only ANTHROPIC_API_KEY is set',
    'local',
  )
  .option(
    '--base-url <url>',
    'base URL for the "local" provider. If that server requires an API key, set O4C_LOCAL_API_KEY in the environment (no CLI flag, to keep it out of process listings)',
    'http://localhost:8080',
  )
  .option('--image <path>', 'path to an image file to attach (vision-capable providers only)')
  .option('--resume <sessionId>', 'resume a saved session by id (used internally by /resume)')
  .option('-c, --continue', 'resume the most recent session in this project')
  .option(
    '--session <sessionId>',
    'one-shot only: continue the saved session with this id (or start it), and save it afterwards - lets a script drive a multi-turn session without the TUI',
  )
  .option('--mode <mode>', 'start in this mode: manual, auto, acceptEdits or plan (used internally when the session reloads)')
  .option(
    '--window <size>',
    'send only the recent part of the conversation: a token count or a percentage (used internally when the session reloads)',
  )
  .option(
    '--profile <name>',
    'named preset (~/.o4c/profiles/<name>.json) to seed this project\'s config.json from on first trust - only has an effect the one time a project is first trusted; ignored on an already-trusted project. See "o4c-agent-design.md" §1.5/§5.',
  )
  .action(async (promptParts: string[], opts: RestartableOpts & { resume?: string; continue?: boolean; session?: string; profile?: string; mode?: string; window?: string }) => {
    const prompt = promptParts.join(' ');

    // Before anything that can block - the trust gate prompts, the server probes wait, and a
    // process that dies in here used to leave nothing behind at all. Resolved synchronously
    // because `ensureTrusted` below has not run yet and this line has to be on disk before it
    // does. No API key is ever a CLI argument (see --base-url's help), so argv is safe to record.
    const lifecycleDir = logsDirFor(findProjectRootSync(process.cwd()));
    recordLifecycle(lifecycleDir, 'start', {
      argv: process.argv.slice(2),
      worker: process.env.O4C_WORKER === '1',
      freshScreen: process.env.O4C_FRESH_SCREEN === '1',
      oneShot: prompt.length > 0,
      // Time Node spent before reaching this line - its own boot plus loading o4c's modules. The
      // one part of a launch nothing else measures; added 2026-11-01 for David's 20-30 s starts,
      // which the phases below (all well under a second) do not account for.
      loadMs: Math.round(process.uptime() * 1000),
    });
    // The last thing any path writes, restart or not, so the file always says how a process
    // ended and not merely how far it got.
    process.on('exit', (code) => recordLifecycle(lifecycleDir, 'exit', { code }));

    // Interactive launches run under a thin supervisor: this process becomes the launcher, and the real
    // app runs as its child (O4C_WORKER=1). A session reload is then a loop in the supervisor instead of
    // a nested process per reload. Skipped for one-shot prompts, non-terminals, nested workers, and when
    // O4C_NO_SUPERVISOR=1 (falls back to the old nested restart).
    if (
      !prompt &&
      process.env.O4C_WORKER !== '1' &&
      process.env.O4C_NO_SUPERVISOR !== '1' &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const supervisorCode = runSupervisor({
          nodePath: process.execPath,
          script: process.argv[1],
          initialArgs: process.argv.slice(2),
          handoffPath: join(tmpdir(), `o4c-handoff-${process.pid}.json`),
          env: process.env,
          // Every child the supervisor launches, recorded by the one process that outlives them
          // all. A child that dies before its own 'start' line leaves this as the only evidence
          // it was ever spawned, which is exactly the case that was undiagnosable before.
          onSpawn: (args) => recordLifecycle(lifecycleDir, 'spawn', { args }),
          spawn: (command, args, options) => spawnSync(command, args, options),
        });
      // The real quit (B22): background jobs the workers started belong to this process.
      const supervisedRoot = findProjectRootSync(process.cwd());
      setJobsDir(supervisedRoot ? join(supervisedRoot, '.o4c', 'jobs') : join(tmpdir(), 'o4c-jobs'));
      killOwnedJobs(process.pid);
      process.exit(supervisorCode);
    }
    const initialMode: Mode | undefined = MODES.some((m) => m.mode === opts.mode) ? (opts.mode as Mode) : undefined;

    // The trust gate: a project that has never used o4c before (no .o4c/ anywhere above cwd) gets
    // asked once, interactively, before anything else happens - including before any project-level
    // o4c.md is read, since that content is attacker-controlled text from whoever's repo this is
    // until the user has actually said they trust it. --profile only matters on this first trust;
    // ensureTrusted itself ignores it entirely once a project already has a .o4c/ (returns early,
    // never even looks at the parameter).
    const cwd = process.cwd();
    const { trusted, projectRoot } = await ensureTrusted(cwd, undefined, undefined, opts.profile);
    recordLifecycle(lifecycleDir, 'trusted', { trusted, projectRoot });
    const projectContext = trusted ? await resolveO4cMd(cwd, projectRoot) : '';
    // E20: a /database-restore scheduled by the last process, before anything opens a database.
    let restoreNote: string | undefined;
    try {
      restoreNote = applyPendingRestore(dbDirsFor(trusted ? projectRoot : undefined));
    } catch (err) {
      restoreNote = `Database restore failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (restoreNote) recordLifecycle(lifecycleDir, 'restore', { note: restoreNote });
    // E13: --continue is --resume with the newest saved session in this project.
    if (opts.continue && !opts.resume) {
      const last = await latestSession(new SessionStore(sessionsDirFor(projectRoot))).catch(() => undefined);
      if (last) opts = { ...opts, resume: last.id };
      else console.error('No saved session in this project yet - starting a new one.');
    }
    // Named explicitly: told only "their current directory", the model invented a plausible-looking
    // path when asked where it was (seen live 2026-10-24) and could do the same in a tool call.
    const cwdLine = `Working directory: ${cwd}`;

    // An explicit CLI flag always wins; otherwise fall back to the resolved config.json (global
    // -> local -> personal, see configStore.ts), and only then to the option's own hardcoded
    // default. getOptionValueSource distinguishes "user typed --model" from "commander filled in
    // the default" - without it there'd be no way to tell an explicit `-p anthropic` apart from
    // config.json quietly wanting `-p local` instead.
    const configStore = new ConfigStore(trusted ? projectRoot : undefined);
    const resolvedConfig = await configStore.resolve();
    // F3: prune old run logs (newest 50 and the last 7 days are always kept; see logRotation.ts).
    {
      const { keep, keepDays } = logRotationSettings(resolvedConfig);
      pruneRunLogs(logsDirFor(trusted ? projectRoot : undefined), keep, keepDays);
    }
    // G10: custom modes from config, and the one that was active when this session last ran.
    const customModeSetup = parseCustomModes(resolvedConfig.modes);
    setCustomModes(customModeSetup.modes, typeof resolvedConfig[CUSTOM_MODE_KEY] === 'string' ? (resolvedConfig[CUSTOM_MODE_KEY] as string) : undefined);
    function configOr(optName: 'model' | 'provider' | 'baseUrl', cliValue: string): string {
      if (program.getOptionValueSource(optName) !== 'default') return cliValue;
      const configValue = resolvedConfig[optName];
      return typeof configValue === 'string' ? configValue : cliValue;
    }
    opts = {
      ...opts,
      model: configOr('model', opts.model),
      // No -p and no `provider` key: local-first rule (session/providerDefault.ts).
      provider: program.getOptionValueSource('provider') !== 'default' ? opts.provider : defaultProvider(resolvedConfig),
      baseUrl: configOr('baseUrl', opts.baseUrl),
    };
    // No CLI flag for this on purpose (same reasoning as O4C_LOCAL_API_KEY - keeps it out of
    // process listings). config.json read here on every launch/restart, so unlike model/provider/
    // baseUrl above it's never frozen into spawnRestart's argv - a key rotated in config.local.json
    // takes effect on the very next run without needing anything re-threaded through opts.
    // config.local.json (personal, always gitignored - see configStore.ts) is the right scope for
    // this, never the shared config.json.
    // F2: the credentials map (config.local.json / ~/.o4c/config.json only) comes first.
    const credentials = await loadCredentials(configStore);
    for (const value of Object.values(credentials.values)) registerSecret(value);
    const localApiKey =
      credentials.values.local ?? (typeof resolvedConfig.localApiKey === 'string' ? resolvedConfig.localApiKey : undefined);
    // Every key o4c holds is redacted wherever o4c writes text to disk (session/redact.ts).
    registerSecret(localApiKey);
    registerSecret(process.env.O4C_LOCAL_API_KEY);
    registerSecret(process.env.ANTHROPIC_API_KEY);
    // Secure/air-gapped mode (PATH_FORWARD §1a.2/§1a.3, checklist item 21f). Deliberately NOT read
    // from `resolvedConfig`, which is the ordinary global -> local -> personal override cascade:
    // this key is a ratchet, so each scope is read on its own and any `true` wins. A project's
    // `.o4c/config.json` must be able to tighten the egress boundary and never to switch it off -
    // the same reason that file is not trusted to name a command for o4c to spawn.
    const secureMode = secureModeFromScopes(
      await Promise.all(
        (['global', 'local', 'personal'] as const).map((scope) => configStore.readScope(scope)),
      ),
    );
    // Refused before the provider is built, and fatally rather than by falling back to something
    // else: the mode's entire content is "nothing leaves this network", so quietly continuing on a
    // different provider is the one unacceptable outcome. stderr because Ink does not own the
    // screen yet.
    // G9: the web tools - refused in secure mode; the search provider from config.
    setWebOptions({ secureMode, search: parseSearchConfig(resolvedConfig.webSearch, credentials.values) });
    if (secureMode) {
      const refusal = secureModeProviderRefusal(opts.provider, opts.baseUrl);
      if (refusal) {
        console.error(refusal);
        process.exit(1);
      }
    }
    // Manually-configured override - still wins over auto-detection below when set (front-end
    // plan item #8's own scope note: proceed with auto-detected-only for now, no override command
    // yet, but a hand-set config value should still take precedence over whatever gets detected).
    const configuredContextWindow =
      typeof resolvedConfig.contextWindow === 'number' ? resolvedConfig.contextWindow : undefined;
    const reasoningBudgetTokens =
      typeof resolvedConfig.reasoningBudgetTokens === 'number' && resolvedConfig.reasoningBudgetTokens > 0
        ? resolvedConfig.reasoningBudgetTokens
        : undefined;
    // /config-highlightcolor (+ -local-/-global-, App.tsx) - read fresh on every launch/restart,
    // same "config.json only, re-read each time" shape as localApiKey above. Defaults to the
    // amber theme's own accent rather than an arbitrary color, since that's what the rest of the
    // UI already uses everywhere else.
    const highlightColor =
      typeof resolvedConfig.highlightColor === 'string' ? resolvedConfig.highlightColor : theme.accent;
    // How much of a saved session the repaint shows (/set-sessionview, + -local-/-global-): re-read on
    // every launch and restart like the other config keys, so a change needs no handoff argument.
    const sessionView = parseSessionView(resolvedConfig.sessionView);
    // Front-end checklist #11: make Tab-cycles-modes discoverable instead of leaving it to whoever
    // reads "(/mode or Tab)" on the status line. The policy, including why `--resume` must not
    // count as a run, is in tabHint.ts where it can be tested.
    const tabHint = decideTabHint(resolvedConfig, Boolean(opts.resume));
    const showTabHint = tabHint.show;
    // E5: a tip on a fresh start (not on a reload, not when the Tab hint shows), rotating.
    let tip: string | undefined;
    if (!showTabHint && !opts.resume && resolvedConfig[SHOW_TIPS_KEY] !== false) {
      const counter = typeof resolvedConfig[TIP_COUNTER_KEY] === 'number' ? (resolvedConfig[TIP_COUNTER_KEY] as number) : 0;
      tip = tipFor(counter);
      void configStore.set('global', TIP_COUNTER_KEY, counter + 1).catch(() => undefined);
    }
    if (tabHint.recordRuns !== undefined) {
      // Fire-and-forget, and global: which shortcuts somebody has been taught is a fact about the
      // user, not about a project. A failed write means the tip shows once more, which is a far
      // better failure than delaying startup on it.
      void configStore
        .set('global', TAB_HINT_RUNS_KEY, tabHint.recordRuns)
        .catch(() => undefined);
    }
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
    // Opt-in only, same "no CLI flag, config.json only" shape as the others above - real need
    // found via direct user report/live monitoring: a long, verbose local-model turn pushed RSS
    // to 4+GB and crashed with a real "JavaScript heap out of memory" (see loop.ts's own delta-
    // throttling fix for the O(n²) render-cost bug that mainly caused this). Throttling the
    // render cost gives V8's own GC a fair chance to run, but doesn't force it to run *proactively*
    // at a chosen watermark - this does, for anyone who wants memory kept down near a specific
    // number regardless (e.g. running on an older/lower-RAM machine) rather than trusting V8's own
    // heuristics for when collection is worthwhile. Requires the process to actually have `global.gc`
    // available (Node's `--expose-gc` flag, e.g. via `NODE_OPTIONS=--expose-gc`) - installGcWatchdog
    // itself warns once, rather than silently no-op'ing, if this is configured without it.
    const gcThresholdMB =
      typeof resolvedConfig.gcThresholdMB === 'number' ? resolvedConfig.gcThresholdMB : undefined;

    // The `-m`/`--model` value means nothing to LocalProvider - it never sends a `model` field
    // at all (llama-server only ever has one model loaded). Without this, the status bar and
    // `/context` would display whatever opts.model happened to default to (the CLI's hardcoded
    // Anthropic default, unrelated to what's actually being talked to) instead of the real
    // served model - real bug, found via direct user report. Best-effort: on any failure to
    // reach the server, opts.model (whatever it already was) is left unchanged rather than
    // blocking startup on it. Run alongside the context-window probe below (Promise.all, not
    // sequential awaits) - two independent, best-effort GETs against the same server, no reason
    // to pay their latency twice at startup.
    // One probe tells model, context size AND whether the server is up at all (down: nothing answered, loading: it
    // answered 503 while loading its model). When it is not up the app opens the "Server is down: wait or choose
    // another model" box, waits however long a small laptop-sized server needs, and re-reads the context size once
    // it answers - startup never blocks on it.
    let autoContextWindow: number | undefined;
    let probedSlots: number | undefined;
    // Undefined for a non-local provider (Anthropic's five efforts are already known) and until
    // the probe answers; `thinkLevel.ts` falls back to sane defaults in both cases.
    let thinkCaps: ThinkCaps | undefined;
    let serverStatus: ServerStatus = 'up';
    if (opts.provider === 'local') {
      const probe = await probeLocalServer(opts.baseUrl, localApiKey);
      serverStatus = probe.status;
      if (probe.model) opts = { ...opts, model: probe.model };
      autoContextWindow = probe.contextWindow;
      probedSlots = probe.totalSlots;
      // Which reasoning controls this model honours, for `/think`. Cached per model id in
      // config, so the probe runs once per model rather than at every launch - David's explicit
      // requirement. The probe itself is ~0.01s (the chat template rejects the sentinel effort
      // before generating anything), but caching also means a model stays usable when the server
      // is briefly unprobeable.
      if (probe.status === 'up' && opts.model) {
        const cachedAll = (resolvedConfig[THINK_CAPS_CONFIG_KEY] ?? {}) as Record<string, unknown>;
        const cached = cachedAll[opts.model];
        if (isThinkCaps(cached)) {
          thinkCaps = cached;
        } else {
          thinkCaps = await probeThinkCaps(opts.baseUrl, localApiKey);
          // Best-effort: a failed write just means it is probed again next launch.
          try {
            await configStore.set('global', THINK_CAPS_CONFIG_KEY, { ...cachedAll, [opts.model]: thinkCaps });
          } catch {
            // Keep the probed value for this session.
          }
        }
      }
    }
    // Front-end plan item #8: auto-detected max context, not a guess or a required manual value -
    // a manually-configured contextWindow (above) still wins when set. Local comes from the real
    // probe just above (confirmed live against PHOEBE's /props); Anthropic has no equivalent query
    // endpoint, so this falls back to the flat 200K every current Claude model actually has
    // (matches cc's own MODEL_CONTEXT_WINDOW_DEFAULT fallback, confirmed directly against its
    // source during this project's own context-window research) rather than guessing per model id.
    // 'mock' gets no default - a test/dev provider has no real window to report.
    recordLifecycle(lifecycleDir, 'provider', {
      provider: opts.provider,
      model: opts.model,
      serverStatus,
    });
    const ANTHROPIC_DEFAULT_CONTEXT_WINDOW = 200_000;
    // E19: the models registry - below config.json, above what the server reports.
    const registryModel = modelEntry(opts.model);
    const contextWindow =
      configuredContextWindow ??
      registryModel?.contextWindow ??
      autoContextWindow ??
      (opts.provider === 'anthropic' ? ANTHROPIC_DEFAULT_CONTEXT_WINDOW : undefined);
    // E18: /config-editor's choice, unless O4C_EDITOR is already set in the environment.
    if (!process.env.O4C_EDITOR && typeof resolvedConfig[EDITOR_CONFIG_KEY] === 'string' && resolvedConfig[EDITOR_CONFIG_KEY]) {
      process.env.O4C_EDITOR = resolvedConfig[EDITOR_CONFIG_KEY] as string;
    }
    // E14: a numeric /think budget saved for this model replaces the level's own budget.
    setThinkBudgetOverride(savedThinkBudget(resolvedConfig, opts.model));
    // E13: one health line under the banner on a fresh start (not on the per-turn reload).
    const health = opts.resume
      ? undefined
      : startupLine({
          provider: opts.provider,
          status: serverStatus,
          model: opts.model,
          contextWindow,
          last: await latestSession(new SessionStore(sessionsDirFor(projectRoot))).catch(() => undefined),
        });
    // A restore that just ran (E20) is reported even on a resume - the restart that applied it is one.
    const startup = [restoreNote, ...credentials.problems, ...hookProblems().map((p) => `config.json hooks: ${p}`), ...customModeSetup.problems.map((p) => `config.json ${p}`), health].filter(Boolean).join('\n') || undefined;
    // Half the configured context window, not the flat 4096 both providers used to hardcode -
    // that flat cap was unrelated to the model's real budget and silently truncated any turn
    // whose <think> reasoning alone ran past it (real bug, found via direct reproduction against
    // PHOEBE: the turn just ended with an empty answer, no error). Undefined (no contextWindow
    // known at all) falls back to each provider's own pre-existing default.
    // Was contextWindow/2 until 2026-10-03 - see the setMaxTokens call below (and loop.ts's
    // dynamicMaxTokens comment) for the real run that showed a half-window per-response budget is
    // what starves every round after the first big one.
    const providerMaxTokens = contextWindow ? Math.min(32768, Math.floor(contextWindow / 4)) : undefined;

    let provider: LLMProvider;
    let localProvider: LocalProvider | undefined;
    if (opts.provider === 'mock') {
      provider = new MockProvider();
    } else if (opts.provider === 'local') {
      provider = localProvider = new LocalProvider({
        baseUrl: opts.baseUrl,
        apiKey: localApiKey,
        maxTokens: providerMaxTokens,
        reasoningBudgetTokens,
        thinkCaps,
        connectTimeoutMs,
        idleTimeoutMs,
        modelId: opts.model,
        sampling: resolvedConfig.localSampling ?? registryModel?.sampling,
        slots: probedSlots,
        // Plan 0006 A7; config.json "localReasoningReplay" to override.
        reasoningReplay: ['all', 'current-turn', 'none', 'all-as-text'].includes(String(resolvedConfig.localReasoningReplay))
          ? (resolvedConfig.localReasoningReplay as LocalReasoningReplay)
          : undefined,
      });
    } else if (opts.provider === 'anthropic') {
      try {
        provider = new AnthropicProvider({
          apiKey: credentials.values.anthropic,
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

    // Built here, after the probe, so the profile follows the model the server really serves (B1).
    // The tool set is the one the session starts with: the built-ins, plus code_graph when the graph
    // will expose it - fixed for the session, like everything else in the system prompt.
    // The shell run_shell uses (B24) - set before the prompt, which names it.
    setShell(resolvedConfig[SHELL_CONFIG_KEY]);
    // G3: hooks from config, Claude Code format (see session/hooks.ts).
    const hookSetup = parseHooks(resolvedConfig.hooks);
    setHooks(hookSetup);
    // G2: skills (project > global > bundled), listed in the prompt and loadable with the skill tool.
    const skills = loadSkills(trusted ? projectRoot : undefined);
    setSkills(skills);
    // G4: sub-agent profiles (built-in explore/verify, then global, then project) and the task tool.
    const taskTool = createTaskTool(loadProfiles(trusted ? projectRoot : undefined));
    const systemPrompt = buildSystemPrompt({
      profile: promptProfileFor(opts.model, resolvedConfig[PROMPT_PROFILE_CONFIG_KEY]),
      tools: [...defaultTools.map((t) => t.name), taskTool.name, ...(trusted && resolvedConfig.codeGraph !== false ? ['code_graph'] : [])],
      skills: skillListing(skills),
      environment: [cwdLine, shellPromptLine(currentShell())],
      projectContext,
    });
    // F1: retry with backoff (429/5xx/timeouts), then the configured fallbackChain, if any.
    {
      const { specs, errors } = parseProviderSpecs(resolvedConfig.fallbackChain);
      for (const e of errors) console.error(`config.json: ${e}`);
      const fallbacks: LLMProvider[] = [];
      for (const spec of specs) {
        try {
          fallbacks.push(createProvider(spec, { maxTokens: providerMaxTokens, connectTimeoutMs, idleTimeoutMs }, process.env, credentials.values));
        } catch (err) {
          console.error(`config.json fallbackChain: ${spec.provider} skipped - ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (opts.provider !== 'mock') {
        provider = new RetryingProvider([provider, ...fallbacks], {
          retries: typeof resolvedConfig.providerRetries === 'number' && resolvedConfig.providerRetries >= 0 ? resolvedConfig.providerRetries : undefined,
          onRetry: (info) => recordLifecycle(lifecycleDir, 'provider', { retry: info }),
        });
      }
    }
    const loop = new AgentLoop(provider, [...defaultTools, taskTool], systemPrompt);
    setTaskRuntime({ provider, tools: () => loop.getTools(), environment: [cwdLine, shellPromptLine(currentShell())], contextWindow });
    // G3: PostToolUse runs around every tool; PreCompact is told before a compaction.
    loop.registerCore(postToolHooksComponent({ sessionId: opts.resume ?? opts.session, cwd }));
    loop.onBeforeCompact = (trigger) => {
      if (hasHooks('PreCompact')) void runHooks(hooksConfig(), 'PreCompact', { trigger }, { cwd }).catch(() => undefined);
    };
    loop.textToolCallRecovery = resolvedConfig.textToolCallRecovery !== false;
    loop.loopGuardEnabled = resolvedConfig.loopGuard !== false;
    if (typeof resolvedConfig.deferToolsAbove === 'number') loop.deferToolsAbove = resolvedConfig.deferToolsAbove;
    if (localProvider) localProvider.repetitionGuard = resolvedConfig.repetitionAbort !== false;
    setSyntaxCheckMode(resolvedConfig.syntaxCheck);
    setShellTimeoutDefault(resolvedConfig.shellTimeoutMs);
    setPassKeysToShell(resolvedConfig.passKeysToShell);
    setPinnedCommands(resolvedConfig.pinnedCommands);
    // Background jobs (B22): records under .o4c/jobs; this process kills the ones it owns on exit -
    // a reloading worker owns none (the supervisor does), so a reload never stops a dev server.
    setJobsDir(trusted && projectRoot ? join(projectRoot, '.o4c', 'jobs') : join(tmpdir(), 'o4c-jobs'));
    process.on('exit', () => killOwnedJobs(process.pid));
    loop.registerCore({
      name: 'jobs',
      turnNote: () => {
        const done = unreportedFinished();
        if (done.length === 0) return undefined;
        return `[o4c] Background job${done.length === 1 ? '' : 's'} finished: ${done.map((j) => describeJob(j).replace(/\s+/g, ' ')).join('; ')}. Read the output with job_output.`;
      },
    });
    // This process's session id, decided now rather than at the first save - every session switch
    // (/clear, /resume, the per-turn reload) is a fresh process, so one process is one session.
    // The history store files entries under it from the first one; App saves under it too, so the
    // two always agree. See AppProps.sessionId.
    const sessionId = opts.resume ?? opts.session ?? randomUUID();
    // Restored before the first turn, because o4c reloads itself after most of them and
    // `--window` is how the setting gets across - the same mechanism `--mode` uses, for the
    // same reason. An unparseable value is ignored rather than refused: it can only come from
    // a hand-typed flag, and starting with no window is the safe reading.
    const initialWindow = opts.window ? parseWindowSetting(String(opts.window)) : undefined;
    if (initialWindow) loop.setSlidingWindow(initialWindow);

    // MCP servers. Here, between the two branches below, because the REPL and one-shot mode need
    // exactly the same thing: the same tools appended to the same loop, and the same cleanup.
    //
    // Not awaited - `startMcpSession` returns immediately and the tools land when they land (see
    // its own comment for why startup must not wait, and `AgentLoop.registerPendingTools` for
    // what stops the first turn running without them). `trusted ? projectRoot : undefined` is the
    // same rule `ConfigStore` above gets, and matters more here: an MCP entry in an untrusted
    // repo's `.o4c/` is not a preference, it is a command line this process would spawn.
    const mcp = startMcpSession({
      projectRoot: trusted ? projectRoot : undefined,
      // Resolved as a ratchet across config scopes above, and the same value already refused a
      // cloud provider there - gating MCP alone would be theatre while every prompt went to an
      // API. A blocked server costs only its own tools and says so in the startup notices.
      secureMode,
      addTools: (tools) => loop.addTools(tools),
    });
    loop.registerPendingTools(mcp.ready);
    // The backstop that catches every way this process leaves, the restart paths' own
    // `process.exit()` calls included - the same reasoning (and the same hook) as UsageStore's
    // flush in runRepl. Synchronous because 'exit' permits nothing else; the graceful close is
    // attempted first, below, on the paths that can await.
    process.on('exit', () => mcp.killAllNow());

    // The history store - NextUp item 13. Registered BEFORE the graph, which makes it the outer of
    // the two `aroundTool` wrappers and leaves the graph innermost, as the graph's own note below
    // asks. The recorder only observes - it reads a file before a write and diffs it after, and
    // returns the tool's result untouched - so wrapping the graph changes nothing the graph sees.
    // NextUp item 23: the live context window type, read from config like `/datagraph` so the
    // per-turn reload keeps it. `none` turns the recorder off - one-shot answers are not kept.
    const contextWindowType = contextWindowTypeControl(
      contextWindowTypeFromConfig(resolvedConfig[CONTEXT_WINDOW_TYPE_CONFIG_KEY]),
    );
    const history = startHistory({
      projectRoot: trusted ? projectRoot : undefined,
      sessionId,
      enabled: () => contextWindowType.current().type !== 'none',
    });
    if (history) {
      loop.registerCore(history.recorder);
      // G4: each sub-agent run filed as its own finished task, in a side session of this one.
      setTaskRuntime({
        provider,
        tools: () => loop.getTools(),
        environment: [cwdLine, shellPromptLine(currentShell())],
        contextWindow,
        record: () => {
          const recorder = new HistoryRecorder({ store: history.store, sessionId: `${sessionId}:agents`, projectRoot: projectRoot!, enabled: () => true });
          return {
            onEntry: (e) => recorder.onEntry(e),
            finish: () => {
              const id = recorder.currentTask();
              if (id !== undefined) history.store.finishTask(id);
            },
          };
        },
      });
      process.on('exit', () => history.close());
    }
    recordLifecycle(lifecycleDir, 'history', { opened: history !== undefined });
    // What the model has read, so edits are made against the file as it is (plan 0006 B9). After the
    // history recorder and before the graph: the graph stays the innermost aroundTool wrapper.
    // Checkpoints (C1): the files as they were before each turn changed them, in a shadow git repo.
    const checkpointHooks: CheckpointHooks | undefined =
      history && trusted && projectRoot && resolvedConfig.checkpoints !== false && ShadowGit.available()
        ? { shadow: new ShadowGit(projectRoot), store: history.store.checkpoints(), sessionId }
        : undefined;
    if (checkpointHooks) loop.registerCore(checkpointComponent(checkpointHooks));
    // Memories (D3): project ones in history.db, global ones in ~/.o4c/db/global.db; a turn note when
    // they change, and a remember tool.
    const memoryStores: MemoryStores = { project: history?.store.memories() };
    try {
      const globalMemories = openGlobalMemories();
      memoryStores.global = globalMemories.store;
      process.on('exit', () => globalMemories.close());
    } catch {
      // no global store: project memories still work
    }
    if (history) setRecentTasksSource(() => history.store.recentFinishedTasks(8));
    if (history) setTaskCountSource(() => history.store.taskCounts());
    if (history) setIncorrectMarker((arg) => markIncorrectCommand(history.store, sessionId, arg));
    if (memoryStores.project || memoryStores.global) {
      setActiveMemoryStores(memoryStores);
      loop.registerCore(memoriesComponent(memoryStores));
      loop.addTools([createRememberTool(memoryStores)]);
    }
    // Instruction files below the working directory, given on first touch (D1).
    if (trusted && projectRoot) {
      loop.registerCore(subdirInstructionsComponent({ projectRoot, seenFile: join(projectRoot, '.o4c', 'instructions-seen', `${sessionId}.json`) }));
    }
    // .o4cignore (C5): only when the project has one.
    if (loadO4cIgnore(trusted ? projectRoot : undefined)) loop.registerCore(o4cIgnoreComponent());
    if (resolvedConfig.fileStateGuard !== false) {
      loop.registerCore(fileStateComponent({ file: fileStatePath(trusted ? projectRoot : undefined, sessionId) }));
    }
    // Shapes every request by the type: `none` sends only the current turn, `pointer` and `curated`
    // add what the history offers. Registered whether or not the store opened - `none` needs no
    // store, and without one `pointer`/`curated` simply send what `floating` would.
    //
    // The graph starts below, so the staleness lookup is a late-bound reference: retrieval only
    // runs during a turn, by which time it is set (or stays undefined, and staleness is unknown).
    let entityExists: ((entityUid: string) => boolean | undefined) | undefined;
    const retrieval = history
      ? new HistoryRetrieval({
          store: history.store,
          sessionId,
          currentTask: () => history.recorder.currentTask(),
          entityExists: (uid) => entityExists?.(uid),
          // No pointer hint at a tool the model was not given (D11).
          searchAllowed: () => historySearchAllowed(contextWindowType.current(), resolvedConfig[MODEL_INITIATED_SEARCHES_KEY]),
        })
      : undefined;
    loop.registerCore(
      contextTypeComponent({
        control: contextWindowType,
        retrieval: history && retrieval && {
          pointerHint: (request) => retrieval.pointerHint(request),
          // The same provider the turn uses: `curated`'s two calls are the model building its own
          // context, so they go to the model that will read it.
          curatedHistory: (request, budget) =>
            curatedHistory(
              {
                complete: async (completion) => {
                  const response = await provider.complete(completion);
                  loop.countExternalCall(response);
                  return response;
                },
                store: history.store,
                retrieval,
                currentTask: () => history.recorder.currentTask(),
              },
              request,
              budget,
            ),
        },
        curatedBudget: curatedBudgetTokens,
        recentExchanges: CURATED_RECENT_EXCHANGES,
        recentFraction: CURATED_RECENT_FRACTION,
      }),
    );
    // `search_history` is offered with the types that point the model at past tasks, and follows
    // the type when it changes mid-session.
    if (history && retrieval) {
      const historyTool = createHistoryTool(history.store, retrieval);
      const syncHistoryTool = (setting: ContextWindowType) => {
        loop.removeTools([historyTool.name]);
        if (historySearchAllowed(setting, resolvedConfig[MODEL_INITIATED_SEARCHES_KEY])) loop.addTools([historyTool]);
      };
      syncHistoryTool(contextWindowType.current());
      contextWindowType.onChange(syncHistoryTool);
    }

    // Plans (brief 0005): `.o4c/plans/*.md` written before plans moved into history.db are imported
    // (once per plan - safe on every start), then `update_plan` is offered while any plan exists.
    // `syncPlanTool` is re-run by the commands that create a plan.
    let syncPlanTool = () => {};
    if (history) {
      const plans = history.store.plans();
      const planTool = createPlanTool({ plans, sessionId, currentTask: () => history.recorder.currentTask() });
      syncPlanTool = () => {
        loop.removeTools([planTool.name]);
        if (plans.listPlans().length > 0) loop.addTools([planTool]);
      };
      syncPlanTool();
      // Q7: the active plan's current item rides along with every request. After the context
      // window type component, so it adds to whatever that projection kept.
      loop.registerCore(
        planContextComponent({ plans, sessionId, enabled: () => contextWindowType.current().type !== 'none' }),
      );
      void importPlanFiles(trusted ? projectRoot : undefined, plans)
        .then((result) => {
          recordLifecycle(lifecycleDir, 'history', { plansImported: result.imported.length, renumbered: result.renumbered });
          if (result.imported.length > 0) syncPlanTool();
        })
        .catch(() => {});
    }

    // The Code Graph - build step 4, in the core tier rather than the MCP tier (design doc §5.1's
    // revision: it has to change what a tool call *returns*, which a server cannot express).
    //
    // `registerCore` order is hook order and the wiring site is where that decision gets made, so
    // to state it: this is the only core component registered today, and when the others land
    // (items 13, 23, 40) the graph belongs **innermost** of the `aroundTool` wrappers - it
    // annotates a tool's own output, and wrapping it around a component that substitutes its own
    // answer would have it annotate that instead.
    //
    // `trusted ? projectRoot : undefined`, the same rule ConfigStore and MCP get above. The first
    // index pass is not awaited; until it lands every answer reports `incomplete`.
    const graph = startCodeGraph({
      projectRoot: trusted ? projectRoot : undefined,
      addTools: (tools) => loop.addTools(tools),
      removeTools: (names) => loop.removeTools(names),
      // Read from config rather than carried as a restart flag like --window: `/datagraph` saves it,
      // so the per-turn reload and the next session both pick it up with no extra plumbing.
      exposed: resolvedConfig.codeGraph !== false,
    });
    if (graph) {
      entityExists = (uid) => graph.component.entityExists(uid);
      loop.registerCore(graph.component);
      // On 'exit' rather than in each branch's teardown: the close is synchronous, so one hook
      // covers the REPL, one-shot mode and the restart paths' own process.exit() alike.
      process.on('exit', () => graph.close());
    }
    recordLifecycle(lifecycleDir, 'graph', { opened: graph !== undefined });

    // Installed before either branch below (interactive REPL or one-shot) so both are covered -
    // this is a process-wide concern, not specific to the TUI. See gcWatchdog.ts's own doc comment
    // for why this exists. console.error rather than anything TUI-specific: needs to work
    // identically in one-shot mode too, and a warning is worth showing even if the interactive
    // Ink UI takes over the screen right after (it'll simply scroll into the terminal's own
    // history above the TUI, same as any other startup diagnostic). Fire-and-forget for the
    // process's whole lifetime, same as installResizeReflowFix above - its own `.unref()`'d timer
    // already means it never keeps the process alive on its own, so there's nothing to clean up.
    if (gcThresholdMB !== undefined) {
      installGcWatchdog(gcThresholdMB, (message) => console.error(`\n${message}\n`));
    }

    if (!prompt) {
      const sessionStore = new SessionStore(sessionsDirFor(projectRoot), sessionsToSave);
      // The project's lifetime token count, for the footer's token line. Loaded with the session
      // id being resumed (if any) so a per-turn reload picks this session's subtotal back up
      // rather than restarting it at zero every turn - see usageStore.ts on why that matters.
      // Undefined without a trusted project: the count is deliberately per-project only.
      const usageFile = usageFileFor(projectRoot);
      const usageStore = usageFile
        ? new UsageStore(usageFile, () => {
            const used = loop.getUsage();
            return {
              input: used.inputTokens,
              output: used.outputTokens,
              requests: used.requestCount,
              cached: used.cachedTokens,
              processed: used.processedPromptTokens,
              prefillMs: used.prefillMs,
              draftN: used.draftTokens,
              draftAccepted: used.draftAccepted,
            };
          }, Date.now, globalUsageFile())
        : undefined;
      usageStore?.load(opts.resume);
      let initialSession: { id: string; title: string; messages: Message[]; entries?: ContextEntry[]; inputHistory?: string[] } | undefined;
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
          entries: data.entries,
          inputHistory: data.inputHistory,
        };
      }
      await runRepl(
        loop,
        projectRoot,
        sessionStore,
        opts,
        contextWindow,
        thinkCaps,
        usageStore,
        highlightColor,
        maxIterations,
        initialSession,
        initialMode,
        sessionView,
        opts.provider === 'local'
          ? {
              status: serverStatus,
              probe: () => probeLocalServer(opts.baseUrl, localApiKey),
              onRecovered: (probe) => {
                localProvider?.setSlots(probe.totalSlots);
                // The capability probe never ran if the server was down at launch, so the levels
                // were using assumed defaults. Re-probe here rather than in App.tsx: this is where
                // localApiKey is in scope, and a key-protected server would simply 401 an
                // unauthenticated probe and silently fall back to those same defaults.
                void probeThinkCaps(opts.baseUrl, localApiKey).then((caps) => localProvider?.setThinkCaps(caps));
                // The reply limit follows the context size - but only when the size came from the
                // server; a size set in config.json was already applied at launch and stays.
                // Was half the context size until 2026-10-03, when a real run showed that letting
                // one response consume half the window is exactly what starves every round after
                // it (loop.ts's dynamicMaxTokens comment has the measured numbers). This is only
                // the fallback anyway - loop.ts computes a tighter per-request budget from the
                // actual prompt size and overrides it on every real call.
                if (probe.contextWindow && configuredContextWindow === undefined && registryModel?.contextWindow === undefined) {
                  localProvider?.setMaxTokens(Math.min(32768, Math.floor(probe.contextWindow / 4)));
                }
              },
            }
          : undefined,
        showTabHint,
        mcp,
        graph,
        sessionId,
        contextWindowType,
        history && ((arg: string) => markWorkedCommand(history.store, sessionId, arg)),
        history && {
          store: history.store.plans(),
          sessionId,
          changed: () => syncPlanTool(),
          currentTask: () => history.recorder.currentTask(),
          research: (goal) =>
            gatherUltraplanResearch(goal, {
              store: history.store,
              retrieval,
              graphMap: graph ? (focus, maxTokens) => graph.component.rankedMap(focus, maxTokens) : undefined,
            }),
        },
        checkpointHooks,
        tip,
        startup,
      );
      return;
    }

    const loadedRules = await loadRules((s) => configStore.readScope(s as 'global' | 'local' | 'personal'));
    const headlessRules = loadedRules.deny.length + loadedRules.ask.length > 0 || loadedRules.confirmDestructive ? loadedRules : undefined;

    // `--session`: a headless multi-turn session, one process per message - how a script drives a
    // long run (e.g. the C:\tmp.tmp4 test project) through every context window type, which only
    // differ in what carries across messages. Loaded before the run, saved after it whatever happens,
    // so a crashed or failed message still leaves the session continuable.
    const oneShotStore = opts.session ? new SessionStore(sessionsDirFor(projectRoot), sessionsToSave) : undefined;
    // The same FULLCONTEXT wire transcript the TUI writes, so a headless run is replayable.
    const oneShotFullLogger = new RunLogger(logsDirFor(projectRoot), 'FULLCONTEXT');
    const oneShotProviderLog = createProviderCallLogger(oneShotFullLogger);
    process.on('exit', () => oneShotFullLogger.flush());
    if (oneShotStore && opts.session) {
      const data = await oneShotStore.load(opts.session);
      if (data) loop.loadEntries(data.entries);
    }

    // Counted for the stats line below (the eval runner reads it, plan 0006 J1).
    let toolCalls = 0;
    try {
      const finalAnswer = await loop.run(prompt, {
        images: opts.image ? [opts.image] : undefined,
        onEvent: (event) => {
          if (event.type === 'tool_call') toolCalls++;
          printEvent(event);
        },
        onProviderCall: oneShotProviderLog,
        maxIterations,
        // Nobody to ask in one-shot mode (B18): summarize, so a script gets an answer, not a throw.
        onStepLimit: async () => 'summarize',
        // Permission rules apply headless too (C3): deny holds, and ask is a deny - nobody can answer.
        // G4: whatever policy this run uses is also the one its sub-agents use.
        toolPolicy: withTaskPolicy(headlessRules
          ? async (tool, input) => {
              const skillDenied = skillGate(tool.name);
              if (skillDenied) return { verdict: 'deny', reason: skillDenied };
              const hooked = await preToolHookVerdict(tool.name, input, cwd);
              if (typeof hooked === 'object') return hooked;
              if (hooked === 'ask') return { verdict: 'deny', reason: 'a PreToolUse hook asks for approval, which a headless run cannot give' };
              if (hooked === 'allow') return 'allow';
              const ruled = evaluateRules(headlessRules, tool, input, splitShellSegments);
              if (ruled?.decision === 'deny') return { verdict: 'deny', reason: `the permission rule ${ruled.rule.pattern} (${ruled.rule.scope}) denies this` };
              if (ruled?.decision === 'ask') return { verdict: 'deny', reason: `the permission rule ${ruled.rule.pattern} asks for approval, which a headless run cannot give` };
              const destructive = headlessRules.confirmDestructive && tool.name === 'run_shell' && typeof input.command === 'string' ? destructiveReason(input.command) : undefined;
              if (destructive) return { verdict: 'deny', reason: `confirmDestructive is on and ${destructive} needs approval, which a headless run cannot give` };
              return 'allow';
            }
          : // G2: with no rules, the only headless restriction is an active skill's allowed-tools.
            async (tool, input) => {
              const skillDenied = skillGate(tool.name);
              if (skillDenied) return { verdict: 'deny', reason: skillDenied };
              const hooked = await preToolHookVerdict(tool.name, input, cwd);
              if (hooked === 'ask') return { verdict: 'deny', reason: 'a PreToolUse hook asks for approval, which a headless run cannot give' };
              return hooked ?? 'allow';
            }),
        // One-shot is autonomous like Auto mode: ask once to verify edits nobody checked (B19).
        verifyOnStop: resolvedConfig.verifyOnStop !== false,
        // The model's real window, exactly as the TUI passes it. Missing until 2026-11-01, which
        // left one-shot runs with no compaction, no pre-send size check and no curated bound: the
        // tmp4 long run grew a turn to 229,610 tokens against a 229,376 window and the server
        // rejected every request from then on. Short one-shot prompts never got near the limit,
        // which is how it went unnoticed.
        contextWindow,
        toolOutputDir: toolOutputDirFor(projectRoot),
        // The level the TUI would start at: the per-model `thinkLevelByModel` entry, else o4c's
        // default (`med`). Missing until 2026-11-01, so one-shot runs sent no reasoning limit at
        // all and llama-server let the model think without bound - on the tmp4 long run that was
        // ~2,300 output tokens per call, most of it planning probes.
        thinkLevel: oneShotThinkLevel(resolvedConfig, opts.model),
      });

      process.stdout.write(`\n--- final ---\n${finalAnswer}\n`);
    } catch (err) {
      printError(err);
      process.exitCode = 1;
    } finally {
      // On stderr so it never mixes into an answer a script is reading from stdout. In `finally`
      // so a message that ends on an error - the iteration cap a long scripted run sets on purpose
      // - still reports what it spent.
      const used = loop.getUsage();
      process.stderr.write(
        `--- usage --- requests ${used.requestCount} · input ${used.inputTokens} · output ${used.outputTokens}\n`,
      );
      process.stderr.write(
        `${STATS_MARK}${JSON.stringify({ requests: used.requestCount, inputTokens: used.inputTokens, outputTokens: used.outputTokens, cachedTokens: used.cachedTokens, toolCalls })}\n`,
      );
      if (oneShotStore && loop.getEntries().length > 0) {
        try {
          await oneShotStore.save(loop.getEntries(), sessionId);
        } catch (err) {
          printError(err);
        }
      }
      // One-shot mode ends by falling off the end of the action, with no process.exit() of its
      // own, so without this a spawned server could keep the event loop alive after the answer
      // has already been printed - the same class of hang the explicit exit in runRepl exists for.
      await mcp.shutdown();
    }
  });

// `o4c eval run|diff|list` (plan 0006 J1). Checked by hand rather than as a commander subcommand,
// so only those exact forms are taken and a prompt that merely starts with "eval" still is one.
if (process.argv[2] === 'eval' && ['run', 'diff', 'list'].includes(process.argv[3] ?? '')) {
  process.exitCode = await runEvalCli(process.argv.slice(3));
} else {
  program.parseAsync(process.argv);
}
