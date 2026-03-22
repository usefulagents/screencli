import type { Page } from 'playwright';

export interface AccessibilityNode {
  role: string;
  name: string;
  children?: AccessibilityNode[];
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
}

export interface InteractiveElement {
  index: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  type?: string;
  value?: string;
  bbox: { x: number; y: number; width: number; height: number };
}

/**
 * Find all interactive elements visible in the viewport, inject `data-screencli-idx`
 * attributes for reliable targeting, and return a formatted list.
 *
 * This is the primary observation tool — the agent picks elements by index.
 */
export async function getInteractiveElements(page: Page): Promise<{
  elements: InteractiveElement[];
  formatted: string;
}> {
  const elements: InteractiveElement[] = await page.evaluate(`
    (function() {
      document.querySelectorAll('[data-screencli-idx]').forEach(function(el) {
        el.removeAttribute('data-screencli-idx');
      });

      var selectors = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=textbox], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=switch], [role=combobox], [role=option], [role=searchbox], [tabindex]:not([tabindex="-1"])';
      var allEls = document.querySelectorAll(selectors);
      var results = [];
      var seen = new Set();
      var idx = 0;

      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (seen.has(el)) continue;
        seen.add(el);

        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        var rect = el.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        if (rect.right < 0 || rect.left > window.innerWidth) continue;

        el.setAttribute('data-screencli-idx', String(idx));

        var tag = el.tagName.toLowerCase();
        var rawRole = el.getAttribute('role');
        var role = rawRole || (tag === 'a' ? 'link' : tag === 'button' ? 'button' :
          tag === 'input' ? 'input' : tag === 'select' ? 'select' :
          tag === 'textarea' ? 'textarea' : tag);
        var name = el.getAttribute('aria-label') || el.getAttribute('title')
          || el.getAttribute('placeholder') || '';
        var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        var type = el.type || undefined;
        var value = el.value || undefined;

        results.push({
          index: idx,
          tag: tag, role: role, name: name, text: text, type: type, value: value,
          bbox: {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
          },
        });

        idx++;
      }

      return results;
    })()
  `) as InteractiveElement[];

  // Cap at 50 elements to keep token count low
  const capped = elements.slice(0, 50);

  const lines = capped.map(el => {
    let desc = `[${el.index}] ${el.role}`;
    if (el.name) desc += ` "${el.name}"`;
    else if (el.text && el.text.length > 0) desc += ` "${el.text}"`;
    if (el.type && el.type !== el.tag && el.type !== 'submit') desc += ` (${el.type})`;
    if (el.value) desc += ` value="${el.value}"`;
    return desc;
  });

  const url = page.url();
  const title = await page.title();

  // Scroll metrics — lets the agent know where it is on the page
  const scrollInfo = await page.evaluate(`
    (function() {
      var y = window.scrollY || document.documentElement.scrollTop;
      var h = document.documentElement.scrollHeight;
      var vh = window.innerHeight;
      return { scrollY: Math.round(y), scrollHeight: Math.round(h), viewportHeight: vh };
    })()
  `) as { scrollY: number; scrollHeight: number; viewportHeight: number };

  const scrollPct = scrollInfo.scrollHeight > 0
    ? Math.round((scrollInfo.scrollY + scrollInfo.viewportHeight) / scrollInfo.scrollHeight * 100)
    : 100;
  const atBottom = scrollPct >= 95;
  const scrollLine = `Scroll: ${scrollInfo.scrollY}px / ${scrollInfo.scrollHeight}px (${scrollPct}%)${atBottom ? ' [AT BOTTOM]' : ''}`;

  const more = elements.length > 50 ? `\n(${elements.length - 50} more elements not shown — scroll to reveal)` : '';
  const header = `URL: ${url}\nTitle: ${title}\n${scrollLine}\n${capped.length} elements:\n`;

  return { elements, formatted: header + lines.join('\n') + more };
}

/**
 * Legacy: get the full ARIA accessibility tree.
 * Prefer getInteractiveElements() for agent use — it's smaller and indexed.
 */
export async function getAccessibilityTree(page: Page): Promise<{
  tree: string;
  elementCount: number;
}> {
  try {
    const snapshot = await page.locator('body').ariaSnapshot();
    const lineCount = snapshot.split('\n').length;
    return { tree: snapshot, elementCount: lineCount };
  } catch {
    const tree = await page.evaluate(`
      (function() {
        function walk(el, depth) {
          var role = el.getAttribute('role') || el.tagName.toLowerCase();
          var name = el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').slice(0, 50);
          var prefix = '  '.repeat(depth);
          var line = prefix + '- ' + role;
          if (name) line += ' "' + name.replace(/"/g, '\\\\"') + '"';
          var lines = [line];
          for (var i = 0; i < el.children.length; i++) {
            lines.push(walk(el.children[i], depth + 1));
          }
          return lines.join('\\n');
        }
        return walk(document.body, 0);
      })()
    `) as string;
    const lineCount = tree.split('\n').length;
    return { tree, elementCount: lineCount };
  }
}

export async function getPageInfo(page: Page): Promise<{
  url: string;
  title: string;
  viewport: { width: number; height: number };
  loading: boolean;
}> {
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  let loading = false;
  try {
    loading = await page.evaluate(`document.readyState !== 'complete'`) as boolean;
  } catch {
    loading = true;
  }

  return {
    url: page.url(),
    title: await page.title(),
    viewport,
    loading,
  };
}
