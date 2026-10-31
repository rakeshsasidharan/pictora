import { describe, expect, it } from 'vitest';
import { WCAG_TAGS, seriousViolations, type Violation } from '../src/accessibility.js';

const violation = (id: string, impact: string | null, targets: string[][]): Violation => ({
  id,
  impact,
  help: `${id} help`,
  nodes: targets.map((target) => ({ target })),
});

describe('seriousViolations', () => {
  it('keeps serious and critical violations, one line each with the elements found', () => {
    expect(
      seriousViolations([
        violation('color-contrast', 'serious', [['p.muted'], ['span.badge']]),
        violation('button-name', 'critical', [['button.icon']]),
      ]),
    ).toEqual([
      'color-contrast (serious): color-contrast help at p.muted, span.badge',
      'button-name (critical): button-name help at button.icon',
    ]);
  });

  it('leaves minor and moderate findings, and those without an impact, to review', () => {
    expect(
      seriousViolations([
        violation('region', 'moderate', [['div']]),
        violation('meta-viewport-large', 'minor', [['meta']]),
        violation('unknown', null, [['div']]),
      ]),
    ).toEqual([]);
  });

  it('names an element inside a frame by its whole path', () => {
    expect(seriousViolations([violation('label', 'critical', [['iframe', 'input']])])).toEqual([
      'label (critical): label help at iframe input',
    ]);
  });
});

describe('WCAG_TAGS', () => {
  it('checks WCAG 2.0, 2.1 and 2.2 at levels A and AA', () => {
    expect(WCAG_TAGS).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  });
});
