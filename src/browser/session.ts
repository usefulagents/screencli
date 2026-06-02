import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { renameSync, existsSync, readdirSync } from 'node:fs';
import { BrowserError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { Viewport } from '../recording/types.js';

// Playwright finalizes the recorded video on context.close(); a malformed or
// not-cleanly-finalized stream can wedge that call forever, stranding the
// recording in `uploading` with no verdict. This timeout makes close() reject
// so record.ts's try/catch + /confirm fallback can run. Override via env.
const BROWSER_CLOSE_TIMEOUT_MS = Number(process.env['SCREENCLI_BROWSER_CLOSE_TIMEOUT_MS']) || 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserError(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<string | undefined>;
}

export async function launchSession(options: {
  viewport: Viewport;
  headless: boolean;
  slowMo: number;
  recordDir: string;
  storageState?: string | object;
}): Promise<BrowserSession> {
  logger.info('Launching browser...');

  const browser = await chromium.launch({
    headless: options.headless,
    slowMo: options.slowMo,
  });

  const context = await browser.newContext({
    viewport: options.viewport,
    recordVideo: {
      dir: options.recordDir,
      size: options.viewport,
    },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ...(options.storageState ? { storageState: options.storageState as any } : {}),
  });

  const page = await context.newPage();

  logger.info(`Browser launched. Viewport: ${options.viewport.width}x${options.viewport.height}`);

  async function close(): Promise<string | undefined> {
    try {
      // Must close context to finalize video
      await withTimeout(context.close(), BROWSER_CLOSE_TIMEOUT_MS, 'context.close (video finalize)');
      await withTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'browser.close');

      // Playwright saves video as a random name in recordDir; find and rename it
      const files = readdirSync(options.recordDir).filter((f) => f.endsWith('.webm'));
      if (files.length > 0) {
        const src = join(options.recordDir, files[0]!);
        const dest = join(options.recordDir, 'raw.webm');
        if (src !== dest) {
          renameSync(src, dest);
        }
        return dest;
      }
      return undefined;
    } catch (err) {
      logger.error('Error closing browser session', err);
      throw new BrowserError(`Failed to close browser: ${err}`);
    }
  }

  return { browser, context, page, close };
}
