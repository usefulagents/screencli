import React from 'react';
import { Box } from 'ink';
import { Header } from './Header.js';
import { ActionList } from './ActionList.js';
import { StatusBar } from './StatusBar.js';
import type { RecordingPhase, ActionEntry } from '../event-bus.js';

interface RecordingScreenProps {
  url: string;
  prompt: string;
  id: string;
  phase: RecordingPhase;
  phaseLabel: string;
  actions: ActionEntry[];
  startTime: number;
  elapsedMs: number;
}

export function RecordingScreen({
  url, prompt, id, phase, phaseLabel, actions, startTime, elapsedMs,
}: RecordingScreenProps) {
  return (
    <Box flexDirection="column">
      <Header url={url} prompt={prompt} id={id} />
      <ActionList actions={actions} startTime={startTime} />
      <StatusBar
        phase={phase}
        phaseLabel={phaseLabel}
        stepCount={actions.length}
        elapsedMs={elapsedMs}
      />
    </Box>
  );
}
