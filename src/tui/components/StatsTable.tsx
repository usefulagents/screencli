import React from 'react';
import { Box, Text } from 'ink';

interface StatsRow {
  label: string;
  value: string | number;
}

interface StatsTableProps {
  rows: StatsRow[];
}

export function StatsTable({ rows }: StatsTableProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((row) => (
        <Box key={row.label}>
          <Text dimColor>{row.label.padEnd(22)}</Text>
          <Text>{row.value}</Text>
        </Box>
      ))}
    </Box>
  );
}
