import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { InputBox } from './InputBox.js';
import { SessionPicker } from './SessionPicker.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CommandPalette } from './CommandPalette.js';
import { ModePicker } from './ModePicker.js';
import { CommandFamilyPicker } from './CommandFamilyPicker.js';
import { MODES, classifyToolAccess, modeInfo, modeSystemPrompt, type Mode } from './modePolicy.js';
import { plansDirFor } from '../session/projectContext.js';
import { formatEvent } from './formatEvent.js';
import { formatError } from './formatError.js';
import { formatMessage } from './formatMessage.js';
import { renderKeyboardCommandsHelp } from './keyboardCommandsHelp.js';
import { parseOsArg } from './osKeyboardNotes.js';
import { detectCurrentOs } from './platform.js';
import type { Line } from './types.js';
import { initialTextWindow, makeBlock, textWindowReducer, type TextBlock } from './textWindow.js';
import { theme } from './theme.js';
import { formatTokenCount, formatElapsed, renderProgressBar, progressBarFilledCells } from './statusBar.js';
import { AbortedError, type AgentLoop, type AgentEvent } from '../agent/loop.js';
import type { SessionStore, SessionMeta } from '../session/sessionStore.js';
import type { RunLogger } from '../session/runLog.js';
import { ConfigStore, type ConfigScope } from '../session/configStore.js';
import { HIGHLIGHT_COLOR_NAMES, isValidHighlightColor, resolveHighlightColor } from './highlightColor.js';
import { buildSplashText } from './splash.js';
import type { Tool } from '../tools/types.js';
import type { Message } from '../providers/types.js';
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
  initialSession?: { id: string; title: string; messages: Message[]; inputHistory?: string[] };
  /** Requests that /clear or /resume hand off to a brand-new process instead of resetting
   * state in-place - see cli.ts's spawnRestart for why. Call this, then exit() (as /exit does),
   * never both without the other: cli.ts only spawns the replacement after this process's Ink
   * instance has actually unmounted. */
  restart: (resumeId?: string) => void;
  /** Undefined for an untrusted/no-project run. Only consulted to scope Plan-Write mode's
   * write_file exception to `.o4c/plans/` - see modePolicy.ts's classifyToolAccess. */
  projectRoot?: string;
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
const MAX_VISIBLE_TOOL_EVENTS_PER_TURN = 10;

