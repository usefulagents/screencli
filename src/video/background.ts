import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { Viewport } from '../recording/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Walk up from __dirname until we find package.json (the package root). */
function findPackageRoot(): string {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return __dirname;
}

const PKG_ROOT = findPackageRoot();

export type BackgroundPreset = 'midnight' | 'ember' | 'forest' | 'nebula' | 'slate' | 'copper';

export const BACKGROUND_PRESETS: BackgroundPreset[] = ['midnight', 'ember', 'forest', 'nebula', 'slate', 'copper'];

/** Pick a random background preset. */
export function randomPreset(): BackgroundPreset {
  return BACKGROUND_PRESETS[Math.floor(Math.random() * BACKGROUND_PRESETS.length)]!;
}

/** Resolve the absolute path to a background image. */
export function backgroundImagePath(preset: BackgroundPreset): string {
  return join(PKG_ROOT, 'assets', 'backgrounds', `${preset}.png`);
}

export interface BackgroundOptions {
  gradient: BackgroundPreset;
  /** Padding as a percentage of output size (0–50). Default 8. */
  padding: number;
  /** Corner radius in pixels. Default 12. */
  cornerRadius: number;
  /** Add a drop shadow behind the video frame. Default true. */
  shadow: boolean;
}

export const DEFAULT_BACKGROUND: BackgroundOptions = {
  gradient: 'midnight',
  padding: 8,
  cornerRadius: 12,
  shadow: true,
};

interface LayoutMetrics {
  outW: number;
  outH: number;
  scaledW: number;
  scaledH: number;
  padX: number;
  padY: number;
}

/** Ensure value is even (required by most video codecs). */
function even(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

function computeLayout(viewport: Viewport, padding: number): LayoutMetrics {
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

/**
 * Compute layout when the source aspect ratio differs from the output.
 * The video is fit (letterboxed) inside the padded area.
 */
export function computeFitLayout(
  source: Viewport,
  output: Viewport,
  padding: number,
): LayoutMetrics {
  const outW = even(output.width);
  const outH = even(output.height);
  const fraction = padding / 100;
  const maxW = outW - 2 * Math.round(outW * fraction);
  const maxH = outH - 2 * Math.round(outH * fraction);

  const scale = Math.min(maxW / source.width, maxH / source.height);
  const scaledW = even(Math.round(source.width * scale));
  const scaledH = even(Math.round(source.height * scale));

  return {
    outW,
    outH,
    scaledW,
    scaledH,
    padX: Math.round((outW - scaledW) / 2),
    padY: Math.round((outH - scaledH) / 2),
  };
}

function buildCornerRadiusExpr(radius: number): string {
  const R = radius;
  return (
    `a='if(gt(abs(X-W/2),W/2-${R})*gt(abs(Y-H/2),H/2-${R}),` +
    `if(lte(hypot(abs(X-W/2)-(W/2-${R}),abs(Y-H/2)-(H/2-${R})),${R}),255,0),255)'` +
    `:r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'`
  );
}

/**
 * Build an FFmpeg filter_complex that composites the video onto an image
 * background with optional rounded corners and drop shadow.
 *
 * Input [0:v] = the recording video
 * Input [1:v] = the background image
 *
 * @returns The full filter_complex string. Output label is `[out]`.
 */
export function buildBackgroundFilterComplex(
  effectFilters: string[],
  viewport: Viewport,
  opts: BackgroundOptions,
  layout?: LayoutMetrics,
): string {
  const m = layout ?? computeLayout(viewport, opts.padding);
  const { outW, outH, scaledW, scaledH, padX, padY } = m;

  const chains: string[] = [];

  // ── Chain 1: process input → scale → round corners ──
  const effectStr = effectFilters.length > 0 ? effectFilters.join(',') + ',' : '';
  let fgChain = `[0:v]${effectStr}scale=${scaledW}:${scaledH},format=rgba`;

  if (opts.cornerRadius > 0) {
    fgChain += `,geq=${buildCornerRadiusExpr(opts.cornerRadius)}`;
  }

  if (opts.shadow) {
    fgChain += '[fg_raw]';
    chains.push(fgChain);
    chains.push('[fg_raw]split[fg][shadow_src]');
    chains.push(
      '[shadow_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.4,boxblur=12:4[shadow]',
    );
  } else {
    fgChain += '[fg]';
    chains.push(fgChain);
  }

  // ── Chain 2: scale background image to output size, loop to match video duration ──
  chains.push(
    `[1:v]scale=${outW}:${outH},format=rgba,loop=-1:size=1:start=0[bg]`,
  );

  // ── Chain 3: composite ──
  if (opts.shadow) {
    const sx = padX + 4;
    const sy = padY + 6;
    chains.push(`[bg][shadow]overlay=${sx}:${sy}:shortest=1[bg_s]`);
    chains.push(`[bg_s][fg]overlay=${padX}:${padY}:shortest=1[out]`);
  } else {
    chains.push(`[bg][fg]overlay=${padX}:${padY}:shortest=1[out]`);
  }

  return chains.join(';');
}
