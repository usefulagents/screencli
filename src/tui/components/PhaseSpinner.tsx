import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface PhaseSpinnerProps {
  label: string;
}

export function PhaseSpinner({ label }: PhaseSpinnerProps) {
  return (
    <Box marginTop={1}>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text> {label}</Text>
    </Box>
  );
}
