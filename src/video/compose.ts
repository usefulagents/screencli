import { join, dirname } from 'node:path';
import type { RecordingEvent, Viewport } from '../recording/types.js';
import { generateZoomKeyframes, buildZoomFilterExpr } from './zoom.js';
import { buildHighlightFilters } from './highlight.js';
import { buildCursorFilter } from './cursor.js';
import { computeActiveSegments, buildTrimFilter, estimateTrimmedDuration } from './trim.js';
import { runFFmpeg, getVideoDuration } from './ffmpeg.js';
import { buildBackgroundFilterComplex, backgroundImagePath, type BackgroundOptions } from './background.js';
import { logger } from '../utils/logger.js';
import { unlinkSync } from 'node:fs';

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
        // Event is before this segment — it's in a trimmed gap, snap to current newT
        break;
      } else if (t_s <= seg.end_s) {
        // Event is within this segment
        newT += t_s - seg.start_s;
        break;
      } else {
        // Event is after this segment — accumulate the segment duration
        newT += seg.end_s - seg.start_s;
      }
    }

    return { ...e, timestamp_ms: Math.round(newT * 1000) };
  });
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
    // Worth trimming — do a first pass
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

  // Step 2: Build effect filters using remapped timestamps
  const filters: string[] = [];

  if (options.zoom) {
    const keyframes = generateZoomKeyframes(eventsForEffects, options.viewport);
    const zoomFilter = buildZoomFilterExpr(keyframes, options.viewport);
    if (zoomFilter) {
      filters.push(zoomFilter);
    }
  }

  if (options.highlight) {
    const highlightFilters = buildHighlightFilters(eventsForEffects, options.viewport);
    filters.push(...highlightFilters);
  }

  if (options.cursor) {
    const cursorFilters = buildCursorFilter(eventsForEffects, options.viewport);
    filters.push(...cursorFilters);
  }

  // Step 3: Apply effects + optional background
  if (options.background) {
    // Use filter_complex to composite video onto background image
    const bgImage = backgroundImagePath(options.background.gradient);
    const fc = buildBackgroundFilterComplex(filters, options.viewport, options.background);
    logger.info(`Applying background (${options.background.gradient}) with ${filters.length} effect filters...`);

    await runFFmpeg({
      input: currentInput,
      extraInputs: [bgImage],
      output: options.outputPath,
      filterComplex: fc,
      outputArgs: [
        '-map', '[out]',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
      ],
    });
  } else if (filters.length > 0) {
    const filterChain = filters.join(',');
    logger.info(`Applying ${filters.length} effect filters...`);

    await runFFmpeg({
      input: currentInput,
      output: options.outputPath,
      outputArgs: [
        '-vf', filterChain,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
      ],
    });
  } else {
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
