import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { InputBox } from './InputBox.js';
import { SessionPicker } from './SessionPicker.js';
import { ConfirmDialog, type ConfirmChoice } from './ConfirmDialog.js';
import { describeRules, evaluateRules, loadRules, matchesPattern, patternFor } from '../session/permissionRules.js';
import { destructiveReason, splitShellSegments } from '../tools/interactive.js';

/** The tool-confirmation answer (C2). */
interface ConfirmAnswer {
  choice: ConfirmChoice;
  reason?: string;
}
import { CommandPalette } from './CommandPalette.js';
import { ModePicker } from './ModePicker.js';
import { SessionViewPicker, type SessionViewChoice } from './SessionViewPicker.js';
import { ServerDownPicker, SERVER_POLL_MS, type ServerDownChoice, type ServerWaitStatus } from './ServerDownPicker.js';
import { ServerUnavailableError } from '../providers/types.js';
import type { ServerProbe, ServerStatus } from '../providers/local.js';
import { CommandFamilyPicker } from './CommandFamilyPicker.js';
import { ThinkPicker, ThinkScopePicker, type ThinkScope, type ThinkScopeChoice } from './ThinkPicker.js';

import { MODES, classifyToolAccess, modeInfo, modeSystemPrompt, type Mode } from './modePolicy.js';
import { parsePlanCommand, planPrompt, savePlanFromAnswer, type PlanHooks } from '../session/planAuthoring.js';
import { ULTRAPLAN_MAX_ITERATIONS } from '../session/ultraplanResearch.js';
import { formatChecklist, formatItemDetail, formatPlan } from '../session/planView.js';
import { exportPlan } from '../session/planExport.js';
import { importPlanFiles } from '../session/planImport.js';
import {
  PLAN_PICKER_TITLE,
  parsePlanEditCommand,
  planActionRows,
  planActionTitle,
  planItemOpRows,
  planItemRows,
  planPickerRows,
  plansListing,
  type ChoiceRow,
  type PlanAction,
  type PlanItemOp,
} from './planPicker.js';
import { PlanRuleError, formatPlanNo } from '../session/planStore.js';
import { SelectList } from './SelectList.js';
import { TAB_USED_KEY } from './tabHint.js';
import { dbDirFor, plansDirFor, toolOutputDirFor } from '../session/projectContext.js';
import { listDatabases, openReadOnly, recordDetail, recordRows, rowsTitle, schemaDetail, tableRows } from './dbBrowser.js';
import { listPlans, plansReport } from '../session/plansStore.js';
import { clipDiff, diffLines, diffStats, formatDiffStats } from './lineDiff.js';
import { styleCodePreview, styleDiff, type StyledDiffLine } from './diffStyle.js';
import { grammarForPath, highlightCode } from './syntaxHighlight.js';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { projectLabel, readGitBranch, readGitDirty, readMountPoint } from '../session/gitInfo.js';
import {
  DEFAULT_THINK_CAPS,
  DEFAULT_THINK_LEVEL,
  THINK_LEVEL_CONFIG_KEY,
  THINK_BUDGET_CONFIG_KEY,
  parseThinkBudget,
  setThinkBudgetOverride,
  thinkBudgetOverride,
  THINK_LEVELS,
  THINK_LEVEL_INFO,
  effectiveThinkLevel,
  parseThinkLevel,
  type ThinkCaps,
  type ThinkLevel,
} from '../agent/thinkLevel.js';
import { formatEvent } from './formatEvent.js';
import {
  CONTEXT_WINDOW_TYPES,
  CONTEXT_WINDOW_TYPE_CONFIG_KEY,
  CONTEXT_WINDOW_TYPE_INFO,
  type ContextWindowTypeControl,
} from '../agent/contextWindowType.js';
import {
  contextWindowTypeFromConfig,
  describeContextWindowType,
  formatContextWindowType,
  parseContextWindowType,
} from './contextWindowSetting.js';
import { formatError } from './formatError.js';
import { formatConfirmMessage, previewLineCount } from './confirmPreview.js';
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
import { parseWindowSetting, describeWindowSetting } from './windowSetting.js';
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
import { theme, lineStyle, contextBarStyle, diffColors, scopeColor } from './theme.js';
import { FenceTracker, fencedSegments } from './codeFences.js';
import { colorViewLines } from './colorView.js';
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
  cacheSharePercent,
  cacheReportLines,
} from './statusBar.js';
import { AbortedError, CONTEXT_PRESSURE_RATIO, type AgentLoop, type AgentEvent, type PolicyAnswer } from '../agent/loop.js';
import { describeCacheBreak } from '../agent/cacheBreak.js';
import type { SessionStore, SessionMeta } from '../session/sessionStore.js';
import { createProviderCallLogger, type RunLogger } from '../session/runLog.js';
import { ConfigStore, scopeOwningEntry, type ConfigScope } from '../session/configStore.js';
import type { UsageStore } from '../session/usageStore.js';
import type { CodeGraphSession } from '../graph/startup.js';
import { HIGHLIGHT_COLOR_NAMES, isValidHighlightColor, resolveHighlightColor } from './highlightColor.js';
import { buildSplashText } from './splash.js';
import type { Tool } from '../tools/types.js';
import type { CompletionRequest, CompletionResponse, Message } from '../providers/types.js';
import { estimateTextTokens, withoutUnansweredToolCalls, type ContextEntry } from '../agent/contextEntry.js';
import { builtSystemPrompt } from '../agent/systemPrompt.js';
import { contextBreakdown, formatBreakdown } from '../agent/contextBreakdown.js';
import { formatStatus } from './statusReport.js';
import { checkConfigFiles, checkDatabases, checkDisk, checkGit, checkNode, formatChecks, type Check } from '../session/doctor.js';
import { runShellCommand } from '../tools/shellRunner.js';
import { loadLanguage } from '../graph/loadLanguage.js';
import { probeLocalServer } from '../providers/local.js';
import { commandSection, formatSection, searchDocs } from '../session/helpDocs.js';
import { SHOW_TIPS_KEY, TIPS } from './tips.js';
import { completeMention, expandMentions, mentionCandidates, mentionPrefix } from './mentions.js';
import { bangCommand, runBang, withShellNotes } from './bangCommand.js';
import { EDITOR_CONFIG_KEY, editorCommand, editText, isTerminalEditor, openInEditor, viewInEditor } from './externalEditor.js';
import { logToView } from '../session/logView.js';
import { expandCustomCommand, loadCustomCommands } from '../session/customCommands.js';
import { markIncorrect } from '../session/workedCommand.js';
import { backupDatabases, checkBackup, dbDirsFor, listBackups, scheduleRestore } from '../session/dbBackup.js';
import { costOf, describeModel, modelEntry, parseModelArgs, setModelFields } from '../session/modelRegistry.js';
import { formatDebugDump, lastRequestFromLogs, type LoggedRequest } from '../session/debugDump.js';
import { redactSecrets } from '../session/redact.js';
import { logsDirFor } from '../session/projectContext.js';
import { defaultLogsDir } from '../session/runLog.js';
import { MOUSE_CONFIG_KEY } from './mouse.js';
import { BLOCK_GAP_KEY, parseBlockGap, settingLabel, settingValues } from './settingsIndex.js';
import { describeKeybindings, isAction } from './keybindings.js';
import { copyToClipboard, replyBack } from './clipboard.js';
import { cleanCommitMessage, commitDiff, commitPrompt, runCommit } from '../session/commit.js';
import { formatStats, taskCounts } from './statsReport.js';
import { cleanTitle, forkSession, GENERATE_TITLES_KEY, lastErrorReport, recordLastError, titlePrompt } from '../session/sessionExtras.js';
import {
  DEFAULT_NOTIFY,
  DEFAULT_NOTIFY_AFTER_SECONDS,
  NOTIFY_AFTER_CONFIG_KEY,
  NOTIFY_CONFIG_KEY,
  notifyUser,
  parseNotifyMode,
  shouldNotifyTurn,
  type NotifyMode,
} from './notify.js';
import { runShellTool } from '../tools/runShell.js';
import { walkFiles } from '../tools/searchUtils.js';
import { describeSampling, samplingFor } from '../agent/sampling.js';
import { describeJob, getJob, killJob, listJobs } from '../tools/jobs.js';
import { currentShell, setShell, SHELL_CONFIG_KEY } from '../tools/shell.js';
import { setAskUserHandler } from '../tools/askUser.js';
import { draftO4cMd, scanProject } from '../session/projectScan.js';
import { activeMemoryStores } from '../session/memories.js';
import { parseLessons, recentTasks, reflectPrompt, REFLECT_SCHEMA } from '../session/reflect.js';
import { reviewPrompt } from '../session/review.js';
import type { CheckpointHooks } from '../session/checkpoints.js';
import {
  COMMANDS,
  KNOWN_COMMANDS,
  knownCommandNames,
  parsePromptArguments,
  looksLikeSlashCommand,
  isComposingCommand,
  matchCommands,
  commandName,
  commandForHelpTarget,
  allCommands,
  pinnedCommands,
  setPinnedCommands,
  setCommands,
  configCommands,
  commandFamily,
  familyFor,
  type CommandInfo,
  type McpPromptRef,
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
  /**
   * The id this session is saved under, decided at startup rather than at the first save (design
   * doc section 4's 2026-09-28 `session_id` resolution, NextUp item 13). The history store files
   * every entry under it from the very first one, so the session file and the store have to agree
   * on it before either has written anything. Nothing is written any earlier than before: an id
   * that never gets a save is simply never used. Absent in tests, where the first save mints one.
   */
  sessionId?: string;
  /**
   * Plans in history.db (brief 0005): what `/plan`, `/ultraplan` and `/view-plan` read and write.
   * Absent without a trusted project, or in tests that are not about plans.
   */
  plans?: PlanHooks;
  /** /undo, /rewind, /diff (plan 0006 C1); undefined when checkpoints are off or git is missing. */
  checkpoints?: CheckpointHooks;
  /**
   * The live context window type (NextUp item 23), shared with the components that act on it -
   * the history recorder and the request builders. Absent in tests that are not about it, where
   * `/set-contextwindowtype` still saves the setting but has nothing live to switch.
   */
  contextWindowType?: ContextWindowTypeControl;
  /** `/worked`'s action - marks a task in the history store and says what it did. Absent without a
   * trusted project (no store), where `/worked` explains that instead. */
  markWorked?: (arg: string) => string;
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
  /** Whether to teach Tab-cycles-modes in the startup banner (front-end checklist #11). Decided in
   * cli.ts, where the config read and the launch counting already live, so this stays a plain
   * render flag: the app shows the tip when told to and records the moment Tab is first pressed. */
  showTabHint?: boolean;
  /** This start's tip (E5); undefined when tips are off, on a reload, or the tab hint shows instead. */
  tip?: string;
  /** The startup health line (E13): server, model, context, last session. Fresh starts only. */
  startup?: string;
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
  /**
   * The `/mcp-<server>-<prompt>` command rows, once discovery finishes - `McpSession.ready`
   * resolved. A promise rather than a value because servers are still connecting while the
   * first frame renders, which is deliberate (see `startMcpSession`): the screen must not wait
   * on a handshake.
   */
  mcpPromptCommands?: Promise<readonly CommandInfo[]>;
  /** The lines `/mcp` prints. Undefined when this session has no MCP layer at all. */
  mcpStatusReport?: () => readonly string[];
  /**
   * Expands one prompt into text for the input box. Pre-flattened by `startMcpSession`, so this
   * file needs no MCP types - a `McpPromptRef` and strings are all that cross the boundary.
   */
  expandMcpPrompt?: (
    ref: McpPromptRef,
    args: Record<string, string>,
  ) => Promise<{ readonly text: string; readonly notes: readonly string[] }>;
  /** The Code Graph, for `/datagraph`. Undefined when it is not running (untrusted project, tests). */
  codeGraph?: CodeGraphSession;
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

function Spinner({ label = 'Thinking...' }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={theme.warn}>
      {SPINNER_FRAMES[frame]} {label}
    </Text>
  );
}

/** How often the spinner's "Writing <tool> call..." count may re-render (NextUp item 43): every
 * streamed fragment would be a render each, for a number nobody reads faster than this. */
const TOOL_PROGRESS_MS = 250;

/** Session-elapsed-time ticker + the model/tokens/context-usage line shown above the input box -
 * per direct instruction, matching Hermes Agent's own status bar. `tick` exists purely to force
 * a re-render once a second; `getVisibleTokenEstimate()` is read fresh on every render rather
 * than lifted into state, since `AgentLoop` already mutates it outside React's own state flow
 * (same reasoning as `getUsage()` elsewhere in this file). */
function StatusBar({
  loop,
  usage,
  contextWindow,
  liveText,
  mode,
  busy,
}: {
  loop: AgentLoop;
  /** Where the clock's elapsed time comes from, because this process is not the session: o4c
   * reloads itself into a fresh process after most turns, so a clock counting from mount restarted
   * every turn or two (0002 item 7). The store carries the session's summed active time across
   * those reloads. Undefined without a trusted project (and in tests), which falls the clock back
   * to this process's own uptime - the old behaviour, and the best available answer when there is
   * nowhere to persist one. */
  usage?: UsageStore;
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
  // The session's active time, not this process's: read fresh on every render, like every other
  // figure on this line, because it is a clock.
  const elapsedMs = usage?.totals().session.activeMs ?? Date.now() - startRef.current;
  const elapsed = busy ? formatElapsed(elapsedMs) : formatElapsedCoarse(elapsedMs);
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
      <Text color={theme.border}> Esc stop · Enter steers · Ctrl+Q queues</Text>
      <Text color={theme.border}> | </Text>
      <Text color={theme.accent}>
        {formatTokenCount(tokens)}
        {contextWindow ? `/${formatTokenCount(contextWindow)}` : ''}
      </Text>
      {fraction !== undefined && (
        <Text>
          {' ['}
          {/* Front-end checklist #13: red at exactly the share where the loop starts pausing to
              compact, passing the ENGINE's threshold in rather than writing 0.8 again here - a bar
              that changed colour at its own number would be reporting a threshold nothing acts on. */}
          <Text color={contextBarStyle(fraction, CONTEXT_PRESSURE_RATIO).bar}>
            {'█'.repeat(progressBarFilledCells(fraction))}
          </Text>
          <Text color={theme.border}>{'░'.repeat(10 - progressBarFilledCells(fraction))}</Text>
          {'] '}
          <Text color={contextBarStyle(fraction, CONTEXT_PRESSURE_RATIO).percent}>
            {Math.round(fraction * 100)}%
          </Text>
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
  const cacheShare = totals
    ? cacheSharePercent(totals.session.cached, totals.session.processed)
    : cacheSharePercent(spent.cachedTokens, spent.processedPromptTokens);
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
      <Text color={theme.accent}>
        Think: {THINK_LEVEL_INFO[thinkLevel].label}
        {thinkLevel !== 'nothink' && thinkBudgetOverride() !== undefined ? ` ${formatCumulativeTokens(thinkBudgetOverride()!)}` : ''}
      </Text>
      <Text color={theme.border}> | </Text>
      {totals && (
        <Text>
          <Text color={theme.border}>t-tks: </Text>
          {pair(totals.project)}
          {totals.machine && (
            <Text>
              <Text color={theme.border}> all: </Text>
              {pair(totals.machine)}
            </Text>
          )}
          <Text color={theme.border}> | </Text>
        </Text>
      )}
      <Text color={theme.border}>s-tks: </Text>
      {pair(session)}
      <Text color={theme.border}>/</Text>
      <Text color={theme.accent}>{rateText}</Text>
      <Text color={theme.border}> t/s</Text>
      {cacheShare !== undefined && (
        <Text>
          <Text color={theme.border}> | cache </Text>
          <Text color={theme.accent}>{cacheShare}%</Text>
        </Text>
      )}
    </Text>
  );
}

/**
 * The footer's third line: which model, which branch, and which volume/project/path you are in.
 *
 *     ◆ qwen3.8-27b-Q4_K_M-imatFP16 | main* · dir: D:/Open4Coding/o4c-agent
 *
 * The `*` after the branch means the working tree has uncommitted changes, the same single-character
 * convention shell prompts use. It is absent both when the tree is clean and when git could not be
 * asked, which is deliberate: a marker that appeared on uncertainty would be a lie half the time,
 * whereas a missing marker only ever understates.
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
function ProjectBar({
  model,
  branch,
  dirty,
  project,
}: {
  model: string;
  branch?: string;
  dirty?: boolean;
  project: string;
}) {
  return (
    <Text>
      <Text color={theme.accent}>◆ {formatModelName(model)}</Text>
      <Text color={theme.border}> | </Text>
      {branch && (
        <Text>
          <Text color={theme.accent}>{branch}</Text>
          {/* `warn` rather than `accent`: the point of the marker is to catch the eye on a bar that
              otherwise never changes, and uncommitted work is exactly a soft caution. */}
          {dirty && <Text color={theme.warn}>*</Text>}
          <Text color={theme.border}> · </Text>
        </Text>
      )}
      <Text color={theme.border}>dir: {project}</Text>
    </Text>
  );
}

