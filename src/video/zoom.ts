import type { RecordingEvent, Viewport } from '../recording/types.js';

export interface ZoomKeyframe {
  time_s: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Tuning constants ──

/** Time (s) for the camera to travel from full viewport to the zoom target. */
const APPROACH_S = 1.0;
/** The camera settles on the target this many seconds BEFORE the action. */
const SETTLE_BEFORE_S = 0.3;
/** Hold time (s) after the last event in a session before zooming out. */
const HOLD_AFTER_S = 0.5;
/** Time (s) to animate from zoomed back to full viewport. */
const RELEASE_S = 0.8;
/** Padding around the target element, as a fraction of the element's size. */
const PADDING_RATIO = 0.3;
/** The crop region will never be smaller than this fraction of the viewport. */
const MIN_ZOOM_RATIO = 0.4;
/** Skip zoom entirely when the crop would cover this much of the viewport. */
const SKIP_ZOOM_RATIO = 0.85;
/** Maximum time gap (s) between events to keep them in the same zoom session. */
const SESSION_GAP_S = 2.5;

// ── Helpers ──

function fullViewport(vp: Viewport): CropRegion {
  return { x: 0, y: 0, w: vp.width, h: vp.height };
}

/**
 * Compute the ideal crop region for a single event's bounding box.
 * Returns `null` if the crop would cover most of the viewport (no useful zoom).
 */
function computeCropForEvent(event: RecordingEvent, viewport: Viewport): CropRegion | null {
  const box = event.bounding_box;
  if (!box) return null;

  // Pad around the element
  const padX = box.width * PADDING_RATIO;
  const padY = box.height * PADDING_RATIO;
  let cropW = box.width + padX * 2;
  let cropH = box.height + padY * 2;

  // Enforce minimum zoom (don't zoom in too far on tiny elements)
  const minW = viewport.width * MIN_ZOOM_RATIO;
  const minH = viewport.height * MIN_ZOOM_RATIO;
  cropW = Math.max(cropW, minW);
  cropH = Math.max(cropH, minH);

  // Maintain viewport aspect ratio
  const aspect = viewport.width / viewport.height;
  if (cropW / cropH < aspect) {
    cropW = cropH * aspect;
  } else {
    cropH = cropW / aspect;
  }

  // Don't exceed viewport
  cropW = Math.min(cropW, viewport.width);
  cropH = Math.min(cropH, viewport.height);

  // Skip zoom if it wouldn't be meaningful
  if (cropW >= viewport.width * SKIP_ZOOM_RATIO && cropH >= viewport.height * SKIP_ZOOM_RATIO) {
    return null;
  }

  // Center on the element
  let cropX = box.x + box.width / 2 - cropW / 2;
  let cropY = box.y + box.height / 2 - cropH / 2;

  // Clamp to viewport bounds
  cropX = Math.max(0, Math.min(cropX, viewport.width - cropW));
  cropY = Math.max(0, Math.min(cropY, viewport.height - cropH));

  return { x: cropX, y: cropY, w: cropW, h: cropH };
}

interface ZoomTarget {
  time_s: number;
  crop: CropRegion;
}

type ZoomSession = ZoomTarget[];

/**
 * Group events into zoom sessions.
 * Events within SESSION_GAP_S of each other stay in the same session.
 * Events that produce no meaningful zoom are excluded.
 */
function groupIntoSessions(events: RecordingEvent[], viewport: Viewport): ZoomSession[] {
  const targets: ZoomTarget[] = [];
  for (const event of events) {
    const crop = computeCropForEvent(event, viewport);
    if (crop) {
      targets.push({ time_s: event.timestamp_ms / 1000, crop });
    }
  }

  if (targets.length === 0) return [];

  // Group by temporal proximity
  const sessions: ZoomSession[] = [];
  let current: ZoomSession = [targets[0]!];

  for (let i = 1; i < targets.length; i++) {
    const prev = current[current.length - 1]!;
    const next = targets[i]!;

    if (next.time_s - prev.time_s <= SESSION_GAP_S) {
      current.push(next);
    } else {
      sessions.push(current);
      current = [next];
    }
  }
  sessions.push(current);

  // Merge sessions whose release/approach would overlap
  const merged: ZoomSession[] = [sessions[0]!];
  for (let i = 1; i < sessions.length; i++) {
    const prevSession = merged[merged.length - 1]!;
    const nextSession = sessions[i]!;
    const prevEnd = prevSession[prevSession.length - 1]!.time_s + HOLD_AFTER_S + RELEASE_S;
    const nextStart = nextSession[0]!.time_s - SETTLE_BEFORE_S - APPROACH_S;

    if (prevEnd >= nextStart) {
      merged[merged.length - 1] = [...prevSession, ...nextSession];
    } else {
      merged.push(nextSession);
    }
  }

  return merged;
}

/**
 * Generate zoom keyframes that anticipate actions.
 *
 * The camera zooms in BEFORE each action so the viewer is already focused on
 * the target when the click/type happens — mimicking how a human viewer's eye
 * would follow the cursor. Within a session, the camera pans smoothly between
 * targets, arriving early at each one.
 *
 * Timeline for a single action at time T:
 *   T - 1.3s : start zooming in from full viewport
 *   T - 0.3s : settled on target (viewer sees the area)
 *   T        : action happens
 *   T + 0.5s : hold (viewer sees result)
 *   T + 1.3s : back to full viewport
 */
export function generateZoomKeyframes(
  events: RecordingEvent[],
  viewport: Viewport
): ZoomKeyframe[] {
  const sessions = groupIntoSessions(events, viewport);
  if (sessions.length === 0) return [];

  const keyframes: ZoomKeyframe[] = [];
  const full = fullViewport(viewport);

  // Start fully zoomed out
  keyframes.push({ time_s: 0, ...full });

  for (const session of sessions) {
    const first = session[0]!;
    const last = session[session.length - 1]!;

    // ── Approach: zoom in and settle BEFORE the first action ──
    const settleTime = first.time_s - SETTLE_BEFORE_S;
    const approachStart = Math.max(0, settleTime - APPROACH_S);
    keyframes.push({ time_s: approachStart, ...full });
    keyframes.push({ time_s: Math.max(0, settleTime), ...first.crop });

    // ── Pan between targets within the session ──
    // The camera should arrive at each target BEFORE the action happens.
    for (let i = 1; i < session.length; i++) {
      const prev = session[i - 1]!;
      const curr = session[i]!;
      const gap = curr.time_s - prev.time_s;

      // Hold at the previous target briefly after its action, then pan to
      // arrive at the next target SETTLE_BEFORE_S before its action.
      const arriveBy = curr.time_s - SETTLE_BEFORE_S;

      // Hold at prev for 40% of the gap or until we need to start panning
      const holdEnd = Math.min(prev.time_s + gap * 0.4, arriveBy - 0.1);

      if (holdEnd > prev.time_s + 0.05) {
        keyframes.push({ time_s: holdEnd, ...prev.crop });
      }

      // Arrive at next target early
      keyframes.push({ time_s: Math.max(holdEnd + 0.05, arriveBy), ...curr.crop });
    }

    // ── Release: hold after last action, then zoom out ──
    const holdEnd = last.time_s + HOLD_AFTER_S;
    keyframes.push({ time_s: holdEnd, ...last.crop });

    const resetEnd = holdEnd + RELEASE_S;
    keyframes.push({ time_s: resetEnd, ...full });
  }

  return keyframes;
}

/**
 * Build a zoompan filter expression from keyframes.
 *
 * Uses FFmpeg's `zoompan` filter instead of `crop` because FFmpeg 8.x's crop
 * filter evaluates expressions only once at init time, making time-based
 * expressions ineffective. The zoompan filter evaluates per-frame.
 *
 * Keyframes specify crop regions (x, y, w, h). These are converted to
 * zoompan parameters: zoom = viewport_w / crop_w, x = crop_x, y = crop_y.
 */
export function buildZoomFilterExpr(
  keyframes: ZoomKeyframe[],
  viewport: Viewport
): string {
  if (keyframes.length === 0) return '';

  // Build a per-frame expression for a zoompan parameter using linear
  // interpolation between keyframes. Uses `in_time` (zoompan's input timestamp).
  const buildExpr = (getValue: (kf: ZoomKeyframe) => number): string => {
    if (keyframes.length === 1) return getValue(keyframes[0]!).toFixed(4);

    let expr = '';
    let segments = 0;
    for (let i = 0; i < keyframes.length - 1; i++) {
      const k0 = keyframes[i]!;
      const k1 = keyframes[i + 1]!;
      const t0 = k0.time_s;
      const t1 = k1.time_s;

      if (t1 === t0) continue;

      const v0 = getValue(k0);
      const v1 = getValue(k1);

      // Linear interpolation: v0 + (v1 - v0) * (in_time - t0) / (t1 - t0)
      const segment = `if(between(in_time,${t0.toFixed(3)},${t1.toFixed(3)}),${v0.toFixed(4)}+(${(v1 - v0).toFixed(4)})*(in_time-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)}`;
      expr = expr ? `${expr},${segment}` : segment;
      segments++;
    }

    const lastVal = getValue(keyframes[keyframes.length - 1]!);
    const closingParens = ')'.repeat(segments);
    return `${expr},${lastVal.toFixed(4)}${closingParens}`;
  };

  const zExpr = buildExpr((kf) => viewport.width / kf.w);
  const xExpr = buildExpr((kf) => kf.x);
  const yExpr = buildExpr((kf) => kf.y);

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${viewport.width}x${viewport.height}:fps=25`;
}
