import fs from 'node:fs';
import { getToken } from './client.js';

const API_BASE = process.env['SCREENCLI_API_URL'] || 'https://screencli.sh';

const FLUSH_INTERVAL_MS = 5_000;
// The flush fetch must never be the thing that hangs the CLI (that's the very
// failure mode we're trying to make visible), so it's hard-bounded.
const FLUSH_TIMEOUT_MS = 5_000;
const MAX_LINE_LEN = 2_000;
// Cap the unsent buffer so repeated flush failures can't grow memory without
// bound. The authoritative full log lives in `full` and is dumped to R2 at the
// end; the live buffer is a best-effort tail.
const MAX_BUFFER_LINES = 2_000;
const MAX_FULL_LINES = 50_000;

/** Lifecycle phase the CLI reports; mirrored into recordings.status server-side. */
export type Phase = 'recording' | 'processing' | 'uploading';

/**
 * Ships consolidated run logs to the cloud per recording, so a run that hangs
 * anywhere (agent loop, compose, browser close, upload) still leaves a trail
 * before the watchdog force-fails it.
 *
 *  - Registered as a logger sink, so it captures agentic AND non-agentic lines.
 *  - Flushes on a timer + immediately at each phase transition.
 *  - Carries the current phase on every flush; the server mirrors it into the
 *    recording's status (recording → processing → uploading).
 *  - All network work is best-effort and time-bounded; failures are swallowed
 *    and never propagate to the caller (never calls process.exit).
 */
export class LogShipper {
  private readonly recordingId: string;
  private buffer: string[] = [];
  private full: string[] = [];
  private phase: Phase = 'recording';
  private lastSentPhase: Phase | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  private stopped = false;

  constructor(recordingId: string) {
    this.recordingId = recordingId;
  }

  start(): void {
    this.timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive on our account.
    this.timer.unref?.();
  }

  /** Logger sink entry point. */
  add = (line: string): void => {
    const trimmed = line.length > MAX_LINE_LEN ? `${line.slice(0, MAX_LINE_LEN)}…` : line;
    this.buffer.push(trimmed);
    this.full.push(trimmed);
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_LINES);
    }
    if (this.full.length > MAX_FULL_LINES) {
      this.full.splice(0, this.full.length - MAX_FULL_LINES);
    }
  };

  /** Advance the reported phase and flush immediately so the status moves now. */
  async setPhase(phase: Phase): Promise<void> {
    this.phase = phase;
    await this.flush();
  }

  getFullLog(): string {
    return this.full.join('\n');
  }

  /** Write the complete in-memory log to a file (for upload to R2). */
  dumpTo(filePath: string): void {
    try {
      fs.writeFileSync(filePath, this.getFullLog());
    } catch { /* best-effort */ }
  }

  async flush(): Promise<void> {
    if (this.stopped || this.flushing) return;
    const hasLines = this.buffer.length > 0;
    const phaseChanged = this.phase !== this.lastSentPhase;
    if (!hasLines && !phaseChanged) return;

    const token = getToken();
    if (!token) return; // not logged in — nothing to ship

    this.flushing = true;
    const lines = this.buffer.splice(0, this.buffer.length);
    const phase = this.phase;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/api/recordings/${this.recordingId}/logs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ lines, phase }),
        signal: controller.signal,
      });
      if (res.ok) {
        this.lastSentPhase = phase;
      } else {
        // Requeue so the next tick retries (capped in add()/here).
        this.requeue(lines);
      }
    } catch {
      this.requeue(lines);
    } finally {
      clearTimeout(timer);
      this.flushing = false;
    }
  }

  private requeue(lines: string[]): void {
    this.buffer.unshift(...lines);
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_LINES);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