function LineText({ line }: { line: Line }) {
  const style = lineStyle[line.kind];
  // Item 9: code in a reply is coloured; the text itself is unchanged, so layout is too. Code is
  // never bold - the reply's bold accent is for prose - and fence lines recede.
  if (line.fence) return <Text color={diffColors.gutter}>{line.text}</Text>;
  if (line.code) {
    return (
      <Text>
        {line.code.map((s, i) => (
          <Text key={i} color={scopeColor(s.scope) ?? theme.text}>
            {s.text}
          </Text>
        ))}
      </Text>
    );
  }
  const segments = (line.kind === 'final' || line.kind === 'tool_call') && !line.color ? fencedSegments(line.text) : undefined;
  if (segments) {
    return (
      <Text>
        {segments.map((s, i) =>
          s.kind === 'prose' ? (
            <Text key={i} bold={style.bold} color={style.color}>
              {s.text}
            </Text>
          ) : (
            <Text key={i} color={s.kind === 'fence' ? diffColors.gutter : (scopeColor(s.scope) ?? theme.text)}>
              {s.text}
            </Text>
          ),
        )}
      </Text>
    );
  }
  return (
    <Text bold={style.bold} color={line.color ?? style.color}>
      {line.text}
    </Text>
  );
}

export function App({
  loop,
  initialImage,
  sessionStore,
  runLogger,
  fullContextLogger,
  initialSession,
  sessionId: plannedSessionId,
  contextWindowType,
  markWorked,
  plans,
  checkpoints,
  restart,
  initialMode,
  os = detectCurrentOs(),
  reloadAfterTurn,
  sessionView,
  showTabHint,
  tip,
  startup,
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
  mcpPromptCommands,
  mcpStatusReport,
  expandMcpPrompt,
  codeGraph,
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
      // Front-end checklist #11: Tab cycles modes, and the status line's "(/mode or Tab)" was the
      // only place that said so - which the plan's own wording calls out as relying on the user
      // reading the status line. This teaches it where the eye already is on a fresh start.
      //
      // Two `system` lines rather than part of buildSplashText: the splash renders in bold
      // primary, which is the wrong weight for a tip, and splash.ts stays a pure word-mark +
      // startup-snapshot formatter. The cycle is derived from MODES so it cannot drift out of step
      // with what Tab actually does.
      ...(startup ? ([{ kind: 'system', text: startup }] as const) : []),
      ...(showTabHint
        ? ([
            { kind: 'system', text: 'Tip: press Tab to cycle modes, or /mode to pick one directly.' },
            { kind: 'system', text: `     ${MODES.map((m) => m.label).join(' → ')}` },
          ] as const)
        : tip
          ? ([{ kind: 'system', text: `Tip: ${tip}  (/tips off to hide)` }] as const)
          : []),
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
  // The tool call whose arguments are streaming right now, for the spinner's label (NextUp item
  // 43). Null whenever the model is not in the middle of writing one.
  const [toolProgress, setToolProgress] = useState<{ name: string; chars: number } | null>(null);
  // Plan 0006 A13: what the server is doing before the first token - reading the prompt, or queued
  // behind another client. Live status only, cleared as soon as anything streams.
  const [serverStatusLine, setServerStatusLine] = useState<string | null>(null);
  const toolProgressShownAtRef = useRef(0);
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
  // Messages typed while a turn runs, for the model's next step (C6). Plain Enter steers; Ctrl+Q
  // queues for after the turn; anything the turn did not pick up joins the queue at its end.
  const steeringRef = useRef<string[]>([]);
  // `!command` outputs waiting to go in front of the next message (E7) - append-only, cache-safe.
  const shellNotesRef = useRef<string[]>([]);
  // ask_user (C7): while the model waits for a typed answer, the next Enter answers it.
  const askUserPendingRef = useRef<((answer: string | undefined) => void) | undefined>(undefined);

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
  // The full-context log writer; it remembers the previous request so it can write deltas.
  const providerCallLoggerRef = useRef(createProviderCallLogger(fullContextLogger));
  // L3 /debug: this process's last request and response, exactly as sent and received.
  const lastCallRef = useRef<{ request: CompletionRequest; response: CompletionResponse } | undefined>(undefined);

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
      dispatchTextWindow({
        type: 'commit',
        lines: lines.map((t) => (kind === 'text' ? replyLine(t) : { kind: lineKind, text: t })),
        flow: true,
      });
    }
    dispatchTextWindow({ type: 'setLiveTail', text: tail });
  };

  /**
   * Item 9: which fenced block, if any, the streamed reply is inside. A line is committed before
   * the next one exists, so the code/fence decision has to be made here, in order, and carried on
   * the line - see `Line.code`.
   */
  const fenceTrackerRef = useRef(new FenceTracker());
  const replyLine = (text: string): Line => {
    const role = fenceTrackerRef.current.next(text);
    if (role.role === 'fence') return { kind: 'final', text, fence: true };
    if (role.role === 'code') return { kind: 'final', text, code: role.code };
    return { kind: 'final', text };
  };

  /** Commits whatever partial line is left, at the end of a stream segment (the kind changing, a
   * tool call interrupting, the turn ending) so the tail is never the thing that gets dropped. */
  const flushStreamTail = (kind: 'think' | 'text' | null): void => {
    const pending = streamTailRef.current;
    streamTailRef.current = '';
    if (pending !== '') {
      dispatchTextWindow({
        type: 'commit',
        lines: [kind === 'text' ? replyLine(pending) : { kind: 'system', text: pending }],
        flow: true,
      });
    }
    // The segment is over: a block it left open does not carry into the next one.
    fenceTrackerRef.current.reset();
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
  // Guards the one-time `tabUsed` write in the Tab handler below, so holding Tab down does not
  // queue a config write per keypress.
  const tabRecordedRef = useRef(false);
  // Whether the tree has uncommitted changes, on the same cadence as the branch. `undefined` until
  // the first read answers, and again whenever git could not be asked - see readGitDirty on why
  // "do not know" has to be distinguishable from "clean".
  const [gitDirty, setGitDirty] = useState<boolean | undefined>(undefined);
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
  // True while /clear's "start fresh?" check is showing (No selected by default, like Stop now?).
  const [clearConfirm, setClearConfirm] = useState(false);

  // Every session save goes through this one queue, so two saves never run at once - two first
  // saves of a session would each file a separate one. The entries are taken when the save is asked
  // for (`snapshot`, or the loop's history as it stands); the id when its turn in the queue comes.
  // Resolves to the session id, or undefined when there was nothing to save.
  //
  // `final` closes the session: later saves are skipped. /clear needs both halves. It saves before
  // aborting, because an aborted turn is rolled back out of the loop's history entirely; and the
  // aborted turn's own autosave, which runs after that rollback, must not overwrite the save.
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const sessionClosedRef = useRef(false);
  const saveSessionNow = useCallback(
    (snapshot?: readonly ContextEntry[], final = false): Promise<string | undefined> => {
      if (sessionClosedRef.current) return Promise.resolve(currentSessionIdRef.current);
      if (final) sessionClosedRef.current = true;
      const entries = snapshot ?? [...loop.getEntries()];
      const inputHistory = [...inputHistoryRef.current];
      const run = saveQueueRef.current
        .catch(() => {})
        .then(async () => {
          if (entries.length === 0) return undefined;
          const id = await sessionStore.save(entries, currentSessionIdRef.current ?? plannedSessionId, inputHistory);
          currentSessionIdRef.current = id;
          // A brand-new session gets its id at its first save, and the usage store needs it before
          // this process exits, or the session subtotal is filed under no id (see usageStore.ts).
          usageStore?.setSessionId(id);
          return id;
        });
      saveQueueRef.current = run;
      return run;
    },
    [loop, sessionStore, usageStore],
  );
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
  // A plain dropdown of labelled choices - `/view-plan`'s plan list and its action list, and any
  // later list that needs nothing more than "pick one of these". Same pending-Promise pattern.
  const [choicePicker, setChoicePicker] = useState<{
    /** A new id per list opened: it is the SelectList's React key, so a list opened straight after
     * another (a plan, then what to do with it) mounts fresh instead of inheriting the previous
     * list's highlighted row - which pointed past the end of a shorter list and crashed it. */
    id: number;
    title: string;
    rows: readonly ChoiceRow[];
    resolve: (key: string | undefined) => void;
  } | null>(null);
  const choicePickerIdRef = useRef(0);
  const pickChoice = useCallback(
    <K extends string>(title: string, rows: readonly ChoiceRow<K>[]) =>
      new Promise<K | undefined>((resolve) => {
        setChoicePicker({ id: ++choicePickerIdRef.current, title, rows, resolve: resolve as (key: string | undefined) => void });
      }),
    [],
  );
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
  // The one dynamic part of the command registry: an MCP server's prompts, which arrive when its
  // handshake finishes rather than at module load. Empty is both the initial state and the
  // normal one - `grants.slashCommands` is off by default.
  // The commands beyond the built-in ones: custom markdown commands (G1, read once here) and MCP
  // prompts (arriving when their servers connect). One list, so the palette, /help and /all treat
  // both alike; `custom` / `mcpPrompt` on each entry says which it is.
  const [mcpCommands, setMcpCommands] = useState<readonly CommandInfo[]>(() =>
    loadCustomCommands(projectRoot, new Set(KNOWN_COMMANDS)).commands.map((c) => ({
      name: c.name,
      description: `${c.description}${c.args.length ? ` Usage: ${c.name} ${c.args.map((a) => `<${a}>`).join(' ')}` : ''}`,
      custom: { body: c.body, args: c.args, file: c.file },
    })),
  );
  useEffect(() => {
    if (!mcpPromptCommands) return;
    let live = true;
    void mcpPromptCommands.then((commands) => {
      // Guarded against a resolve landing after unmount, which is the ordinary case rather than
      // the exotic one: o4c hands off to a fresh process after most turns, so a server still
      // inside its connect timeout will resolve into a torn-down tree.
      if (live && commands.length > 0) {
        setMcpCommands((prev) => {
          const taken = new Set(prev.filter((c) => c.custom).map((c) => c.name));
          return [...prev.filter((c) => c.custom), ...commands.filter((c) => !taken.has(c.name))];
        });
      }
    });
    return () => {
      live = false;
    };
  }, [mcpPromptCommands]);

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
    /** A write_file diff, already clipped and styled - items 8 and 9. Absent for every other tool. */
    diff?: readonly StyledDiffLine[];
    tool: Tool;
    input: Record<string, unknown>;
    /** What "always allow" would cover (C2). */
    alwaysLabel?: string;
    resolve: (answer: ConfirmAnswer) => void;
  } | null>(null);

  // E23: blank rows between finished blocks (0/1/2, default 1).
  const [blockGap, setBlockGap] = useState<0 | 1 | 2>(1);
  useEffect(() => {
    void configStore
      .get(BLOCK_GAP_KEY)
      .then((v) => setBlockGap(parseBlockGap(v)))
      .catch(() => undefined);
  }, [configStore]);
  // E16: click-to-place-cursor, opt-in (it takes the wheel away from scrollback while on).
  const [mouseOn, setMouseOn] = useState(false);
  useEffect(() => {
    void configStore
      .get(MOUSE_CONFIG_KEY)
      .then((v) => setMouseOn(v === true))
      .catch(() => undefined);
  }, [configStore]);
  // E12: bell / OS toast when a long turn ends or an approval waits. Read once; /set-notify updates it.
  const notifyRef = useRef<{ mode: NotifyMode; after: number }>({ mode: DEFAULT_NOTIFY, after: DEFAULT_NOTIFY_AFTER_SECONDS });
  useEffect(() => {
    void Promise.all([configStore.get(NOTIFY_CONFIG_KEY), configStore.get(NOTIFY_AFTER_CONFIG_KEY)])
      .then(([mode, after]) => {
        notifyRef.current = { mode: parseNotifyMode(mode), after: typeof after === 'number' && after >= 0 ? after : DEFAULT_NOTIFY_AFTER_SECONDS };
      })
      .catch(() => undefined);
  }, [configStore]);

  const askConfirm = useCallback(
    (
      message: string,
      tool: Tool,
      input: Record<string, unknown>,
      diff?: readonly StyledDiffLine[],
      alwaysLabel?: string,
    ): Promise<ConfirmAnswer> => {
      notifyUser(notifyRef.current.mode, `Approval needed: ${message.split('\n')[0]}`);
      return new Promise((resolve) => {
        setConfirmDialog({ id: nextDialogId++, message, diff, tool, input, alwaysLabel, resolve });
      });
    },
    [],
  );
  // "Always allow" answers given this session (C2): consulted before asking again. Also saved to
  // config as allow rules, which C3's rule engine reads on later runs.
  const alwaysAllowRef = useRef<string[]>([]);

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
  // Set for the length of one turn that must run in a mode other than the user's - a /plan turn is
  // read-only whatever mode is selected (brief 0005, decision 2). Read by `toolPolicy` before
  // `modeRef`, and cleared when the turn settles.
  const turnModeRef = useRef<Mode | undefined>(undefined);
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
        // E19: the models registry's level is the default until /think saves one for this model.
        const level = (typeof forModel === 'string' ? parseThinkLevel(forModel) : undefined) ?? modelEntry(model)?.thinkLevel;
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
      const dir = projectRoot ?? process.cwd();
      // Sequential, not Promise.all: the dirty read spawns git and the branch read does not, so
      // starting both at once would only move the spawn earlier, and the branch is the half that
      // has to be on screen - if the spawn hangs until its timeout the branch is already there.
      const branch = await readGitBranch(dir);
      if (cancelled) return;
      setGitBranch(branch);
      const dirty = branch === undefined ? undefined : await readGitDirty(dir);
      if (!cancelled) setGitDirty(dirty);
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
    async (tool: Tool, input: Record<string, unknown>): Promise<PolicyAnswer> => {
      const access = classifyToolAccess(turnModeRef.current ?? modeRef.current, tool, input, plansDirRef.current);
      // A mode's own refusal is absolute (Plan mode stays read-only whatever the rules say).
      if (access === 'deny') return 'deny';
      // Permission rules (C3), read fresh so an edit to config.json applies at once: deny > ask >
      // allow, and ahead of the mode's own allow, so a deny or ask rule holds in Auto mode too.
      const rulesNow = await loadRules((s) => configStore.readScope(s as ConfigScope));
      const ruled = evaluateRules(rulesNow, tool, input, splitShellSegments);
      if (ruled?.decision === 'deny') return { verdict: 'deny', reason: `the permission rule ${ruled.rule.pattern} (${ruled.rule.scope}) denies this` };
      // C5: with confirmDestructive on, a destructive command always asks - Auto mode included.
      const destructive = rulesNow.confirmDestructive && tool.name === 'run_shell' && typeof input.command === 'string' ? destructiveReason(input.command) : undefined;
      if (ruled?.decision !== 'ask' && !destructive) {
        if (access === 'allow' || ruled?.decision === 'allow') return 'allow';
        if (alwaysAllowRef.current.some((p) => matchesPattern(p, tool, input))) return 'allow';
      }
      const pattern = patternFor(tool, input);
      // `tool.mcp` is undefined for every built-in; for a proxied tool it is what puts the
      // server, the egress and the server's own claims about the tool in front of the user
      // before they answer. Nothing here decides anything - see confirmPreview.ts.
      // Item 8 / design doc 9.6: for a write_file, show WHAT CHANGES rather than only the
      // content being written. Computed here rather than in formatConfirmMessage because it
      // needs to read the file, and that function is pure and synchronous by design.
      // Failure to read is not an error: a new file (ENOENT) is the ordinary case and reads
      // as all-additions, and an unreadable existing file simply gets no diff - the content
      // preview is still there, so the dialog is never worse than before this existed.
      let diff: readonly StyledDiffLine[] | undefined;
      let diffSummary: string | undefined;
      if (tool.name === 'write_file' && typeof input.path === 'string') {
        let existing: string | undefined;
        try {
          existing = await readFile(input.path, 'utf-8');
        } catch {
          // ENOENT (a file being created) or an unreadable one. Either way there is nothing to
          // diff against, and `undefined` rather than `''` is what keeps those two cases apart
          // from a file that genuinely is empty.
          existing = undefined;
        }
        // **Only an existing file gets a diff.** For a new one the diff would be "all 300 lines
        // added", which tells the user nothing the content preview does not, and costs its
        // "+284 more lines" tail. A diff answers "what changes"; a file being created has no
        // answer to that, only content. So: existing file -> diff, new file -> the preview that
        // was already there. Found by the big-write_file dialog test, which asserts on that tail:
        // the regression was mine and the test was right.
        const content = String(input.content ?? '');
        const full = existing === undefined ? [] : diffLines(existing, content);
        const stats = diffStats(full);
        if (stats.added > 0 || stats.removed > 0) {
          // Sized from the terminal, like every other part of this dialog: a third of the
          // window, floored at 4 and capped at 16, so the diff informs the decision without
          // becoming the frame-taller-than-the-window bug confirmPreview.ts exists to fix.
          const rows = process.stdout.rows || 24;
          const clipped = clipDiff(full, Math.max(4, Math.min(16, Math.floor(rows / 3))));
          // Item 9: both versions highlighted whole, so a line inside a block comment is still a
          // comment; each diff line then takes its colours from the version it belongs to.
          const grammar = grammarForPath(input.path);
          diff = styleDiff(clipped, highlightCode(existing ?? '', grammar), highlightCode(content, grammar));
          diffSummary = formatDiffStats(stats);
        } else {
          // No diff to show - a new file, or a write that changes nothing: the file's first lines
          // instead, numbered and coloured (item 9). Only the lines shown are highlighted, which
          // is exact, since highlighting runs forward from the top of the file.
          const lines = content.split('\n');
          const head = lines.slice(0, Math.min(lines.length, previewLineCount())).join('\n');
          diff = styleCodePreview(
            highlightCode(head, grammarForPath(input.path)),
            lines.length,
            (process.stdout.columns || 80) - 4,
          );
        }
      }
      const answer = await askConfirm(
        formatConfirmMessage(tool.name, input, undefined, tool.mcp, diffSummary, diff !== undefined && !diffSummary),
        tool,
        input,
        diff,
        pattern,
      );
      if (answer.choice === 'always') {
        alwaysAllowRef.current.push(pattern);
        // Saved where the project's own settings live; read back by the C3 rule engine.
        void (async () => {
          const scope = projectRoot ? 'local' : 'global';
          const current = ((await configStore.readScope(scope)).permissions ?? {}) as { allow?: string[] };
          const allow = [...new Set([...(current.allow ?? []), pattern])];
          await configStore.set(scope, 'permissions', { ...current, allow });
        })().catch(() => undefined);
      }
      if (answer.choice === 'yes' || answer.choice === 'always') return 'allow';
      // `declined`, not `deny`: the mode permits this tool and only this call was refused. The loop
      // tells the model which of the two happened, because it changes what the model does next.
      return answer.choice === 'tell' && answer.reason?.trim() ? { verdict: 'declined', reason: answer.reason } : 'declined';
    },
    [askConfirm, configStore, projectRoot],
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
    confirmDialog.resolve({ choice: access === 'allow' ? 'yes' : 'no' });
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
      // Ctrl+T: stop thinking and answer now (plan 0006 A17). The turn goes on - only the
      // reasoning is cut short - unlike Escape, which cancels the turn.
      if (isAction('stop-thinking', input, key) && isProcessing) {
        void loop.endReasoning().then((ended) => {
          if (ended) pushBlock([{ kind: 'system', text: 'Thinking ended by you (Ctrl+T) - answering now.' }]);
        });
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
      // Ctrl+G (E8): compose the message in your own editor; the result comes back into the box.
      if (isAction('editor', _input, key) && !confirmDialog && !choicePicker) {
        const r = editText(inputValueRef.current);
        if (r.text !== undefined) setPrefill({ token: nextPrefillToken++, text: r.text });
        else pushBlock([infoLine(`Could not open the editor (${r.editor}): ${r.error ?? 'unknown error'}. Set VISUAL or EDITOR - a GUI editor needs its wait flag, e.g. "code --wait".`)]);
        return;
      }
      if (key.tab) {
        // E6: while an @mention is being typed, Tab completes it instead of cycling modes.
        if (mentionChoices.length > 0) {
          setPrefill({ token: nextPrefillToken++, text: completeMention(inputValueRef.current, mentionChoices[0]!) });
          return;
        }
        const currentIndex = MODES.findIndex((m) => m.mode === mode);
        const next = MODES[(currentIndex + 1) % MODES.length].mode;
        setMode(next);
        pushBlock([{ kind: 'system', text: `Mode set to ${modeInfo(next).label}.` }]);
        // The banner tip has done its job the moment Tab is actually used, so retire it for good
        // (front-end checklist #11). Global scope: knowing this shortcut is a fact about the user,
        // not about one project. Only written while the tip is still showing, and once per process
        // - fire-and-forget, because failing to retire a tip must not interrupt a keystroke.
        if (showTabHint && !tabRecordedRef.current) {
          tabRecordedRef.current = true;
          void configStore.set('global', TAB_USED_KEY, true).catch(() => undefined);
        }
      }
    },
    { isActive: true },
  );

  // @mentions (E6): the project's files, listed once when the first @ is typed.
  const [projectFiles, setProjectFiles] = useState<string[] | undefined>(undefined);
  const typingMention = mentionPrefix(inputValue);
  useEffect(() => {
    if (typingMention === undefined || projectFiles !== undefined) return;
    void walkFiles(process.cwd())
      .then(({ entries }) => setProjectFiles(entries.filter((e) => !e.isDirectory).map((e) => e.path.replace(/\\/g, '/'))))
      .catch(() => setProjectFiles([]));
  }, [typingMention, projectFiles]);
  const mentionChoices = typingMention !== undefined && projectFiles ? mentionCandidates(typingMention, projectFiles) : [];

  const processTurn = useCallback(
    async (input: string) => {
      const turnStartedAt = Date.now();
      const notifyTurnEnd = () => {
        if (shouldNotifyTurn(notifyRef.current.mode, Date.now() - turnStartedAt, notifyRef.current.after)) {
          notifyUser(notifyRef.current.mode, 'Done - o4c is waiting for your next message.');
        }
      };
      // /exit, /quit, and /clear are intercepted earlier, in handleSubmit, before they can ever
      // be queued behind a busy turn - they never reach here.
      if (input === '/context' || input === '/ctx') {
        // The session's figures, not this process's (0002 item 7): `loop.getUsage()` covers about
        // one turn, because o4c reloads itself into a fresh process after most of them, so these
        // three counters used to reset while the session they claimed to describe carried on.
        // `UsageStore` carries them across the reload; without a trusted project there is nowhere
        // to persist them, and this process's own count is the whole of what is known.
        const thisProcess = loop.getUsage();
        const usage = usageStore?.totals().session ?? {
          input: thisProcess.inputTokens,
          output: thisProcess.outputTokens,
          requests: thisProcess.requestCount,
          cached: thisProcess.cachedTokens,
          processed: thisProcess.processedPromptTokens,
          prefillMs: thisProcess.prefillMs,
          draftN: thisProcess.draftTokens,
          draftAccepted: thisProcess.draftAccepted,
        };
        const totalTokens = usage.input + usage.output;
        const visible = loop.getVisibleTokenEstimate();
        const windowSetting = loop.slidingWindowSettings();
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
          `  Requests sent: ${usage.requests}`,
          `  Input tokens:  ${usage.input}`,
          `  Output tokens: ${usage.output}`,
          `  Total tokens:  ${totalTokens}`,
          ...cacheReportLines(usage, thisProcess.last),
          // D5: where the tokens of a request go, bucket by bucket.
          ...formatBreakdown(contextBreakdown(loop.previewRequest(), builtSystemPrompt()?.sections)),
          ...loop.getCacheBreaks().slice(-3).map((b) => `  Last ${describeCacheBreak(b)}`),
          `  Messages in history: ${loop.getMessages().length}`,
          // Only when it is on. A window makes the model stop seeing part of the conversation,
          // so the one place that reports context has to say so - but a line saying "off" on
          // every /context would be noise for the default every session runs in.
          ...(windowSetting
            ? [
                `  Sending only the recent ${describeWindowSetting(windowSetting)} - ` +
                  'older messages are kept but not sent (/window off).',
              ]
            : []),
        ].join('\n');
        pushBlock([
          userLine(input),
          infoLine(text),
        ]);
      } else if (commandName(input) === '/plans') {
        // Local and display-only, exactly like /context above - never calls loop.run(), so the
        // listing is not sent to the model or added to history. This is front-end checklist item
        // 10's *browsing* half; the writing half already works, through Plan-Write mode's
        // `write_file` exception, which is scoped to this very directory (modePolicy.ts's
        // classifyToolAccess). Reads the disk on every invocation rather than caching: a plan the
        // model just wrote has to show up, and the directory is small.
        pushBlock([userLine(input)]);
        if (plans) {
          // Plans live in history.db now (brief 0005). Importing first is what keeps Plan-Write
          // mode useful: a plan file the model just wrote shows up here as a plan straight away.
          const result = await importPlanFiles(projectRoot, plans.store);
          if (result.imported.length > 0) plans.changed();
          pushBlock([infoLine(plansListing(plans.store, result.unrecognised, result.imported).join('\n'))]);
        } else {
          const listing = await listPlans(projectRoot);
          pushBlock([infoLine(plansReport(listing, Boolean(projectRoot)).join('\n'))]);
        }
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
      } else if (commandName(input) === '/view-log') {
        // E18: a log in the user's editor. Bare = the newest run log made readable (think blocks too).
        pushBlock([userLine(input)]);
        const arg = (input.trim().split(/\s+/)[1] ?? 'run').toLowerCase();
        const kind = (['run', 'full', 'lifecycle', 'crash'] as const).find((k) => k === arg);
        if (!kind) pushBlock([infoLine('Usage: /view-log [run|full|lifecycle|crash] - run (default) is the newest run log, readable; full is the FULLCONTEXT log.')]);
        else {
          const target = logToView(kind === 'crash' ? defaultLogsDir() : logsDirFor(projectRoot), kind);
          if (!target.path) pushBlock([infoLine(target.error ?? 'No log found.')]);
          else {
            const r = viewInEditor(target.path);
            pushBlock([infoLine(r.ok ? `Opened ${target.path} in ${r.editor}.` : `Could not open the editor (${r.editor}): ${r.error ?? ''}. The file is ${target.path}.`)]);
          }
        }
      } else if (commandName(input) === '/edit-config') {
        // E18: a config file in the user's editor, checked when the editor closes.
        pushBlock([userLine(input)]);
        const scope = await pickChoice<ConfigScope>('Which config file? (↑/↓, Enter, Esc to cancel)', [
          { key: 'global', label: `global - every project (${configStore.configPath('global') ?? 'n/a'})` },
          ...(configStore.hasScope('solution')
            ? ([{ key: 'solution', label: `solution - every project in this solution (${configStore.configPath('solution') ?? 'n/a'})` }] as const)
            : []),
          ...(projectRoot
            ? ([
                { key: 'local', label: `local - this project, shared (${configStore.configPath('local') ?? 'n/a'})` },
                { key: 'personal', label: `personal - this project, just you, gitignored (${configStore.configPath('personal') ?? 'n/a'})` },
              ] as const)
            : []),
        ]);
        const file = scope ? configStore.configPath(scope) : undefined;
        if (!scope || !file) pushBlock([infoLine('Config unchanged.')]);
        else {
          if (!existsSync(file)) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, '{}\n', 'utf-8');
          }
          const r = openInEditor(file);
          if (!r.ok) pushBlock([infoLine(`Could not open the editor (${r.editor}): ${r.error ?? ''}. The file is ${file}.`)]);
          else {
            try {
              JSON.parse(readFileSync(file, 'utf-8'));
              pushBlock([infoLine(`Saved ${file}. It takes effect from your next message.`)]);
            } catch (err) {
              pushBlock([infoLine(`${file} is not valid JSON now (${err instanceof Error ? err.message : String(err)}) - run /edit-config again to fix it.`)]);
            }
          }
        }
      } else if (commandName(input) === '/config-editor') {
        // E18: the editor o4c opens (Ctrl+G, /view-log, /edit-config), apart from VISUAL/EDITOR.
        pushBlock([userLine(input)]);
        const arg = input.trim().slice('/config-editor'.length).trim();
        if (!arg) {
          pushBlock([infoLine(`o4c opens: ${editorCommand()}. Usage: /config-editor <command> (a GUI editor needs its wait flag, e.g. "code --wait"), or /config-editor default to use VISUAL/EDITOR again.`)]);
        } else if (arg === 'default') {
          await configStore.set('global', EDITOR_CONFIG_KEY, '').catch(() => undefined);
          delete process.env.O4C_EDITOR;
          pushBlock([infoLine(`Editor back to the default: ${editorCommand()}.`)]);
        } else {
          await configStore.set('global', EDITOR_CONFIG_KEY, arg).catch(() => undefined);
          process.env.O4C_EDITOR = arg;
          pushBlock([infoLine(`o4c now opens ${arg}.${isTerminalEditor(arg) ? ' (A terminal editor - it takes over this window until you quit it.)' : ''}`)]);
        }
      } else if (commandName(input) === '/database-backup') {
        // E20: a consistent snapshot of every o4c database (project and global).
        pushBlock([userLine(input)]);
        try {
          const b = backupDatabases(dbDirsFor(projectRoot));
          pushBlock([
            infoLine(
              b.files.length
                ? [`Backed up ${b.files.length} database${b.files.length === 1 ? '' : 's'} to ${b.dir}:`, ...b.files.map((f) => `  ${f.name} (${(f.bytes / 1024).toFixed(0)} KB)`), '/database-restore puts one back.'].join('\n')
                : 'No databases to back up yet.',
            ),
          ]);
        } catch (err) {
          pushBlock([infoLine(`Backup failed: ${err instanceof Error ? err.message : String(err)}`)]);
        }
      } else if (commandName(input) === '/database-restore') {
        // E20: pick a backup, check it, confirm; applied by the restart before any database opens.
        pushBlock([userLine(input)]);
        const dirs = dbDirsFor(projectRoot);
        const backups = listBackups(dirs);
        if (backups.length === 0) pushBlock([infoLine('No backups yet - /database-backup makes one.')]);
        else {
          const stamp = await pickChoice(
            'Restore which backup? (↑/↓, Enter, Esc to cancel)',
            backups.map((b) => ({ key: b.stamp, label: `${b.stamp} - ${b.files.join(', ')} (${(b.bytes / 1024).toFixed(0)} KB)` })),
          );
          const problems = stamp ? checkBackup(dirs, stamp) : [];
          if (!stamp) pushBlock([infoLine('Nothing restored.')]);
          else if (problems.length) pushBlock([infoLine(`That backup failed its check, so it was not restored:\n${problems.map((p) => `  ${p}`).join('\n')}`)]);
          else {
            const ok = await pickChoice(`Replace the current databases with the ${stamp} backup? The current ones are kept (in a "before-restore" folder beside the backups).`, [
              { key: 'yes', label: 'Yes - restore it and restart o4c' },
              { key: 'no', label: 'No - keep the current databases' },
            ]);
            if (ok !== 'yes') pushBlock([infoLine('Nothing restored.')]);
            else {
              scheduleRestore(dirs, stamp);
              await saveSessionNow();
              pushBlock([infoLine(`Restoring ${stamp} - restarting...`)]);
              restart(currentSessionIdRef.current, modeRef.current);
            }
          }
        }
      } else if (commandName(input) === '/view-model') {
        // E19: this model's registry entry beside what was detected.
        pushBlock([userLine(input)]);
        pushBlock([
          infoLine(
            describeModel(model, modelEntry(model), {
              provider,
              contextWindow,
              thinkCaps: thinkCaps ? JSON.stringify(thinkCaps) : undefined,
            }).join('\n'),
          ),
        ]);
      } else if (commandName(input) === '/config-model') {
        // E19: set fields of this model's registry entry.
        pushBlock([userLine(input)]);
        const text = input.trim().slice('/config-model'.length).trim();
        if (!text) {
          pushBlock([infoLine('Usage: /config-model name="..." comment="..." context=<tokens> think=<level> price_in=<$/1M> price_out=<$/1M> - key= clears a field. /view-model shows the entry.')]);
        } else {
          const { fields, errors } = parseModelArgs(text);
          if (errors.length) pushBlock([infoLine(`Not saved:\n${errors.map((e) => `  ${e}`).join('\n')}`)]);
          else {
            setModelFields(model, fields);
            pushBlock([infoLine(`Saved for ${model}. Context and sampling take effect on the next start (o4c reloads after most turns); /view-model shows the entry.`)]);
          }
        }
      } else if (commandName(input) === '/keyboard-bindings') {
        // E17: the remappable Ctrl+letter actions as bound now, and any problem in the file.
        pushBlock([userLine(input)]);
        pushBlock([infoLine(describeKeybindings().join('\n'))]);
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
      } else if (commandName(input) === '/colorview') {
        // Local and display-only, like /keyboard and /context above - never reaches loop.run(),
        // so a color chart is never sent to the model or added to history.
        pushBlock([userLine(input)]);
        pushBlock(colorViewLines());
        void runLogger.log({ type: 'system', sub_type: 'info', command: '/colorview' });
      } else if (parsePlanEditCommand(input)) {
        const command = parsePlanEditCommand(input)!;
        pushBlock([userLine(input)]);
        const plan = plans?.store.getPlanByNumber(command.plan);
        if (!plans || !plan) {
          pushBlock([infoLine(`There is no plan ${formatPlanNo(command.plan)}.`)]);
        } else if (!command.text) {
          pushBlock([infoLine('Nothing changed - the item text was empty.')]);
        } else {
          try {
            if (command.op === 'reword') plans.store.rewordItem(plan.id, command.item, command.text);
            else plans.store.addItem(plan.id, { text: command.text }, command.item);
            pushBlock([infoLine([`Plan ${formatPlanNo(plan.number)}: ${command.op === 'reword' ? `reworded item ${command.item}` : `added after item ${command.item}`}.`, ...formatChecklist(plans.store, plans.store.getPlan(plan.id)!)].join('\n'))]);
          } catch (err) {
            pushBlock([infoLine(err instanceof PlanRuleError ? err.message : formatError(err))]);
          }
        }
      } else if (bangCommand(input) !== undefined) {
        // E7: the user's own shell command - no model call; permission deny rules still apply.
        const command = bangCommand(input)!;
        pushBlock([userLine(input)]);
        const ruled = evaluateRules(await loadRules((sc) => configStore.readScope(sc as ConfigScope)), runShellTool, { command }, splitShellSegments);
        if (ruled?.decision === 'deny') {
          pushBlock([infoLine(`Not run: the permission rule ${ruled.rule.pattern} (${ruled.rule.scope}) denies it.`)]);
        } else {
          const { output, note } = await runBang(command, runShellTool);
          shellNotesRef.current.push(note);
          pushBlock([infoLine(`${output}\n(the model sees this with your next message)`)]);
        }
      } else if (commandName(input) === '/fork') {
        // E13: the conversation so far under a new id; this window carries on in the fork.
        pushBlock([userLine(input)]);
        const entries = [...loop.getEntries()];
        if (entries.length === 0) pushBlock([infoLine('Nothing to fork yet - send a message first.')]);
        else {
          await saveSessionNow();
          const original = currentSessionIdRef.current;
          const title = (original ? (await sessionStore.readManifest()).find((m) => m.id === original)?.title : undefined) ?? 'Session';
          const fork = await forkSession(sessionStore, entries, [...inputHistoryRef.current], title);
          currentSessionIdRef.current = fork.id;
          usageStore?.setSessionId(fork.id);
          pushBlock([infoLine(`Forked: you are now in "${fork.title}". The original is unchanged - /resume to go back to it.`)]);
        }
      } else if (commandName(input) === '/debug') {
        // L3: o4c debugging itself - the exact last request and why, in the editor. No model call.
        pushBlock([userLine(input)]);
        const own = lastCallRef.current;
        const fromLog = own ? undefined : lastRequestFromLogs(logsDirFor(projectRoot));
        const request: LoggedRequest | undefined = own
          ? { systemPrompt: own.request.systemPrompt, messages: [...own.request.messages], tools: [...(own.request.tools ?? [])], response: own.response }
          : fromLog?.request;
        if (!request) pushBlock([infoLine('No request has been sent yet (none in this process, and no FULLCONTEXT log in this project) - send a message first.')]);
        else {
          const lastBreak = loop.getCacheBreaks().at(-1);
          const rules = await loadRules((sc) => configStore.readScope(sc as ConfigScope));
          const text = formatDebugDump({
            request,
            source: own ? 'this process - the last request, exactly as sent' : `rebuilt from ${fromLog!.file}`,
            breakdown: formatBreakdown(contextBreakdown({ systemPrompt: request.systemPrompt ?? '', messages: request.messages, tools: request.tools }, builtSystemPrompt()?.sections)),
            window: (() => {
              const w = loop.slidingWindowSettings();
              return w ? describeWindowSetting(w) : 'full history (no sliding window)';
            })(),
            historyEntries: loop.getEntries().length,
            cacheBreak: lastBreak ? describeCacheBreak(lastBreak) : undefined,
            rules: describeRules(rules),
            model,
            thinkLevel: THINK_LEVEL_INFO[thinkLevel].label,
          });
          const dir = join(tmpdir(), 'o4c-debug');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
          writeFileSync(file, redactSecrets(text), 'utf-8');
          const r = viewInEditor(file);
          pushBlock([infoLine(r.ok ? `Debug dump (${request.messages.length} messages, ${text.length.toLocaleString()} characters) opened in ${r.editor}: ${file}` : `Wrote ${file}; could not open the editor (${r.editor}): ${r.error ?? ''}`)]);
        }
      } else if (commandName(input) === '/last-error') {
        // E13: the last failed request in full, and the end of crash.log.
        pushBlock([userLine(input)]);
        pushBlock([infoLine(lastErrorReport().join('\n'))]);
      } else if (commandName(input) === '/stats') {
        // E11: session, project and machine totals - no model call.
        pushBlock([userLine(input)]);
        const used = loop.getUsage();
        const totals = usageStore?.totals();
        const messages = loop.getMessages();
        pushBlock([
          infoLine(
            formatStats({
              session: totals?.session ?? {
                input: used.inputTokens,
                output: used.outputTokens,
                requests: used.requestCount,
                cached: used.cachedTokens,
                processed: used.processedPromptTokens,
                prefillMs: used.prefillMs,
                draftN: used.draftTokens,
                draftAccepted: used.draftAccepted,
                activeMs: 0,
              },
              project: totals?.project,
              machine: totals?.machine,
              turns: messages.filter((m) => m.role === 'user').length,
              toolCalls: messages.filter((m) => m.role === 'tool').length,
              tasks: taskCounts(),
              ...(() => {
                const c = totals?.session ? costOf(totals.session, modelEntry(model)) : undefined;
                return c === undefined ? {} : { cost: { session: c, model } };
              })(),
            }).join('\n'),
          ),
        ]);
      } else if (commandName(input) === '/commit') {
        // E10: a generated commit message, shown for approval; no trailer unless commitTrailer is set.
        pushBlock([userLine(input)]);
        const d = commitDiff();
        if ('error' in d) pushBlock([infoLine(d.error)]);
        else {
          pushBlock([infoLine(`Writing a commit message for:\n${d.stat}`)]);
          let message: string | undefined;
          try {
            const trailer = (await configStore.get('commitTrailer')) as string | undefined;
            message = cleanCommitMessage(await loop.sideRequest(commitPrompt(d, input.trim().slice('/commit'.length).trim())), trailer);
          } catch (err) {
            pushBlock([infoLine(`Could not write a message: ${err instanceof Error ? err.message : String(err)}`)]);
          }
          while (message) {
            pushBlock([infoLine(`Commit message:\n\n${message}`)]);
            const pick = await pickChoice(
              d.staged ? 'Commit the staged changes with this message?' : 'Nothing is staged - stage ALL changes (git add -A) and commit with this message?',
              [
                { key: 'commit', label: 'Commit' },
                { key: 'edit', label: 'Edit the message in your editor, then ask again' },
                { key: 'cancel', label: 'Cancel - nothing is committed' },
              ],
            );
            if (pick === 'edit') {
              const r = editText(message);
              if (r.text?.trim()) message = r.text;
              else if (r.error) pushBlock([infoLine(`Could not open the editor (${r.editor}): ${r.error}`)]);
              continue;
            }
            if (pick === 'commit') {
              const r = runCommit(message, !d.staged);
              pushBlock([infoLine(r.hash ? `Committed ${r.hash}.` : `git commit failed:\n${r.error ?? ''}`)]);
            } else pushBlock([infoLine('Not committed.')]);
            break;
          }
        }
      } else if (commandName(input) === '/copy') {
        // E9: a reply to the clipboard - /copy is the last one, /copy 2 the one before.
        pushBlock([userLine(input)]);
        const n = Math.max(1, Number.parseInt(input.trim().split(/\s+/)[1] ?? '1', 10) || 1);
        const reply = replyBack(loop.getMessages(), n);
        if (reply === undefined) pushBlock([infoLine(n === 1 ? 'No reply to copy yet.' : `There is no reply ${n} back.`)]);
        else {
          const via = copyToClipboard(reply);
          pushBlock([infoLine(via ? `Copied ${reply.length.toLocaleString()} characters (via ${via}).` : 'Could not reach a clipboard: no clip/pbcopy/wl-copy/xclip/xsel worked and this is not a terminal.')]);
        }
      } else if (commandName(input) === '/tips') {
        // E5: the start-of-session tip, on or off.
        pushBlock([userLine(input)]);
        const arg = input.trim().split(/\s+/)[1]?.toLowerCase();
        if (arg === 'on' || arg === 'off') {
          await configStore.set('global', SHOW_TIPS_KEY, arg === 'on').catch(() => undefined);
          pushBlock([infoLine(arg === 'on' ? 'Tips on - one at the start of each new session.' : 'Tips off.')]);
        } else {
          pushBlock([infoLine(['Usage: /tips on|off. All the tips:', ...TIPS.map((t) => `  - ${t}`)].join('\n'))]);
        }
      } else if (commandName(input) === '/doctor') {
        // E3: each check, and for each failure what to do.
        pushBlock([userLine(input), infoLine('Running checks (one small model call for the tool round trip)...')]);
        const checks: Check[] = [checkNode()];
        checks.push(...checkConfigFiles((['global', 'solution', 'local', 'personal'] as const).flatMap((sc) => { const p = configStore.configPath(sc); return p ? [{ scope: sc, path: p }] : []; })));
        checks.push(checkGit());
        const shellRun = await runShellCommand('echo o4c-ok', { timeoutMs: 10_000, maxBufferBytes: 100_000 }).catch(() => undefined);
        checks.push(shellRun?.stdout.includes('o4c-ok')
          ? { name: 'Shell', state: 'ok', detail: `${currentShell().kind} (${currentShell().exe})` }
          : { name: 'Shell', state: 'fail', detail: `${currentShell().exe} did not run a command`, fix: 'Pick another shell with /set-shell (auto, cmd, pwsh, bash, sh).' });
        try {
          await loadLanguage('javascript');
          await loadLanguage('python');
          checks.push({ name: 'Grammars', state: 'ok', detail: 'bundled tree-sitter grammars load' });
        } catch (err) {
          checks.push({ name: 'Grammars', state: 'warn', detail: formatError(err), fix: 'Reinstall o4c (npm i -g @open4coding/o4c-agent): the grammars/ folder is missing or damaged. The code graph and syntax checks are off until then.' });
        }
        checks.push(...checkDatabases([...(dbDirFor(projectRoot) ? [{ label: 'project', dir: dbDirFor(projectRoot)! }] : []), { label: 'global', dir: join(homedir(), '.o4c', 'db') }]));
        checks.push(checkDisk(projectRoot ?? process.cwd()));
        if (provider === 'local') {
          const apiKey = process.env.O4C_LOCAL_API_KEY ?? ((await configStore.get('localApiKey')) as string | undefined);
          const probe = await probeLocalServer(baseUrl, apiKey).catch(() => undefined);
          if (probe?.status !== 'up') {
            checks.push({ name: 'Server', state: 'fail', detail: `${baseUrl}: ${probe?.status ?? 'unreachable'}`, fix: 'Start llama-server (or check the address with /config, and the network path - a closed tunnel is the usual cause), then /doctor again.' });
          } else {
            checks.push({ name: 'Server', state: 'ok', detail: `${baseUrl}: ${probe.model ?? 'model id not reported'}, context ${probe.contextWindow?.toLocaleString() ?? 'unknown'}${probe.totalSlots ? `, ${probe.totalSlots} slot(s)` : ''}` });
            try {
              const r = await loop.probeToolCall();
              checks.push(r.ok
                ? { name: 'Tool calls', state: 'ok', detail: r.detail }
                : { name: 'Tool calls', state: 'fail', detail: r.detail, fix: 'Start llama-server with --jinja and a chat template that supports tools (the model card says which); o4c also runs tool calls written as text, but a model that cannot call tools works badly.' });
            } catch (err) {
              checks.push({ name: 'Tool calls', state: 'fail', detail: formatError(err), fix: 'See the server log; /last-error shows the provider error.' });
            }
          }
        }
        pushBlock([infoLine(formatChecks(checks).join('\n'))]);
      } else if (commandName(input) === '/status') {
        // E2: setup and health at a glance - all local.
        pushBlock([userLine(input)]);
        const usageNow = loop.getUsage();
        const session = usageStore?.totals().session;
        const prompt = builtSystemPrompt();
        const projectSection = prompt?.sections.find((sec) => sec.name === 'project')?.text ?? '';
        const instructionFiles = [...projectSection.matchAll(/^--- (\S+) \(/gm)].map((m) => m[1]!);
        const memoryStores = activeMemoryStores();
        const rules = await loadRules((sc) => configStore.readScope(sc as ConfigScope));
        const lastBreak = loop.getCacheBreaks().at(-1);
        const last = usageNow.last;
        const sampling = describeSampling(samplingFor(model, shownThinkLevel, await configStore.get('localSampling')));
        pushBlock([
          infoLine(
            formatStatus({
              model,
              provider,
              contextWindow,
              contextUsed: loop.getVisibleTokenEstimate(),
              cachePercent: session ? cacheSharePercent(session.cached, session.processed) : cacheSharePercent(usageNow.cachedTokens, usageNow.processedPromptTokens),
              lastPrefillMs: last?.prefillMs,
              draftAcceptPercent: usageNow.draftTokens > 0 ? Math.round((usageNow.draftAccepted / usageNow.draftTokens) * 100) : undefined,
              lastCacheBreak: lastBreak ? describeCacheBreak(lastBreak) : undefined,
              instructionFiles,
              promptProfile: prompt?.profile,
              thinkLevel: shownThinkLevel,
              sampling,
              shell: `${currentShell().kind} (${currentShell().exe})`,
              mcp: [...(mcpStatusReport?.() ?? [])].filter((l) => l.trim()).slice(0, 4),
              checkpoints: !!checkpoints,
              memories: (memoryStores.project?.list().length ?? 0) + (memoryStores.global?.list().length ?? 0),
              permissionRules: rules.allow.length + rules.ask.length + rules.deny.length,
            }).join('\n'),
          ),
        ]);
      } else if (commandName(input) === '/all') {
        // E1: everything, hidden commands included; Enter runs it or fills it in, like the palette.
        pushBlock([userLine(input)]);
        const commands = allCommands(mcpCommands).filter((c) => c.name !== '/all');
        const picked = await pickChoice('All commands (↑/↓, Enter, Esc to close):', commands.map((c) => ({ key: c.name, label: `${c.name}${c.hidden ? ' (hidden)' : ''} - ${c.description}` })));
        const command = commands.find((c) => c.name === picked);
        // Into the input box either way: Enter runs it, or type its argument first.
        if (command) setPrefill({ token: nextPrefillToken++, text: command.select === 'run' ? command.name : `${command.name} ` });
      } else if (commandName(input) === '/set-pinnedcommands') {
        // E1: pin hidden commands into the bare / list. One toggle per pick; Esc when done.
        pushBlock([userLine(input)]);
        const hidden = allCommands().filter((c) => c.hidden);
        for (;;) {
          const current = new Set(pinnedCommands());
          const picked = await pickChoice(
            'Pinned commands show in the bare / list (Enter toggles, Esc when done):',
            hidden.map((c) => ({ key: c.name, label: `${current.has(c.name) ? '[x]' : '[ ]'} ${c.name} - ${c.description}` })),
          );
          if (!picked) break;
          if (current.has(picked)) current.delete(picked);
          else current.add(picked);
          setPinnedCommands([...current]);
          await configStore.set('global', 'pinnedCommands', [...current]).catch(() => undefined);
        }
        const now = pinnedCommands();
        pushBlock([infoLine(now.length ? `Pinned: ${now.join(', ')}` : 'No commands pinned.')]);
      } else if (commandName(input) === '/view-prompt') {
        // Display-only: the prompt was fixed when the session started (systemPrompt.ts).
        pushBlock([userLine(input)]);
        const prompt = builtSystemPrompt();
        if (!prompt) pushBlock([infoLine('No system prompt was built in this process.')]);
        else {
          const total = prompt.sections.reduce((n, s) => n + estimateTextTokens(s.text), 0);
          pushBlock([
            infoLine(
              [
                `System prompt - profile ${prompt.profile}, about ${total} tokens (set config promptProfile to default, qwen or small to change it):`,
                ...prompt.sections.flatMap((s) => ['', `── ${s.name} (${estimateTextTokens(s.text)} tokens)`, s.text]),
              ].join('\n'),
            ),
          ]);
        }
      } else if (commandName(input) === '/view-db') {
        // Read-only and local: database -> table -> one row in full. See dbBrowser.ts.
        pushBlock([userLine(input)]);
        const dbDir = dbDirFor(projectRoot);
        // The project's databases, and the global ones (~/.o4c/db - global memories, D3).
        const globalDbDir = join(homedir(), '.o4c', 'db');
        const choices = [
          ...(dbDir ? listDatabases(dbDir).map((n) => ({ key: `p:${n}`, label: n, dir: dbDir, file: n })) : []),
          ...listDatabases(globalDbDir).map((n) => ({ key: `g:${n}`, label: `${n} (global, ~/.o4c/db)`, dir: globalDbDir, file: n })),
        ];
        if (choices.length === 0) {
          pushBlock([infoLine("No databases yet - o4c makes them in .o4c/db/ once the project is trusted.")]);
        } else {
          const picked = await pickChoice('Database (↑/↓ to choose, Enter to select, Esc to cancel):', choices.map((c) => ({ key: c.key, label: c.label })));
          const choice = choices.find((c) => c.key === picked);
          const name = choice?.file;
          let db: ReturnType<typeof openReadOnly> | undefined;
          try {
            db = choice === undefined ? undefined : openReadOnly(choice.dir, choice.file);
            const table = db ? await pickChoice(`${name} - tables (↑/↓ to choose, Enter to select, Esc to cancel):`, tableRows(db)) : undefined;
            const row = db && table ? await pickChoice(rowsTitle(db, table), recordRows(db, table)) : undefined;
            if (!db || !table || !row) pushBlock([infoLine('Nothing chosen.')]);
            else pushBlock([infoLine((row === '__schema' ? schemaDetail(db, table) : recordDetail(db, table, row)).join('\n'))]);
          } catch (err) {
            pushBlock([infoLine(`Could not read ${name}: ${formatError(err)}`)]);
          } finally {
            db?.close();
          }
        }
      } else if (commandName(input) === '/view-plan') {
        // Local and display-only like /plans: picking and viewing never reach loop.run().
        pushBlock([userLine(input)]);
        if (!plans) {
          pushBlock([infoLine('Plans need a trusted project - o4c keeps them in .o4c/db/history.db.')]);
        } else if (plans.store.listPlans().length === 0) {
          pushBlock([infoLine('No plans yet. Make one with /plan <goal> (or /ultraplan <goal> to research first).')]);
        } else {
          const picked = await pickChoice(PLAN_PICKER_TITLE, planPickerRows(plans.store));
          const plan = picked === undefined ? undefined : plans.store.getPlan(Number(picked));
          const action = plan ? await pickChoice<PlanAction>(planActionTitle(plan), planActionRows(plan, plans.sessionId)) : undefined;
          if (!plan || !action) {
            pushBlock([infoLine('No plan chosen.')]);
          } else if (action === 'view' || action === 'full') {
            pushBlock([infoLine(formatPlan(plans.store, plan, { full: action === 'full' }).join('\n'))]);
          } else if (action === 'checklist') {
            // The nested level: plan -> its checklist -> one item, shown in full, then what to do with it.
            const which = await pickChoice(planActionTitle(plan).replace(' (', ' - checklist ('), planItemRows(plans.store, plan));
            const count = plans.store.items(plan.id).length;
            const no = formatPlanNo(plan.number);
            const position = which === 'end' ? count : Number(which);
            const item = which === undefined || which === 'end' ? undefined : plans.store.getItem(plan.id, position);
            if (item) pushBlock([infoLine(formatItemDetail(plans.store, plan, item).join('\n'))]);
            const op: PlanItemOp | undefined =
              which === undefined ? undefined : which === 'end' ? 'add' : await pickChoice<PlanItemOp>(`Item ${which} (↑/↓ to choose, Enter to select, Esc to cancel):`, planItemOpRows(position, count));
            if (!op || op === 'none') {
              pushBlock([infoLine('Nothing changed.')]);
            } else if (op === 'reword') {
              // The text is the part a dropdown cannot collect: hand it to the input box, finished there.
              const current = plans.store.getItem(plan.id, position)!.text.replace(/\s*\n\s*/g, ' ');
              const text = `/plan-reword ${plan.number} ${position} ${current}`;
              setInputValue(text);
              setPrefill({ token: nextPrefillToken++, text });
              pushBlock([infoLine(`Edit item ${position}'s text in the input box, then press Enter.`)]);
            } else if (op === 'add') {
              const text = `/plan-add ${plan.number} ${position} `;
              setInputValue(text);
              setPrefill({ token: nextPrefillToken++, text });
              pushBlock([infoLine(`Type the new item after "${position}" in the input box, then press Enter.`)]);
            } else {
              try {
                if (op === 'remove') plans.store.removeItem(plan.id, position);
                else plans.store.moveItem(plan.id, position, op === 'up' ? position - 1 : position + 1);
                pushBlock([infoLine([`Plan ${no}: ${op === 'remove' ? `removed item ${position}` : `moved item ${position} ${op}`}.`, ...formatChecklist(plans.store, plans.store.getPlan(plan.id)!)].join('\n'))]);
              } catch (err) {
                pushBlock([infoLine(err instanceof PlanRuleError ? err.message : formatError(err))]);
              }
            }
          } else if (action === 'export') {
            if (!projectRoot) {
              pushBlock([infoLine('Exporting needs a trusted project to write into.')]);
            } else {
              try {
                const files = await exportPlan(projectRoot, plans.store, plan);
                pushBlock([infoLine(`Exported to ${files.planFile} and ${files.checklistFile}. They are a snapshot - export again after changes.`)]);
              } catch (err) {
                pushBlock([{ kind: 'error', text: `Export failed: ${formatError(err)}` }]);
              }
            }
          } else if (action === 'activate') {
            plans.store.activate(plan.id, plans.sessionId);
            pushBlock([infoLine(`${planActionTitle(plan).split(' (')[0]} is now the active plan.`)]);
          } else {
            plans.store.park(plan.id);
            pushBlock([infoLine(`${planActionTitle(plan).split(' (')[0]} is parked - still saved, no longer active.`)]);
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
        // E14: `/think 4000` (or 4k) sets a token budget instead of a level.
        const budget = typed ? parseThinkBudget(typed) : undefined;
        const saveBudget = (value: number | undefined) =>
          void (async () => {
            try {
              const scope = await scopeOwningEntry(configStore, THINK_BUDGET_CONFIG_KEY, model);
              const own = (await configStore.readScope(scope))[THINK_BUDGET_CONFIG_KEY];
              const next: Record<string, unknown> = { ...(own && typeof own === 'object' ? own : {}) };
              if (value === undefined) delete next[model];
              else next[model] = value;
              await configStore.set(scope, THINK_BUDGET_CONFIG_KEY, next);
            } catch {
              // Live for this process either way.
            }
          })();
        if (budget !== undefined) {
          if (thinkLevel === 'nothink') {
            pushBlock([infoLine('Thinking is off (nothink), so a budget would do nothing - choose a level first, then /think <tokens>.')]);
          } else {
            setThinkBudgetOverride(budget);
            saveBudget(budget);
            pushBlock([infoLine(`Thinking budget set to ${budget.toLocaleString()} tokens (replaces ${THINK_LEVEL_INFO[thinkLevel].label}'s own budget; choosing a level clears it).${thinkCaps && !thinkCaps.supportsBudget ? ' This model cannot take a budget, so it has no effect here.' : ''}`)]);
          }
        }
        const direct = typed && budget === undefined ? parseThinkLevel(typed) : undefined;
        if (budget !== undefined) {
          // Done above.
        } else if (typed && !direct) {
          pushBlock([
            infoLine(`"${typed}" is not a thinking level - choose one of ${THINK_LEVELS.join(', ')}.`),
          ]);
        }
        const chosen =
          budget !== undefined
            ? undefined
            : direct ??
              (await new Promise<ThinkLevel | undefined>((resolve) => {
                setThinkPicker({ resolve });
              }));
        if (budget !== undefined) {
          // A budget was set; the level stays as it is.
        } else if (chosen) {
          setThinkLevel(chosen);
          if (thinkBudgetOverride() !== undefined) {
            setThinkBudgetOverride(undefined);
            saveBudget(undefined);
          }
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
      } else if (input === '/window' || input.startsWith('/window ')) {
        pushBlock([userLine(input)]);
        // Local and immediate: a window changes only what the next request *sends*, so there is
        // nothing to call the model about and nothing to undo. See `AgentLoop.setSlidingWindow`.
        const typed = input.slice('/window'.length).trim().toLowerCase();
        const current = loop.slidingWindowSettings();

        if (!typed) {
          pushBlock([
            infoLine(
              current
                ? `Context window limit is on (${describeWindowSetting(current)}). ` +
                  '/window off turns it off; nothing was deleted.'
                : 'Context window limit is off - the whole conversation is sent. ' +
                  'Set one with /window 40000 or /window 50%.',
            ),
          ]);
        } else if (typed === 'off' || typed === '0') {
          loop.setSlidingWindow(undefined);
          pushBlock([infoLine('Context window limit off - the next request carries the whole conversation again.')]);
          void runLogger.log({ type: 'system', sub_type: 'info', command: '/window', setting: 'off' });
        } else {
          const parsed = parseWindowSetting(typed);
          if (!parsed) {
            pushBlock([
              infoLine(
                `"${typed}" is not a window size - give a token count (/window 40000), ` +
                  'a share of the context window (/window 50%), or off.',
              ),
            ]);
          } else {
            loop.setSlidingWindow(parsed);
            // Said plainly, because this is the one command that makes the model stop seeing
            // part of the conversation. A silent success here would look like a bug later.
            pushBlock([
              infoLine(
                `Context window limit on (${describeWindowSetting(parsed)}). ` +
                  'Older messages stay in history and in the session file - they are simply not sent. ' +
                  '/window off restores them.',
              ),
            ]);
            void runLogger.log({ type: 'system', sub_type: 'info', command: '/window', setting: typed });
          }
        }
      } else if (commandName(input) === '/mark-incorrect') {
        // E22: the answer was wrong - ranked down, reason kept for search and /reflect.
        pushBlock([userLine(input)]);
        try {
          pushBlock([infoLine(markIncorrect(input.trim().slice('/mark-incorrect'.length)))]);
        } catch (err) {
          pushBlock([{ kind: 'error', text: formatError(err) }]);
        }
      } else if (input === '/worked' || input.startsWith('/worked ')) {
        pushBlock([userLine(input)]);
        const arg = input.slice('/worked'.length);
        try {
          pushBlock([
            infoLine(markWorked ? markWorked(arg) : 'No task history here - it needs a trusted project, where o4c keeps .o4c/db/history.db.'),
          ]);
          void runLogger.log({ type: 'system', sub_type: 'info', command: '/worked', setting: arg.trim() });
        } catch (err) {
          pushBlock([{ kind: 'error', text: formatError(err) }]);
        }
      } else if (input === '/datagraph' || input.startsWith('/datagraph ')) {
        pushBlock([userLine(input)]);
        const typed = input.slice('/datagraph'.length).trim().toLowerCase();
        if (!codeGraph) {
          pushBlock([infoLine('The Code Graph is not running in this session (it needs a trusted project).')]);
        } else if (!typed) {
          pushBlock([
            infoLine(
              codeGraph.component.isExposed()
                ? 'Code Graph is on: the model gets the code_graph tool and notes on grep/read results. /datagraph off hides it.'
                : 'Code Graph is off: the model uses grep, glob and read only. It keeps indexing in the background; /datagraph on shows it again.',
            ),
          ]);
        } else if (typed === 'on' || typed === 'off') {
          const on = typed === 'on';
          codeGraph.setExposed(on);
          // Saved so the per-turn reload keeps it - cli.ts reads `codeGraph` at startup.
          void configStore.set('local', 'codeGraph', on).catch(() => {});
          pushBlock([
            infoLine(
              on
                ? 'Code Graph on - the next request includes the code_graph tool and its notes.'
                : 'Code Graph off - the next request uses grep, glob and read only. Indexing continues in the background.',
            ),
          ]);
          void runLogger.log({ type: 'system', sub_type: 'info', command: '/datagraph', setting: typed });
        } else {
          pushBlock([infoLine(`"${typed}" is not a setting - use /datagraph on or /datagraph off.`)]);
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
              pushBlock([
                infoLine(
                  `Session view set to ${value} (${scope}${chosen === 'default' ? ', copied from the global value' : ''}).${note}`,
                ),
              ]);
              // Reload every time now (David, 2026-10-11), so the new view is on screen at once and
              // there is nothing left for an "it takes effect at the next reload or /resume" note to
              // say - that wording is gone along with the condition that produced it.
              //
              // Deliberately NOT gated on `reloadAfterTurn`: that flag governs the per-turn repaint
              // and is off in tests, but restart() works regardless of it (cli.ts hands the args to
              // the supervisor when O4C_HANDOFF_FILE is set, and falls back to spawnRestart when it
              // is not). The old gate also required an existing session id, which is why the note
              // appeared at all - before the first autosave there is no id.
              //
              // Save first, for the same reason the per-turn reload does: a session that has never
              // been saved has no id, and handing off without one would drop the conversation.
              let resumeId = currentSessionIdRef.current;
              const entriesToSave = loop.getEntries();
              if (entriesToSave.length > 0) {
                try {
                  resumeId = await sessionStore.save(entriesToSave, resumeId, inputHistoryRef.current);
                  currentSessionIdRef.current = resumeId;
                  // A brand-new session gets its id here, and the usage store needs it before this
                  // process exits or the session subtotal is filed under no id (see usageStore.ts).
                  usageStore?.setSessionId(resumeId);
                } catch (saveErr) {
                  pushBlock([{ kind: 'error', text: `Warning: failed to save session: ${formatError(saveErr)}` }]);
                }
              }
              if (resumeId || entriesToSave.length === 0) {
                restart(resumeId, modeRef.current);
                setTimeout(() => exit(), 0);
              } else {
                // Only reachable when the save above failed on a session that had no id yet:
                // reloading would repaint from nothing and lose it, so the setting waits instead.
                pushBlock([
                  infoLine(
                    'Not reloading, because this session could not be saved - the new view applies at the next reload or /resume.',
                  ),
                ]);
              }
            }
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (
        commandName(input) === '/set-contextwindowtype' ||
        commandName(input) === '/set-local-contextwindowtype' ||
        commandName(input) === '/set-global-contextwindowtype'
      ) {
        pushBlock([userLine(input)]);
        const name = commandName(input);
        const scope: ConfigScope = name === '/set-global-contextwindowtype' ? 'global' : 'local';
        const raw = input.slice(name.length).trim();
        const current = contextWindowType?.current() ?? contextWindowTypeFromConfig(await configStore.get(CONTEXT_WINDOW_TYPE_CONFIG_KEY));
        const listing = CONTEXT_WINDOW_TYPES.map((t) => `  ${t} - ${CONTEXT_WINDOW_TYPE_INFO[t]}`);
        const parsed = raw.toLowerCase() === 'default' ? 'default' : parseContextWindowType(raw);
        if (!raw) {
          pushBlock([
            infoLine(
              [
                `Context window type: ${describeContextWindowType(current)}.`,
                ...listing,
                `Usage: ${name} <type>, e.g. ${name} pointer or ${name} curated 20%. ${name} default clears the saved value.`,
              ].join('\n'),
            ),
          ]);
        } else if (!parsed) {
          pushBlock([
            {
              kind: 'error',
              text: `"${raw}" isn't a context window type. Choose none, floating, pointer or curated (only curated takes a budget, e.g. curated 20% or curated 20000).`,
            },
          ]);
        } else if (scope === 'local' && !configStore.hasScope('local')) {
          pushBlock([
            {
              kind: 'error',
              text: 'No trusted project in this directory - nothing to set a local value into. Trust this project first, or use /set-global-contextwindowtype instead.',
            },
          ]);
        } else {
          try {
            await configStore.set(scope, CONTEXT_WINDOW_TYPE_CONFIG_KEY, parsed === 'default' ? undefined : formatContextWindowType(parsed));
            // What wins after the write, not what was typed: a global choice under a project that
            // has its own value changes nothing here, and saying otherwise would be a lie.
            const effective = contextWindowTypeFromConfig(await configStore.get(CONTEXT_WINDOW_TYPE_CONFIG_KEY));
            contextWindowType?.set(effective);
            const what =
              parsed === 'default'
                ? `Saved context window type cleared (${scope}).`
                : `Context window type set to ${describeContextWindowType(parsed)} (${scope}).`;
            const shadowed =
              parsed !== 'default' && formatContextWindowType(effective) !== formatContextWindowType(parsed)
                ? ' This project has its own value, which still wins here.'
                : '';
            pushBlock([infoLine(`${what}${shadowed} Now in effect: ${describeContextWindowType(effective)}.`)]);
            void runLogger.log({ type: 'system', sub_type: 'info', command: name, setting: raw, scope });
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
      } else if (commandName(input) === '/help' && input.trim() !== '/help') {
        // E4: /help <question> - the shipped docs, searched locally; no model call.
        pushBlock([userLine(input)]);
        const question = input.trim().slice('/help'.length).trim();
        const hits = searchDocs(question);
        pushBlock([
          infoLine(
            hits.length
              ? [`From the o4c docs (best ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${question}"):`, '', ...hits.map((h) => formatSection(h)).join('\n\n').split('\n')].join('\n')
              : `Nothing in the o4c docs matches "${question}". /help lists the commands; /all shows hidden ones too.`,
          ),
        ]);
      } else if (input === '/help') {
        pushBlock([userLine(input)]);
        // Dynamic rows included: /help is the single full reference, and a command that exists
        // but is missing from the one listing that claims to be complete is worse than noise.
        const lines = [...COMMANDS, ...mcpCommands].map(
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
        const target = commandForHelpTarget(rest, mcpCommands);
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
          // E4: the docs' own section on this command, when they have one.
          const docSection = commandSection(target.name);
          if (docSection) detailLines.push('', formatSection(docSection, 40));
          pushBlock([infoLine(detailLines.join('\n'))]);
          void runLogger.log({ type: 'system', sub_type: 'info', command: `/help-${rest}` });
        }
      } else if (commandName(input) === '/undo' || commandName(input) === '/diff' || commandName(input) === '/rewind') {
        // Checkpoints (C1): the shadow git repository under .o4c/checkpoints, never the user's .git.
        pushBlock([userLine(input)]);
        const cmd = commandName(input);
        if (!checkpoints) {
          pushBlock([infoLine('Checkpoints are off here: they need a trusted project, git installed, and config checkpoints not set to false.')]);
        } else {
          const turns = checkpoints.store.list(checkpoints.sessionId);
          if (turns.length === 0) {
            pushBlock([infoLine('No checkpoints yet in this session - one is taken before the first change of each turn.')]);
          } else if (cmd === '/diff') {
            const first = turns[turns.length - 1]!;
            pushBlock([infoLine(`Changes since before "${first.label}":\n${checkpoints.shadow.diffSince(first.git_commit)}`)]);
          } else {
            let target = turns[0]!;
            let what: 'files' | 'conversation' | 'both' = 'files';
            if (cmd === '/rewind') {
              const picked = await pickChoice(
                'Rewind to before which turn? (↑/↓, Enter, Esc to cancel)',
                turns.map((t) => ({ key: String(t.id), label: `${new Date(t.created_at).toLocaleTimeString()}  ${t.label}` })),
              );
              const found = turns.find((t) => String(t.id) === picked);
              const how = found
                ? await pickChoice<'files' | 'conversation' | 'both'>('Restore what?', [
                    { key: 'files', label: 'Files only - the conversation stays' },
                    { key: 'conversation', label: 'Conversation only - the files stay' },
                    { key: 'both', label: 'Both' },
                  ])
                : undefined;
              if (!found || !how) {
                pushBlock([infoLine('Nothing rewound.')]);
                return;
              }
              target = found;
              what = how;
            }
            if (what !== 'conversation') {
              try {
                const r = checkpoints.shadow.restore(target.git_commit);
                checkpoints.store.add({ session_id: checkpoints.sessionId, turn_entry_id: null, label: `restore point before going back to "${target.label}"`, git_commit: r.current, kind: 'restore' });
                pushBlock([infoLine(`Files restored to before "${target.label}": ${r.restored} restored, ${r.removed} removed. The state you left is kept as a restore point (git ${r.current.slice(0, 8)} in .o4c/checkpoints).`)]);
              } catch (err) {
                pushBlock([{ kind: 'error', text: `Could not restore: ${formatError(err)}` }]);
                return;
              }
            }
            if (what !== 'files') {
              const entries = loop.getEntries();
              const at = target.turn_entry_id ? entries.findIndex((e) => e.id === target.turn_entry_id) : -1;
              if (at < 0) {
                pushBlock([infoLine('The conversation could not be rewound: that turn is not in this session any more.')]);
              } else {
                loop.loadEntries(entries.slice(0, at));
                await saveSessionNow();
                pushBlock([infoLine(`Conversation rewound to before "${target.label}". Reloading...`)]);
                restart(currentSessionIdRef.current, modeRef.current);
              }
            }
          }
        }
      } else if (commandName(input) === '/memory') {
        // D3: what o4c remembers across sessions - view, edit (back into the input box), delete.
        pushBlock([userLine(input)]);
        const stores = activeMemoryStores();
        const rows = [
          ...(stores.project?.list() ?? []).map((m) => ({ ...m, scope: 'project' as const })),
          ...(stores.global?.list() ?? []).map((m) => ({ ...m, scope: 'global' as const })),
        ];
        if (rows.length === 0) {
          pushBlock([infoLine('No memories yet. The model saves them with the remember tool, or ask it to remember something.')]);
        } else {
          const picked = await pickChoice('Memories (↑/↓, Enter to choose, Esc to close):', rows.map((m) => ({ key: `${m.scope}:${m.id}`, label: `[${m.kind}${m.scope === 'global' ? ', global' : ''}] ${m.text}` })));
          const row = rows.find((m) => `${m.scope}:${m.id}` === picked);
          const action = row ? await pickChoice<'edit' | 'delete'>('Edit or delete it?', [{ key: 'edit', label: 'Edit - put it in the input box as /memory-edit' }, { key: 'delete', label: 'Delete it' }]) : undefined;
          const store = row?.scope === 'global' ? stores.global : stores.project;
          if (!row || !action || !store) pushBlock([infoLine('Memories unchanged.')]);
          else if (action === 'delete') {
            store.remove(row.id);
            pushBlock([infoLine(`Deleted: ${row.text}`)]);
          } else {
            setPrefill({ token: nextPrefillToken++, text: `/memory-edit ${row.scope}:${row.id} ${row.text}` });
          }
        }
      } else if (commandName(input) === '/config-contextwindow-modelinitiatedsearches') {
        // D11 (design 2.4): whether the model may search past tasks on its own.
        pushBlock([userLine(input)]);
        const arg = input.trim().split(/\s+/)[1]?.toLowerCase();
        if (arg !== 'on' && arg !== 'off' && arg !== 'auto') {
          pushBlock([infoLine('Usage: /config-contextwindow-modelinitiatedsearches on|off|auto - on: the model gets search_history with every context window type; off: never; auto (default): with the pointer and curated types only.')]);
        } else {
          await configStore.set('global', 'modelInitiatedSearches', arg === 'auto' ? undefined : arg === 'on').catch(() => undefined);
          pushBlock([infoLine(`Model-initiated history search: ${arg}. Takes effect from your next message.`)]);
        }
      } else if (commandName(input) === '/compact') {
        // D6: compaction now, optionally told what to keep in detail.
        pushBlock([userLine(input)]);
        const focus = input.trim().slice('/compact'.length).trim();
        if (!contextWindow) {
          pushBlock([infoLine("/compact needs the model's context size, which is not known yet (the server has not answered).")]);
        } else {
          pushBlock([infoLine(`Compacting${focus ? ` (keeping in detail: ${focus})` : ''}...`)]);
          try {
            const r = await loop.compactNow({ contextWindow, focus: focus || undefined });
            if (!r) pushBlock([infoLine('Nothing to compact yet - there is no earlier turn to fold into a summary.')]);
            else {
              await saveSessionNow();
              pushBlock([infoLine(`Compacted: about ${formatTokenCount(r.before)} -> ${formatTokenCount(r.after)} tokens.`)]);
            }
          } catch (err) {
            pushBlock([{ kind: 'error', text: `Compaction failed: ${formatError(err)}` }]);
          }
        }
      } else if (commandName(input) === '/reflect') {
        // D4: lessons from recent finished tasks, proposed by one model call, saved only if picked.
        pushBlock([userLine(input)]);
        const tasks = recentTasks();
        const stores = activeMemoryStores();
        if (tasks.length === 0 || !(stores.project ?? stores.global)) {
          pushBlock([infoLine('Nothing to reflect on yet - /reflect looks at finished tasks in this project, and needs a trusted project.')]);
        } else {
          pushBlock([infoLine(`Looking at the last ${tasks.length} finished task(s) for lessons worth keeping (one model call)...`)]);
          try {
            const lessons = parseLessons(await loop.sideRequest(reflectPrompt(tasks), { responseSchema: REFLECT_SCHEMA as unknown as Record<string, unknown> }));
            if (lessons.length === 0) {
              pushBlock([infoLine('No lessons worth keeping came out of those tasks.')]);
            } else {
              const picked = await pickChoice('Save which as a lesson? (Esc saves none)', [
                { key: 'all', label: `All ${lessons.length}` },
                ...lessons.map((l, i) => ({ key: String(i), label: l })),
              ]);
              const chosen = picked === 'all' ? lessons : picked === undefined ? [] : [lessons[Number(picked)]!];
              const store = stores.project ?? stores.global!;
              for (const l of chosen) store.add(l, 'lesson');
              pushBlock([infoLine(chosen.length ? `Saved ${chosen.length} lesson(s) - see /memory.` : 'Nothing saved.')]);
            }
          } catch (err) {
            pushBlock([{ kind: 'error', text: `Reflect failed: ${formatError(err)}` }]);
          }
        }
      } else if (commandName(input) === '/memory-edit') {
        pushBlock([userLine(input)]);
        const m = /^\/memory-edit\s+(project|global):(\d+)\s+([\s\S]+)$/.exec(input.trim());
        const stores = activeMemoryStores();
        const store = m?.[1] === 'global' ? stores.global : stores.project;
        if (!m || !store) pushBlock([infoLine('Usage: /memory-edit <project|global>:<id> <new text> - /memory fills this in.')]);
        else pushBlock([infoLine(store.update(Number(m[2]), m[3]!.trim()) ? 'Memory updated.' : 'No such memory.')]);
      } else if (commandName(input) === '/init') {
        // D2: a first O4C.md from what the project's own files say - shown, then written on Yes.
        pushBlock([userLine(input)]);
        if (!projectRoot) {
          pushBlock([infoLine('/init needs a trusted project (o4c asks to trust a directory the first time it runs there).')]);
        } else if (existsSync(join(projectRoot, 'O4C.md')) || existsSync(join(projectRoot, 'o4c.md'))) {
          pushBlock([infoLine('This project already has an O4C.md - /init only writes a new one. Edit the existing file instead.')]);
        } else {
          const draft = draftO4cMd(await scanProject(projectRoot));
          pushBlock([infoLine(`Draft O4C.md (from the project's own files):\n\n${draft}`)]);
          const write = await pickChoice<'yes' | 'no'>('Write this as O4C.md in the project root?', [
            { key: 'yes', label: 'Yes - write O4C.md (edit it afterwards to add your conventions)' },
            { key: 'no', label: 'No - nothing is written' },
          ]);
          if (write === 'yes') {
            await writeFile(join(projectRoot, 'O4C.md'), draft, 'utf-8');
            pushBlock([infoLine('Wrote O4C.md. o4c reads it from the next message on; edit it to say what only you know.')]);
          } else {
            pushBlock([infoLine('Nothing written.')]);
          }
        }
      } else if (commandName(input) === '/btw') {
        // C8: a side question - answered from the conversation, kept out of it.
        pushBlock([userLine(input)]);
        const question = input.trim().slice('/btw'.length).trim();
        if (!question) {
          pushBlock([infoLine('Usage: /btw <question> - ask about the conversation without adding to it.')]);
        } else {
          try {
            const answer = await loop.askAside(question, { contextWindow });
            pushBlock([infoLine(`(aside, not part of the conversation)\n${answer || '(no answer)'}`)]);
          } catch (err) {
            pushBlock([{ kind: 'error', text: `The side question failed: ${formatError(err)}` }]);
          }
        }
      } else if (commandName(input) === '/queue') {
        // C6: what waits to run after the current turn - pick one to edit (back into the input box)
        // or drop.
        pushBlock([userLine(input)]);
        const items = queuedInputsRef.current;
        if (items.length === 0) {
          pushBlock([infoLine('Nothing is queued.')]);
        } else {
          const picked = await pickChoice('Queued messages (↑/↓, Enter to choose, Esc to cancel):', items.map((text, i) => ({ key: String(i), label: `${i + 1}. ${text.length > 120 ? `${text.slice(0, 120)}...` : text}` })));
          const index = picked === undefined ? -1 : Number(picked);
          const what = index >= 0 ? await pickChoice<'edit' | 'drop'>('Edit or drop it?', [{ key: 'edit', label: 'Edit - move it back into the input box' }, { key: 'drop', label: 'Drop it' }]) : undefined;
          if (index < 0 || !what || index >= queuedInputsRef.current.length) {
            pushBlock([infoLine('Queue unchanged.')]);
          } else {
            const [text] = queuedInputsRef.current.splice(index, 1);
            setQueuedPreview([...queuedInputsRef.current]);
            if (what === 'edit') {
              setPrefill({ token: nextPrefillToken++, text: text! });
              pushBlock([infoLine('Moved back into the input box - edit it and press Enter (or Ctrl+Q to queue it again).')]);
            } else {
              pushBlock([infoLine(`Dropped: ${text}`)]);
            }
          }
        }
      } else if (commandName(input) === '/view-permissions') {
        // C3: the effective rules and where each came from. Empty by default.
        pushBlock([userLine(input)]);
        const rules = await loadRules((s) => configStore.readScope(s as ConfigScope));
        pushBlock([
          infoLine(
            [
              'Permission rules (deny beats ask beats allow; a shell command is checked per segment):',
              ...describeRules(rules),
              '',
              'Add rules to config.json under "permissions": {"allow": [...], "ask": [...], "deny": [...]}, e.g. "run_shell(npm test*)" or "edit_file(src/**)".',
              '"Yes, and always allow" in an approval dialog adds an allow rule for you. /set-autoallowreadonly on allows read-only shell commands.',
            ].join('\n'),
          ),
        ]);
      } else if (commandName(input) === '/set-autoallowreadonly') {
        pushBlock([userLine(input)]);
        const arg = input.trim().split(/\s+/)[1]?.toLowerCase();
        if (arg !== 'on' && arg !== 'off') {
          pushBlock([infoLine('Usage: /set-autoallowreadonly on|off - whether read-only shell commands (git status, ls, dir, cat ...) run without asking.')]);
        } else {
          await configStore.set('global', 'autoAllowReadOnly', arg === 'on').catch(() => undefined);
          pushBlock([infoLine(arg === 'on' ? 'Read-only shell commands now run without asking (see /view-permissions).' : 'Read-only shell commands ask again, like any other command.')]);
        }
      } else if (commandName(input) === '/settings') {
        // E23: every setting with its value and scope; picking one runs its command.
        pushBlock([userLine(input)]);
        const values = await settingValues(configStore, model);
        const picked = await pickChoice(
          'Settings - value (scope it comes from). Enter changes it, Esc closes:',
          values.map((v) => ({ key: v.command, label: settingLabel(v) })),
        );
        if (picked) await processTurn(picked);
      } else if (commandName(input) === '/set-blockgap') {
        // E23: the gap between blocks; applies to blocks printed from now on.
        pushBlock([userLine(input)]);
        const choice = await pickChoice('Blank rows between blocks (↑/↓, Enter, Esc to cancel):', [
          { key: '0', label: '0 - compact, no gap' },
          { key: '1', label: '1 - one blank row (default)' },
          { key: '2', label: '2 - two blank rows' },
        ]);
        if (!choice) pushBlock([infoLine('Block gap unchanged.')]);
        else {
          const gap = parseBlockGap(Number(choice));
          await configStore.set('global', BLOCK_GAP_KEY, gap).catch(() => undefined);
          setBlockGap(gap);
          pushBlock([infoLine(`Block gap: ${gap}. Blocks already on screen keep their spacing.`)]);
        }
      } else if (commandName(input) === '/set-mouse') {
        // E16: opt-in, with the trade-off said up front.
        pushBlock([userLine(input)]);
        const choice = await pickChoice('Mouse click places the cursor in the input box (↑/↓, Enter, Esc to cancel):', [
          { key: 'off', label: 'off - the wheel scrolls back through the conversation and drag selects text (default)' },
          { key: 'on', label: 'on - click to place the cursor; the wheel stops scrolling back, and selecting text needs Shift+drag' },
        ]);
        if (!choice) pushBlock([infoLine('Mouse unchanged.')]);
        else {
          await configStore.set('global', MOUSE_CONFIG_KEY, choice === 'on').catch(() => undefined);
          setMouseOn(choice === 'on');
          pushBlock([infoLine(choice === 'on' ? 'Mouse on: click in the input box to move the cursor. Shift+drag selects text; /set-mouse to turn it off.' : 'Mouse off.')]);
        }
      } else if (commandName(input) === '/set-notify') {
        // E12: how o4c gets your attention when a long turn ends or an approval waits.
        pushBlock([userLine(input)]);
        const choice = await pickChoice('Notify when a long turn ends or an approval waits (↑/↓, Enter, Esc to cancel):', [
          { key: 'bell', label: 'bell - the terminal bell (default)' },
          { key: 'toast', label: 'toast - an OS notification' },
          { key: 'both', label: 'both - bell and OS notification' },
          { key: 'off', label: 'off - never' },
        ]);
        if (!choice) pushBlock([infoLine('Notifications unchanged.')]);
        else {
          await configStore.set('global', NOTIFY_CONFIG_KEY, choice).catch(() => undefined);
          notifyRef.current = { ...notifyRef.current, mode: choice };
          pushBlock([infoLine(`Notifications: ${choice}. A turn counts as long after ${notifyRef.current.after} s (config key ${NOTIFY_AFTER_CONFIG_KEY}); approvals always notify.`)]);
        }
      } else if (commandName(input) === '/set-shell') {
        // B24: which shell run_shell uses. Saved to config; the next message's process picks it up
        // (the system prompt names the shell, so changing it costs one full re-read of the context).
        pushBlock([userLine(input)]);
        const choice = await pickChoice('Shell for run_shell (↑/↓ to choose, Enter to select, Esc to cancel):', [
          { key: 'auto', label: `auto - ${process.platform === 'win32' ? 'cmd.exe on Windows' : 'bash if installed, else sh'}` },
          { key: 'cmd', label: 'cmd - Windows command prompt' },
          { key: 'pwsh', label: 'pwsh - PowerShell 7 (&& works)' },
          { key: 'powershell', label: 'powershell - Windows PowerShell 5.1 (no &&)' },
          { key: 'bash', label: 'bash' },
          { key: 'sh', label: 'sh' },
        ]);
        if (!choice) pushBlock([infoLine('Shell unchanged.')]);
        else {
          await configStore.set(projectRoot ? 'local' : 'global', SHELL_CONFIG_KEY, choice).catch(() => undefined);
          setShell(choice);
          pushBlock([infoLine(`Shell set to ${choice} (${currentShell().exe}). The model is told from your next message.`)]);
        }
      } else if (commandName(input) === '/ps') {
        // Local: the job records under .o4c/jobs (B22).
        pushBlock([userLine(input)]);
        const jobs = listJobs();
        pushBlock([infoLine(jobs.length ? ['Background jobs:', ...jobs.map((j) => `  ${describeJob(j)}`)].join('\n') : 'No background jobs.')]);
      } else if (commandName(input) === '/kill') {
        pushBlock([userLine(input)]);
        const id = input.trim().split(/\s+/)[1] ?? '';
        const job = id ? getJob(id) : undefined;
        if (!job) pushBlock([infoLine(id ? `No background job "${id}" - see /ps.` : 'Usage: /kill <id> - see /ps for the ids.')]);
        else pushBlock([infoLine(killJob(job) ? `Stopped ${job.id}: ${job.command}` : `${job.id} is not running.`)]);
      } else if (commandName(input) === '/mcp') {
        pushBlock([userLine(input)]);
        // `mcpStatusReport` is undefined only for a session with no MCP layer at all (tests, and
        // any future headless path) - distinct from "configured nothing", which the report
        // itself says, so the two never get confused for each other.
        pushBlock([
          infoLine(
            (mcpStatusReport?.() ?? ['MCP is not running in this session.']).join('\n'),
          ),
        ]);
        void runLogger.log({ type: 'system', sub_type: 'info', command: '/mcp' });
      } else if (mcpCommands.some((c) => c.name === commandName(input) && c.custom)) {
        // G1: a custom command's body goes into the input box to read and edit - never sent on its own.
        pushBlock([userLine(input)]);
        const name = commandName(input);
        const custom = mcpCommands.find((c) => c.name === name)!.custom!;
        const text = expandCustomCommand(custom, input.slice(name.length));
        setInputValue(text);
        setPrefill({ token: nextPrefillToken++, text });
        pushBlock([infoLine(`${name} expanded into the input box (from ${custom.file}). Read it, edit it if you like, then press Enter to send it.`)]);
      } else if (mcpCommands.some((c) => c.name === commandName(input))) {
        // An MCP prompt is a template the user asked for by name. It expands into the input box
        // rather than being sent: the spec's own user-interaction model for prompts asks for
        // "transparent display of the prompt's underlying template", and more concretely, text
        // that came from a server must never auto-submit or be re-read as a command - an
        // expansion beginning "/clear" would otherwise be a server clearing the session.
        pushBlock([userLine(input)]);
        const name = commandName(input);
        const ref = mcpCommands.find((c) => c.name === name)?.mcpPrompt;
        if (!ref || !expandMcpPrompt) {
          pushBlock([{ kind: 'error', text: `${name} is no longer available - its MCP server is not connected.` }]);
        } else {
          const parsed = parsePromptArguments(ref, input.slice(name.length));
          if (!parsed.ok) {
            pushBlock([{ kind: 'error', text: parsed.error }]);
          } else {
            try {
              const expanded = await expandMcpPrompt(ref, parsed.args);
              if (!expanded.text.trim()) {
                pushBlock([
                  {
                    kind: 'error',
                    text: [
                      `Prompt "${ref.promptName}" on MCP server "${ref.serverId}" expanded to no text, so there is nothing to send.`,
                      ...expanded.notes,
                    ].join('\n'),
                  },
                ]);
              } else {
                setInputValue(expanded.text);
                setPrefill({ token: nextPrefillToken++, text: expanded.text });
                pushBlock([
                  infoLine(
                    [
                      `${name} expanded into the input box. Read it, edit it if you like, then press Enter to send it.`,
                      ...expanded.notes,
                    ].join('\n'),
                  ),
                ]);
              }
              void runLogger.log({ type: 'system', sub_type: 'info', command: name });
            } catch (err) {
              pushBlock([{ kind: 'error', text: formatError(err) }]);
            }
          }
        }
      } else if (parsePlanCommand(input) && (!plans || !parsePlanCommand(input)!.goal)) {
        const command = parsePlanCommand(input)!;
        pushBlock([
          userLine(input),
          infoLine(
            !plans
              ? 'Plans need a trusted project - o4c keeps them in .o4c/db/history.db.'
              : `Usage: /${command.kind} <goal> - what you want planned, e.g. /${command.kind} add an export command for plans`,
          ),
        ]);
      } else if (looksLikeSlashCommand(input) && !knownCommandNames(mcpCommands).includes(commandName(input))) {
        pushBlock([
          userLine(input),
          {
            kind: 'error',
            text: `Unknown command: ${commandName(input)}. Known commands: ${knownCommandNames(mcpCommands).join(', ')}.`,
          },
        ]);
      } else {
        // Echo the user's own line immediately, as its own permanent block - don't
        // wait for the (possibly very long) response before it shows up in scrollback.
        pushBlock([userLine(input)]);
        // `/plan <goal>`: the same turn with a planning prompt, run read-only, its answer saved as a
        // plan below. The echo above stays the user's own short command.
        const planCommand = plans ? parsePlanCommand(input) : undefined;
        // `/ultraplan` (Q6): o4c's fixed research steps run first and go into the prompt; the model
        // then thinks harder and gets a bounded follow-up of its own.
        const ultra = planCommand?.kind === 'ultraplan';
        // `/review [focus]` (D9): this session's checkpoint diff, reviewed read-only.
        const reviewCommand = commandName(input) === '/review';
        let reviewDiff: string | undefined;
        if (reviewCommand && checkpoints) {
          const first = checkpoints.store.list(checkpoints.sessionId).at(-1);
          if (first) {
            try {
              reviewDiff = checkpoints.shadow.diffSince(first.git_commit, 40_000);
            } catch {
              reviewDiff = undefined;
            }
          }
        }
        const sent = planCommand
          ? planPrompt(planCommand, ultra ? plans?.research?.(planCommand.goal) : undefined)
          : reviewCommand
            ? reviewPrompt(reviewDiff, input.trim().slice('/review'.length).trim())
            : // E6: @file and @file:10-40 attach those contents; the typed text stays as typed.
              // E7: any `!command` outputs since the last message go in front of it.
              withShellNotes(shellNotesRef.current.splice(0), expandMentions(input));
        turnModeRef.current = planCommand || reviewCommand ? 'plan' : undefined;

        const responseLines: Line[] = [];
        dispatchTextWindow({ type: 'clearLive' });
        setIsThinking(true);
        setToolProgress(null);
        setServerStatusLine(null);
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
        fenceTrackerRef.current.reset();
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
          const finalAnswer = await loop.run(sent, {
            images: initialImage ? [initialImage] : undefined,
            toolPolicy,
            // At the step limit, ask (B18) - Esc counts as stop, the old behaviour.
            onStepLimit: async (steps: number) =>
              (await pickChoice(`The model has taken ${steps} steps this turn (the step limit). What now?`, [
                { key: 'continue', label: `Continue - allow another ${maxIterations && maxIterations > 0 ? maxIterations : 25} steps.` },
                { key: 'summarize', label: 'Summarize - one last answer, no tools: what is done, what is left, what to do next.' },
                { key: 'stop', label: 'Stop - end the turn now' },
              ])) ?? 'stop',
            takeSteering: () => steeringRef.current.splice(0),
            // Auto mode only: nobody approves each step, so ask once to verify unchecked edits (B19).
            verifyOnStop: mode === 'auto' && (await configStore.get('verifyOnStop')) !== false,
            modeInstruction: modeSystemPrompt(planCommand ? 'plan' : mode, plansDir),
            signal: controller.signal,
            contextWindow,
            toolOutputDir,
            // `/think`'s level, read fresh per turn via the ref so a change made while a turn
            // was queued still applies to it.
            thinkLevel: ultra && THINK_LEVELS.indexOf(thinkLevelRef.current ?? DEFAULT_THINK_LEVEL) < THINK_LEVELS.indexOf('high') ? 'high' : thinkLevelRef.current,
            maxIterations: ultra ? Math.min(maxIterations ?? ULTRAPLAN_MAX_ITERATIONS, ULTRAPLAN_MAX_ITERATIONS) : maxIterations,
            // The full request/response wire transcript - "the sends", distinct from onEvent's
            // already-derived AgentEvent stream below (which only ever carries the *response*
            // side, split/reshaped for display). Fire-and-forget, same reasoning as runLogger's
            // own calls: a logging failure must never interrupt the turn itself.
            onProviderCall: (call) => {
              lastCallRef.current = call;
              providerCallLoggerRef.current(call);
            },
            onEvent: (event: AgentEvent) => {
              // Raw streamed text - a live-preview-only signal, not logged (the run log already
              // gets the complete, final 'think'/'text' events below once the stream ends) and
              // not one of responseLines' permanent entries. Appends onto the current streaming
              // line rather than starting a new one each time (textWindow.ts's own deltaActive
              // tracking) - handled first and returned early since every other event type below
              // means "a new, distinct line", the opposite of what a delta continuation needs.
              // Live status only, like 'delta': not logged, never a transcript line. Throttled,
              // because it arrives once per streamed fragment of the arguments.
              if (event.type === 'prefill_progress' && event.prefill) {
                const { total, cached, processed } = event.prefill;
                const done = Math.min(total, cached + processed);
                setServerStatusLine(
                  `Reading context ${total > 0 ? Math.round((done / total) * 100) : 0}% (${formatTokenCount(done)} of ${formatTokenCount(total)}, ${formatTokenCount(cached)} reused)`,
                );
                return;
              }
              if (event.type === 'server_busy') {
                setServerStatusLine('Server busy with another request - waiting for it');
                return;
              }
              if (event.type === 'tool_output') {
                // A running command's latest line, next to the spinner (B24). Throttled like tool_progress.
                const now = Date.now();
                const line = (event.text ?? '').split(/\r?\n/).filter((l) => l.trim()).pop();
                if (line && now - toolProgressShownAtRef.current >= TOOL_PROGRESS_MS) {
                  toolProgressShownAtRef.current = now;
                  setServerStatusLine(`${event.toolName ?? 'run_shell'}: ${line.trim().slice(0, 160)}`);
                }
                return;
              }
              if (event.type === 'tool_progress') {
                setServerStatusLine(null);
                const now = Date.now();
                if (event.toolName && now - toolProgressShownAtRef.current >= TOOL_PROGRESS_MS) {
                  toolProgressShownAtRef.current = now;
                  setToolProgress({ name: event.toolName, chars: event.chars ?? 0 });
                }
                return;
              }
              if (event.type === 'delta') {
                setToolProgress(null);
                setServerStatusLine(null);
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

              // The call it was counting has arrived whole: back to "Thinking...".
              if (event.type === 'tool_call') setToolProgress(null);
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
              //
              // **Both** buffers have to be drained here, in this order, and for a while only the
              // second one was. Streamed text sits in two places: `deltaBufferRef` holds deltas
              // that have arrived but are still being coalesced (the O(n^2) guard), and
              // `streamTailRef` holds the partial line of what has already been committed.
              // Flushing only the tail left the coalesced deltas pending, so they landed *after*
              // the tool line, on their own, without the "[think]" label - which only goes on at a
              // kind change, and this buffer was not started by one. Reported 2026-10-24: one
              // sentence of reasoning rendered as "[think] First", then the tool call, then
              // ", let's investigate the directory structure..." with the comma still on the front.
              // The kind-change path above already drains both in exactly this order; this is the
              // same requirement, and the ordering matters because `flushDeltaBuffer` feeds
              // `commitStreamText`, which is what leaves the tail that `flushStreamTail` commits.
              if ((event.type === 'tool_call' || event.type === 'tool_result') && sessionViewRef.current === 'full') {
                const text = formatEvent(event, 'full');
                if (!text) return;
                flushDeltaBuffer();
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
                (event.type === 'compaction' || event.type === 'prune' || event.type === 'warning' || event.type === 'info')
              ) {
                // Both buffers, same order, same reason as the tool lines above: a compaction or
                // warning arriving mid-stream must not jump ahead of reasoning that is still
                // coalescing, or it lands between a sentence and its own tail.
                flushDeltaBuffer();
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
              } else if (event.type === 'compaction' || event.type === 'prune' || event.type === 'info') {
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
          if (planCommand && plans) {
            // Before the autosave below, so the notice is saved with the turn and survives the
            // per-turn reload's repaint.
            const saved = savePlanFromAnswer(plans, planCommand, finalAnswer ?? '');
            loop.addNotice(saved.message);
            responseLines.push(infoLine(saved.message));
          }
        } catch (err) {
          turnFailed = true;
          if (!(err instanceof AbortedError)) recordLastError(err); // E13: /last-error shows it in full
          if (err instanceof AbortedError) {
            // Escape while thinking: history was already rolled back inside loop.run() itself -
            // just put the prompt that started this turn back in the input box, unedited, so the
            // user can revise and resend it. Not an "error" line - a plain system note fits the
            // deliberate, expected nature of a cancellation better than the red error styling.
            responseLines.push({ kind: 'system', text: 'Cancelled - your message is back in the input box.' });
            // A /plan turn sent its planning prompt; what goes back is what the user typed.
            setPrefill({ token: nextPrefillToken++, text: planCommand ? input : err.prompt });
          } else if (err instanceof ServerUnavailableError) {
            // Not a failed request: the server cannot answer yet. The loop already rolled the turn back, so put
            // the message back in the input box and open the wait box - when the server answers the user just
            // presses Enter again.
            responseLines.push({
              kind: 'error',
              text: `${err.message} Your message is back in the input box - waiting for the server.`,
            });
            if (err.prompt) setPrefill({ token: nextPrefillToken++, text: planCommand ? input : err.prompt });
            setServerWait({ status: err.loading ? 'loading' : 'down', checks: 0 });
          } else {
            responseLines.push({ kind: 'error', text: formatError(err) });
          }
        } finally {
          turnModeRef.current = undefined;
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
          if (loop.getEntries().length > 0) {
            try {
              // Through the shared queue, not a direct save: /clear can abort this turn and save
              // at the same moment, and two concurrent first saves would file two sessions.
              turnSaved = (await saveSessionNow()) !== undefined;
            } catch (saveErr) {
              if (!stale) pushBlock([{ kind: 'error', text: `Warning: failed to save session: ${formatError(saveErr)}` }]);
            }
          }

          // E13: a generated title after the session's first answered message - off unless
          // generateTitles is set; otherwise the title stays the first line of that message.
          // Awaited (one short call) so the per-turn reload cannot cut it off.
          if (turnSaved && !turnFailed && !stale && currentSessionIdRef.current && loop.getMessages().filter((m) => m.role === 'user').length === 1) {
            try {
              if ((await configStore.get(GENERATE_TITLES_KEY)) === true) {
                const title = cleanTitle(await loop.sideRequest(titlePrompt(input)));
                if (title) await sessionStore.rename(currentSessionIdRef.current, title);
              }
            } catch {
              // The first-line title stays.
            }
          }

          if (stale) return;
        }

        // /clear closed this session while the turn was running and is restarting fresh. Nothing
        // after this point may run: a per-turn reload here would call restart() with this
        // session's id and, landing after /clear's own restart(), resume the session it cleared.
        if (sessionClosedRef.current) return;

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
          notifyTurnEnd();
          restart(currentSessionIdRef.current, modeRef.current);
          setTimeout(() => exit(), 0);
          return;
        }
      }

      // Steering the turn never reached (it ended first) runs next, ahead of the queue (C6).
      if (steeringRef.current.length > 0) {
        queuedInputsRef.current.unshift(...steeringRef.current.splice(0));
        setQueuedPreview([...queuedInputsRef.current]);
      }
      const next = queuedInputsRef.current.shift();
      if (next !== undefined) {
        setQueuedPreview([...queuedInputsRef.current]);
        await processTurn(next);
      } else {
        notifyTurnEnd();
        setIsProcessing(false);
      }
    },
    [loop, initialImage, pushBlock, sessionStore, usageStore, askConfirm, toolPolicy, mode, plansDir, reloadAfterTurn, restart, exit, contextWindow, toolOutputDir, mcpCommands, mcpStatusReport, expandMcpPrompt, codeGraph, configStore, saveSessionNow, plans, pickChoice, checkpoints],
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

  const handleChoiceSelect = useCallback(
    (row: ChoiceRow) => {
      choicePicker?.resolve(row.key);
      setChoicePicker(null);
    },
    [choicePicker],
  );

  const handleChoiceCancel = useCallback(() => {
    choicePicker?.resolve(undefined);
    setChoicePicker(null);
  }, [choicePicker]);





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

  const handleConfirmChoice = useCallback(
    (choice: ConfirmChoice, reason?: string) => {
      confirmDialog?.resolve({ choice, reason });
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

  // /clear's confirmation. Yes stops any running turn, saves the whole session (it stays resumable
  // via /resume), then restarts fresh. The save is awaited before the restart: the per-turn
  // autosave only runs when a turn completes, so without it a /clear mid-turn - or after commands
  // that only added input history - would drop whatever came after the last completed turn.
  const handleClearResolve = useCallback(
    (yes: boolean) => {
      setClearConfirm(false);
      if (!yes) {
        pushBlock([infoLine('Clear cancelled - the session is unchanged.')]);
        return;
      }
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
      //
      // Saved BEFORE the abort, from a snapshot: an aborted turn rolls itself out of the loop's
      // history entirely, so saving afterwards would lose this turn's message and every tool round
      // it finished. Only a tool call still waiting for its result is left out - a resumed session
      // carrying one would be rejected by the provider. `final` stops the aborted turn's own
      // autosave from overwriting this with the rolled-back history.
      const saved = saveSessionNow(withoutUnansweredToolCalls(loop.getEntries()), true);
      abortTurn();
      // A failed save does not clear: the point of saving first is that clearing loses nothing.
      void saved.then(
        () => {
          restart(undefined, modeRef.current);
          setTimeout(() => exit(), 0);
        },
        (saveErr) => {
          // The session goes on, so later turns must be able to save it again.
          sessionClosedRef.current = false;
          pushBlock([
            {
              kind: 'error',
              text: `Not cleared - saving the session failed: ${formatError(saveErr)}`,
            },
          ]);
        },
      );
    },
    [loop, abortTurn, saveSessionNow, pushBlock, restart, exit],
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
        // Asks first, No selected - see handleClearResolve for what Yes does.
        setClearConfirm(true);
        return;
      }

      if (input === '/resume') {
        void openResumePicker();
        return;
      }

      if (askUserPendingRef.current && !input.startsWith('/')) {
        const answer = askUserPendingRef.current;
        askUserPendingRef.current = undefined;
        pushBlock([userLine(input)]);
        answer(input);
        return;
      }

      if (isProcessing) {
        // A command waits for the turn to end; a message steers the turn now (C6).
        if (input.startsWith('/') || input.trimStart().startsWith('!')) {
          queuedInputsRef.current.push(input);
          setQueuedPreview([...queuedInputsRef.current]);
        } else {
          steeringRef.current.push(input);
          pushBlock([infoLine(`↪ ${input.length > 100 ? `${input.slice(0, 100)}...` : input}  (goes to the model at its next step; Ctrl+Q queues for after the turn instead)`)]);
        }
        return;
      }

      setIsProcessing(true);
      void processTurn(input);
    },
    [isProcessing, processTurn, exit, restart, openResumePicker, pushBlock],
  );

  // ask_user (C7): the question in the transcript, the options as a dropdown, and free text always.
  useEffect(() => {
    setAskUserHandler(async (question, options, signal) => {
      pushBlock([infoLine(`The model asks: ${question}`)]);
      const TYPED = '__o4c_typed__';
      if (options.length > 0) {
        const picked = await pickChoice('Answer (↑/↓, Enter; Esc = no answer):', [
          ...options.map((o, i) => ({ key: String(i), label: o })),
          { key: TYPED, label: 'Something else - type my own answer' },
        ]);
        if (picked === undefined) return undefined;
        if (picked !== TYPED) {
          const answer = options[Number(picked)];
          pushBlock([userLine(answer ?? '')]);
          return answer;
        }
      }
      pushBlock([infoLine('Type your answer and press Enter.')]);
      return new Promise<string | undefined>((resolve) => {
        askUserPendingRef.current = resolve;
        signal?.addEventListener('abort', () => {
          if (askUserPendingRef.current === resolve) askUserPendingRef.current = undefined;
          resolve(undefined);
        }, { once: true });
      });
    });
    return () => setAskUserHandler(undefined);
  }, [pushBlock, pickChoice]);

  // Ctrl+Q (C6): queue a message to run as its own turn after the current one, instead of steering.
  const handleQueue = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text) return;
      if (!isProcessing) {
        setIsProcessing(true);
        void processTurn(text);
        return;
      }
      queuedInputsRef.current.push(text);
      setQueuedPreview([...queuedInputsRef.current]);
    },
    [isProcessing, processTurn],
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
  const soleMatch = familyTyped ? matchCommands(familyTyped, mcpCommands) : [];
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
    ? commandFamily(familyBare, mcpCommands)
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
    !choicePicker &&
    !thinkScopePicker &&
    !stopConfirm &&
    !clearConfirm &&
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

  const paletteMatches = isComposingCommand(inputValue) ? matchCommands(inputValue, mcpCommands) : [];
  const paletteOpen =
    !paletteDismissed &&
    !confirmDialog &&
    !resumePicker &&
    !modePicker &&
    !viewPicker &&
    !choicePicker &&
    !thinkScopePicker &&
    !stopConfirm &&
    !clearConfirm &&
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
          <Box key={block.id} flexDirection="column" marginBottom={block.flow ? 0 : blockGap}>
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
      {/* Not while a write_file/run_shell confirmation is open: that box arrives mid-turn, so
          isThinking is still true, but nothing is running until the user answers (NextUp item
          41). The "Stop now?" box is different - the model keeps working behind it. */}
      {isThinking && !confirmDialog && (
        <Spinner
          label={
            toolProgress
              ? `Writing the ${toolProgress.name} call... ${toolProgress.chars.toLocaleString('en-US')} characters`
              : (serverStatusLine ?? undefined)
          }
        />
      )}
      <InputBox
        disabled={isProcessing}
        onQueue={handleQueue}
        active={!confirmDialog && !stopConfirm && !clearConfirm && !serverWait && !resumePicker && !modePicker && !thinkPicker && !thinkScopePicker && !viewPicker && !choicePicker}
        suppressNav={paletteOpen || familyOpen}
        mouse={mouseOn}
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
      {/* E6: files matching the @mention being typed; Tab takes the first. */}
      {mentionChoices.length > 0 ? (
        <Text color={theme.border}>
          {'  @ '}
          {mentionChoices.join('   ')}
          {'  (Tab completes)'}
        </Text>
      ) : null}
      {/* Three footer lines, grouped by how fast each one changes: what is live (mode, hints,
          think level, context fill, clock), what accumulates (tokens), and what holds still for
          the session (model, branch, directory). Front-end plan item #8 put context
          max/current/%used on the Mode line; the hint line that used to sit last is now folded
          into it. */}
      <StatusBar loop={loop} usage={usageStore} contextWindow={contextWindow} liveText={textWindow.live} mode={mode} busy={isProcessing} />
      <UsageBar loop={loop} usage={usageStore} busy={isProcessing} sessionView={shownSessionView} thinkLevel={shownThinkLevel} />
      <ProjectBar model={model} branch={gitBranch} dirty={gitDirty} project={projectLabelText} />
      {confirmDialog ? (
        <ConfirmDialog
          key={confirmDialog.id}
          message={confirmDialog.message}
          diff={confirmDialog.diff}
          onResolve={(ok) => handleConfirmChoice(ok ? 'yes' : 'no')}
          onChoice={handleConfirmChoice}
          alwaysLabel={confirmDialog.alwaysLabel}
          onEscape={abortTurn}
        />
      ) : stopConfirm ? (
        <ConfirmDialog
          key="stop-confirm"
          message="Stop now?"
          yesNote="this stops the current process"
          onResolve={handleStopResolve}
        />
      ) : clearConfirm ? (
        <ConfirmDialog
          key="clear-confirm"
          message="Clear the session and start fresh?"
          yesNote="the session is saved first and stays resumable via /resume"
          onResolve={handleClearResolve}
        />
      ) :serverWait ? (
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
      ) : choicePicker ? (
        <SelectList
          key={choicePicker.id}
          items={choicePicker.rows}
          getKey={(r) => r.key}
          title={choicePicker.title}
          borderColor={highlightColor}
          onSelect={handleChoiceSelect}
          onCancel={handleChoiceCancel}
          rowText={(r) => r.label}
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
