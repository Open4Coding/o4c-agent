import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { InputBox } from './InputBox.js';
import { SessionPicker } from './SessionPicker.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CommandPalette } from './CommandPalette.js';
import { ModePicker } from './ModePicker.js';
import { SessionViewPicker, type SessionViewChoice } from './SessionViewPicker.js';
import { ServerDownPicker, SERVER_POLL_MS, type ServerDownChoice, type ServerWaitStatus } from './ServerDownPicker.js';
import { ServerUnavailableError } from '../providers/types.js';
import type { ServerProbe, ServerStatus } from '../providers/local.js';
import { CommandFamilyPicker } from './CommandFamilyPicker.js';
import { ThinkPicker, ThinkScopePicker, type ThinkScope, type ThinkScopeChoice } from './ThinkPicker.js';

/** `config.json` key holding the chosen thinking level per model id - `/think`'s choice is about
 * how one particular model behaves, so Qwen3 and Claude keep separate values and neither is
 * clobbered by switching provider. */
const THINK_LEVEL_CONFIG_KEY = 'thinkLevelByModel';
import { MODES, classifyToolAccess, modeInfo, modeSystemPrompt, type Mode } from './modePolicy.js';
import { plansDirFor, toolOutputDirFor } from '../session/projectContext.js';
import { projectLabel, readGitBranch, readMountPoint } from '../session/gitInfo.js';
import {
  DEFAULT_THINK_CAPS,
  DEFAULT_THINK_LEVEL,
  THINK_LEVELS,
  THINK_LEVEL_INFO,
  effectiveThinkLevel,
  parseThinkLevel,
  type ThinkCaps,
  type ThinkLevel,
} from '../agent/thinkLevel.js';
import { formatEvent } from './formatEvent.js';
import { formatError } from './formatError.js';
import { formatConfirmMessage } from './confirmPreview.js';
import { needsGapBefore } from './lineSpacing.js';
import { formatMessage } from './formatMessage.js';
import {
  MAX_VISIBLE_TOOL_EVENTS_PER_TURN,
  formatEntries,
  parseSessionView,
  thinkLineText,
  type SessionView,
} from './formatEntries.js';
import { renderKeyboardCommandsHelp } from './keyboardCommandsHelp.js';
import { parseOsArg } from './osKeyboardNotes.js';
import { detectCurrentOs, type OsKey } from './platform.js';
import type { Line, LineKind } from './types.js';
import { RESPONSE_TAG, THINK_TAG, infoLine, labelled, userLine } from './labels.js';
import {
  initialTextWindow,
  makeBlock,
  shouldFlushDelta,
  splitStreamLines,
  textWindowReducer,
  type TextBlock,
} from './textWindow.js';
import {
  expandedInputBoxCapRows,
  inputBoxCapRows,
  liveRegionCapChars as sharedLiveRegionCapChars,
  liveRegionCapRows as sharedLiveRegionCapRows,
  liveRegionCapRowsFor,
} from './frameBudget.js';
import { theme } from './theme.js';
import {
  formatTokenCount,
  formatElapsed,
  formatElapsedCoarse,
  formatModelName,
  formatTokenRate,
  formatCumulativeTokens,
  elapsedTickMs,
  renderProgressBar,
  progressBarFilledCells,
} from './statusBar.js';
import { AbortedError, type AgentLoop, type AgentEvent } from '../agent/loop.js';
import type { SessionStore, SessionMeta } from '../session/sessionStore.js';
import type { RunLogger } from '../session/runLog.js';
import { ConfigStore, scopeOwningEntry, type ConfigScope } from '../session/configStore.js';
import type { UsageStore } from '../session/usageStore.js';
import { HIGHLIGHT_COLOR_NAMES, isValidHighlightColor, resolveHighlightColor } from './highlightColor.js';
import { buildSplashText } from './splash.js';
import type { Tool } from '../tools/types.js';
import type { Message } from '../providers/types.js';
import type { ContextEntry } from '../agent/contextEntry.js';
import {
  COMMANDS,
  KNOWN_COMMANDS,
  looksLikeSlashCommand,
  isComposingCommand,
  matchCommands,
  commandName,
  commandForHelpTarget,
  setCommands,
  configCommands,
  commandFamily,
  familyFor,
  type CommandInfo,
} from './slashCommand.js';

export interface AppProps {
  loop: AgentLoop;
  initialImage?: string;
  sessionStore: SessionStore;
  runLogger: RunLogger;
  /** Per-session `<timestamp>.FULLCONTEXT.jsonl`, same directory/convention as runLogger's own
   * file - the raw wire-level transcript (every provider request/response, every tool call and
   * result), distinct from runLogger's already-derived, display-oriented event stream. */
  fullContextLogger: RunLogger;
  /** Set by cli.ts when this process was launched with `--resume <id>` - seeds the visible
   * scrollback and currentSessionIdRef on mount, since a fresh process handoff (see `restart`
   * below) never gets a chance to append it mid-session. */
  initialSession?: { id: string; title: string; messages: Message[]; entries?: ContextEntry[]; inputHistory?: string[] };
  /** Requests that /clear or /resume hand off to a brand-new process instead of resetting
   * state in-place - see cli.ts's spawnRestart for why. Call this, then exit() (as /exit does),
   * never both without the other: cli.ts only spawns the replacement after this process's Ink
   * instance has actually unmounted. */
  restart: (resumeId?: string, mode?: Mode) => void;
  /** The mode to start in - set by a restart so a reload keeps Auto/Manual instead of dropping back
   * to Manual. Undefined means the normal default (Manual). */
  initialMode?: Mode;
  /** When true, after a turn that thought or used tools finishes and saves, hand off to a fresh
   * process that reloads this same session by id: the new process repaints the whole history from
   * the saved entries (think blocks, narration, tool calls, answer) and starts with empty buffers.
   * Off by default so tests that count restarts are unaffected; cli.ts turns it on. */
  /** The OS this session detected at startup, resolved once in `cli.ts` and passed down rather
   * than re-derived at each call site, so `/keyboard` and anything else OS-conditional
   * answer from one fact. Defaults to detecting it here, for tests and callers that omit it. */
  os?: OsKey;
  reloadAfterTurn?: boolean;
  /** How much of a saved session the repaint shows (`compact` or `full`) - read from config.json at
   * every launch/restart (`/set-sessionview`). Undefined means compact. */
  sessionView?: SessionView;
  /** How the local server answered at launch (`up` when unknown/not a local server). When it is `down` or
   * `loading` the app opens the "Server is down: wait or choose another model" box straight away. */
  serverStatus?: ServerStatus;
  /** Asks the server how it is doing right now - polled while the box is open, to notice it coming up. */
  probeServer?: () => Promise<ServerProbe>;
  /** Called once with the first probe that finds the server up after a wait, so cli.ts can apply what it learned
   * (the provider's reply limit follows the context size). */
  onServerRecovered?: (probe: ServerProbe) => void;
  /** Milliseconds between checks while waiting (default 5000). Tests shorten it. */
  serverPollMs?: number;
  /** Undefined for an untrusted/no-project run. Only consulted to scope Plan-Write mode's
   * write_file exception to `.o4c/plans/` - see modePolicy.ts's classifyToolAccess. */
  projectRoot?: string;
  /** What the active model's chat template honours, from the startup capability probe
   * (`probeThinkCaps`), cached per model id. Undefined for a provider needing no probe, or a
   * server that could not be reached - `thinkLevel.ts` falls back to sane defaults. */
  thinkCaps?: ThinkCaps;
  /** The project's lifetime token count, for the footer's token line. Undefined only in
   * tests and headless runs, where the bar falls back to this process's own figures. */
  usageStore?: UsageStore;
  /** The model id this session is running (`-m`/config.json's `model`, as passed to the
   * provider) - display only, shown in the status bar. */
  model: string;
  /** `'local' | 'anthropic' | 'mock'` - display only, for the startup splash header. */
  provider: string;
  /** Only meaningful (and only shown) for the local provider - display only, for the startup
   * splash header. Anthropic's own fixed API endpoint isn't shown; nobody configured it. */
  baseUrl: string;
  /** The current model's max context size, in tokens - only known when set explicitly via
   * config.json's `contextWindow` key (no per-model metadata registry exists yet, per
   * docs/o4c-agent-design.md §2.3/§7.1 - this deliberately doesn't guess). Undefined hides the
   * status bar's progress-bar/percentage, showing just the raw token estimate instead. */
  contextWindow?: number;
  /** Caps how many provider round-trips a single turn can make before giving up - see
   * `AgentLoop.run()`'s own `RunOptions.maxIterations` doc comment (0/negative = no cap). Only
   * known when set explicitly via config.json's `maxIterations` key; undefined falls back to
   * `AgentLoop`'s own default (25) unchanged. */
  maxIterations?: number;
  /** The "/" command palette's highlight color (border + selected-row color), resolved once at
   * cli.ts startup from config.json's `highlightColor` key (default amber, matching theme.ts) -
   * seeds local state here (see /config-highlightcolor's own handling below) so a live
   * /config-highlightcolor takes effect immediately, without needing a restart. */
  initialHighlightColor: string;
  /** Test-only override for ConfigStore's global scope (~/.o4c otherwise) - same isolation
   * convention `ensureTrusted`/`seedLocalConfig`/`resolveO4cMd` already use elsewhere, so
   * /config-global-highlightcolor never writes into the real machine's global config during a
   * test. cli.ts never passes this - production always uses the real ~/.o4c. */
  configGlobalDir?: string;
}

// Above this many tool_call/tool_result events in a single turn, further ones collapse into a
// single running summary line instead of each getting its own displayed line - a codebase-
// exploration turn that reads dozens of files would otherwise flood both the live region and
// the permanent scrollback. The full, untruncated event stream is always written to the run log
// regardless of this cap.

/** Heartbeat for buffered streamed deltas - the longest a chunk waits before reaching a render
 * when `shouldFlushDelta` (textWindow.ts) hasn't already flushed it, so a slow stream still
 * visibly moves. A fast stream flushes by size (5 lines' worth) long before this fires. Bounds
 * both the O(n²) blowup `deltaBufferRef`'s doc comment describes and the terminal write volume:
 * at most one repaint per 5 lines or per heartbeat, instead of up to 20/sec. */
const DELTA_FLUSH_MS = 1500;

/**
 * Character budget for the in-flight live region, sized to the terminal: `(rows - 10) * cols`
 * reserves ten rows for the input box, status bar and spinner that share the frame, so the live
 * frame stays strictly below the viewport height. That is what keeps Ink off its Windows
 * full-terminal-clear + whole-history-rewrite path (`shouldClearTerminalForFrame` clears on any
 * frame at or above the viewport on win32) - the visible "screen reset" at the end of a long
 * think-block turn. Recomputed on every terminal resize (see the resize effect in App), so the
 * frame stays under the viewport after a resize too.
 */
function liveRegionCapChars(): number {
  return sharedLiveRegionCapChars(process.stdout.rows, process.stdout.columns);
}

/** Row bound matching `liveRegionCapChars`. Both now come from `frameBudget`, which divides the
 * viewport between the live region and the input box from one set of numbers - the box became
 * bounded too, and two caps that each assumed the other stayed small would sum past the viewport
 * and bring back the stacking they each exist to prevent. */
function liveRegionCapRows(): number {
  return sharedLiveRegionCapRows(process.stdout.rows);
}

function liveRegionCols(): number {
  return process.stdout.columns ?? 80;
}

let nextPrefillToken = 0;
let nextHistoryToken = 0;
// Unrelated to the text window's own block ids (textWindow.ts owns those internally now) - just a
// second, independent React-key source for ConfirmDialog instances.
let nextDialogId = 0;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Every spinner tick repaints the whole live frame (Ink re-renders and re-tokenizes it), and at the
 * old 80 ms this alone was ~12 repaints/s during a turn - measured as the bulk of ~100 MB/s of
 * allocation churn and ~100 KB/s of terminal writes. 250 ms (4 fps) still reads as clearly alive. */
export const SPINNER_INTERVAL_MS = 250;

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={theme.warn}>
      {SPINNER_FRAMES[frame]} Thinking...
    </Text>
  );
}

/** Session-elapsed-time ticker + the model/tokens/context-usage line shown above the input box -
 * per direct instruction, matching Hermes Agent's own status bar. `tick` exists purely to force
 * a re-render once a second; `getVisibleTokenEstimate()` is read fresh on every render rather
 * than lifted into state, since `AgentLoop` already mutates it outside React's own state flow
 * (same reasoning as `getUsage()` elsewhere in this file). */
