import React, { useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import type { RecordingEventBus } from '../event-bus.js';
import { useRecordingState } from '../hooks/useRecordingState.js';
import { useElapsedTime } from '../hooks/useElapsedTime.js';
import { RecordingScreen } from './RecordingScreen.js';
import { ResultsScreen } from './ResultsScreen.js';
import { PhaseSpinner } from './PhaseSpinner.js';

interface RecordingAppProps {
  bus: RecordingEventBus;
  url: string;
  prompt: string;
  id: string;
  startTime: number;
}

export function RecordingApp({ bus, url, prompt, id, startTime }: RecordingAppProps) {
  const { exit } = useApp();
  const state = useRecordingState(bus);
  const elapsedMs = useElapsedTime(startTime, state.phase !== 'done' && state.phase !== 'error');

  useEffect(() => {
    if (state.phase === 'done' || state.phase === 'error') {
      const timer = setTimeout(() => exit(), 150);
      return () => clearTimeout(timer);
    }
  }, [state.phase, exit]);

  if (state.phase === 'recording') {
    return (
      <RecordingScreen
        url={url}
        prompt={prompt}
        id={id}
        phase={state.phase}
        phaseLabel={state.phaseLabel}
        actions={state.actions}
        startTime={startTime}
        elapsedMs={elapsedMs}
      />
    );
  }

  if (state.phase === 'done' && state.donePayload) {
    return <ResultsScreen payload={state.donePayload} />;
  }

  if (state.phase === 'error') {
    return (
      <Box marginTop={1}>
        <Text color="red">  {'\u2717'} {state.errorMessage ?? 'Unknown error'}</Text>
      </Box>
    );
  }

  // Spinner phases: launching, composing, uploading
  return <PhaseSpinner label={state.phaseLabel} />;
}
