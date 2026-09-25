import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { InputBox } from './InputBox.js';
import { SessionPicker } from './SessionPicker.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CommandPalette } from './CommandPalette.js';
import { ModePicker } from './ModePicker.js';
import { CommandFamilyPicker } from './CommandFamilyPicker.js';
import { MODES, classifyToolAccess, modeInfo, type Mode } from './modePolicy.js';
import { formatEvent } from './formatEvent.js';
import { formatError } from './formatError.js';
import { formatMessage } from './formatMessage.js';
import { renderKeyboardCommandsHelp } from './keyboardCommandsHelp.js';
import { parseOsArg } from './osKeyboardNotes.js';
import { detectCurrentOs } from './platform.js';
import type { Line } from './types.js';
import { AbortedError, type AgentLoop, type AgentEvent } from '../agent/loop.js';
import type { SessionStore, SessionMeta } from '../session/sessionStore.js';
import type { RunLogger } from '../session/runLog.js';
import type { Tool } from '../tools/types.js';
import type { Message } from '../providers/types.js';
import {
  KNOWN_COMMANDS,
  looksLikeSlashCommand,
  isComposingCommand,
  matchCommands,
  commandName,
  setCommands,
  configCommands,
  type CommandInfo,
} from './slashCommand.js';

export interface AppProps {
  loop: AgentLoop;
  initialImage?: string;
  sessionStore: SessionStore;
  runLogger: RunLogger;
  /** Set by cli.ts when this process was launched with `--resume <id>` - seeds the visible
   * scrollback and currentSessionIdRef on mount, since a fresh process handoff (see `restart`
   * below) never gets a chance to append it mid-session. */
  initialSession?: { id: string; title: string; messages: Message[]; inputHistory?: string[] };
  /** Requests that /clear, /wipe or /resume hand off to a brand-new process instead of resetting
   * state in-place - see cli.ts's spawnRestart for why. Call this, then exit() (as /exit does),
   * never both without the other: cli.ts only spawns the replacement after this process's Ink
   * instance has actually unmounted. */
  restart: (resumeId?: string) => void;
}

// Above this many tool_call/tool_result events in a single turn, further ones collapse into a
// single running summary line instead of each getting its own displayed line - a codebase-
// exploration turn that reads dozens of files would otherwise flood both the live region and
// the permanent scrollback. The full, untruncated event stream is always written to the run log
// regardless of this cap.
const MAX_VISIBLE_TOOL_EVENTS_PER_TURN = 10;

interface HistoryBlock {
  id: number;
  lines: Line[];
}

let nextBlockId = 0;
let nextPrefillToken = 0;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color="cyan">
      {SPINNER_FRAMES[frame]} Thinking...
    </Text>
  );
}

function LineText({ line }: { line: Line }) {
  switch (line.kind) {
    case 'user':
      return (
        <Text bold color="cyan">
          {line.text}
        </Text>
      );
    case 'tool_call':
    case 'tool_result':
      return <Text dimColor>{line.text}</Text>;
    case 'final':
      return <Text bold>{line.text}</Text>;
    case 'error':
      return <Text color="red">{line.text}</Text>;
    default:
      return <Text dimColor>{line.text}</Text>;
  }
}