function StatusBar({
  loop,
  contextWindow,
  liveText,
  mode,
  busy,
}: {
  loop: AgentLoop;
  contextWindow?: number;
  /** The text currently streaming in (`textWindow.live`), not yet a committed `ContextEntry` -
   * real bug found via direct user report: without this, the bar sat frozen at its pre-turn value
   * for a response's entire generation time (`getVisibleTokenEstimate()` only updates once an
   * entry is appended, which happens after a call fully completes, not as it streams), making a
   * long turn look exactly like a hang even when it wasn't one. Included in the token count and
   * fill fraction below as a rough estimate (chars/4, same heuristic `estimateTokens()` uses),
   * never persisted anywhere - purely a live display adjustment. */
  liveText: readonly string[];
  /** Front-end plan item #8: context max/current/%used belongs on the same line as Mode, under
   * the input box - folded in here (Ink renders sibling `<Text>` elements on separate rows unless
   * they're nested inside one shared `<Text>` tree, which is what this whole component already is)
   * rather than as a second, separately-positioned line the way it used to be. */
  mode: Mode;
  /** A turn is running: the clock ticks every second and shows seconds. At idle it ticks once a
   * minute and shows minutes only, so an untouched screen is not repainted every second. */
  busy: boolean;
}) {
  const [, tick] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), elapsedTickMs(busy));
    return () => clearInterval(id);
  }, [busy]);

  const liveTokens = Math.ceil(liveText.join('').length / 4);
  const tokens = loop.getVisibleTokenEstimate() + liveTokens;
  const fraction = contextWindow ? tokens / contextWindow : undefined;
  const elapsed = busy ? formatElapsed(Date.now() - startRef.current) : formatElapsedCoarse(Date.now() - startRef.current);
  // Throughput used to sit here; it moved to the token line below, where it belongs with the other
  // two token figures rather than being the same number printed twice in two formats.
  return (
    <Text>
      <Text color={modeInfo(mode).color}>
        Mode: {modeInfo(mode).label} (/mode or Tab)
      </Text>
      {/* The key hints sit directly after the mode they qualify rather than on a line of their
          own at the foot of the footer, and the model name moved down to the dir line: it
          changes once a session, where everything left on this line moves constantly. */}
      <Text color={theme.border}> Esc stop · type to queue</Text>
      <Text color={theme.border}> | </Text>
      <Text color={theme.accent}>
        {formatTokenCount(tokens)}
        {contextWindow ? `/${formatTokenCount(contextWindow)}` : ''}
      </Text>
      {fraction !== undefined && (
        <Text>
          {' ['}
          <Text color={theme.warn}>{'█'.repeat(progressBarFilledCells(fraction))}</Text>
          <Text color={theme.border}>{'░'.repeat(10 - progressBarFilledCells(fraction))}</Text>
          {'] '}
          <Text color={theme.accent}>{Math.round(fraction * 100)}%</Text>
        </Text>
      )}
      <Text color={theme.border}> | </Text>
      <Text color={theme.accent}>{elapsed}</Text>
    </Text>
  );
}

/**
 * The footer's second line: what this project has cost in tokens.
 *
 *     t-tks: 18.6M↑/1.3M↓ | s-tks: 1.6M↑/0.3M↓/46 t/s
 *
 * `t-` is this project's lifetime total, `s-` this session. Prompt and completion are shown
 * apart because they are not comparable quantities: a measured 8h run sent 18.6M prompt tokens
 * and generated 1.3M, so one sum would be 94% prefill and would bury the figure that actually
 * tracks output.
 *
 * The arrows are from the client's seat, not the model's - the way any transfer meter reads. The
 * prompt goes UP to the server and the completion comes back DOWN, so the large figure carries
 * the up arrow and the small one the down arrow.
 *
 * The totals come from `UsageStore` (on disk, because a process here lasts about one turn - see
 * that file); the rate is the server's own `predicted_per_second`. Without a trusted project
 * there is no lifetime total, so the `t-` half is dropped rather than shown as a figure pooled
 * across unrelated directories.
 *
 * Ticks on the same cadence as `StatusBar` and reads its values fresh on every render for the
 * same reason: `AgentLoop` mutates its usage counters outside React's state flow, so lifting
 * them into state would show stale numbers.
 */
function UsageBar({
  loop,
  usage,
  busy,
  sessionView,
  thinkLevel,
}: {
  loop: AgentLoop;
  usage?: UsageStore;
  busy: boolean;
  /** How much of a session a reload or `/resume` repaints (`/set-sessionview`). Shown because it
   * is otherwise invisible until the next repaint, by which time the screen it produced is the
   * only evidence of what the setting was - and `compact` silently hides think blocks, which is
   * exactly the thing a user then goes looking for. The effective (merged-scope) value, so a
   * project-local setting is displayed rather than the global one it overrides. */
  sessionView: SessionView;
  /** The level that will actually take effect, which on a model missing a control can be weaker
   * than the one chosen (`thinkLevel.ts`'s `effectiveThinkLevel()`). Shown so this line never
   * claims a setting the request did not really make. */
  thinkLevel: ThinkLevel;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), elapsedTickMs(busy));
    return () => clearInterval(id);
  }, [busy]);

  // Without a store there is no project, so only the session half is real - and this process's
  // own spend is all of it, since nothing was ever carried in from disk.
  const spent = loop.getUsage();
  const totals = usage?.totals();
  const session = totals?.session ?? { input: spent.inputTokens, output: spent.outputTokens };
  // `0 t/s` before any response has reported a rate, rather than a `n/s` placeholder: the column
  // keeps one shape, so the eye does not have to re-read it to see what it is showing.
  const rateText = formatTokenRate(loop.getTokensPerSecond() ?? 0);

  const pair = (spend: { input: number; output: number }) => (
    <Text>
      <Text color={theme.accent}>{formatCumulativeTokens(spend.input)}</Text>
      <Text color={theme.border}>↑/</Text>
      <Text color={theme.accent}>{formatCumulativeTokens(spend.output)}</Text>
      <Text color={theme.border}>↓</Text>
    </Text>
  );

  return (
    <Text>
      {/* Flush left, like every other footer line.

          The two settings lead this line rather than trailing it, and sit here rather than on line
          1, which was running to ~126 columns. Leading matters: the token totals below grow
          through a session (3.8K -> 272K), so anything printed after them drifts sideways all
          session, while at the left edge these two only move when you actually change one. */}
      <Text color={theme.accent}>view: {sessionView}</Text>
      <Text color={theme.border}> | </Text>
      <Text color={theme.accent}>Think: {THINK_LEVEL_INFO[thinkLevel].label}</Text>
      <Text color={theme.border}> | </Text>
      {totals && (
        <Text>
          <Text color={theme.border}>t-tks: </Text>
          {pair(totals.project)}
          <Text color={theme.border}> | </Text>
        </Text>
      )}
      <Text color={theme.border}>s-tks: </Text>
      {pair(session)}
      <Text color={theme.border}>/</Text>
      <Text color={theme.accent}>{rateText}</Text>
      <Text color={theme.border}> t/s</Text>
    </Text>
  );
}

/**
 * The footer's third line: which model, which branch, and which volume/project/path you are in.
 *
 *     ◆ qwen3.8-27b-Q4_K_M-imatFP16 | main · dir: D:/Open4Coding/o4c-agent
 *
 * These three belong together because they share a cadence: all of them hold still for a whole
 * session. That is why the model name lives here and not on the status line, which re-renders on
 * a timer - this component takes already-resolved strings and does no I/O of its own (see
 * `session/gitInfo.ts` on why reading `.git/HEAD` per render would be the wrong shape even though
 * it is cheap).
 *
 * Renders without a branch when there is none, which is a normal case rather than an error: the
 * meta workspace and the scratch directories are not repositories.
 */
function ProjectBar({ model, branch, project }: { model: string; branch?: string; project: string }) {
  return (
    <Text>
      <Text color={theme.accent}>◆ {formatModelName(model)}</Text>
      <Text color={theme.border}> | </Text>
      {branch && (
        <Text>
          <Text color={theme.accent}>{branch}</Text>
          <Text color={theme.border}> · </Text>
        </Text>
      )}
      <Text color={theme.border}>dir: {project}</Text>
    </Text>
  );
}

function LineText({ line }: { line: Line }) {
  switch (line.kind) {
    case 'user':
      return (
        <Text bold color={theme.accent}>
          {line.text}
        </Text>
      );
    case 'tool_call':
    case 'tool_result':
      return <Text color={theme.border}>{line.text}</Text>;
    case 'final':
      return (
        <Text bold color={theme.accent}>
          {line.text}
        </Text>
      );
    case 'error':
      return <Text color={theme.error}>{line.text}</Text>;
    case 'splash':
      return (
        <Text bold color={theme.primary}>
          {line.text}
        </Text>
      );
    default:
      return <Text color={theme.border}>{line.text}</Text>;
  }
}

