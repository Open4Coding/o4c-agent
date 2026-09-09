import React, { useCallback, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import { InputBox } from './InputBox.js';
import { formatEvent } from './formatEvent.js';
import { formatError } from './formatError.js';
import type { AgentLoop } from '../agent/loop.js';

export interface AppProps {
  loop: AgentLoop;
  initialImage?: string;
}

interface HistoryBlock {
  id: number;
  lines: string[];
}

let nextBlockId = 0;

export function App({ loop, initialImage }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<HistoryBlock[]>([
    {
      id: nextBlockId++,
      lines: ['o4c interactive session. Type your request, or /clear to clear history, /exit to quit.'],
    },
  ]);
  const [liveLines, setLiveLines] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = useCallback(
    async (raw: string) => {
      const input = raw.trim();
      if (!input) return;

      if (input === '/exit' || input === '/quit') {
        exit();
        return;
      }
      if (input === '/clear') {
        loop.reset();
        setHistory((h) => [...h, { id: nextBlockId++, lines: [`> ${input}`, 'History cleared.'] }]);
        return;
      }

      const turnLines: string[] = [`> ${input}`];
      setLiveLines([]);
      setIsProcessing(true);

      try {
        const finalAnswer = await loop.run(input, {
          images: initialImage ? [initialImage] : undefined,
          onEvent: (event) => {
            const line = formatEvent(event);
            if (line) {
              turnLines.push(line);
              setLiveLines((prev) => [...prev, line]);
            }
          },
        });
        turnLines.push('--- final ---', finalAnswer);
      } catch (err) {
        turnLines.push(formatError(err));
      } finally {
        setHistory((h) => [...h, { id: nextBlockId++, lines: turnLines }]);
        setLiveLines([]);
        setIsProcessing(false);
      }
    },
    [loop, initialImage, exit],
  );

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(block) => (
          <Box key={block.id} flexDirection="column" marginBottom={1}>
            {block.lines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        )}
      </Static>
      {isProcessing &&
        liveLines.map((line, i) => (
          <Text key={i} color="gray">
            {line}
          </Text>
        ))}
      <InputBox disabled={isProcessing} onSubmit={handleSubmit} />
    </Box>
  );
}
