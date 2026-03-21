import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { RecordingEvent, Viewport } from '../recording/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageRoot(): string {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return __dirname;
}

/** Path to the cursor pointer PNG asset. */
export function cursorImagePath(): string {
  return join(findPackageRoot(), 'assets', 'cursor.png');
}

// ── Timing: cursor leads the zoom ──
// Zoom: approach starts at t - 1.3s, settles at t - 0.3s
// Cursor: glides 0.7s, arrives 1.0s before the action (well before zoom settles)
const TRAVEL_S = 0.7;
const ARRIVE_BEFORE_S = 1.0;

interface CursorKeyframe {
  time_s: number;
  x: number;
  y: number;
}

/**
 * Generate cursor keyframes synced with zoom timing.
 *
 * The cursor glides (0.7s) to each target and arrives exactly when
 * the zoom settles (0.3s before the action). Between actions it holds still.
 */
function generateCursorKeyframes(events: RecordingEvent[]): CursorKeyframe[] {
  const positions: { time_s: number; x: number; y: number }[] = [];
  for (const event of events) {
    if (event.bounding_box) {
      positions.push({
        time_s: event.timestamp_ms / 1000,
        x: Math.round(event.bounding_box.x + event.bounding_box.width / 2),
        y: Math.round(event.bounding_box.y + event.bounding_box.height / 2),
      });
    }
  }

  if (positions.length === 0) return [];

  const keyframes: CursorKeyframe[] = [];

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]!;
    const arriveAt = pos.time_s - ARRIVE_BEFORE_S;
    const startMoveAt = arriveAt - TRAVEL_S;

    if (i === 0) {
      // First event: cursor starts at target (already in place when zoom begins)
      keyframes.push({ time_s: Math.max(0, startMoveAt), x: pos.x, y: pos.y });
    } else {
      const prev = positions[i - 1]!;

      // Hold at previous position, then glide to new target
      keyframes.push({ time_s: Math.max(prev.time_s, startMoveAt), x: prev.x, y: prev.y });
      keyframes.push({ time_s: arriveAt, x: pos.x, y: pos.y });
    }

    // Hold at target through the action
    keyframes.push({ time_s: pos.time_s, x: pos.x, y: pos.y });
  }

  // Hold at last position
  const last = positions[positions.length - 1]!;
  keyframes.push({ time_s: last.time_s + 2.0, x: last.x, y: last.y });

  return keyframes;
}

function buildInterpolatedExpr(keyframes: CursorKeyframe[], prop: 'x' | 'y'): string {
  if (keyframes.length === 0) return '0';
  if (keyframes.length === 1) return String(keyframes[0]![prop]);

  let expr = '';
  let segments = 0;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const k0 = keyframes[i]!;
    const k1 = keyframes[i + 1]!;
    const t0 = k0.time_s;
    const t1 = k1.time_s;

    if (t1 <= t0) continue;

    const v0 = k0[prop];
    const v1 = k1[prop];

    const segment = `if(between(t,${t0.toFixed(3)},${t1.toFixed(3)}),${v0.toFixed(1)}+(${(v1 - v0).toFixed(1)})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)}`;
    expr = expr ? `${expr},${segment}` : segment;
    segments++;
  }

  const lastVal = keyframes[keyframes.length - 1]![prop];
  const closingParens = ')'.repeat(segments);
  return `${expr},${lastVal.toFixed(1)}${closingParens}`;
}

export interface CursorOverlayResult {
  /** Path to the cursor pointer image (added as extra FFmpeg input). */
  imagePath: string;
  /** Filter to prep the cursor input (loop + format). */
  inputFilter: string;
  /** The overlay filter expression with animated x/y. */
  overlay: string;
}

/**
 * Build cursor overlay using a pointer PNG image with animated position.
 * The hotspot is at the top-left (tip of the arrow).
 */
export function buildCursorOverlay(
  events: RecordingEvent[],
  viewport: Viewport
): CursorOverlayResult | null {
  const keyframes = generateCursorKeyframes(events);
  if (keyframes.length === 0) return null;

  const xExpr = buildInterpolatedExpr(keyframes, 'x');
  const yExpr = buildInterpolatedExpr(keyframes, 'y');

  return {
    imagePath: cursorImagePath(),
    inputFilter: 'format=rgba,loop=-1:size=1:start=0',
    overlay: `x='${xExpr}':y='${yExpr}':shortest=1`,
  };
}

// Legacy exports
export function extractCursorPositions(events: RecordingEvent[]) {
  const positions: { time_s: number; x: number; y: number }[] = [];
  for (const event of events) {
    if (event.bounding_box) {
      positions.push({
        time_s: event.timestamp_ms / 1000,
        x: Math.round(event.bounding_box.x + event.bounding_box.width / 2),
        y: Math.round(event.bounding_box.y + event.bounding_box.height / 2),
      });
    }
  }
  return positions;
}

export function buildCursorFilter(_events: RecordingEvent[], _viewport: Viewport): string[] {
  return [];
}
