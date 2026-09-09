import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { InputBox } from './InputBox.js';
import { formatEvent } from './formatEvent.js';
import { formatError } from './formatError.js';
import { formatDebugView } from './formatDebug.js';
import type { AgentLoop } from '../agent/loop.js';

export interface AppProps {
  loop: AgentLoop;
  initialImage?: string;
}

type LineKind = 'system' | 'user' | 'tool_call' | 'tool_result' | 'final' | 'error';

interface Line {
  kind: LineKind;
  text: string;
}

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

export function App({ loop, initialImage }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<HistoryBlock[]>([
    {
      id: nextBlockId++,
      lines: [
        {
          kind: 'system',
          text: 'o4c interactive session. Type your request, /clear to clear history, /debug to inspect raw data (Esc to exit), /exit to quit.',
        },
      ],
    },
  ]);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [queuedPreview, setQueuedPreview] = useState<string[]>([]);

  // FIFO queue: you can type ahead and submit (more than once) while busy instead of
  // being locked out - every submission while processing is kept, in order, and runs
  // automatically once the current turn finishes, one at a time. A ref (not state)
  // since it's read/written from inside the async turn-processing function itself,
  // not something that drives render on its own - queuedPreview mirrors it for display.
  const queuedInputsRef = useRef<string[]>([]);

  useInput(
    (_input, key) => {
      if (key.escape) setDebugMode(false);
    },
    { isActive: debugMode },
  );

  const pushBlock = useCallback((lines: Line[]) => {
    setHistory((h) => [...h, { id: nextBlockId++, lines }]);
  }, []);

  const processTurn = useCallback(
    async (input: string) => {
      if (input === '/exit' || input === '/quit') {
        exit();
        return;
      }
      if (input === '/debug') {
        setDebugMode(true);
        return;
      }
      if (input === '/clear') {
        loop.reset();
        pushBlock([
          { kind: 'user', text: `> ${input}` },
          { kind: 'system', text: 'History cleared.' },
        ]);
      } else {
        // Echo the user's own line immediately, as its own permanent block - don't
        // wait for the (possibly very long) response before it shows up in scrollback.
        pushBlock([{ kind: 'user', text: `> ${input}` }]);

        const responseLines: Line[] = [];
        setLiveLines([]);

        try {
          const finalAnswer = await loop.run(input, {
            images: initialImage ? [initialImage] : undefined,
            onEvent: (event) => {
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
    [loop, initialImage, exit, pushBlock],
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      const input = raw.trim();
      if (!input) return;

      if (isProcessing) {
        queuedInputsRef.current.push(input);
        setQueuedPreview([...queuedInputsRef.current]);
        return;
      }

      setIsProcessing(true);
      void processTurn(input);
    },
    [isProcessing, processTurn],
  );

  if (debugMode) {
    const maxLines = Math.max(10, (process.stdout.rows ?? 24) - 4);
    const debugLines = formatDebugView(loop.getMessages(), maxLines);
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          --- raw session data (Esc to exit) ---
        </Text>
        {debugLines.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    );
  }

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
      <InputBox disabled={isProcessing} onSubmit={handleSubmit} />
      {queuedPreview.map((q, i) => (
        <Text key={i} dimColor>
          Queued #{i + 1}: {q}
        </Text>
      ))}
    </Box>
  );
}
