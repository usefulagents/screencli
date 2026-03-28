import React from 'react';
import { render } from 'ink';
import { RecordingApp } from './components/RecordingApp.js';
import { RecordingEventBus } from './event-bus.js';

export { RecordingEventBus } from './event-bus.js';
export type { RecordingPhase, ActionEntry, DonePayload } from './event-bus.js';

export function runRecordingTUI(options: {
  bus: RecordingEventBus;
  url: string;
  prompt: string;
  id: string;
  startTime: number;
}): { waitUntilExit: () => Promise<void> } {
  const instance = render(
    React.createElement(RecordingApp, {
      bus: options.bus,
      url: options.url,
      prompt: options.prompt,
      id: options.id,
      startTime: options.startTime,
    }),
  );

  return { waitUntilExit: () => instance.waitUntilExit() };
}
