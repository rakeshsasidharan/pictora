import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

/** The WCAG 2.2 AA rule sets axe checks (PRD, Accessibility). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Impacts that fail the suite; minor and moderate findings are left to review (#30). */
const FAILING_IMPACTS = new Set(['serious', 'critical']);

/** The fields of an axe violation the report needs. */
export interface Violation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[] }[];
}

/** Violations that fail the suite, one line each: rule, impact, help and the elements it found. */
export function seriousViolations(violations: readonly Violation[]): string[] {
  return violations
    .filter((violation) => FAILING_IMPACTS.has(violation.impact ?? ''))
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} at ${violation.nodes
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    );
}

/**
 * Runs axe on the page as it is now, in the light and dark themes, and fails on any serious or critical
 * WCAG 2.2 AA violation. The theme follows the system, so emulating the colour scheme switches it.
 */
export async function expectNoSeriousViolations(page: Page): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    // next-themes sets the class on <html> once it sees the change.
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${colorScheme}\\b`));
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(seriousViolations(results.violations), `${colorScheme} theme`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: null });
}

/** How far the page scrolls sideways; 0 when it fits the window. */
export function horizontalOverflow(page: Page): Promise<number> {
  return page
    .locator('html')
    .evaluate(
      (html: { scrollWidth: number; clientWidth: number }) => html.scrollWidth - html.clientWidth,
    );
}

/** The widths the layout is checked at: a small phone, a tablet and a laptop (PRD, Responsiveness). */
export const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

/** Most key presses to reach a control; a page with more stops than this needs a skip link. */
const MAX_PRESSES = 80;

/** Presses the key until the control has the focus, up to `max` times; false if it never gets it. */
export async function pressUntilFocused(
  page: Page,
  target: Locator,
  key: string,
  max = MAX_PRESSES,
): Promise<boolean> {
  for (let presses = 0; presses <= max; presses++) {
    if (await isFocused(target)) return true;
    if (presses < max) await page.keyboard.press(key);
  }
  return false;
}

/** Presses Tab until the control has the focus, as a keyboard user would. Fails if it can't be reached. */
export async function tabTo(page: Page, target: Locator): Promise<void> {
  expect(await pressUntilFocused(page, target, 'Tab'), `Tab never reached ${target}`).toBe(true);
}

/** Moves through a group (a toggle group or a select's options) with an arrow key until the item has the focus. */
export async function arrowTo(page: Page, target: Locator, key = 'ArrowDown'): Promise<void> {
  expect(await pressUntilFocused(page, target, key, 20), `${key} never reached ${target}`).toBe(
    true,
  );
}

function isFocused(target: Locator): Promise<boolean> {
  return target
    .first()
    .evaluate(
      (element: { ownerDocument: { activeElement: unknown } }) =>
        element.ownerDocument.activeElement === element,
    )
    .catch(() => false);
}
