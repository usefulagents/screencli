import React from 'react';
import { Box, Text } from 'ink';

interface ShareUrlProps {
  url: string;
}

export function ShareUrl({ url }: ShareUrlProps) {
  return (
    <Box borderStyle="round" borderColor="green" paddingX={2} marginTop={1}>
      <Text bold color="green">{url}</Text>
    </Box>
  );
}
