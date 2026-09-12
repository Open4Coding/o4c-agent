import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import { InputBox } from './InputBox.js';
import { SessionPicker } from './SessionPicker.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CommandPalette } from './CommandPalette.js';
import { formatEvent } from './formatEvent.js';
import { formatError } from './formatError.js';
import { formatMessage } from './formatMessage.js';
import type { Line } from './types.js';
import type { AgentLoop, AgentEvent } from '../agent/loop.js';
import type { SessionStore, SessionMeta } from '../session/sessionStore.js';
import type { RunLogger } from '../session/runLog.js';
import {
  KNOWN_COMMANDS,
  looksLikeSlashCommand,
  isComposingCommand,
  matchCommands,
  commandName,
  type CommandInfo,
} from './slashCommand.js';

export interface AppProps {
  loop: AgentLoop;
  initialImage?: string;
  sessionStore: SessionStore;
  runLogger: RunLogger;
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

export function App({ loop, initialImage, sessionStore, runLogger }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<HistoryBlock[]>([
    {
      id: nextBlockId++,
      lines: [
        {
          kind: 'system',
          text: 'o4c interactive session. Type your request, or / to see available commands.',
        },
      ],
    },
  ]);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
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
  // turn autosaves successfully; reused on every subsequent save so it updates in place rather
  // than creating a new session file per turn.
  const currentSessionIdRef = useRef<string | undefined>(undefined);

  // Non-null while /resume's picker is showing. `resolve` is the pending Promise's resolver
  // that processTurn is awaiting on - selecting or cancelling calls it, which is what lets
  // processTurn pause mid-turn for the picker and then continue afterward, without restructuring
  // the existing async control flow.
  const [resumePicker, setResumePicker] = useState<{
    sessions: SessionMeta[];
    resolve: (id: string | undefined) => void;
  } | null>(null);

  // Same pending-Promise-resolver pattern as resumePicker, generic to any yes/no confirmation
  // (run_shell execution, write_file overwrite, /wipe). /wipe chains two of these in sequence by
  // calling askConfirm twice, awaiting each in turn - no special "double confirm" logic needed.
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  const askConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmDialog({ message, resolve });
    });
  }, []);

  const pushBlock = useCallback((lines: Line[]) => {
    setHistory((h) => [...h, { id: nextBlockId++, lines }]);
  }, []);

  const processTurn = useCallback(
    async (input: string) => {
      // /exit and /quit are intercepted earlier, in handleSubmit, before they can ever be
      // queued behind a busy turn - they never reach here.
      if (input === '/clear') {
        loop.reset();
        // The just-cleared session's file (if it had been autosaved) is left alone on disk,
        // resumable via /resume - only the in-memory pointer to it is dropped, so the next
        // message starts a brand-new session id instead of overwriting that one.
        currentSessionIdRef.current = undefined;
        pushBlock([
          { kind: 'user', text: `> ${input}` },
          { kind: 'system', text: 'History cleared.' },
        ]);
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
            const data = await sessionStore.load(chosenId);
            if (data) {
              loop.loadMessages(data.messages);
              currentSessionIdRef.current = data.id;
              pushBlock([{ kind: 'system', text: `Resumed session: ${data.title}` }]);
              // Restore the visible scrollback too - loadMessages only restores the model's
              // own memory, so without this the screen stays blank even though the loop
              // already has full context (this was the actual bug: /resume "worked" in that
              // later questions were answered correctly, but the prior conversation never
              // reappeared on screen).
              const restoredLines = data.messages.flatMap(formatMessage);
              if (restoredLines.length > 0) pushBlock(restoredLines);
            } else {
              pushBlock([
                { kind: 'error', text: 'Failed to load that session (it may have been removed).' },
              ]);
            }
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
              loop.reset();
              currentSessionIdRef.current = undefined;
              pushBlock([{ kind: 'system', text: 'Session permanently deleted.' }]);
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
        let toolEventCount = 0;
        let summaryLine: Line | undefined;

        try {
          const finalAnswer = await loop.run(input, {
            images: initialImage ? [initialImage] : undefined,
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
          responseLines.push({ kind: 'error', text: formatError(err) });
        } finally {
          if (responseLines.length > 0) pushBlock(responseLines);
          setLiveLines([]);

          // Autosave after every completed turn, success or error - even a failed turn already
          // pushed the user's message into loop's history (AgentLoop.run pushes it before calling
          // the provider), so it's worth persisting rather than losing on a crash or network error.
          const messages = loop.getMessages();
          if (messages.length > 0) {
            try {
              currentSessionIdRef.current = await sessionStore.save(messages, currentSessionIdRef.current);
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
    [loop, initialImage, pushBlock, sessionStore, askConfirm],
  );

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

  const paletteMatches = isComposingCommand(inputValue) ? matchCommands(inputValue) : [];
  const paletteOpen = !paletteDismissed && !confirmDialog && !resumePicker && paletteMatches.length > 0;

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
      {isProcessing &&
        liveLines.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      {isProcessing && <Spinner />}
      <InputBox
        disabled={isProcessing}
        active={!confirmDialog && !resumePicker}
        suppressNav={paletteOpen}
        onChange={handleInputChange}
        resetToken={inputResetToken}
        onSubmit={handleSubmit}
      />
      {confirmDialog ? (
        <ConfirmDialog message={confirmDialog.message} onResolve={handleConfirmResolve} />
      ) : resumePicker ? (
        <SessionPicker
          sessions={resumePicker.sessions}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
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
