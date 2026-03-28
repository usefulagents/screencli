import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  url: string;
  prompt: string;
  id: string;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

export function Header({ url, prompt, id }: HeaderProps) {
  const shortId = id.slice(0, 8);

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box>
        <Text color="cyan" bold>screencli record</Text>
        <Text dimColor> {shortId}</Text>
      </Box>
      <Box>
        <Text dimColor>URL    </Text>
        <Text>{truncate(url, 60)}</Text>
      </Box>
      <Box>
        <Text dimColor>Prompt </Text>
        <Text>{truncate(prompt, 60)}</Text>
      </Box>
    </Box>
  );
}
