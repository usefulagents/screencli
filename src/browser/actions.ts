import type { Page } from 'playwright';
import { resolveLocator, getBoundingBox, type ElementTarget } from './resolve-locator.js';
import type { BoundingBox } from '../recording/types.js';

export interface ActionResult {
  bounding_box?: BoundingBox;
  screenshot: Buffer;
  url: string;
}

/** Capture a JPEG screenshot (much smaller than PNG → faster API calls). */
async function captureState(page: Page): Promise<{ screenshot: Buffer; url: string }> {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 75 });
  return { screenshot, url: page.url() };
}

export async function click(
  page: Page,
  target: ElementTarget,
  clickType: 'left' | 'right' | 'double' = 'left',
  delayMs: number = 0
): Promise<ActionResult> {
  // Coordinate-based click (fallback)
  if (target.x !== undefined && target.y !== undefined) {
    if (clickType === 'double') {
      await page.mouse.dblclick(target.x, target.y);
    } else {
      await page.mouse.click(target.x, target.y, { button: clickType });
    }
    const bounding_box = { x: target.x - 5, y: target.y - 5, width: 10, height: 10 };
    if (delayMs > 0) await page.waitForTimeout(delayMs);
    const state = await captureState(page);
    return { bounding_box, ...state };
  }

  const locator = resolveLocator(page, target);
  const bounding_box = await getBoundingBox(locator);

  if (clickType === 'double') {
    await locator.dblclick({ timeout: 10000 });
  } else {
    await locator.click({ button: clickType, timeout: 10000 });
  }

  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { bounding_box, ...state };
}

export async function type(
  page: Page,
  target: ElementTarget,
  text: string,
  options: { clearFirst?: boolean; characterByCharacter?: boolean } = {},
  delayMs: number = 0
): Promise<ActionResult> {
  const locator = resolveLocator(page, target);
  const bounding_box = await getBoundingBox(locator);

  if (options.clearFirst) {
    await locator.clear({ timeout: 10000 });
  }

  if (options.characterByCharacter) {
    await locator.pressSequentially(text, { delay: 50, timeout: 30000 });
  } else {
    await locator.fill(text, { timeout: 10000 });
  }

  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { bounding_box, ...state };
}

export async function pressKey(
  page: Page,
  key: string,
  delayMs: number = 0
): Promise<ActionResult> {
  await page.keyboard.press(key);
  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { ...state };
}

export async function goBack(
  page: Page,
  delayMs: number = 0
): Promise<ActionResult> {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {
    // goBack may fail if there's no history — that's OK
  });
  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { ...state };
}

export async function scroll(
  page: Page,
  options: {
    direction?: 'up' | 'down' | 'left' | 'right';
    amount?: number;
    toElement?: ElementTarget;
  },
  delayMs: number = 0
): Promise<ActionResult> {
  let bounding_box: BoundingBox | undefined;

  if (options.toElement) {
    const locator = resolveLocator(page, options.toElement);
    bounding_box = await getBoundingBox(locator);
    await locator.scrollIntoViewIfNeeded({ timeout: 10000 });
  } else {
    const amount = options.amount ?? 600;
    const deltaX =
      options.direction === 'left' ? -amount : options.direction === 'right' ? amount : 0;
    const deltaY =
      options.direction === 'up' ? -amount : options.direction === 'down' ? amount : 0;

    // Smooth scroll for recording quality
    const STEP_PX = 40;
    const STEP_DELAY_MS = 16;
    const total = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    const steps = Math.max(1, Math.ceil(total / STEP_PX));
    const stepX = deltaX / steps;
    const stepY = deltaY / steps;

    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(stepX, stepY);
      await page.waitForTimeout(STEP_DELAY_MS);
    }
  }

  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { bounding_box, ...state };
}

export async function hover(
  page: Page,
  target: ElementTarget,
  delayMs: number = 0
): Promise<ActionResult> {
  const locator = resolveLocator(page, target);
  const bounding_box = await getBoundingBox(locator);
  await locator.hover({ timeout: 10000 });

  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { bounding_box, ...state };
}

export async function navigate(
  page: Page,
  url: string,
  delayMs: number = 0
): Promise<ActionResult> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { ...state };
}

export async function waitFor(
  page: Page,
  condition: {
    time?: number;
    elementVisible?: ElementTarget;
    elementHidden?: ElementTarget;
    networkIdle?: boolean;
  }
): Promise<ActionResult> {
  if (condition.time) {
    await page.waitForTimeout(condition.time);
  }
  if (condition.elementVisible) {
    const locator = resolveLocator(page, condition.elementVisible);
    await locator.waitFor({ state: 'visible', timeout: 15000 });
  }
  if (condition.elementHidden) {
    const locator = resolveLocator(page, condition.elementHidden);
    await locator.waitFor({ state: 'hidden', timeout: 15000 });
  }
  if (condition.networkIdle) {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  }
  const state = await captureState(page);
  return { ...state };
}

export async function selectOption(
  page: Page,
  target: ElementTarget,
  option: { label?: string; value?: string },
  delayMs: number = 0
): Promise<ActionResult> {
  const locator = resolveLocator(page, target);
  const bounding_box = await getBoundingBox(locator);

  if (option.label) {
    await locator.selectOption({ label: option.label }, { timeout: 10000 });
  } else if (option.value) {
    await locator.selectOption({ value: option.value }, { timeout: 10000 });
  }

  if (delayMs > 0) await page.waitForTimeout(delayMs);
  const state = await captureState(page);
  return { bounding_box, ...state };
}
