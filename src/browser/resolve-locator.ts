import type { Page, Locator } from 'playwright';

export interface ElementTarget {
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  index?: number;
  x?: number;
  y?: number;
}

/**
 * Resolve a Playwright Locator from an ElementTarget.
 *
 * Priority:
 *   1. index — uses data-screencli-idx attribute (most reliable, from get_interactive_elements)
 *   2. role + name — Playwright getByRole
 *   3. text — Playwright getByText
 *   4. selector — CSS selector
 *   5. x + y — coordinate click (handled separately in actions.ts)
 */
export function resolveLocator(page: Page, target: ElementTarget): Locator {
  if (target.index !== undefined) {
    return page.locator(`[data-screencli-idx="${target.index}"]`);
  }
  if (target.role && target.name) {
    return page.getByRole(target.role as any, { name: target.name });
  }
  if (target.role) {
    return page.getByRole(target.role as any);
  }
  if (target.text) {
    return page.getByText(target.text);
  }
  if (target.selector) {
    return page.locator(target.selector);
  }
  throw new Error('No valid target provided. Use index (from get_interactive_elements), role+name, text, or selector.');
}

export async function getBoundingBox(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  try {
    const box = await locator.boundingBox({ timeout: 3000 });
    if (!box) return undefined;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch {
    return undefined;
  }
}