export function App({
  loop,
  initialImage,
  sessionStore,
  runLogger,
  fullContextLogger,
  initialSession,
  restart,
  initialMode,
  os = detectCurrentOs(),
  reloadAfterTurn,
  sessionView,
  projectRoot,
  thinkCaps: probedThinkCaps,
  usageStore,
  model: modelProp,
  provider,
  baseUrl,
  contextWindow: contextWindowProp,
  serverStatus = 'up',
  probeServer,
  onServerRecovered,
  serverPollMs = SERVER_POLL_MS,
  maxIterations,
  initialHighlightColor,
  configGlobalDir,
}: AppProps) {
  const { exit } = useApp();
  // The model name and context size can change after launch: a server that was down at startup tells us both
  // once it is up (see the wait below), so they are state seeded from the launch values.
  const [model, setModel] = useState(modelProp);
  const [contextWindow, setContextWindow] = useState(contextWindowProp);
  // The "Server is down: wait or choose another model" box. Open at launch if the server did not answer, and
  // reopened when a request fails because the server cannot be reached; `checks` counts the polls since.
  const [serverWait, setServerWait] = useState<{ status: ServerWaitStatus; checks: number } | null>(() =>
    serverStatus === 'up' ? null : { status: serverStatus, checks: 0 },
  );
  const plansDir = plansDirFor(projectRoot);
  // Where an over-budget tool result's full text is spilled before the model is handed a bounded
  // slice of it - see AgentLoop.boundToolOutput(). Same projectRoot-derived shape as plansDir.
  const toolOutputDir = toolOutputDirFor(projectRoot);
  // Undefined projectRoot already means "untrusted/no project" (ensureTrusted's own contract,
  // projectContext.ts) - matches exactly what ConfigStore.hasScope('local') needs to correctly
  // refuse a local-scope write, so no separate trusted flag needs threading down from cli.ts.
  const configStore = useMemo(
    () => new ConfigStore(projectRoot, configGlobalDir),
    [projectRoot, configGlobalDir],
  );
  // Read-path validation (defense in depth - the /config-highlightcolor write path validates too,
  // but config.json is hand-editable and this is the value that actually reaches Ink): an
  // unrecognized color is SILENTLY DROPPED by Ink/chalk (verified at the byte level 2026-09-27 -
  // no color SGR emitted at all), so an unvalidated bad value would strip the palette highlight
  // styling with no error anywhere. resolveHighlightColor falls it back to the theme accent.
  const [highlightColor, setHighlightColor] = useState(() => resolveHighlightColor(initialHighlightColor));
  const [textWindow, dispatchTextWindow] = useReducer(textWindowReducer, undefined, () => {
    let id = 0;
    const banner = makeBlock(id++, [
      {
        kind: 'splash',
        text: buildSplashText({
          location: projectRoot ?? process.cwd(),
          provider,
          model,
          // mode's own useState always starts at 'manual' (declared further below in this
          // component) - hardcoded here rather than reading that state var, which isn't in scope
          // yet at this point in the component body (this lazy initializer runs before it).
          modeLabel: modeInfo('manual').label,
          baseUrl: provider === 'local' ? baseUrl : undefined,
        }),
      },
      {
        kind: 'system',
        text: 'Type your request, or / to see available commands.',
      },
    ]);
    if (!initialSession) return initialTextWindow([banner], liveRegionCapChars(), liveRegionCapRows(), liveRegionCols());
    const blocks: TextBlock[] = [
      banner,
      makeBlock(id++, [{ kind: 'system', text: `Resumed session: ${initialSession.title}` }]),
    ];
    // Prefer the full entries (think blocks, [scan] collapse, live line format) over the wire
    // messages, which only hold what the model was sent; messages remain the fallback for callers
    // that only have those (tests, older handoffs).
    const restoredLines = initialSession.entries
      ? formatEntries(initialSession.entries, undefined, { view: sessionView })
      : initialSession.messages.flatMap(formatMessage);
    if (restoredLines.length > 0) blocks.push(makeBlock(id++, restoredLines));
    return initialTextWindow(blocks, liveRegionCapChars(), liveRegionCapRows(), liveRegionCols());
  });
  useEffect(() => {
    const onResize = (): void => {
      dispatchTextWindow({
        type: 'setLiveCaps',
        liveCapChars: liveRegionCapChars(),
        liveCapRows: liveRegionCapRows(),
        liveCols: liveRegionCols(),
      });
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  const [isProcessing, setIsProcessing] = useState(false);
  // Separate from isProcessing (which covers the whole turn, including waiting on /resume's
  // picker or a write_file/run_shell confirmation) - this is only true while an actual LLM call
  // is in flight,
  // so the "Thinking..." spinner doesn't run during a turn that's really just waiting on the user.
  const [isThinking, setIsThinking] = useState(false);
  // Narrower than isThinking: true while waiting on the model itself (including the silent gap
  // before its first byte), false while a tool is actually executing or the final answer is
  // already streaming. Drives handleEscape's choice between asking first and stopping at once -
  // see that callback's own comment for why only the "waiting on the model" case gets asked.
  const [isInThinkBlock, setIsInThinkBlock] = useState(false);
  const [queuedPreview, setQueuedPreview] = useState<string[]>([]);

  // Drives the "/" command palette - mirrors InputBox's own text (InputBox owns the actual
  // value/cursor state; this is just what App needs to decide whether the palette should be
  // showing and what to filter it by). Reset any time the palette is explicitly dismissed via
  // Esc, and un-dismissed again the moment the user types anything further - matching a normal
  // dropdown-menu feel rather than a one-time popup.
  const [inputValue, setInputValue] = useState('');
  // Mirrors inputValue for code that runs outside React renders (the turn-end reload must not discard
  // a draft the user is typing).
  const inputValueRef = useRef('');
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  // Bumped to force InputBox to clear its text after a palette selection fills in and submits a
  // command programmatically (see resetToken's doc comment on InputBox).
  const [inputResetToken, setInputResetToken] = useState(0);

  // FIFO queue: you can type ahead and submit (more than once) while busy instead of
  // being locked out - every submission while processing is kept, in order, and runs
  // automatically once the current turn finishes, one at a time. A ref (not state)
  // since it's read/written from inside the async turn-processing function itself,
  // not something that drives render on its own - queuedPreview mirrors it for display.
  const queuedInputsRef = useRef<string[]>([]);

  // undefined = no session persisted yet (fresh start, or just after /clear). Set once the first
  // turn autosaves successfully, or immediately on mount by a /resume restart handoff; reused on
  // every subsequent save so it updates in place rather than creating a new session file per turn.
  const currentSessionIdRef = useRef<string | undefined>(initialSession?.id);

  // Mirrors InputBox's own submit-history array (kept there, not lifted into React state here -
  // it only needs to be read at autosave time, not drive any render) so it can be persisted
  // alongside the conversation. Seeded from a /resume restart handoff exactly like `messages`
  // is; a fresh session (no initialSession, or /clear's restart with none) starts empty,
  // matching the conversation itself also starting empty.
  const inputHistoryRef = useRef<string[]>(initialSession?.inputHistory ?? []);
  const handleInputHistoryChange = useCallback((history: string[]) => {
    inputHistoryRef.current = history;
  }, []);

  // Non-null only while a turn's loop.run() call is actually in flight - lets Escape cancel it
  // (see handleEscape below). Null the rest of the time, so an Escape press with nothing running
  // is a safe no-op rather than needing its own isThinking check.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Tracks the most recent delta's kind for the turn currently streaming - lets the live display
  // tell the instant reasoning starts (to prefix "[think] ") and the instant it switches to the
  // real answer (to start a fresh line rather than run on from the reasoning text). Reset to null
  // at the start of every turn in processTurn, alongside its other per-turn tracking state.
  const lastDeltaKindRef = useRef<'think' | 'text' | null>(null);
  // True once the current turn produced any reasoning - with tool use, what makes the turn worth a reload.
  const turnHadThinkRef = useRef(false);

  /**
   * Real bug found via direct reproduction, 2026-09-30: dispatching a React state update (plus
   * the array-copy + string-concat `appendDelta` does, plus a full terminal repaint each time -
   * including `resizeReflowFix.ts`'s own whole-frame width scan) for every single raw streamed
   * chunk is O(current response length) per chunk. For a short response this is nothing; for one
   * very long, continuous response (a verbose model's single huge `<think>` block) it's O(n²)
   * total - confirmed directly: 40,000 chunks (200,000 chars) took 5+ minutes of pure synchronous
   * CPU time in isolation. That's long enough to block Node's event loop outright, starving the
   * garbage collector of any chance to run while transient allocations from the hot loop keep
   * piling up - matches a real captured crash (`FATAL ERROR: ... heap out of memory`, `scavenge
   * might not succeed` - literally GC failing to keep pace) far better than a genuine memory leak
   * would, since the session that crashed had a small, ordinary amount of overall history.
   *
   * Fix: batch raw deltas into this ref instead of dispatching each one - `flushDeltaBuffer`
   * (below) is what actually calls `dispatchTextWindow`, at most once per `DELTA_FLUSH_MS`,
   * coalescing however many raw chunks arrived in that window into one state update. This bounds
   * the number of renders/repaints to a fixed rate regardless of the model's token rate or chunk
   * size, closing the O(n²) blowup at the source rather than just making each render cheaper.
   */
  const deltaBufferRef = useRef<{ text: string; startNewLine: boolean; kind: 'think' | 'text' } | null>(null);
  const deltaFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while openResumePicker is mid-flight, so a second /resume can't stack another picker.
  const resumePickerOpenRef = useRef(false);
  // Tracks the previous provider call's request size so the full-context log writes deltas
  // instead of the whole growing message list every round-trip (see onProviderCall below).
  const lastProviderLogRef = useRef<{ messageCount: number; systemPrompt: string | undefined }>({
    messageCount: 0,
    systemPrompt: undefined,
  });

  /**
   * `full` view only: the piece of the current stream that has arrived with no newline after it
   * yet, so it is not a finished line and cannot be committed as one. Everything before it is
   * already permanent scrollback - this is the only streamed text the live region still holds.
   */
  const streamTailRef = useRef('');

  /** Which kinds of streamed text this turn has already committed to scrollback as it arrived
   * (`full` view). What it is for: the end-of-turn commit must not print the think block or the
   * final answer a second time under the copy that already streamed into place. Reset per turn. */
  const streamCommittedRef = useRef<{ think: boolean; text: boolean }>({ think: false, text: false });

  /**
   * `full` view's progressive commit: streamed text goes into the terminal's permanent scrollback
   * as it arrives, one finished line at a time, instead of into the rolling live region.
   *
   * This is the fix for the reported bug. The live region is bounded (`textWindow.ts`'s
   * `trimLiveToCap`/`trimLiveToRows`) because an Ink frame that reaches the viewport height
   * corrupts the display - so while a turn ran, its own output scrolled out of that window and
   * was simply dropped: not in scrollback, not scrollable, gone, and only a summary reached the
   * screen when the turn ended. On a long think the screen therefore "went compact" mid-turn no
   * matter what /set-sessionview said. Committing each finished line to `<Static>` makes it real
   * terminal history the moment it is complete, so nothing a turn prints can be lost again and
   * the live region only ever holds one unfinished line.
   */
  const commitStreamText = (text: string, kind: 'think' | 'text'): void => {
    // `kind` is what the provider said this chunk was, so reasoning keeps the dim system styling
    // and the answer keeps the accent - the same colours the end-of-turn commit gave them.
    const lineKind: LineKind = kind === 'think' ? 'system' : 'final';
    const { lines, tail } = splitStreamLines(streamTailRef.current + text);
    streamTailRef.current = tail;
    if (lines.length > 0) {
      dispatchTextWindow({ type: 'commit', lines: lines.map((t) => ({ kind: lineKind, text: t })), flow: true });
    }
    dispatchTextWindow({ type: 'setLiveTail', text: tail });
  };

  /** Commits whatever partial line is left, at the end of a stream segment (the kind changing, a
   * tool call interrupting, the turn ending) so the tail is never the thing that gets dropped. */
  const flushStreamTail = (kind: 'think' | 'text' | null): void => {
    const pending = streamTailRef.current;
    streamTailRef.current = '';
    if (pending !== '') {
      dispatchTextWindow({
        type: 'commit',
        lines: [{ kind: kind === 'text' ? 'final' : 'system', text: pending }],
        flow: true,
      });
    }
    dispatchTextWindow({ type: 'setLiveTail', text: '' });
  };

  // Dispatches whatever's buffered, if anything - the only place `appendDelta` actually gets
  // sent. `dispatchTextWindow` itself is stable (useReducer's own guarantee), so this needs no
  // dependency array/useCallback to stay correct across renders.
  const flushDeltaBuffer = () => {
    const pending = deltaBufferRef.current;
    deltaBufferRef.current = null;
    if (!pending) return;
    if (sessionViewRef.current === 'full') {
      streamCommittedRef.current[pending.kind] = true;
      commitStreamText(pending.text, pending.kind);
      return;
    }
    dispatchTextWindow({ type: 'appendDelta', text: pending.text, startNewLine: pending.startNewLine });
  };

  // Bumped only by handleForceRecover (Ctrl+C) - lets a processTurn invocation that's still
  // stuck in flight when the user force-recovers recognize, whenever it eventually does settle,
  // that it's been abandoned and a newer turn already owns the visible UI state. Every provider
  // and tool call already has a real timeout backstop (LocalProvider/AnthropicProvider: 5min,
  // run_shell: 60s), so an abandoned call is never *eternally* stuck - just slower to give up
  // than the user wants to wait - but it can still append late entries to AgentLoop's own entry
  // log if the user has already started a new turn by the time it finally settles. Known,
  // accepted, bounded limitation: AgentLoop was designed for one turn at a time, not real
  // concurrent turns; a full fix would mean the loop itself tracking/rejecting overlapping calls,
  // a bigger change than this recovery button needs to solve today.
  const turnGenerationRef = useRef(0);

  // Non-null while /resume's picker is showing. `resolve` is the pending Promise's resolver
  // that processTurn is awaiting on - selecting or cancelling calls it, which is what lets
  // processTurn pause mid-turn for the picker and then continue afterward, without restructuring
  // the existing async control flow.
  const [resumePicker, setResumePicker] = useState<{
    sessions: SessionMeta[];
    resolve: (id: string | undefined) => void;
  } | null>(null);

  // Governs whether write_file/run_shell run silently, need confirmation, or are blocked outright
  // - see src/ui/modePolicy.ts. Manual is the default: a deliberate behavior change from "nothing
  // is ever confirmed" today, the actual fix for the long-open run_shell/write_file safety gap.
  const [mode, setMode] = useState<Mode>(initialMode ?? 'manual');
  // `/think`'s level. Seeded from the default (unrestricted, i.e. exactly what the server did
  // before this command existed) and replaced by the per-model value from config once it loads,
  // so a first paint never shows a level the next turn would not actually use.
  // What the footer reports for `/set-sessionview`. Seeded with the value cli.ts resolved from
  // config at launch (so it is right from the first frame, with no read on mount), and updated
  // when a `/set-sessionview` actually changes the *effective* value. Separate from the
  // `sessionView` prop, which stays the value the current screen was painted with.
  const [shownSessionView, setShownSessionView] = useState<SessionView>(parseSessionView(sessionView));
  const [thinkLevel, setThinkLevel] = useState<ThinkLevel>(DEFAULT_THINK_LEVEL);
  // What this model's chat template honours, from the startup probe. Defaults are assumed until
  // the probe answers; `effectiveThinkLevel` is what reconciles the two for display.
  // Not state: the probe runs once at startup (cli.ts, where the API key lives) and the answer
  // cannot change while the process runs - a model swap restarts the process. If the server was
  // down at launch, cli.ts re-probes on recovery and updates the PROVIDER, which is what governs
  // actual requests; this display value keeps the assumed defaults until the next launch.
  const thinkCaps = probedThinkCaps;
  // Read once on mount and refreshed when a turn finishes - never per render (see gitInfo.ts).
  const [gitBranch, setGitBranch] = useState<string | undefined>(undefined);
  // The volume the project sits on - `D:` here, a POSIX mount point elsewhere. Read once only: a
  // directory cannot change which device it is on while the process runs, so unlike the branch
  // this never needs refreshing.
  const [mountPoint, setMountPoint] = useState<string | undefined>(undefined);
  // Same pending-Promise-resolver pattern as resumePicker, for the /mode command's picker.
  const [modePicker, setModePicker] = useState<{ resolve: (m: Mode | undefined) => void } | null>(
    null,
  );
  // Same pending-Promise-resolver pattern as modePicker above.
  const [thinkPicker, setThinkPicker] = useState<{ resolve: (l: ThinkLevel | undefined) => void } | null>(
    null,
  );
  // True while the "Stop now?" check is showing: Esc during a running turn asks before it stops anything.
  const [stopConfirm, setStopConfirm] = useState(false);
  // The turn that was running when the check opened - Yes only stops THAT turn, never a later one a queued
  // message started while the box sat open.
  const stopTargetRef = useRef<AbortController | null>(null);
  // Same pending-Promise-resolver pattern again, for the /set-*sessionview picklist.
  // `/set-think`'s picker. Separate from `thinkPicker` above because it edits a config tier for
  // future sessions rather than this session's live level, and so resolves a different choice type.
  const [thinkScopePicker, setThinkScopePicker] = useState<{
    scope: ThinkScope;
    storedLevel: ThinkLevel | undefined;
    globalLevel: ThinkLevel | undefined;
    resolve: (c: ThinkScopeChoice | undefined) => void;
  } | null>(null);
  const [viewPicker, setViewPicker] = useState<{
    scope: ConfigScope;
    currentValue: SessionView;
    storedValue: SessionView | undefined;
    globalValue: SessionView;
    resolve: (c: SessionViewChoice | undefined) => void;
  } | null>(null);

  // Bumping the token replaces InputBox's text with `text` (cursor at the end) without
  // submitting - how /set hands a chosen command like `/set-sessionname` back to the user to
  // finish typing its argument onto, rather than auto-submitting the way a plain palette
  // selection does (existing commands all take no arguments, so that never needed this).
  const [prefill, setPrefill] = useState<{ token: number; text: string } | undefined>(undefined);
  // Same token-bump shape as `prefill`: appends to InputBox's ↑/↓ history without touching its
  // text, for commands run straight from the palette or a family dropdown.
  const [historyAppend, setHistoryAppend] = useState<{ token: number; text: string } | undefined>(undefined);

  // Same pending-Promise-resolver pattern as resumePicker, generic to any yes/no confirmation
  // (run_shell execution, write_file overwrite). A caller can chain two of these in sequence by
  // calling askConfirm twice, awaiting each in turn - no special "double confirm" logic needed.
  // `id` exists purely to be passed as <ConfirmDialog>'s `key` (below) - without it, two sequential
  // dialogs would be the same component instance (no key change, same JSX type), so
  // ConfirmDialog's own internal `selected` state could carry over from the first dialog's "Yes"
  // into the second instead of resetting to its documented "always defaults to No" - a real bug
  // found via the now-removed /wipe command (which used to chain two confirmations), masked by
  // exactly how React happened to batch the null-then-new setConfirmDialog calls across the
  // intervening microtask, which changed on the React 19 upgrade. Kept even with no current
  // sequential-confirm caller, since the underlying key-reuse bug applies to any future one too.
  const [confirmDialog, setConfirmDialog] = useState<{
    id: number;
    message: string;
    tool: Tool;
    input: Record<string, unknown>;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const askConfirm = useCallback(
    (message: string, tool: Tool, input: Record<string, unknown>): Promise<boolean> => {
      return new Promise((resolve) => {
        setConfirmDialog({ id: nextDialogId++, message, tool, input, resolve });
      });
    },
    [],
  );

  // Real bug found via hands-on testing, 2026-09-26: switching to Auto mid-turn (Tab or /mode,
  // while a long multi-tool-call turn was already running) kept confirming every remaining
  // run_shell call in that turn instead of taking effect immediately. Root cause: `loop.run()`
  // captures one `toolPolicy` function *reference* for the whole turn (every iteration's tool
  // call awaits that same reference, per loop.ts), so a plain closure over `mode` only ever sees
  // whatever `mode` was at the moment the turn started - a later `setMode` doesn't retroactively
  // reach an already-passed closure. Refs sidestep this: the closure itself can stay the same,
  // but reading `.current` on each call picks up whatever `setMode` most recently wrote,
  // including mid-turn, since the ref is mutated directly in the render body below (not via
  // useEffect - there's no external side effect to defer, just keeping a plain mutable cache in
  // sync every render, the same pattern this file already uses for currentSessionIdRef/
  // inputHistoryRef).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const plansDirRef = useRef(plansDir);
  plansDirRef.current = plansDir;

  // Read inside the turn callback rather than captured: a level chosen while a turn was queued
  // should still apply to it, exactly as modeRef/plansDirRef do for their own settings.
  const thinkLevelRef = useRef(thinkLevel);
  thinkLevelRef.current = thinkLevel;
  // Read inside a running turn's event handler, which is outside the render that owns the state.
  const sessionViewRef = useRef(shownSessionView);
  sessionViewRef.current = shownSessionView;
  // What the status bar shows: the level that will really take effect, which on a model missing
  // a control can be weaker than the one chosen.
  const shownThinkLevel = effectiveThinkLevel(thinkLevel, thinkCaps ?? DEFAULT_THINK_CAPS);
  // Project-wise location for the footer's second line - pure, so it costs nothing per render.
  // The volume prefix appears once `mountPoint` resolves (one stat, on mount).
  const projectLabelText = projectLabel(projectRoot, process.cwd(), mountPoint);

  // The saved level is per model id, so Qwen3 and Claude each keep their own - the setting is
  // about how a particular model behaves, not a global preference. Read once on mount; a missing
  // or unparseable value leaves the unrestricted default, which is what the server did anyway.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = (await configStore.get(THINK_LEVEL_CONFIG_KEY)) as Record<string, unknown> | undefined;
        const forModel = saved && typeof saved === 'object' ? saved[model] : undefined;
        const level = typeof forModel === 'string' ? parseThinkLevel(forModel) : undefined;
        if (!cancelled && level) setThinkLevel(level);
      } catch {
        // A cosmetic preference - an unreadable config must not stop the app starting.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configStore, model]);

  // Branch for the footer. Read on mount and again whenever a turn finishes (a turn can switch
  // branches), never per render - see gitInfo.ts on why that distinction matters even though the
  // read itself is one small file.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const branch = await readGitBranch(projectRoot ?? process.cwd());
      if (!cancelled) setGitBranch(branch);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoot, isProcessing]);

  // Volume for the footer, read once. Deliberately NOT keyed on isProcessing like the branch
  // above: a drive letter or mount point is fixed for the life of the process, so re-reading it
  // per turn would be stats spent to learn the same answer.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mount = await readMountPoint(projectRoot ?? process.cwd());
      if (!cancelled) setMountPoint(mount);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  // Passed into loop.run() as RunOptions.toolPolicy - the current mode decides whether a
  // mutating tool call runs silently, needs a yes/no first (via the same generic ConfirmDialog
  // above), or is refused outright (Plan/Plan-Write modes). Reads modeRef/plansDirRef (not the
  // mode/plansDir variables directly) so a mode change takes effect on the very next tool call,
  // even mid-turn - see the comment on those refs above for why that distinction matters.
  const toolPolicy = useCallback(
    async (tool: Tool, input: Record<string, unknown>): Promise<'allow' | 'deny'> => {
      const access = classifyToolAccess(modeRef.current, tool, input, plansDirRef.current);
      if (access === 'allow') return 'allow';
      if (access === 'deny') return 'deny';
      const ok = await askConfirm(formatConfirmMessage(tool.name, input), tool, input);
      return ok ? 'allow' : 'deny';
    },
    [askConfirm],
  );

  // A mode switch (Tab/`/mode`) should take effect immediately on an already-*open* confirmation
  // too, not just on the next tool call (modeRef above already covers that case) - real bug found
  // via direct user report: switching Manual -> Auto mid-turn while a permission prompt was up
  // left the prompt sitting there, blocking, instead of auto-approving it - even though Auto's
  // entire point is "don't ask." Re-runs the exact same classifyToolAccess the open prompt's
  // question came from, against the *new* mode: an 'allow' or 'deny' result resolves and closes
  // the dialog right away (matching what would have happened had this mode been active when the
  // call was first made); 'confirm' (the new mode still wants a real answer for this specific
  // call - e.g. Manual -> Accept Edits while confirming a run_shell, which Accept Edits still
  // gates) leaves the dialog open, unchanged. Deliberately keyed on `mode` alone, not
  // `confirmDialog` - this only needs to react to a mode *change*, and re-evaluating a dialog
  // against the same mode it was already opened under is a same-decision no-op anyway.
  useEffect(() => {
    if (!confirmDialog) return;
    const access = classifyToolAccess(mode, confirmDialog.tool, confirmDialog.input, plansDir);
    if (access === 'confirm') return;
    confirmDialog.resolve(access === 'allow');
    setConfirmDialog(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const pushBlock = useCallback((lines: Line[]) => {
    dispatchTextWindow({ type: 'commit', lines });
  }, []);

  // Ctrl+C: force-recover, not exit - revised per direct instruction 2026-09-26 ("I do not want
  // to exit the app just stop background processing, and get the text entry window working again
  // after a fail"). An earlier version of this called process.exit() directly; reverted before it
  // shipped. This is the real gap Escape alone doesn't cover: Escape (handleEscape, below) only
  // ever *asks* the in-flight call to stop via its AbortController, which does nothing if that
  // signal never reaches whatever's actually stuck (every provider and run_shell already have
  // their own real timeout backstops - LocalProvider/AnthropicProvider: 5min, run_shell: 60s - so
  // this is a "faster than waiting out the timeout" button, not the only way out). Ctrl+C instead
  // unconditionally resets the visible UI state right away - the abort is still attempted
  // (best-effort, same as Escape), but the input box becomes usable again immediately regardless
  // of whether that abort actually lands. Bumps turnGenerationRef so a still-stuck call that
  // eventually does settle later recognizes it's stale (see that ref's own comment above) instead
  // of clobbering whatever's happened since. Checked in this same always-active hook (not buried
  // in InputBox) so it fires no matter what has focus - a picker, a confirm dialog, or an
  // unresponsive turn.
  const handleForceRecover = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    turnGenerationRef.current += 1;
    queuedInputsRef.current = [];
    setQueuedPreview([]);
    dispatchTextWindow({ type: 'clearLive' });
    setIsThinking(false);
    setIsInThinkBlock(false);
    setIsProcessing(false);
    pushBlock([
      { kind: 'system', text: 'Stopped (Ctrl+C) - background processing cancelled, input is available again.' },
    ]);
  }, [pushBlock]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        handleForceRecover();
      }
    },
    { isActive: true },
  );

  // Tab cycles through the 5 modes in order, in addition to (not instead of) /mode's picker - a
  // quick keyboard-only path for the same switch. Originally plain Tab only, not Shift+Tab:
  // without the Kitty keyboard protocol, Windows Terminal sends the identical byte (0x09) for
  // both, with no way to tell them apart (confirmed with a raw-input probe - ConPTY only
  // disambiguates via the separate "Win32 Input Mode" protocol, which Ink doesn't support).
  // cli.ts's render() now opts into Kitty protocol detection (mode: 'auto'), and on a terminal
  // that supports it (confirmed via a raw-byte capture of key.shift on David's Windows Terminal
  // - see the plan for the log), key.shift now correctly reports true for Shift+Tab and false
  // for plain Tab. This handler doesn't act on that distinction yet - both still cycle forward
  // identically - since Kitty support isn't universal (older/non-Preview terminals still send
  // the ambiguous byte, silently falling back to today's behavior). Nothing else in this app's
  // input boxes or pickers does anything with bare Tab, so it was free to claim either way.
  // Always active regardless of what else is showing, matching how this shortcut behaves
  // elsewhere.
  useInput(
    (_input, key) => {
      if (key.tab) {
        const currentIndex = MODES.findIndex((m) => m.mode === mode);
        const next = MODES[(currentIndex + 1) % MODES.length].mode;
        setMode(next);
        pushBlock([{ kind: 'system', text: `Mode set to ${modeInfo(next).label}.` }]);
      }
    },
    { isActive: true },
  );

  const processTurn = useCallback(
    async (input: string) => {
      // /exit, /quit, and /clear are intercepted earlier, in handleSubmit, before they can ever
      // be queued behind a busy turn - they never reach here.
      if (input === '/context' || input === '/ctx') {
        const usage = loop.getUsage();
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const visible = loop.getVisibleTokenEstimate();
        // The fill graph - only when contextWindow is known (config.json's opt-in key, per
        // StatusBar's own reasoning: no per-model max-context registry exists yet, so this
        // never guesses a number). estimateTokens() is a chars/4 heuristic (contextEntry.ts),
        // not exact - labeled "estimated" rather than presented as a hard count.
        const graphLines = contextWindow
          ? [
              `  Context window: ${formatTokenCount(visible)} / ${formatTokenCount(contextWindow)} estimated (${Math.round(
                (visible / contextWindow) * 100,
              )}%)`,
              `  ${renderProgressBar(visible / contextWindow, 30)}`,
            ]
          : [`  Context window: ${formatTokenCount(visible)} estimated (max unknown - set "contextWindow" in config.json to see %)`];
        const text = [
          'Session usage (local only, no LLM call):',
          ...graphLines,
          `  Requests sent: ${usage.requestCount}`,
          `  Input tokens:  ${usage.inputTokens}`,
          `  Output tokens: ${usage.outputTokens}`,
          `  Total tokens:  ${totalTokens}`,
          `  Messages in history: ${loop.getMessages().length}`,
        ].join('\n');
        pushBlock([
          userLine(input),
          infoLine(text),
        ]);
      } else if (commandName(input).startsWith('/keyboard-')) {
        // The "/keyboard-<os>" family: same table, asked about a system other than this
        // one. Named commands rather than only the `[windows|mac|linux]` argument so they are
        // discoverable from the picker instead of having to be known in advance.
        pushBlock([userLine(input)]);
        const wanted = parseOsArg(commandName(input).slice('/keyboard-'.length));
        if (!wanted) {
          pushBlock([{ kind: 'error', text: 'Usage: /keyboard-windows, /keyboard-mac or /keyboard-linux' }]);
        } else {
          pushBlock([infoLine(renderKeyboardCommandsHelp(undefined, wanted))]);
        }
      } else if (commandName(input) === '/keyboard') {
        // Local, display-only, exactly like /context above - never calls loop.run(), so this
        // table is never sent to the model or added to conversation history (see the module's
        // own doc comment for why that matters for a later, currently out-of-scope feature -
        // docs/plans/0001.FrontEndIDEChanges.checklist.md #16, "infinite context window").
        pushBlock([userLine(input)]);
        const osArg = input.slice(commandName(input).length).trim();
        if (!osArg) {
          pushBlock([infoLine(renderKeyboardCommandsHelp(undefined, os))]);
        } else {
          const parsed = parseOsArg(osArg);
          if (!parsed) {
            pushBlock([{ kind: 'error', text: 'Usage: /keyboard [windows|mac|linux]' }]);
          } else {
            pushBlock([infoLine(renderKeyboardCommandsHelp(undefined, parsed))]);
          }
        }
      } else if (input === '/mode') {
        pushBlock([userLine(input)]);
        const chosen = await new Promise<Mode | undefined>((resolve) => {
          setModePicker({ resolve });
        });
        if (chosen) {
          setMode(chosen);
          pushBlock([infoLine(`Mode set to ${modeInfo(chosen).label}.`)]);
        } else {
          pushBlock([infoLine('Mode unchanged.')]);
        }
      } else if (input === '/think' || input.startsWith('/think ')) {
        pushBlock([userLine(input)]);
        // `/think high` sets it outright; a bare `/think`, or an argument that is not a level,
        // opens the dropdown rather than erroring - a typo should land you in the list, not a
        // rejection message.
        const typed = input.slice('/think'.length).trim();
        const direct = typed ? parseThinkLevel(typed) : undefined;
        if (typed && !direct) {
          pushBlock([
            infoLine(`"${typed}" is not a thinking level - choose one of ${THINK_LEVELS.join(', ')}.`),
          ]);
        }
        const chosen =
          direct ??
          (await new Promise<ThinkLevel | undefined>((resolve) => {
            setThinkPicker({ resolve });
          }));
        if (chosen) {
          setThinkLevel(chosen);
          const effective = effectiveThinkLevel(chosen, thinkCaps ?? DEFAULT_THINK_CAPS);
          // Said plainly when the model cannot deliver what was asked for, rather than letting the
          // status bar quietly show something else than the command reported.
          const note =
            effective === chosen
              ? ''
              : ` (this model cannot do ${THINK_LEVEL_INFO[chosen].label}; using ${THINK_LEVEL_INFO[effective].label})`;
          pushBlock([infoLine(`Thinking level set to ${THINK_LEVEL_INFO[chosen].label}.${note}`)]);
          // Persisted per model, best-effort: the level is already live either way, and failing a
          // turn over a preference write would be the wrong trade.
          //
          // Written to the scope the *merged* read will actually return (`scopeOwningEntry`), not
          // always to global. This used to write global unconditionally, which made the setting
          // look broken from the user's side: copy-on-trust seeds a trusted project's local
          // `config.json` as a snapshot of global, that snapshot's level then won every
          // `configStore.get()`, and so the end-of-turn reload restored the snapshot instead of
          // the chosen level - reported 2026-10-09 as "it resets to xhigh when it finishes a
          // thought". Also merges into that one file's own map rather than the resolved view, so a
          // save can no longer copy another scope's entries into this one.
          void (async () => {
            try {
              const scope = await scopeOwningEntry(configStore, THINK_LEVEL_CONFIG_KEY, model);
              const own = (await configStore.readScope(scope))[THINK_LEVEL_CONFIG_KEY];
              const next = { ...(own && typeof own === 'object' ? own : {}), [model]: chosen };
              await configStore.set(scope, THINK_LEVEL_CONFIG_KEY, next);
            } catch {
              // Keep the in-session level; it simply will not survive a restart.
            }
          })();
          void runLogger.log({ type: 'system', sub_type: 'info', command: '/think', level: chosen });
        } else {
          pushBlock([infoLine('Thinking level unchanged.')]);
        }
      } else if (input === '/set' || input === '/config') {
        // Submitted rather than chosen from the dropdown. The dropdown owns Enter while it is open,
        // so reaching here means it was dismissed with Esc first - these commands have no action of
        // their own (`select: 'none'`), they head their family's list. Say where the list is rather
        // than opening a second, separate picker for the same rows, which is what used to happen.
        pushBlock([userLine(input)]);
        pushBlock([
          infoLine(`Type ${input} and choose from the list below the input box (↑/↓ then Enter).`),
        ]);
      } else if (
        commandName(input) === '/config-highlightcolor' ||
        commandName(input) === '/config-local-highlightcolor' ||
        commandName(input) === '/config-global-highlightcolor'
      ) {
        pushBlock([userLine(input)]);
        const name = commandName(input);
        const scope: ConfigScope = name === '/config-global-highlightcolor' ? 'global' : 'local';
        const color = input.slice(name.length).trim();
        const usage = `Usage: ${name} <color> - a #RRGGBB hex code or one of: ${HIGHLIGHT_COLOR_NAMES.join(', ')}`;
        if (!color) {
          pushBlock([{ kind: 'error', text: usage }]);
        } else if (!isValidHighlightColor(color)) {
          pushBlock([{ kind: 'error', text: `Unrecognized color "${color}". ${usage}` }]);
        } else if (scope === 'local' && !configStore.hasScope('local')) {
          pushBlock([
            {
              kind: 'error',
              text: 'No trusted project in this directory - nothing to set a local value into. Trust this project first, or use /config-global-highlightcolor instead.',
            },
          ]);
        } else {
          try {
            await configStore.set(scope, 'highlightColor', color);
            setHighlightColor(color);
            pushBlock([infoLine(`Highlight color set to ${color} (${scope}).`)]);
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (commandName(input) === '/set-sessionname') {
        pushBlock([userLine(input)]);
        const newName = input.slice(commandName(input).length).trim();
        if (!currentSessionIdRef.current) {
          pushBlock([
            infoLine('No active session yet - send a message first, then /set-sessionname <name>.'),
          ]);
        } else if (!newName) {
          pushBlock([{ kind: 'error', text: 'Usage: /set-sessionname <name>' }]);
        } else {
          try {
            await sessionStore.rename(currentSessionIdRef.current, newName);
            pushBlock([infoLine(`Session renamed to "${newName}".`)]);
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (
        commandName(input) === '/set-think' ||
        commandName(input) === '/set-local-think' ||
        commandName(input) === '/set-global-think'
      ) {
        // The stored level new sessions start at, as opposed to `/think`, which changes this one.
        // Deliberately does NOT touch the running session or reload it: a reload mid-session is
        // justified for `/set-sessionview` (it repaints the screen the setting describes) but here
        // it would throw away a live session to apply a setting that is about the next one.
        pushBlock([userLine(input)]);
        const name = commandName(input);
        const scope: ConfigScope = name === '/set-global-think' ? 'global' : 'local';
        if (scope === 'local' && !configStore.hasScope('local')) {
          pushBlock([
            {
              kind: 'error',
              text: 'No trusted project in this directory - nothing to set a local value into. Trust this project first, or use /set-global-think instead.',
            },
          ]);
        } else {
          try {
            const levelsIn = async (s: ConfigScope): Promise<Record<string, unknown>> => {
              const raw = (await configStore.readScope(s))[THINK_LEVEL_CONFIG_KEY];
              return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
            };
            // Per model, like `/think`: the setting is about how one model behaves, so a project
            // pinned to `low` for Qwen3 says nothing about Claude.
            const storedRaw = (await levelsIn(scope))[model];
            const globalRaw = (await levelsIn('global'))[model];
            const storedLevel = typeof storedRaw === 'string' ? parseThinkLevel(storedRaw) : undefined;
            const globalLevel = typeof globalRaw === 'string' ? parseThinkLevel(globalRaw) : undefined;
            const chosen = await new Promise<ThinkScopeChoice | undefined>((resolve) => {
              setThinkScopePicker({ scope, storedLevel, globalLevel, resolve });
            });
            if (!chosen) {
              pushBlock([infoLine('Thinking level for new sessions unchanged.')]);
            } else {
              const levels = await levelsIn(scope);
              if (chosen === 'default') delete levels[model];
              else levels[model] = chosen;
              await configStore.set(scope, THINK_LEVEL_CONFIG_KEY, levels);
              const follows =
                scope === 'local'
                  ? `this machine's choice (currently ${THINK_LEVEL_INFO[globalLevel ?? DEFAULT_THINK_LEVEL].label})`
                  : `o4c's built-in default (${THINK_LEVEL_INFO[DEFAULT_THINK_LEVEL].label})`;
              const what =
                chosen === 'default'
                  ? `Stored thinking level cleared (${scope}); new sessions follow ${follows}.`
                  : `Thinking level for new sessions set to ${THINK_LEVEL_INFO[chosen].label} (${scope}).`;
              // Said every time, because the one thing a user will check is the footer, and the
              // footer is not going to move.
              const note =
                scope === 'global' && configStore.hasScope('local') && (await levelsIn('local'))[model] !== undefined
                  ? ' This project has its own value, which still wins here.'
                  : '';
              pushBlock([
                infoLine(
                  `${what}${note} This session stays on ${THINK_LEVEL_INFO[thinkLevelRef.current].label} - use /think to change it now.`,
                ),
              ]);
              void runLogger.log({ type: 'system', sub_type: 'info', command: name, level: chosen, scope });
            }
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (
        commandName(input) === '/set-sessionview' ||
        commandName(input) === '/set-local-sessionview' ||
        commandName(input) === '/set-global-sessionview'
      ) {
        // How much of a saved session the screen shows after a reload or /resume (compact or full). A
        // picklist, not a typed value: bare and -local- edit the project tier, -global- the machine
        // tier. "default (global)" copies the current global value into the project (one-time copy).
        pushBlock([userLine(input)]);
        const name = commandName(input);
        const scope: ConfigScope = name === '/set-global-sessionview' ? 'global' : 'local';
        if (scope === 'local' && !configStore.hasScope('local')) {
          pushBlock([
            {
              kind: 'error',
              text: 'No trusted project in this directory - nothing to set a local value into. Trust this project first, or use /set-global-sessionview instead.',
            },
          ]);
        } else {
          try {
            const globalConfig = await configStore.readScope('global');
            const storedRaw =
              scope === 'global' ? globalConfig.sessionView : (await configStore.readScope('local')).sessionView;
            const globalValue = parseSessionView(globalConfig.sessionView);
            const storedValue = storedRaw === undefined ? undefined : parseSessionView(storedRaw);
            const chosen = await new Promise<SessionViewChoice | undefined>((resolve) => {
              setViewPicker({
                scope,
                currentValue: storedValue ?? (scope === 'local' ? globalValue : 'compact'),
                storedValue,
                globalValue,
                resolve,
              });
            });
            if (!chosen) {
              pushBlock([infoLine('Session view unchanged.')]);
            } else {
              const value: SessionView = chosen === 'default' ? globalValue : chosen;
              await configStore.set(scope, 'sessionView', value);
              // Re-resolved rather than assumed to be `value`: setting the global value changes
              // nothing here when this project has its own (the note below says exactly that), and
              // the footer has to show whichever one wins.
              setShownSessionView(parseSessionView(await configStore.get('sessionView')));
              let note = '';
              if (scope === 'global' && configStore.hasScope('local')) {
                const localRaw = (await configStore.readScope('local')).sessionView;
                if (localRaw !== undefined && parseSessionView(localRaw) !== value) {
                  note = ` This project has its own value (${parseSessionView(localRaw)}), which still wins here.`;
                }
              }
              const sessionId = currentSessionIdRef.current;
              const repaintNow = Boolean(reloadAfterTurn && sessionId);
              pushBlock([
                infoLine(
                  `Session view set to ${value} (${scope}${chosen === 'default' ? ', copied from the global value' : ''}).${note}` +
                    (repaintNow ? '' : ' It takes effect at the next reload or /resume.'),
                ),
              ]);
              if (repaintNow) {
                // Reload into the same session so the screen repaints in the new view right away - the
                // same handoff the end-of-turn reload uses, keeping the mode.
                restart(sessionId, modeRef.current);
                setTimeout(() => exit(), 0);
              }
            }
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (
        commandName(input) === '/set-sessionsToSave' ||
        commandName(input) === '/set-local-sessionsToSave' ||
        commandName(input) === '/set-global-sessionsToSave'
      ) {
        // Front-end plan item #9 - same local/global structure as /config-highlightcolor above,
        // just under the /set family (a session-store retention setting, not a plugin config).
        pushBlock([userLine(input)]);
        const name = commandName(input);
        const scope: ConfigScope = name === '/set-global-sessionsToSave' ? 'global' : 'local';
        const raw = input.slice(name.length).trim();
        const usage = `Usage: ${name} <n> - a positive whole number of sessions to keep`;
        const n = Number(raw);
        if (!raw) {
          pushBlock([{ kind: 'error', text: usage }]);
        } else if (!Number.isInteger(n) || n < 1) {
          pushBlock([{ kind: 'error', text: `"${raw}" isn't a positive whole number. ${usage}` }]);
        } else if (scope === 'local' && !configStore.hasScope('local')) {
          pushBlock([
            {
              kind: 'error',
              text: 'No trusted project in this directory - nothing to set a local value into. Trust this project first, or use /set-global-sessionsToSave instead.',
            },
          ]);
        } else {
          try {
            await configStore.set(scope, 'sessionsToSave', n);
            // Immediate effect for this process too, not just persisted for the next launch -
            // same dual effect /config-highlightcolor already established.
            sessionStore.maxSessions = n;
            pushBlock([infoLine(`Sessions to save set to ${n} (${scope}).`)]);
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (input === '/help') {
        pushBlock([userLine(input)]);
        const lines = COMMANDS.map(
          (c) => `${c.name}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''} — ${c.description}`,
        );
        pushBlock([
          infoLine(
            ['Available commands:', ...lines, '', 'Use /help-<command> for more detail on one, e.g. /help-mode.'].join(
              '\n',
            ),
          ),
        ]);
        void runLogger.log({ type: 'system', sub_type: 'info', command: '/help' });
      } else if (commandName(input).startsWith('/help-')) {
        pushBlock([userLine(input)]);
        const rest = commandName(input).slice('/help-'.length);
        const target = commandForHelpTarget(rest);
        if (!target) {
          pushBlock([{ kind: 'error', text: `No such command: /${rest}. Try /help for the full list.` }]);
        } else {
          const detailLines = [`${target.name}${target.aliases?.length ? ` (${target.aliases.join(', ')})` : ''} — ${target.description}`];
          // /help-mode's actual point (per direct instruction) - explain what each of the five
          // modes does, not just repeat /mode's own one-line summary. MODES is the single source
          // of truth (modePolicy.ts) both /mode's picker and this reuse the same way, so this
          // can't drift from what /mode itself actually shows.
          if (target.name === '/mode') {
            detailLines.push('', 'Modes:');
            for (const m of MODES) detailLines.push(`  ${m.label} — ${m.description}`);
          }
          pushBlock([infoLine(detailLines.join('\n'))]);
          void runLogger.log({ type: 'system', sub_type: 'info', command: `/help-${rest}` });
        }
      } else if (looksLikeSlashCommand(input) && !KNOWN_COMMANDS.includes(commandName(input))) {
        pushBlock([
          userLine(input),
          {
            kind: 'error',
            text: `Unknown command: ${commandName(input)}. Known commands: ${KNOWN_COMMANDS.join(', ')}.`,
          },
        ]);
      } else {
        // Echo the user's own line immediately, as its own permanent block - don't
        // wait for the (possibly very long) response before it shows up in scrollback.
        pushBlock([userLine(input)]);

        const responseLines: Line[] = [];
        dispatchTextWindow({ type: 'clearLive' });
        setIsThinking(true);
        // True by default at the start of every round waiting on the model - including a
        // non-streaming provider's silent gap before its first byte, which is exactly the
        // long-running-reasoning case Esc should ask about. Flipped false the instant a 'text'
        // delta or a tool_call shows the model isn't (or is no longer) reasoning.
        setIsInThinkBlock(true);
        let toolEventCount = 0;
        let summaryLine: Line | undefined;
        // Turn outcome flags for the end-of-turn reload decision below.
        let turnFailed = false;
        let turnSaved = false;
        turnHadThinkRef.current = false;
        lastDeltaKindRef.current = null;
        streamTailRef.current = '';
        streamCommittedRef.current = { think: false, text: false };
        // Defensive - the finally block below always flushes and clears these at the end of every
        // turn, but starting clean here too means a stray leftover timer/buffer can never bleed a
        // late dispatch into a turn that didn't produce it.
        if (deltaFlushTimerRef.current !== null) {
          clearTimeout(deltaFlushTimerRef.current);
          deltaFlushTimerRef.current = null;
        }
        deltaBufferRef.current = null;

        const controller = new AbortController();
        abortControllerRef.current = controller;
        // Captured now, checked after the await settles (whenever that is) - see
        // turnGenerationRef's own comment above for why this exists.
        const myGeneration = turnGenerationRef.current;

        try {
          const finalAnswer = await loop.run(input, {
            images: initialImage ? [initialImage] : undefined,
            toolPolicy,
            modeInstruction: modeSystemPrompt(mode, plansDir),
            signal: controller.signal,
            contextWindow,
            toolOutputDir,
            // `/think`'s level, read fresh per turn via the ref so a change made while a turn
            // was queued still applies to it.
            thinkLevel: thinkLevelRef.current,
            maxIterations,
            // The full request/response wire transcript - "the sends", distinct from onEvent's
            // already-derived AgentEvent stream below (which only ever carries the *response*
            // side, split/reshaped for display). Fire-and-forget, same reasoning as runLogger's
            // own calls: a logging failure must never interrupt the turn itself.
            onProviderCall: (call) => {
              // Delta logging: the request's messages are the growing visible history, so
              // logging the full request every round-trip is O(n²) disk over a session (and a
              // multi-MB stringify per call). The first call of the session - and any call after
              // a compaction shrank the message list - logs the full request in the original
              // shape; in between, only the messages new since the previous call. Concatenating
              // the deltas reconstructs every request exactly, so nothing is lost.
              const prev = lastProviderLogRef.current;
              const compacted = call.request.messages.length < prev.messageCount;
              if (prev.messageCount === 0 || compacted) {
                void fullContextLogger.log({ type: 'provider_call', ...call });
              } else {
                void fullContextLogger.log({
                  type: 'provider_call_delta',
                  ...(call.request.systemPrompt !== prev.systemPrompt
                    ? { systemPrompt: call.request.systemPrompt }
                    : {}),
                  messages: call.request.messages.slice(prev.messageCount),
                  response: call.response,
                });
              }
              lastProviderLogRef.current = {
                messageCount: call.request.messages.length,
                systemPrompt: call.request.systemPrompt,
              };
            },
            onEvent: (event: AgentEvent) => {
              // Raw streamed text - a live-preview-only signal, not logged (the run log already
              // gets the complete, final 'think'/'text' events below once the stream ends) and
              // not one of responseLines' permanent entries. Appends onto the current streaming
              // line rather than starting a new one each time (textWindow.ts's own deltaActive
              // tracking) - handled first and returned early since every other event type below
              // means "a new, distinct line", the opposite of what a delta continuation needs.
              if (event.type === 'delta') {
                if (event.text) {
                  // event.kind reflects what the provider actually said this chunk was (see
                  // AgentEvent's own doc comment) - defaulted to 'text' only for a provider/fake
                  // that predates this and never sets it. A kind change from the previous delta
                  // (including the very first delta of the turn, since the ref starts null) means
                  // a fresh line: reasoning starting gets a "[think] " label live, the instant it
                  // begins streaming rather than only after the fact; the answer starting after
                  // reasoning gets a clean new line instead of running on from the think text.
                  const kind = event.kind ?? 'text';
                  if (kind === 'think') turnHadThinkRef.current = true;
                  const kindChanged = lastDeltaKindRef.current !== kind;
                  lastDeltaKindRef.current = kind;
                  if (kindChanged) setIsInThinkBlock(kind === 'think');
                  // The label goes in as its own line (labelled() puts the newline there), so the
                  // progressive commit splits it onto a line of its own and the text that follows
                  // starts at the left margin under it - live and repaint produce the same shape.
                  const text = kindChanged
                    ? labelled(kind === 'think' ? THINK_TAG : RESPONSE_TAG, event.text)
                    : event.text;
                  // Buffered, not dispatched directly - see deltaBufferRef's own doc comment for
                  // the O(n²) render-cost blowup this avoids. A kind change flushes whatever was
                  // pending under the OLD kind first, so it never gets merged into the new kind's
                  // own line, then starts a fresh buffer carrying this delta's own startNewLine.
                  if (kindChanged || !deltaBufferRef.current) {
                    flushDeltaBuffer();
                    // In `full` the flushed-out kind's own unfinished line is committed too, so the
                    // new kind starts on a line of its own rather than being appended to it.
                    if (kindChanged && sessionViewRef.current === 'full') {
                      flushStreamTail(kind === 'think' ? 'text' : 'think');
                    }
                    deltaBufferRef.current = { text, startNewLine: kindChanged, kind };
                  } else {
                    deltaBufferRef.current.text += text;
                  }
                  // Leading-edge flush on a kind change so "[think] ..." (or the answer) appears the
                  // instant it starts; after that, chunks coalesce until 5 lines or the heartbeat.
                  if (deltaBufferRef.current && (kindChanged || shouldFlushDelta(deltaBufferRef.current.text, process.stdout.columns ?? 80))) {
                    if (deltaFlushTimerRef.current !== null) {
                      clearTimeout(deltaFlushTimerRef.current);
                      deltaFlushTimerRef.current = null;
                    }
                    flushDeltaBuffer();
                  } else if (deltaFlushTimerRef.current === null) {
                    const timer = setTimeout(() => {
                      deltaFlushTimerRef.current = null;
                      flushDeltaBuffer();
                    }, DELTA_FLUSH_MS);
                    timer.unref?.();
                    deltaFlushTimerRef.current = timer;
                  }
                }
                return;
              }

              // The full, untruncated event always goes to the run log, regardless of what (or
              // whether) anything gets displayed - fire-and-forget, a logging failure shouldn't
              // interrupt the turn.
              void runLogger.log({ event });
              // Same event, also into the full-context log - tool_call/tool_result here is what
              // completes "everything" alongside onProviderCall's request/response pairs above
              // (a tool's actual execution result isn't part of any provider request/response,
              // it's the agent's own local action).
              void fullContextLogger.log({ event });

              const isToolEvent = event.type === 'tool_call' || event.type === 'tool_result';
              if (isToolEvent) {
                toolEventCount += 1;
                // tool_call: the tool is now executing (short, minutes at most) - stop asking.
                // tool_result: the tool finished, so the next model round is starting - back to
                // the risky long-wait case until its own delta/tool_call says otherwise.
                setIsInThinkBlock(event.type === 'tool_result');
              }

              // Full view shows every tool event, exactly as the repaint does - the collapse is a
              // compact-view economy, and applying it here regardless of the setting was half of
              // why `full` did not look full while a turn was running.
              if (isToolEvent && sessionViewRef.current !== 'full' && toolEventCount > MAX_VISIBLE_TOOL_EVENTS_PER_TURN) {
                const collapsed = toolEventCount - MAX_VISIBLE_TOOL_EVENTS_PER_TURN;
                const text = `[scan] ${collapsed} more tool call${collapsed === 1 ? '' : 's'} collapsed - full detail in ${runLogger.getFilePath() ?? 'the run log'}.`;
                if (summaryLine) {
                  summaryLine.text = text;
                } else {
                  summaryLine = { kind: 'system', text };
                  responseLines.push(summaryLine);
                }
                dispatchTextWindow({ type: 'updateScanSummary', text });
                return;
              }

              // `full` commits everything as it happens, so a tool line has to be committed here,
              // in the order it occurred - the end-of-turn commit the compact view uses would put
              // every tool line *after* the reasoning and answer that have already been written to
              // scrollback above it. The unfinished stream line is committed first for the same
              // reason, and the delta kind is reset so the next round's reasoning starts a fresh
              // "[think]" line instead of running on from the previous round's.
              if ((event.type === 'tool_call' || event.type === 'tool_result') && sessionViewRef.current === 'full') {
                const text = formatEvent(event, 'full');
                if (!text) return;
                flushStreamTail(lastDeltaKindRef.current);
                lastDeltaKindRef.current = null;
                dispatchTextWindow({ type: 'commit', lines: [{ kind: event.type, text }] });
                return;
              }

              // Already shown live via 'delta' events as they streamed in - re-appending the full,
              // final text here would duplicate it. Only skipped when `streamed` is actually true
              // though - a provider without onToken support (no real one lacks it, but a test
              // fake or a future one might) never emitted any 'delta' for this call, so this event
              // is the only place its content ever reaches the screen. The final answer is still
              // committed to scrollback separately below, exactly once ('think' entries never were).
              if (event.type === 'think') {
                turnHadThinkRef.current = true;
                // Committed to scrollback in the configured view, exactly as the final answer is
                // below. Until 2026-10-09 thinking was the one thing that lived only in the
                // transient live region: on screen while the model reasoned, gone the instant the
                // turn ended, with the end-of-turn reload's repaint the only way back. So every
                // turn that skipped that reload - a draft left in the input box, something queued,
                // a failed turn, O4C_NO_RELOAD=1 - silently lost its reasoning from the screen no
                // matter what /set-sessionview said, which is how this was reported.
                // Not in `full` once the reasoning actually streamed: it was committed line by
                // line as it arrived (commitStreamText), so pushing the whole block again here
                // would print the entire think a second time under it.
                if (event.text && !(sessionViewRef.current === 'full' && event.streamed && streamCommittedRef.current.think)) {
                  responseLines.push({ kind: 'system', text: thinkLineText(event.text, sessionViewRef.current) });
                }
              }
              if ((event.type === 'think' || event.type === 'text') && event.streamed) return;

              const text = formatEvent(event, sessionViewRef.current);
              if (!text) return;
              // Same ordering rule as the tool lines above: in `full` these are committed where
              // they happened rather than collected for the end of the turn.
              if (
                sessionViewRef.current === 'full' &&
                (event.type === 'compaction' || event.type === 'prune' || event.type === 'warning')
              ) {
                flushStreamTail(lastDeltaKindRef.current);
                lastDeltaKindRef.current = null;
                dispatchTextWindow({
                  type: 'commit',
                  lines: [{ kind: event.type === 'warning' ? 'error' : 'system', text }],
                });
                return;
              }
              dispatchTextWindow({ type: 'appendLive', text });
              if (event.type === 'tool_call' || event.type === 'tool_result') {
                responseLines.push({ kind: event.type, text });
              } else if (event.type === 'compaction' || event.type === 'prune') {
                // Rare and worth a permanent record, unlike plain "text" narration - a user
                // scrolling back should be able to see exactly when/why older history vanished
                // from what the model sees.
                responseLines.push({ kind: 'system', text });
              } else if (event.type === 'warning') {
                // Same permanent-record reasoning as compaction above - a truncated response is
                // exactly the kind of thing that must not just scroll off with the live region and
                // be lost (see loop.ts's own comment on the bug this replaces: a silent empty turn).
                responseLines.push({ kind: 'error', text });
              }
            },
          });
          // Skipped in `full` when the answer streamed: every line of it is already in scrollback,
          // committed as it arrived, so this would be a second copy of the whole thing.
          if (finalAnswer && !(sessionViewRef.current === 'full' && streamCommittedRef.current.text)) {
            responseLines.push({ kind: 'final', text: labelled(RESPONSE_TAG, finalAnswer) });
          }
        } catch (err) {
          turnFailed = true;
          if (err instanceof AbortedError) {
            // Escape while thinking: history was already rolled back inside loop.run() itself -
            // just put the prompt that started this turn back in the input box, unedited, so the
            // user can revise and resend it. Not an "error" line - a plain system note fits the
            // deliberate, expected nature of a cancellation better than the red error styling.
            responseLines.push({ kind: 'system', text: 'Cancelled - your message is back in the input box.' });
            setPrefill({ token: nextPrefillToken++, text: err.prompt });
          } else if (err instanceof ServerUnavailableError) {
            // Not a failed request: the server cannot answer yet. The loop already rolled the turn back, so put
            // the message back in the input box and open the wait box - when the server answers the user just
            // presses Enter again.
            responseLines.push({
              kind: 'error',
              text: `${err.message} Your message is back in the input box - waiting for the server.`,
            });
            if (err.prompt) setPrefill({ token: nextPrefillToken++, text: err.prompt });
            setServerWait({ status: err.loading ? 'loading' : 'down', checks: 0 });
          } else {
            responseLines.push({ kind: 'error', text: formatError(err) });
          }
        } finally {
          // Whenever this call actually settles: if the generation has moved on (the user
          // force-recovered via Ctrl+C, and possibly already started a newer turn), this
          // invocation is stale - abandoned, not cancelled, since whatever it was stuck on may
          // never have honored the abort signal. Skip every visible-state mutation below (a
          // newer generation already owns isThinking/isProcessing/liveLines/scrollback, and
          // clobbering them with a late result would be actively wrong, not just redundant) -
          // but still let the entries this call already produced get persisted (below), since
          // that data is real and there's no reason to throw it away.
          const stale = turnGenerationRef.current !== myGeneration;
          if (abortControllerRef.current === controller) abortControllerRef.current = null;
          // Unconditional, even when stale - a dangling timer must never fire a late dispatch into
          // whatever turn (or nothing) comes next. The live region gets fully cleared below when
          // not stale regardless, so any not-yet-flushed buffered text is already moot either way.
          if (deltaFlushTimerRef.current !== null) {
            clearTimeout(deltaFlushTimerRef.current);
            deltaFlushTimerRef.current = null;
          }
          deltaBufferRef.current = null;
          if (!stale) {
            // The last line of a stream rarely ends in a newline, so without this the final
            // sentence of the answer (or of the reasoning, on a cancelled turn) would be the one
            // thing still sitting in the live region when it is cleared below.
            if (sessionViewRef.current === 'full') flushStreamTail(lastDeltaKindRef.current);
            if (responseLines.length > 0) pushBlock(responseLines);
            dispatchTextWindow({ type: 'clearLive' });
            setIsThinking(false);
            setIsInThinkBlock(false);
          }

          // The [scan] collapse itself is a real event worth finding later (e.g. "how often does
          // this project's turns get big enough to truncate the display"), not just the raw
          // tool_call/tool_result events it collapsed - those are already logged individually,
          // unconditionally, above. Logged once per turn (not once per collapsed event, which
          // would just be noise) using the same {type, sub_type} shape /help's own invocation
          // logging already established, so this is ready to backfill into §7's infinite-context
          // store under the same taxonomy once that plugin exists.
          if (toolEventCount > MAX_VISIBLE_TOOL_EVENTS_PER_TURN) {
            void runLogger.log({
              type: 'system',
              sub_type: 'info',
              tag: 'scan-collapse',
              collapsedCount: toolEventCount - MAX_VISIBLE_TOOL_EVENTS_PER_TURN,
              toolEventTotal: toolEventCount,
            });
          }

          // Autosave after every completed turn, success or error - even a failed turn already
          // pushed the user's message into loop's history (AgentLoop.run pushes it before calling
          // the provider), so it's worth persisting rather than losing on a crash or network error.
          // Proceeds even when stale (see above) - the data's real regardless of whether anyone's
          // still watching for it.
          const entries = loop.getEntries();
          if (entries.length > 0) {
            try {
              currentSessionIdRef.current = await sessionStore.save(
                entries,
                currentSessionIdRef.current,
                inputHistoryRef.current,
              );
              turnSaved = true;
              // A brand new session only gets its id here, at its first save. The store needs
              // it before the reload below exits, or this session's subtotal would be filed
              // under no id at all and restart from zero on the next process.
              usageStore?.setSessionId(currentSessionIdRef.current);
            } catch (saveErr) {
              if (!stale) pushBlock([{ kind: 'error', text: `Warning: failed to save session: ${formatError(saveErr)}` }]);
            }
          }

          if (stale) return;
        }

        // Reload the session in a fresh process: the fix for a long thinking/coding turn that ends in a
        // clear or partial screen. Everything the live view held (streamed think text, narration, the
        // rolling live region, Ink's buffers, every per-turn string and array) goes away with the old
        // process; the new one repaints the full saved history (formatEntries) and the user's mode,
        // input history and session carry over. Only when the turn actually saved (never reload from a
        // stale save), succeeded, did real work, left nothing queued, and the user isn't mid-draft.
        if (
          reloadAfterTurn &&
          turnSaved &&
          !turnFailed &&
          (toolEventCount > 0 || turnHadThinkRef.current) &&
          queuedInputsRef.current.length === 0 &&
          inputValueRef.current.trim() === '' &&
          currentSessionIdRef.current
        ) {
          restart(currentSessionIdRef.current, modeRef.current);
          setTimeout(() => exit(), 0);
          return;
        }
      }

      const next = queuedInputsRef.current.shift();
      if (next !== undefined) {
        setQueuedPreview([...queuedInputsRef.current]);
        await processTurn(next);
      } else {
        setIsProcessing(false);
      }
    },
    [loop, initialImage, pushBlock, sessionStore, askConfirm, toolPolicy, mode, plansDir, reloadAfterTurn, restart, exit, contextWindow, toolOutputDir],
  );

  const handleModePickerSelect = useCallback(
    (m: Mode) => {
      modePicker?.resolve(m);
      setModePicker(null);
    },
    [modePicker],
  );

  const handleModePickerCancel = useCallback(() => {
    modePicker?.resolve(undefined);
    setModePicker(null);
  }, [modePicker]);

  // Mirrors handleModePickerSelect/Cancel above.
  const handleThinkPickerSelect = useCallback(
    (level: ThinkLevel) => {
      thinkPicker?.resolve(level);
      setThinkPicker(null);
    },
    [thinkPicker],
  );
  const handleThinkPickerCancel = useCallback(() => {
    thinkPicker?.resolve(undefined);
    setThinkPicker(null);
  }, [thinkPicker]);

  const handleThinkScopeSelect = useCallback(
    (choice: ThinkScopeChoice) => {
      thinkScopePicker?.resolve(choice);
      setThinkScopePicker(null);
    },
    [thinkScopePicker],
  );
  const handleThinkScopeCancel = useCallback(() => {
    thinkScopePicker?.resolve(undefined);
    setThinkScopePicker(null);
  }, [thinkScopePicker]);

  const handleViewPickerSelect = useCallback(
    (choice: SessionViewChoice) => {
      viewPicker?.resolve(choice);
      setViewPicker(null);
    },
    [viewPicker],
  );

  const handleViewPickerCancel = useCallback(() => {
    viewPicker?.resolve(undefined);
    setViewPicker(null);
  }, [viewPicker]);





  const handlePickerSelect = useCallback(
    (id: string) => {
      resumePicker?.resolve(id);
      setResumePicker(null);
    },
    [resumePicker],
  );

  const handlePickerCancel = useCallback(() => {
    resumePicker?.resolve(undefined);
    setResumePicker(null);
  }, [resumePicker]);

  const handleConfirmResolve = useCallback(
    (confirmed: boolean) => {
      confirmDialog?.resolve(confirmed);
      setConfirmDialog(null);
    },
    [confirmDialog],
  );

  const handleInputChange = useCallback((value: string) => {
    inputValueRef.current = value;
    setInputValue(value);
    setPaletteDismissed(false);
  }, []);

  const handlePaletteCancel = useCallback(() => {
    setPaletteDismissed(true);
  }, []);

  // Escape while a turn is in flight cancels it - a no-op otherwise (abortControllerRef is only
  // non-null for the duration of processTurn's loop.run() call, see its own comment). Pickers
  // (SessionPicker, ModePicker, CommandFamilyPicker, CommandPalette) handle Escape themselves via
  // their own onCancel, independently of this.
  // While the box is open, ask the server every few seconds whether it is up. There is deliberately no time limit:
  // a small box on the back of a laptop can take minutes to boot and load a model. When it answers, read its
  // context size and model name again (they were unknown or stale), let cli.ts apply them, and close the box.
  const waitingForServer = serverWait !== null;
  useEffect(() => {
    if (!waitingForServer || !probeServer) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const probe = await probeServer();
      if (cancelled) return;
      if (probe.status === 'up') {
        if (probe.model) setModel(probe.model);
        if (probe.contextWindow) setContextWindow(probe.contextWindow);
        onServerRecovered?.(probe);
        setServerWait(null);
        pushBlock([
          {
            kind: 'system',
            text: probe.contextWindow
              ? `Server is back. Context window: ${probe.contextWindow.toLocaleString('en-US')} tokens.`
              : 'Server is back.',
          },
        ]);
        return;
      }
      setServerWait((w) => (w ? { status: probe.status === 'loading' ? 'loading' : 'down', checks: w.checks + 1 } : w));
      timer = setTimeout(check, serverPollMs);
    };
    timer = setTimeout(check, serverPollMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [waitingForServer, probeServer, serverPollMs, onServerRecovered, pushBlock]);

  const handleServerPick = useCallback(
    (choice: ServerDownChoice) => {
      // Waiting is already what the box is doing; only the other row needs an answer. There is a single
      // configured model today, so say so and leave the box open.
      if (choice === 'choose') pushBlock([{ kind: 'system', text: 'No other models are configured yet.' }]);
    },
    [pushBlock],
  );

  const handleServerClose = useCallback(() => {
    setServerWait(null);
    pushBlock([{ kind: 'system', text: 'Stopped waiting for the server. Your next message will check it again.' }]);
  }, [pushBlock]);

  const abortTurn = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // Esc in the input box only asks "Stop now?" (No selected by default) while isInThinkBlock is true -
  // waiting on the model, including a silent reasoning round that hasn't streamed anything yet, can run
  // tens of minutes, so an accidental Esc there would be a real loss. Once a tool is actually executing,
  // or the final answer is already streaming, that phase runs in minutes at most, so Esc just stops at
  // once there - asking would be more friction than the loss is worth. The approval dialog keeps its own
  // Esc (decline AND stop - see ConfirmDialog's onEscape), since that box is already a Yes/No.
  const handleEscape = useCallback(() => {
    if (!abortControllerRef.current) return;
    if (isInThinkBlock) {
      stopTargetRef.current = abortControllerRef.current;
      setStopConfirm(true);
    } else {
      abortTurn();
    }
  }, [isInThinkBlock, abortTurn]);

  const handleStopResolve = useCallback(
    (yes: boolean) => {
      setStopConfirm(false);
      if (yes && stopTargetRef.current && abortControllerRef.current === stopTargetRef.current) abortTurn();
      stopTargetRef.current = null;
    },
    [abortTurn],
  );

  // The check has nothing left to stop once the turn is over: close it so a stale box never lingers.
  useEffect(() => {
    if (!isProcessing) setStopConfirm(false);
  }, [isProcessing]);

  // /resume is an escape hatch (e.g. after the screen clears or a turn wedges), so it must never sit
  // behind the FIFO queue like an ordinary message: queued behind a turn still marked busy it did
  // nothing visible ("same screen") for David. Opens the picker immediately; only once a session is
  // actually chosen does it abort any in-flight turn (same as /clear) and hand off to a new process.
  // Cancelling the picker leaves a running turn untouched. isProcessing is deliberately NOT touched -
  // the picker owns input focus while open, and this isn't a turn.
  const openResumePicker = useCallback(async () => {
    if (resumePickerOpenRef.current) return;
    resumePickerOpenRef.current = true;
    try {
      pushBlock([{ kind: 'user', text: '> /resume' }]);
      const sessions = await sessionStore.readManifest();
      if (sessions.length === 0) {
        pushBlock([{ kind: 'system', text: 'No saved sessions to resume.' }]);
        return;
      }
      const chosenId = await new Promise<string | undefined>((resolve) => {
        setResumePicker({ sessions, resolve });
      });
      if (chosenId) {
        // Handed off to a brand-new process, started with `--resume <chosenId>` - it loads and
        // displays that session's history itself, before its first render, instead of this process
        // appending it mid-session (see AppProps.restart's doc comment).
        abortControllerRef.current?.abort();
        restart(chosenId, modeRef.current);
        setTimeout(() => exit(), 0);
      } else {
        pushBlock([{ kind: 'system', text: 'Resume cancelled.' }]);
      }
    } finally {
      resumePickerOpenRef.current = false;
    }
  }, [pushBlock, sessionStore, restart, exit]);

  const handleSubmit = useCallback(
    (raw: string) => {
      const input = raw.trim();
      if (!input) return;

      // /exit and /quit must never sit behind the FIFO queue - a turn stuck mid-processing
      // (a hung or very long local-model response, say) would otherwise leave the user with
      // no way to actually leave until that turn eventually resolves on its own. This was
      // the root cause of needing to submit /exit twice and seeing it stick around as
      // "Queued #1: /exit": the first submission only queued it, invisible until the busy
      // turn finished and dequeued it.
      if (input === '/exit' || input === '/quit') {
        // Deferred a tick rather than called synchronously here: when /exit is chosen via the
        // command palette, the input-clear and palette-close state updates (handlePaletteSelect,
        // below) are queued in this same event handler - calling exit() immediately tears down
        // Ink's render tree before React ever gets to flush and paint that cleared state, so the
        // typed "/exit" text and the open palette were still visible in the terminal's last frame
        // even though the process had genuinely already exited underneath it.
        setTimeout(() => exit(), 0);
        return;
      }

      // /clear needs the exact same bypass, for a different failure mode: queuing it (like any
      // other message) let it fire silently later - the instant whatever unrelated turn was busy
      // finished, with zero further keypress. That's the confirmed root cause of the
      // "spontaneous" screen reset (reproduced live 2026-09-27): the queue only surfaces a small,
      // easy-to-miss "Queued #1: /clear" line, so the reset appeared to happen with no user
      // action at all - the real trigger (typing /clear) had happened earlier, decoupled in time
      // from the effect. Handled directly here (not routed through processTurn) so it can't touch
      // that function's shared end-of-turn dequeue/isProcessing-reset code, which assumes a real
      // turn either just finished or was genuinely queued - neither is true for a bypass like
      // this, and running it through there would wrongly clear isProcessing out from under a
      // still-busy turn.
      if (input === '/clear') {
        // Best-effort abort of any in-flight turn first (same as Escape/Ctrl+C) - not just
        // politeness. Without this, a busy turn's still-arriving delta/think events keep
        // updating the live status bar's token count and the in-flight text for however long it
        // takes the abort signal (or the request's own timeout) to actually land, all while this
        // process is mid-exit. Real, reported symptom this produces: /clear during a long think
        // still showing a large, growing token count afterward - not the new fresh process
        // inheriting anything (a genuinely new AgentLoop starts at 0), but Windows Terminal's own
        // ESC[2J limitation (see resizeReflowFix.ts's doc comment: it scrolls the stale frame into
        // scrollback rather than truly erasing it) leaving that last, larger frame from the dying
        // old process visible above the new one's fresh banner. Stopping the old turn from
        // rendering anything further shrinks this window as much as possible.
        abortControllerRef.current?.abort();
        restart(undefined, modeRef.current);
        setTimeout(() => exit(), 0);
        return;
      }

      if (input === '/resume') {
        void openResumePicker();
        return;
      }

      if (isProcessing) {
        queuedInputsRef.current.push(input);
        setQueuedPreview([...queuedInputsRef.current]);
        return;
      }

      setIsProcessing(true);
      void processTurn(input);
    },
    [isProcessing, processTurn, exit, restart, openResumePicker],
  );

  // A command run straight from the palette or a family dropdown bypasses InputBox's own Enter
  // path, so it has to be handed to the history explicitly or ↑ would not recall it.
  const runCommand = useCallback(
    (name: string) => {
      setInputValue('');
      setPaletteDismissed(false);
      setInputResetToken((t) => t + 1);
      setHistoryAppend({ token: nextHistoryToken++, text: name });
      handleSubmit(name);
    },
    [handleSubmit],
  );

  const handlePaletteSelect = useCallback((command: CommandInfo) => runCommand(command.name), [runCommand]);

  // ONE dropdown for every command family (`/keyboard`, `/set`, `/config`, and whatever is added
  // to COMMAND_FAMILIES next), replacing three near-identical copies of this block.
  //
  // It opens as soon as the bare name is typed - `/set` is enough, the `-` is not required - and
  // its first row is the bare command itself, so a family's own default is visible and selectable
  // in the same place as its alternatives rather than being whatever you get by not opening the
  // list. SelectList starts on row 0 and owns Enter while it is open, so typing `/keyboard` and
  // pressing Enter runs `/keyboard` with no arrow keys involved.
  //
  // What Enter does to a row comes from that command's own `select` field, so this has no special
  // cases: `run` executes it, `prefill` puts `/name ` in the box to finish typing, and `none`
  // deliberately does nothing and leaves the list open (the bare `/set` and `/config`, which have
  // no standalone action - the real choices are the rows below them).
  const familyTyped = isComposingCommand(inputValue) ? inputValue.toLowerCase() : '';
  // Either the family's own name has been typed (`/keyboard`, `/keyboard-mac`), or what has been
  // typed so far can only be heading for one family anyway - `/keyb` matches nothing but
  // `/keyboard`, so showing a one-row palette and then swapping to the family list a few
  // keystrokes later is just a flicker. `/c` still gets the palette, since it could become
  // /clear, /config or /context.
  const soleMatch = familyTyped ? matchCommands(familyTyped) : [];
  const familyBare =
    (familyTyped ? familyFor(familyTyped) : undefined) ??
    (soleMatch.length === 1 && familyFor(soleMatch[0].name) === soleMatch[0].name
      ? soleMatch[0].name
      : undefined);
  // A trailing '-' is dropped before testing the bare row, so `/set-` still offers `/set` itself.
  // A narrower prefix like `/set-sess` no longer ends in '-', so the bare row falls away and only
  // the matching variants remain.
  const familyBasePrefix = familyTyped.endsWith('-') ? familyTyped.slice(0, -1) : familyTyped;
  const familyMatches = familyBare
    ? commandFamily(familyBare)
        .filter((c) =>
          c.name === familyBare
            ? c.name.startsWith(familyBasePrefix)
            : c.name.toLowerCase().startsWith(familyTyped),
        )
        // The bare command keeps the top row - it is the family's default, and Enter on open is
        // meant to land on it. Everything below it is alphabetical, since registry order is an
        // implementation detail nobody reading the list can predict.
        .sort((a, b) => {
          if (a.name === familyBare) return -1;
          if (b.name === familyBare) return 1;
          return a.name.localeCompare(b.name);
        })
    : [];
  const familyOpen =
    !paletteDismissed &&
    !confirmDialog &&
    !resumePicker &&
    !modePicker &&
    !viewPicker &&
    !thinkScopePicker &&
    !stopConfirm &&
    !serverWait &&
    familyMatches.length > 0;

  const handleFamilySelect = useCallback(
    (command: CommandInfo) => {
      const select = command.select ?? 'prefill';
      if (select === 'none') return; // heads its family's list; the choices are the rows below it
      if (select === 'run') {
        runCommand(command.name);
        return;
      }
      setInputValue(`${command.name} `);
      setPrefill({ token: nextPrefillToken++, text: `${command.name} ` });
    },
    [handleSubmit],
  );
  // Ctrl+O grew (or shrank) the input box: hand the live region whatever rows the box is not
  // using, so the two together stay under the viewport. Recomputed from the live terminal size
  // rather than a captured one, for the same reason the box's own cap is - the window resizes.
  const handleExpandChange = useCallback((expanded: boolean) => {
    const rows = process.stdout.rows;
    const boxCap = expanded ? expandedInputBoxCapRows(rows) : inputBoxCapRows(rows);
    const liveCapRows = liveRegionCapRowsFor(rows, boxCap);
    dispatchTextWindow({
      type: 'setLiveCaps',
      liveCapChars: Math.max(800, liveCapRows * (process.stdout.columns ?? 80)),
      liveCapRows,
      liveCols: liveRegionCols(),
    });
  }, []);

  const paletteMatches = isComposingCommand(inputValue) ? matchCommands(inputValue) : [];
  const paletteOpen =
    !paletteDismissed &&
    !confirmDialog &&
    !resumePicker &&
    !modePicker &&
    !viewPicker &&
    !thinkScopePicker &&
    !stopConfirm &&
    !serverWait &&
    !familyOpen &&
    paletteMatches.length > 0;

  return (
    <Box flexDirection="column">
      <Static items={textWindow.blocks as TextBlock[]}>
        {(block) => (
          /* A flow block is one chunk of a stream that is still being written (full view), so it
             gets neither the trailing blank row nor the labelled-line gaps - both would break a
             single think block or answer into visually separate pieces as it arrives. */
          <Box key={block.id} flexDirection="column" marginBottom={block.flow ? 0 : 1}>
            {block.lines.map((line, i) => (
              <React.Fragment key={i}>
                {/* A blank row before a labelled line ([think], [tool], ...) so it does not sit directly
                    under the line above - see lineSpacing.ts. */}
                {!block.flow && i > 0 && needsGapBefore(block.lines[i - 1], line) && <Text> </Text>}
                <LineText line={line} />
                {/* A blank row after every tool_call/tool_result line, per direct instruction -
                    otherwise a turn with several tool calls renders as one dense, hard-to-scan
                    block with no visual boundary between "here's the call" and "here's what it
                    returned." */}
                {(line.kind === 'tool_call' || line.kind === 'tool_result') && <Text> </Text>}
              </React.Fragment>
            ))}
          </Box>
        )}
      </Static>
      {isThinking &&
        textWindow.live.map((line, i) => (
          <React.Fragment key={i}>
            <Text color={theme.border}>{line}</Text>
            <Text> </Text>
          </React.Fragment>
        ))}
      {isThinking && <Spinner />}
      <InputBox
        disabled={isProcessing}
        active={!confirmDialog && !stopConfirm && !serverWait && !resumePicker && !modePicker && !thinkPicker && !thinkScopePicker && !viewPicker}
        suppressNav={paletteOpen || familyOpen}
        onChange={handleInputChange}
        resetToken={inputResetToken}
        prefill={prefill}
        onExpandChange={handleExpandChange}
        onSubmit={handleSubmit}
        onEscape={handleEscape}
        initialHistory={initialSession?.inputHistory}
        historyAppend={historyAppend}
        onHistoryChange={handleInputHistoryChange}
      />
      {/* Three footer lines, grouped by how fast each one changes: what is live (mode, hints,
          think level, context fill, clock), what accumulates (tokens), and what holds still for
          the session (model, branch, directory). Front-end plan item #8 put context
          max/current/%used on the Mode line; the hint line that used to sit last is now folded
          into it. */}
      <StatusBar loop={loop} contextWindow={contextWindow} liveText={textWindow.live} mode={mode} busy={isProcessing} />
      <UsageBar loop={loop} usage={usageStore} busy={isProcessing} sessionView={shownSessionView} thinkLevel={shownThinkLevel} />
      <ProjectBar model={model} branch={gitBranch} project={projectLabelText} />
      {confirmDialog ? (
        <ConfirmDialog
          key={confirmDialog.id}
          message={confirmDialog.message}
          onResolve={handleConfirmResolve}
          onEscape={abortTurn}
        />
      ) : stopConfirm ? (
        <ConfirmDialog
          key="stop-confirm"
          message="Stop now?"
          yesNote="this stops the current process"
          onResolve={handleStopResolve}
        />
      ) : serverWait ? (
        <ServerDownPicker
          status={serverWait.status}
          checks={serverWait.checks}
          pollMs={serverPollMs}
          onSelect={handleServerPick}
          onCancel={handleServerClose}
          highlightColor={highlightColor}
        />
      ) : resumePicker ? (
        <SessionPicker
          sessions={resumePicker.sessions}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
          highlightColor={highlightColor}
        />
      ) : modePicker ? (
        <ModePicker
          currentMode={mode}
          onSelect={handleModePickerSelect}
          onCancel={handleModePickerCancel}
          highlightColor={highlightColor}
        />
      ) : thinkPicker ? (
        <ThinkPicker
          currentLevel={thinkLevel}
          caps={thinkCaps ?? DEFAULT_THINK_CAPS}
          onSelect={handleThinkPickerSelect}
          onCancel={handleThinkPickerCancel}
          highlightColor={highlightColor}
        />
      ) : thinkScopePicker ? (
        <ThinkScopePicker
          scope={thinkScopePicker.scope}
          storedLevel={thinkScopePicker.storedLevel}
          globalLevel={thinkScopePicker.globalLevel}
          caps={thinkCaps ?? DEFAULT_THINK_CAPS}
          onSelect={handleThinkScopeSelect}
          onCancel={handleThinkScopeCancel}
          highlightColor={highlightColor}
        />
      ) : viewPicker ? (
        <SessionViewPicker
          scope={viewPicker.scope === 'global' ? 'global' : 'local'}
          currentValue={viewPicker.currentValue}
          storedValue={viewPicker.storedValue}
          globalValue={viewPicker.globalValue}
          onSelect={handleViewPickerSelect}
          onCancel={handleViewPickerCancel}
          highlightColor={highlightColor}
        />
      ) : familyOpen ? (
        <CommandFamilyPicker
          title={`${familyBare} commands (↑/↓ to choose, Enter to select, Esc to dismiss):`}
          commands={familyMatches}
          onSelect={handleFamilySelect}
          onCancel={handlePaletteCancel}
          highlightColor={highlightColor}
        />
      ) : paletteOpen ? (
        <CommandPalette
          commands={paletteMatches}
          onSelect={handlePaletteSelect}
          onCancel={handlePaletteCancel}
          highlightColor={highlightColor}
        />
      ) : null}
      {queuedPreview.map((q, i) => (
        <Text key={i} color={theme.border}>
          Queued #{i + 1}: {q}
        </Text>
      ))}
    </Box>
  );
}