let nextPrefillToken = 0;
// Unrelated to the text window's own block ids (textWindow.ts owns those internally now) - just a
// second, independent React-key source for ConfirmDialog instances.
let nextDialogId = 0;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
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
  model,
  contextWindow,
  liveText,
}: {
  loop: AgentLoop;
  model: string;
  contextWindow?: number;
  /** The text currently streaming in (`textWindow.live`), not yet a committed `ContextEntry` -
   * real bug found via direct user report: without this, the bar sat frozen at its pre-turn value
   * for a response's entire generation time (`getVisibleTokenEstimate()` only updates once an
   * entry is appended, which happens after a call fully completes, not as it streams), making a
   * long turn look exactly like a hang even when it wasn't one. Included in the token count and
   * fill fraction below as a rough estimate (chars/4, same heuristic `estimateTokens()` uses),
   * never persisted anywhere - purely a live display adjustment. */
  liveText: readonly string[];
}) {
  const [, tick] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const liveTokens = Math.ceil(liveText.join('').length / 4);
  const tokens = loop.getVisibleTokenEstimate() + liveTokens;
  const fraction = contextWindow ? tokens / contextWindow : undefined;
  const elapsed = formatElapsed(Date.now() - startRef.current);

  return (
    <Text>
      <Text color={theme.accent}>◆ {model}</Text>
      <Text color={theme.border}> | </Text>
      <Text color={theme.text}>
        {formatTokenCount(tokens)}
        {contextWindow ? `/${formatTokenCount(contextWindow)}` : ''}
      </Text>
      {fraction !== undefined && (
        <Text>
          {' ['}
          <Text color={theme.warn}>{'█'.repeat(progressBarFilledCells(fraction))}</Text>
          <Text color={theme.border}>{'░'.repeat(10 - progressBarFilledCells(fraction))}</Text>
          {'] '}
          <Text color={theme.text}>{Math.round(fraction * 100)}%</Text>
        </Text>
      )}
      <Text color={theme.border}> | </Text>
      <Text color={theme.text}>{elapsed}</Text>
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
        <Text bold color={theme.text}>
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
  projectRoot,
  model,
  provider,
  baseUrl,
  contextWindow,
  maxIterations,
  initialHighlightColor,
  configGlobalDir,
}: AppProps) {
  const { exit } = useApp();
  const plansDir = plansDirFor(projectRoot);
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
    if (!initialSession) return initialTextWindow([banner]);
    const blocks: TextBlock[] = [
      banner,
      makeBlock(id++, [{ kind: 'system', text: `Resumed session: ${initialSession.title}` }]),
    ];
    const restoredLines = initialSession.messages.flatMap(formatMessage);
    if (restoredLines.length > 0) blocks.push(makeBlock(id++, restoredLines));
    return initialTextWindow(blocks);
  });
  const [isProcessing, setIsProcessing] = useState(false);
  // Separate from isProcessing (which covers the whole turn, including waiting on /resume's
  // picker or a write_file/run_shell confirmation) - this is only true while an actual LLM call
  // is in flight,
  // so the "Thinking..." spinner doesn't run during a turn that's really just waiting on the user.
  const [isThinking, setIsThinking] = useState(false);
  const [queuedPreview, setQueuedPreview] = useState<string[]>([]);

  // Drives the "/" command palette - mirrors InputBox's own text (InputBox owns the actual
  // value/cursor state; this is just what App needs to decide whether the palette should be
  // showing and what to filter it by). Reset any time the palette is explicitly dismissed via
  // Esc, and un-dismissed again the moment the user types anything further - matching a normal
  // dropdown-menu feel rather than a one-time popup.
  const [inputValue, setInputValue] = useState('');
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
  const [mode, setMode] = useState<Mode>('manual');
  // Same pending-Promise-resolver pattern as resumePicker, for the /mode command's picker.
  const [modePicker, setModePicker] = useState<{ resolve: (m: Mode | undefined) => void } | null>(
    null,
  );

  // Same pending-Promise-resolver pattern as resumePicker, for /set's picker. Resolves to the
  // chosen command, not a result of running it - /set itself decides what "chosen" means
  // (prefilling the input box, below).
  const [setPicker, setSetPicker] = useState<{
    resolve: (command: CommandInfo | undefined) => void;
  } | null>(null);

  // /config's own picker (#6) - the plugin-config counterpart to setPicker above, identical
  // shape (see CommandFamilyPicker.tsx, shared between both).
  const [configPicker, setConfigPicker] = useState<{
    resolve: (command: CommandInfo | undefined) => void;
  } | null>(null);

  // Bumping the token replaces InputBox's text with `text` (cursor at the end) without
  // submitting - how /set hands a chosen command like `/set-sessionname` back to the user to
  // finish typing its argument onto, rather than auto-submitting the way a plain palette
  // selection does (existing commands all take no arguments, so that never needed this).
  const [prefill, setPrefill] = useState<{ token: number; text: string } | undefined>(undefined);

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
      const ok = await askConfirm(`Allow ${tool.name}(${JSON.stringify(input)})?`, tool, input);
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
      if (input === '/resume') {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        const sessions = await sessionStore.readManifest();
        if (sessions.length === 0) {
          pushBlock([{ kind: 'system', text: 'No saved sessions to resume.' }]);
        } else {
          const chosenId = await new Promise<string | undefined>((resolve) => {
            setResumePicker({ sessions, resolve });
          });
          if (chosenId) {
            // Handed off to a brand-new process, started with `--resume <chosenId>` - it loads
            // and displays that session's history itself, before its first render, instead of
            // this process appending it mid-session (see AppProps.restart's doc comment).
            restart(chosenId);
            setTimeout(() => exit(), 0);
          } else {
            pushBlock([{ kind: 'system', text: 'Resume cancelled.' }]);
          }
        }
      } else if (input === '/context' || input === '/ctx') {
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
          { kind: 'user', text: `> ${input}` },
          { kind: 'system', text },
        ]);
      } else if (commandName(input) === '/keyboardcommands') {
        // Local, display-only, exactly like /context above - never calls loop.run(), so this
        // table is never sent to the model or added to conversation history (see the module's
        // own doc comment for why that matters for a later, currently out-of-scope feature -
        // docs/plans/0001.FrontEndIDEChanges.checklist.md #16, "infinite context window").
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        const osArg = input.slice(commandName(input).length).trim();
        if (!osArg) {
          pushBlock([{ kind: 'system', text: renderKeyboardCommandsHelp(undefined, detectCurrentOs()) }]);
        } else {
          const parsed = parseOsArg(osArg);
          if (!parsed) {
            pushBlock([{ kind: 'error', text: 'Usage: /keyboardcommands [windows|mac|linux]' }]);
          } else {
            pushBlock([{ kind: 'system', text: renderKeyboardCommandsHelp(undefined, parsed) }]);
          }
        }
      } else if (input === '/mode') {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        const chosen = await new Promise<Mode | undefined>((resolve) => {
          setModePicker({ resolve });
        });
        if (chosen) {
          setMode(chosen);
          pushBlock([{ kind: 'system', text: `Mode set to ${modeInfo(chosen).label}.` }]);
        } else {
          pushBlock([{ kind: 'system', text: 'Mode unchanged.' }]);
        }
      } else if (input === '/set') {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        const commands = setCommands();
        if (commands.length === 0) {
          pushBlock([{ kind: 'system', text: 'Nothing to set yet.' }]);
        } else {
          const chosen = await new Promise<CommandInfo | undefined>((resolve) => {
            setSetPicker({ resolve });
          });
          if (chosen) {
            // Prefills rather than auto-submitting (unlike a plain palette selection) - every
            // /set-* command takes an argument the picker itself has no way to collect.
            setPrefill({ token: nextPrefillToken++, text: `${chosen.name} ` });
          } else {
            pushBlock([{ kind: 'system', text: 'Set cancelled.' }]);
          }
        }
      } else if (input === '/config') {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        const commands = configCommands();
        if (commands.length === 0) {
          pushBlock([{ kind: 'system', text: 'Nothing to configure yet.' }]);
        } else {
          const chosen = await new Promise<CommandInfo | undefined>((resolve) => {
            setConfigPicker({ resolve });
          });
          if (chosen) {
            // Prefills rather than auto-submitting, same reason as /set's picker above - every
            // /config-* command takes an argument the picker itself has no way to collect.
            setPrefill({ token: nextPrefillToken++, text: `${chosen.name} ` });
          } else {
            pushBlock([{ kind: 'system', text: 'Config cancelled.' }]);
          }
        }
      } else if (
        commandName(input) === '/config-highlightcolor' ||
        commandName(input) === '/config-local-highlightcolor' ||
        commandName(input) === '/config-global-highlightcolor'
      ) {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
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
            pushBlock([{ kind: 'system', text: `Highlight color set to ${color} (${scope}).` }]);
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (commandName(input) === '/set-sessionname') {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        const newName = input.slice(commandName(input).length).trim();
        if (!currentSessionIdRef.current) {
          pushBlock([
            {
              kind: 'system',
              text: 'No active session yet - send a message first, then /set-sessionname <name>.',
            },
          ]);
        } else if (!newName) {
          pushBlock([{ kind: 'error', text: 'Usage: /set-sessionname <name>' }]);
        } else {
          try {
            await sessionStore.rename(currentSessionIdRef.current, newName);
            pushBlock([{ kind: 'system', text: `Session renamed to "${newName}".` }]);
          } catch (err) {
            pushBlock([{ kind: 'error', text: formatError(err) }]);
          }
        }
      } else if (input === '/help') {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        const lines = COMMANDS.map(
          (c) => `${c.name}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''} — ${c.description}`,
        );
        pushBlock([
          {
            kind: 'system',
            text: [
              'Available commands:',
              ...lines,
              '',
              'Use /help-<command> for more detail on one, e.g. /help-mode.',
            ].join('\n'),
          },
        ]);
        void runLogger.log({ type: 'system', sub_type: 'info', command: '/help' });
      } else if (commandName(input).startsWith('/help-')) {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
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
          pushBlock([{ kind: 'system', text: detailLines.join('\n') }]);
          void runLogger.log({ type: 'system', sub_type: 'info', command: `/help-${rest}` });
        }
      } else if (looksLikeSlashCommand(input) && !KNOWN_COMMANDS.includes(commandName(input))) {
        pushBlock([
          { kind: 'user', text: `> ${input}` },
          {
            kind: 'error',
            text: `Unknown command: ${commandName(input)}. Known commands: ${KNOWN_COMMANDS.join(', ')}.`,
          },
        ]);
      } else {
        // Echo the user's own line immediately, as its own permanent block - don't
        // wait for the (possibly very long) response before it shows up in scrollback.
        pushBlock([{ kind: 'user', text: `> ${input}` }]);

        const responseLines: Line[] = [];
        dispatchTextWindow({ type: 'clearLive' });
        setIsThinking(true);
        let toolEventCount = 0;
        let summaryLine: Line | undefined;
        lastDeltaKindRef.current = null;

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
            maxIterations,
            // The full request/response wire transcript - "the sends", distinct from onEvent's
            // already-derived AgentEvent stream below (which only ever carries the *response*
            // side, split/reshaped for display). Fire-and-forget, same reasoning as runLogger's
            // own calls: a logging failure must never interrupt the turn itself.
            onProviderCall: (call) => {
              void fullContextLogger.log({ type: 'provider_call', ...call });
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
                  const startNewLine = lastDeltaKindRef.current !== kind;
                  lastDeltaKindRef.current = kind;
                  const text = startNewLine && kind === 'think' ? `[think] ${event.text}` : event.text;
                  dispatchTextWindow({ type: 'appendDelta', text, startNewLine });
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
              if (isToolEvent) toolEventCount += 1;

              if (isToolEvent && toolEventCount > MAX_VISIBLE_TOOL_EVENTS_PER_TURN) {
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

              // Already shown live via 'delta' events as they streamed in - re-appending the full,
              // final text here would duplicate it. Only skipped when `streamed` is actually true
              // though - a provider without onToken support (no real one lacks it, but a test
              // fake or a future one might) never emitted any 'delta' for this call, so this event
              // is the only place its content ever reaches the screen. The final answer is still
              // committed to scrollback separately below, exactly once ('think' entries never were).
              if ((event.type === 'think' || event.type === 'text') && event.streamed) return;

              const text = formatEvent(event);
              if (!text) return;
              dispatchTextWindow({ type: 'appendLive', text });
              if (event.type === 'tool_call' || event.type === 'tool_result') {
                responseLines.push({ kind: event.type, text });
              } else if (event.type === 'compaction') {
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
          if (finalAnswer) responseLines.push({ kind: 'final', text: finalAnswer });
        } catch (err) {
          if (err instanceof AbortedError) {
            // Escape while thinking: history was already rolled back inside loop.run() itself -
            // just put the prompt that started this turn back in the input box, unedited, so the
            // user can revise and resend it. Not an "error" line - a plain system note fits the
            // deliberate, expected nature of a cancellation better than the red error styling.
            responseLines.push({ kind: 'system', text: 'Cancelled - your message is back in the input box.' });
            setPrefill({ token: nextPrefillToken++, text: err.prompt });
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
          if (!stale) {
            if (responseLines.length > 0) pushBlock(responseLines);
            dispatchTextWindow({ type: 'clearLive' });
            setIsThinking(false);
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
            } catch (saveErr) {
              if (!stale) pushBlock([{ kind: 'error', text: `Warning: failed to save session: ${formatError(saveErr)}` }]);
            }
          }

          if (stale) return;
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
    [loop, initialImage, pushBlock, sessionStore, askConfirm, toolPolicy, mode, plansDir],
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

  const handleSetPickerSelect = useCallback(
    (command: CommandInfo) => {
      setPicker?.resolve(command);
      setSetPicker(null);
    },
    [setPicker],
  );

  const handleSetPickerCancel = useCallback(() => {
    setPicker?.resolve(undefined);
    setSetPicker(null);
  }, [setPicker]);

  const handleConfigPickerSelect = useCallback(
    (command: CommandInfo) => {
      configPicker?.resolve(command);
      setConfigPicker(null);
    },
    [configPicker],
  );

  const handleConfigPickerCancel = useCallback(() => {
    configPicker?.resolve(undefined);
    setConfigPicker(null);
  }, [configPicker]);

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
  const handleEscape = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

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
        restart();
        setTimeout(() => exit(), 0);
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
    [isProcessing, processTurn, exit, restart],
  );

  const handlePaletteSelect = useCallback(
    (command: CommandInfo) => {
      setInputValue('');
      setPaletteDismissed(false);
      setInputResetToken((t) => t + 1);
      handleSubmit(command.name);
    },
    [handleSubmit],
  );

  // Live version of what /set's own Enter-triggered picker does - typing "/set-" (not yet
  // submitted) reveals the same family list immediately, since matchCommands (by design) never
  // shows a hidden /set-* command even once its own prefix is fully typed, so without this the
  // palette would otherwise just show nothing for that input. Selecting an entry prefills the
  // input box, the same way /set's picker does, rather than submitting it - these commands all
  // take an argument. #6 (/config, per the checklist) needs the identical treatment for
  // "/config-" once it exists.
  const composingSetFamily = isComposingCommand(inputValue) && inputValue.toLowerCase().startsWith('/set-');
  const setFamilyMatches = composingSetFamily
    ? setCommands().filter((c) => c.name.toLowerCase().startsWith(inputValue.toLowerCase()))
    : [];
  const setFamilyOpen =
    !paletteDismissed &&
    !confirmDialog &&
    !resumePicker &&
    !modePicker &&
    !setPicker &&
    !configPicker &&
    setFamilyMatches.length > 0;

  const handleSetFamilySelect = useCallback((command: CommandInfo) => {
    setInputValue(`${command.name} `);
    setPrefill({ token: nextPrefillToken++, text: `${command.name} ` });
  }, []);

  // Live version of what /config's own Enter-triggered picker does - identical shape to
  // composingSetFamily/setFamilyOpen above, just for "/config-" (#6). setFamilyOpen and
  // configFamilyOpen can never both be true at once - inputValue can't start with both "/set-"
  // and "/config-" simultaneously - so neither needs to reference the other to stay mutually
  // exclusive; each only needs to exclude the *other's own* explicit picker state.
  const composingConfigFamily =
    isComposingCommand(inputValue) && inputValue.toLowerCase().startsWith('/config-');
  const configFamilyMatches = composingConfigFamily
    ? configCommands().filter((c) => c.name.toLowerCase().startsWith(inputValue.toLowerCase()))
    : [];
  const configFamilyOpen =
    !paletteDismissed &&
    !confirmDialog &&
    !resumePicker &&
    !modePicker &&
    !setPicker &&
    !configPicker &&
    configFamilyMatches.length > 0;

  const handleConfigFamilySelect = useCallback((command: CommandInfo) => {
    setInputValue(`${command.name} `);
    setPrefill({ token: nextPrefillToken++, text: `${command.name} ` });
  }, []);

  const paletteMatches = isComposingCommand(inputValue) ? matchCommands(inputValue) : [];
  const paletteOpen =
    !paletteDismissed &&
    !confirmDialog &&
    !resumePicker &&
    !modePicker &&
    !setPicker &&
    !configPicker &&
    !setFamilyOpen &&
    !configFamilyOpen &&
    paletteMatches.length > 0;

  return (
    <Box flexDirection="column">
      <Static items={textWindow.blocks as TextBlock[]}>
        {(block) => (
          <Box key={block.id} flexDirection="column" marginBottom={1}>
            {block.lines.map((line, i) => (
              <React.Fragment key={i}>
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
      <StatusBar loop={loop} model={model} contextWindow={contextWindow} liveText={textWindow.live} />
      <InputBox
        disabled={isProcessing}
        active={!confirmDialog && !resumePicker && !modePicker && !setPicker && !configPicker}
        suppressNav={paletteOpen || setFamilyOpen || configFamilyOpen}
        onChange={handleInputChange}
        resetToken={inputResetToken}
        prefill={prefill}
        onSubmit={handleSubmit}
        onEscape={handleEscape}
        initialHistory={initialSession?.inputHistory}
        onHistoryChange={handleInputHistoryChange}
      />
      <Text color={modeInfo(mode).color}>
        Mode: {modeInfo(mode).label}  (/mode or Tab to change)
      </Text>
      <Text color={theme.border}>Esc interrupt · type to queue · Ctrl+C reset</Text>
      {confirmDialog ? (
        <ConfirmDialog
          key={confirmDialog.id}
          message={confirmDialog.message}
          onResolve={handleConfirmResolve}
          onEscape={handleEscape}
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
      ) : setPicker ? (
        <CommandFamilyPicker
          title="Choose a setting (↑/↓ to choose, Enter to select, Esc to cancel):"
          commands={setCommands()}
          onSelect={handleSetPickerSelect}
          onCancel={handleSetPickerCancel}
          highlightColor={highlightColor}
        />
      ) : setFamilyOpen ? (
        <CommandFamilyPicker
          title="Matching /set-* commands (↑/↓ to choose, Enter to select, Esc to dismiss):"
          commands={setFamilyMatches}
          onSelect={handleSetFamilySelect}
          onCancel={handlePaletteCancel}
          highlightColor={highlightColor}
        />
      ) : configPicker ? (
        <CommandFamilyPicker
          title="Choose a setting (↑/↓ to choose, Enter to select, Esc to cancel):"
          commands={configCommands()}
          onSelect={handleConfigPickerSelect}
          onCancel={handleConfigPickerCancel}
          highlightColor={highlightColor}
        />
      ) : configFamilyOpen ? (
        <CommandFamilyPicker
          title="Matching /config-* commands (↑/↓ to choose, Enter to select, Esc to dismiss):"
          commands={configFamilyMatches}
          onSelect={handleConfigFamilySelect}
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
