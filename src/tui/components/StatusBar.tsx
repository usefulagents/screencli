import React from 'react';
import { Box, Text } from 'ink';
import type { RecordingPhase } from '../event-bus.js';

interface StatusBarProps {
  phase: RecordingPhase;
  phaseLabel: string;
  stepCount: number;
  elapsedMs: number;
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

const PHASE_COLOR: Record<RecordingPhase, string> = {
  launching: 'yellow',
  recording: 'cyan',
  composing: 'yellow',
  uploading: 'yellow',
  done: 'green',
  error: 'red',
};

export function StatusBar({ phase, phaseLabel, stepCount, elapsedMs }: StatusBarProps) {
  const color = PHASE_COLOR[phase];

  return (
    <Box marginTop={1} justifyContent="space-between">
      <Box>
        <Text color={color}>{'\u25CF'} </Text>
        <Text color={color}>{phaseLabel}</Text>
      </Box>
      <Box>
        <Text dimColor>{stepCount} steps</Text>
        <Text dimColor> {'\u00b7'} </Text>
        <Text dimColor>{formatTime(elapsedMs)}</Text>
      </Box>
    </Box>
  );
}
