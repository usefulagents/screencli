import React from 'react';
import { Box, Text, Static } from 'ink';
import type { ActionEntry } from '../event-bus.js';

interface ActionListProps {
  actions: ActionEntry[];
  startTime: number;
}

const TOOL_DISPLAY: Record<string, string> = {
  click: 'click',
  type: 'type',
  navigate: 'navigate',
  scroll: 'scroll',
  hover: 'hover',
  screenshot: 'screenshot',
  done: 'done',
  narrate: 'narrate',
  press_key: 'press_key',
  select_option: 'select',
  wait: 'wait',
  go_back: 'go_back',
};

function formatStep(step: number): string {
  return String(step).padStart(2, '0');
}

function ActionRow({ entry, startTime, live }: { entry: ActionEntry; startTime: number; live?: boolean }) {
  const elapsed = ((entry.timestamp - startTime) / 1000).toFixed(0);
  const tool = TOOL_DISPLAY[entry.toolName] ?? entry.toolName;

  return (
    <Box>
      <Text dimColor>[{formatStep(entry.step)}]</Text>
      <Text> </Text>
      <Text color="cyan">{tool.padEnd(14)}</Text>
      <Text> {entry.description}</Text>
      <Text dimColor> +{elapsed}s</Text>
      {live && <Text color="cyan"> \u25CF</Text>}
    </Box>
  );
}

export function ActionList({ actions, startTime }: ActionListProps) {
  const past = actions.slice(0, -1);
  const current = actions.length > 0 ? actions[actions.length - 1] : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Static items={past}>
        {(entry) => (
          <ActionRow key={entry.step} entry={entry} startTime={startTime} />
        )}
      </Static>
      {current && <ActionRow entry={current} startTime={startTime} live />}
    </Box>
  );
}
