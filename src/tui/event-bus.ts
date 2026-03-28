import { EventEmitter } from 'node:events';
import type { AgentStats } from '../recording/types.js';

export type RecordingPhase =
  | 'launching'
  | 'recording'
  | 'composing'
  | 'uploading'
  | 'done'
  | 'error';

export interface ActionEntry {
  step: number;
  toolName: string;
  description: string;
  timestamp: number;
}

export interface DonePayload {
  summary: string;
  stats: AgentStats;
  shareUrl?: string;
  recDir: string;
  durationMs: number;
  chapterCount: number;
  creditsUsed?: number;
  creditsRemaining?: number;
}

interface EventMap {
  phase: [phase: RecordingPhase, label?: string];
  action: [entry: ActionEntry];
  done: [payload: DonePayload];
  error: [message: string];
}

export class RecordingEventBus extends EventEmitter {
  emitPhase(phase: RecordingPhase, label?: string): void {
    this.emit('phase', phase, label);
  }

  emitAction(entry: ActionEntry): void {
    this.emit('action', entry);
  }

  emitDone(payload: DonePayload): void {
    this.emit('done', payload);
  }

  emitError(message: string): void {
    this.emit('error', message);
  }

  onPhase(fn: (...args: EventMap['phase']) => void): this {
    return this.on('phase', fn);
  }

  onAction(fn: (...args: EventMap['action']) => void): this {
    return this.on('action', fn);
  }

  onDone(fn: (...args: EventMap['done']) => void): this {
    return this.on('done', fn);
  }

  onError(fn: (...args: EventMap['error']) => void): this {
    return this.on('error', fn);
  }
}
