import React from 'react';
import { Box, Text } from 'ink';
import { StatsTable } from './StatsTable.js';
import { ShareUrl } from './ShareUrl.js';
import type { DonePayload } from '../event-bus.js';

interface ResultsScreenProps {
  payload: DonePayload;
}

function formatTime(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ResultsScreen({ payload }: ResultsScreenProps) {
  const { summary, stats, shareUrl, recDir, durationMs, chapterCount, creditsUsed, creditsRemaining } = payload;

  const rows = [
    { label: 'Summary', value: summary },
    { label: 'Actions', value: stats.total_actions },
    { label: 'Tokens (in/out)', value: `${stats.input_tokens} / ${stats.output_tokens}` },
    { label: 'Duration', value: formatTime(durationMs) },
    { label: 'Chapters', value: chapterCount },
    { label: 'Output', value: recDir },
  ];

  if (creditsUsed !== undefined) {
    rows.push({ label: 'Credits used', value: `${creditsUsed}${creditsRemaining !== undefined ? ` (${creditsRemaining} remaining)` : ''}` });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="cyan">  Recording Complete</Text>
      </Box>
      <StatsTable rows={rows} />
      {shareUrl && <ShareUrl url={shareUrl} />}
      {!shareUrl && (
        <Box marginTop={1}>
          <Text dimColor>  Local recording: {recDir}</Text>
        </Box>
      )}
    </Box>
  );
}
