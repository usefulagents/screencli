import { useState, useEffect } from 'react';
import type { RecordingEventBus, RecordingPhase, ActionEntry, DonePayload } from '../event-bus.js';

export interface RecordingState {
  phase: RecordingPhase;
  phaseLabel: string;
  actions: ActionEntry[];
  donePayload?: DonePayload;
  errorMessage?: string;
}

export function useRecordingState(bus: RecordingEventBus): RecordingState {
  const [phase, setPhase] = useState<RecordingPhase>('launching');
  const [phaseLabel, setPhaseLabel] = useState('Launching browser...');
  const [actions, setActions] = useState<ActionEntry[]>([]);
  const [donePayload, setDonePayload] = useState<DonePayload>();
  const [errorMessage, setErrorMessage] = useState<string>();

  useEffect(() => {
    const handlePhase = (p: RecordingPhase, label?: string) => {
      setPhase(p);
      if (label) setPhaseLabel(label);
      else {
        const labels: Record<RecordingPhase, string> = {
          launching: 'Launching browser...',
          recording: 'Recording...',
          composing: 'Composing video...',
          uploading: 'Uploading to cloud...',
          done: 'Done',
          error: 'Error',
        };
        setPhaseLabel(labels[p]);
      }
    };

    const handleAction = (entry: ActionEntry) => {
      setActions(prev => [...prev, entry]);
    };

    const handleDone = (payload: DonePayload) => {
      setDonePayload(payload);
      setPhase('done');
      setPhaseLabel('Done');
    };

    const handleError = (message: string) => {
      setErrorMessage(message);
      setPhase('error');
      setPhaseLabel('Error');
    };

    bus.onPhase(handlePhase);
    bus.onAction(handleAction);
    bus.onDone(handleDone);
    bus.onError(handleError);

    return () => {
      bus.removeListener('phase', handlePhase);
      bus.removeListener('action', handleAction);
      bus.removeListener('done', handleDone);
      bus.removeListener('error', handleError);
    };
  }, [bus]);

  return { phase, phaseLabel, actions, donePayload, errorMessage };
}