export function App({ loop, initialImage, sessionStore, runLogger, initialSession, restart }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<HistoryBlock[]>(() => {
    const banner: HistoryBlock = {
      id: nextBlockId++,
      lines: [
        {
          kind: 'system',
          text: 'o4c interactive session. Type your request, or / to see available commands.',
        },
      ],
    };
    if (!initialSession) return [banner];
    const blocks: HistoryBlock[] = [
      banner,
      { id: nextBlockId++, lines: [{ kind: 'system', text: `Resumed session: ${initialSession.title}` }] },
    ];
    const restoredLines = initialSession.messages.flatMap(formatMessage);
    if (restoredLines.length > 0) blocks.push({ id: nextBlockId++, lines: restoredLines });
    return blocks;
  });
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Separate from isProcessing (which covers the whole turn, including waiting on /resume's
  // picker or /wipe's confirmations) - this is only true while an actual LLM call is in flight,
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
  // is; a fresh session (no initialSession, or /clear/wipe's restart with none) starts empty,
  // matching the conversation itself also starting empty.
  const inputHistoryRef = useRef<string[]>(initialSession?.inputHistory ?? []);
  const handleInputHistoryChange = useCallback((history: string[]) => {
    inputHistoryRef.current = history;
  }, []);

  // Non-null only while a turn's loop.run() call is actually in flight - lets Escape cancel it
  // (see handleEscape below). Null the rest of the time, so an Escape press with nothing running
  // is a safe no-op rather than needing its own isThinking check.
  const abortControllerRef = useRef<AbortController | null>(null);

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
  // (run_shell execution, write_file overwrite, /wipe). /wipe chains two of these in sequence by
  // calling askConfirm twice, awaiting each in turn - no special "double confirm" logic needed.
  // `id` exists purely to be passed as <ConfirmDialog>'s `key` (below) - without it, /wipe's two
  // sequential dialogs are the same component instance (no key change, same JSX type), so
  // ConfirmDialog's own internal `selected` state can carry over from the first dialog's "Yes"
  // into the second instead of resetting to its documented "always defaults to No" - previously
  // masked by exactly how React happened to batch the null-then-new setConfirmDialog calls
  // across the intervening microtask, which changed on the React 19 upgrade.
  const [confirmDialog, setConfirmDialog] = useState<{
    id: number;
    message: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const askConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmDialog({ id: nextBlockId++, message, resolve });
    });
  }, []);

  // Passed into loop.run() as RunOptions.toolPolicy - the current mode decides whether a
  // mutating tool call runs silently, needs a yes/no first (via the same ConfirmDialog /wipe
  // uses), or is refused outright (Plan Mode).
  const toolPolicy = useCallback(
    async (tool: Tool, input: Record<string, unknown>): Promise<'allow' | 'deny'> => {
      const access = classifyToolAccess(mode, tool);
      if (access === 'allow') return 'allow';
      if (access === 'deny') return 'deny';
      const ok = await askConfirm(`Allow ${tool.name}(${JSON.stringify(input)})?`);
      return ok ? 'allow' : 'deny';
    },
    [mode, askConfirm],
  );

  const pushBlock = useCallback((lines: Line[]) => {
    setHistory((h) => [...h, { id: nextBlockId++, lines }]);
  }, []);

  // Tab cycles through the 4 modes in order, in addition to (not instead of) /mode's picker - a
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
      // /exit and /quit are intercepted earlier, in handleSubmit, before they can ever be
      // queued behind a busy turn - they never reach here.
      if (input === '/clear') {
        // Handed off to a brand-new process (see AppProps.restart's doc comment) rather than
        // reset in-place - the only way to get a genuinely clear screen. The just-cleared
        // session's file (if it had been autosaved) is left alone on disk, resumable via /resume
        // - no resumeId is passed, so the new process starts with a brand-new session id instead
        // of overwriting that one.
        restart();
        setTimeout(() => exit(), 0);
      } else if (input === '/resume') {
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
      } else if (input === '/wipe') {
        pushBlock([{ kind: 'user', text: `> ${input}` }]);
        if (!currentSessionIdRef.current) {
          pushBlock([{ kind: 'system', text: 'Nothing to wipe - no session has been saved yet.' }]);
        } else {
          const firstOk = await askConfirm(
            'This will permanently delete this session and remove it from /resume. This cannot be undone. Continue?',
          );
          if (!firstOk) {
            pushBlock([{ kind: 'system', text: 'Wipe cancelled.' }]);
          } else {
            const secondOk = await askConfirm(
              'Are you absolutely sure? This is the last chance to cancel.',
            );
            if (!secondOk) {
              pushBlock([{ kind: 'system', text: 'Wipe cancelled.' }]);
            } else {
              await sessionStore.delete(currentSessionIdRef.current);
              restart();
              setTimeout(() => exit(), 0);
            }
          }
        }
      } else if (input === '/context' || input === '/ctx') {
        const usage = loop.getUsage();
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const text = [
          'Session usage (local only, no LLM call):',
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
        setLiveLines([]);
        setIsThinking(true);
        let toolEventCount = 0;
        let summaryLine: Line | undefined;

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
          const finalAnswer = await loop.run(input, {
            images: initialImage ? [initialImage] : undefined,
            toolPolicy,
            signal: controller.signal,
            onEvent: (event: AgentEvent) => {
              // The full, untruncated event always goes to the run log, regardless of what (or
              // whether) anything gets displayed - fire-and-forget, a logging failure shouldn't
              // interrupt the turn.
              void runLogger.log({ event });

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
                setLiveLines((prev) => [...prev.filter((l) => !l.startsWith('[scan] ')), text]);
                return;
              }

              const text = formatEvent(event);
              if (!text) return;
              setLiveLines((prev) => [...prev, text]);
              // Intermediate narration ("text" events) is shown live only - the
              // final answer is committed separately below, exactly once, avoiding
              // the duplicate-display bug this used to have.
              if (event.type === 'tool_call' || event.type === 'tool_result') {
                responseLines.push({ kind: event.type, text });
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
          abortControllerRef.current = null;
          if (responseLines.length > 0) pushBlock(responseLines);
          setLiveLines([]);
          setIsThinking(false);

          // Autosave after every completed turn, success or error - even a failed turn already
          // pushed the user's message into loop's history (AgentLoop.run pushes it before calling
          // the provider), so it's worth persisting rather than losing on a crash or network error.
          const messages = loop.getMessages();
          if (messages.length > 0) {
            try {
              currentSessionIdRef.current = await sessionStore.save(
                messages,
                currentSessionIdRef.current,
                inputHistoryRef.current,
              );
            } catch (saveErr) {
              pushBlock([{ kind: 'error', text: `Warning: failed to save session: ${formatError(saveErr)}` }]);
            }
          }
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
    [loop, initialImage, pushBlock, sessionStore, askConfirm, toolPolicy],
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

      if (isProcessing) {
        queuedInputsRef.current.push(input);
        setQueuedPreview([...queuedInputsRef.current]);
        return;
      }

      setIsProcessing(true);
      void processTurn(input);
    },
    [isProcessing, processTurn, exit],
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
      <Static items={history}>
        {(block) => (
          <Box key={block.id} flexDirection="column" marginBottom={1}>
            {block.lines.map((line, i) => (
              <LineText key={i} line={line} />
            ))}
          </Box>
        )}
      </Static>
      {isThinking &&
        liveLines.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      {isThinking && <Spinner />}
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
      {confirmDialog ? (
        <ConfirmDialog key={confirmDialog.id} message={confirmDialog.message} onResolve={handleConfirmResolve} />
      ) : resumePicker ? (
        <SessionPicker
          sessions={resumePicker.sessions}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      ) : modePicker ? (
        <ModePicker currentMode={mode} onSelect={handleModePickerSelect} onCancel={handleModePickerCancel} />
      ) : setPicker ? (
        <CommandFamilyPicker
          title="Choose a setting (↑/↓ to choose, Enter to select, Esc to cancel):"
          commands={setCommands()}
          onSelect={handleSetPickerSelect}
          onCancel={handleSetPickerCancel}
        />
      ) : setFamilyOpen ? (
        <CommandFamilyPicker
          title="Matching /set-* commands (↑/↓ to choose, Enter to select, Esc to dismiss):"
          commands={setFamilyMatches}
          onSelect={handleSetFamilySelect}
          onCancel={handlePaletteCancel}
        />
      ) : configPicker ? (
        <CommandFamilyPicker
          title="Choose a setting (↑/↓ to choose, Enter to select, Esc to cancel):"
          commands={configCommands()}
          onSelect={handleConfigPickerSelect}
          onCancel={handleConfigPickerCancel}
        />
      ) : configFamilyOpen ? (
        <CommandFamilyPicker
          title="Matching /config-* commands (↑/↓ to choose, Enter to select, Esc to dismiss):"
          commands={configFamilyMatches}
          onSelect={handleConfigFamilySelect}
          onCancel={handlePaletteCancel}
        />
      ) : paletteOpen ? (
        <CommandPalette commands={paletteMatches} onSelect={handlePaletteSelect} onCancel={handlePaletteCancel} />
      ) : null}
      {queuedPreview.map((q, i) => (
        <Text key={i} dimColor>
          Queued #{i + 1}: {q}
        </Text>
      ))}
    </Box>
  );
}
