import { join, dirname } from 'node:path';
import type { RecordingEvent, Viewport } from '../recording/types.js';
import { generateZoomKeyframes, buildZoomFilterExpr } from './zoom.js';
import { buildHighlightFilters } from './highlight.js';
import { buildCursorOverlay } from './cursor.js';
import { computeActiveSegments, buildTrimFilter, estimateTrimmedDuration } from './trim.js';
import { runFFmpeg, getVideoDuration } from './ffmpeg.js';
import { buildBackgroundFilterComplex, backgroundImagePath, type BackgroundOptions } from './background.js';
import { logger } from '../utils/logger.js';
import { unlinkSync } from 'node:fs';

/**
 * Extract a thumbnail frame from a video file.
 * Seeks to 2s (or 0s if video is shorter) and extracts a single JPEG frame.
 */
export async function generateThumbnail(videoPath: string, outputPath: string): Promise<void> {
  let seekTo = 2;
  try {
    const duration = await getVideoDuration(videoPath);
    if (duration < 2) seekTo = 0;
  } catch {
    seekTo = 0;
  }

  await runFFmpeg({
    input: videoPath,
    output: outputPath,
    outputArgs: [
      '-ss', String(seekTo),
      '-vframes', '1',
      '-q:v', '2',
    ],
  });
}

export interface ComposeOptions {
  rawVideoPath: string;
  events: RecordingEvent[];
  outputPath: string;
  viewport: Viewport;
  zoom: boolean;
  highlight: boolean;
  cursor: boolean;
  background?: BackgroundOptions;
}

/**
 * Remap event timestamps after trimming.
 * Each event's timestamp is shifted to account for removed gaps.
 */
function remapEvents(events: RecordingEvent[], segments: { start_s: number; end_s: number }[]): RecordingEvent[] {
  return events.map((e) => {
    const t_s = e.timestamp_ms / 1000;
    let newT = 0;

    for (const seg of segments) {
      if (t_s < seg.start_s) {
        break;
      } else if (t_s <= seg.end_s) {
        newT += t_s - seg.start_s;
        break;
      } else {
        newT += seg.end_s - seg.start_s;
      }
    }

    return { ...e, timestamp_ms: Math.round(newT * 1000) };
  });
}

/**
 * Build a filter_complex that applies all effects (highlights, animated cursor,
 * zoom) and optionally composites onto a background.
 *
 * Filter order (in original viewport coordinates):
 *   1. Highlight drawboxes  (marks click/type targets)
 *   2. Cursor overlay        (smooth animated dot)
 *   3. Zoom (zoompan)        (crops + scales — cursor/highlights move with content)
 *   4. Background composite  (gradient, padding, corners, shadow)
 */
function buildFullFilterComplex(
  eventsForEffects: RecordingEvent[],
  viewport: Viewport,
  options: ComposeOptions,
): { filterComplex: string; outputLabel: string; extraInputs: string[] } {
  const chains: string[] = [];
  const extraInputs: string[] = [];
  let videoLabel = '0:v';
  let nextInputIdx = 1; // [0] is the main video

  // ── 1. Animated cursor overlay (pointer image) ──
  const cursorOverlay = options.cursor
    ? buildCursorOverlay(eventsForEffects, viewport)
    : null;

  if (cursorOverlay) {
    const cursorIdx = nextInputIdx++;
    extraInputs.push(cursorOverlay.imagePath);
    chains.push(`[${cursorIdx}:v]${cursorOverlay.inputFilter}[cursor]`);
    chains.push(`[${videoLabel}][cursor]overlay=${cursorOverlay.overlay}[with_cursor]`);
    videoLabel = 'with_cursor';
  }

  // ── 3. Zoom ──
  let zoomFilter = '';
  if (options.zoom) {
    const keyframes = generateZoomKeyframes(eventsForEffects, viewport);
    zoomFilter = buildZoomFilterExpr(keyframes, viewport);
  }

  if (zoomFilter) {
    chains.push(`[${videoLabel}]${zoomFilter}[zoomed]`);
    videoLabel = 'zoomed';
  }

  // ── 4. Background composite ──
  if (options.background) {
    const bgOpts = options.background;
    const { outW, outH, scaledW, scaledH, padX, padY } = computeBgLayout(viewport, bgOpts.padding);

    let fgChain = `[${videoLabel}]scale=${scaledW}:${scaledH},format=rgba`;
    if (bgOpts.cornerRadius > 0) {
      const R = bgOpts.cornerRadius;
      fgChain += `,geq=a='if(gt(abs(X-W/2),W/2-${R})*gt(abs(Y-H/2),H/2-${R}),if(lte(hypot(abs(X-W/2)-(W/2-${R}),abs(Y-H/2)-(H/2-${R})),${R}),255,0),255)':r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'`;
    }

    if (bgOpts.shadow) {
      fgChain += '[fg_raw]';
      chains.push(fgChain);
      chains.push('[fg_raw]split[fg][shadow_src]');
      chains.push('[shadow_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.4,boxblur=12:4[shadow]');
    } else {
      fgChain += '[fg]';
      chains.push(fgChain);
    }

    const bgIdx = nextInputIdx++;
    extraInputs.push(backgroundImagePath(options.background.gradient));
    chains.push(
      `[${bgIdx}:v]scale=${outW}:${outH},format=rgba,loop=-1:size=1:start=0[bg]`
    );

    if (bgOpts.shadow) {
      const sx = padX + 4;
      const sy = padY + 6;
      chains.push(`[bg][shadow]overlay=${sx}:${sy}:shortest=1[bg_s]`);
      chains.push(`[bg_s][fg]overlay=${padX}:${padY}:shortest=1[out]`);
    } else {
      chains.push(`[bg][fg]overlay=${padX}:${padY}:shortest=1[out]`);
    }

    return { filterComplex: chains.join(';'), outputLabel: 'out', extraInputs };
  }

  return { filterComplex: chains.join(';'), outputLabel: videoLabel, extraInputs };
}

function even(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

function computeBgLayout(viewport: Viewport, padding: number) {
  const outW = even(viewport.width);
  const outH = even(viewport.height);
  const fraction = padding / 100;
  const padX = Math.round(outW * fraction);
  const padY = Math.round(outH * fraction);
  return {
    outW,
    outH,
    scaledW: even(outW - 2 * padX),
    scaledH: even(outH - 2 * padY),
    padX,
    padY,
  };
}

export async function composeVideo(options: ComposeOptions): Promise<string> {
  let videoDuration: number;
  try {
    videoDuration = await getVideoDuration(options.rawVideoPath);
  } catch {
    videoDuration = options.events.length > 0
      ? options.events[options.events.length - 1]!.timestamp_ms / 1000 + 2
      : 30;
  }

  // Step 1: Trim idle time
  const segments = computeActiveSegments(options.events, videoDuration);
  const trimmedDuration = estimateTrimmedDuration(segments);
  const savedTime = videoDuration - trimmedDuration;

  let currentInput = options.rawVideoPath;
  let trimmedPath: string | undefined;
  let eventsForEffects = options.events;

  if (savedTime > 2) {
    trimmedPath = join(dirname(options.outputPath), '_trimmed.mp4');
    const trimFilter = buildTrimFilter(segments);
    logger.info(`Trimming idle time: ${videoDuration.toFixed(1)}s → ${trimmedDuration.toFixed(1)}s (saving ${savedTime.toFixed(1)}s)`);

    await runFFmpeg({
      input: options.rawVideoPath,
      output: trimmedPath,
      outputArgs: [
        '-vf', trimFilter,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
      ],
    });

    currentInput = trimmedPath;
    eventsForEffects = remapEvents(options.events, segments);
  } else {
    logger.info('No significant idle time to trim.');
  }

  // Step 2: Build and apply effects via filter_complex
  const hasEffects = options.highlight || options.cursor || options.zoom || options.background;

  if (hasEffects) {
    const { filterComplex, outputLabel, extraInputs } = buildFullFilterComplex(
      eventsForEffects, options.viewport, options,
    );

    const effectCount = [options.highlight, options.cursor, options.zoom].filter(Boolean).length;
    logger.info(
      options.background
        ? `Applying background (${options.background.gradient}) with ${effectCount} effect filters...`
        : `Applying ${effectCount} effect filters...`
    );

    await runFFmpeg({
      input: currentInput,
      extraInputs: extraInputs.length > 0 ? extraInputs : undefined,
      output: options.outputPath,
      filterComplex,
      outputArgs: [
        '-map', `[${outputLabel}]`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
      ],
    });
  } else {
    // No effects — just re-encode
    if (currentInput !== options.outputPath) {
      if (trimmedPath) {
        const { renameSync } = await import('node:fs');
        renameSync(trimmedPath, options.outputPath);
        return options.outputPath;
      }
      await runFFmpeg({
        input: currentInput,
        output: options.outputPath,
        outputArgs: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p'],
      });
    }
    return options.outputPath;
  }

  // Clean up intermediate file
  if (trimmedPath) {
    try { unlinkSync(trimmedPath); } catch { /* ignore */ }
  }

  return options.outputPath;
}
