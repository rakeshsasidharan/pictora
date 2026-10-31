import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

// WCAG 2.2 AA colour contrast (#30): text on its background in both themes, from the tokens in globals.css; and
// the reduced-motion rule there.

type Rgb = [number, number, number];
interface Colour {
  rgb: Rgb;
  alpha: number;
}

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

/** The custom properties of a token block (`:root` or `.dark`). */
function tokens(selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  postcss.parse(css).walkRules(selector, (rule) => {
    rule.walkDecls(/^--/, (decl) => {
      found[decl.prop.slice(2)] = decl.value;
    });
  });
  return found;
}

const encode = (linear: number) =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
const decode = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

/** `oklch(L C H)` or `oklch(L C H / A%)` as gamma-encoded sRGB, clipped to the gamut. */
function parseOklch(value: string): Colour {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+)%)?\)$/.exec(value);
  if (!match) throw new Error(`not an oklch colour: ${value}`);
  const [l, c, h] = [Number(match[1]), Number(match[2]), (Number(match[3]) * Math.PI) / 180];
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  const linear: Rgb = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  return {
    rgb: linear.map((channel) => encode(Math.min(1, Math.max(0, channel)))) as Rgb,
    alpha: match[4] === undefined ? 1 : Number(match[4]) / 100,
  };
}

const WHITE: Colour = { rgb: [1, 1, 1], alpha: 1 };

/** A colour painted over an opaque one, as the browser blends it. */
function over(top: Colour, bottom: Rgb): Rgb {
  return top.rgb.map(
    (channel, index) => channel * top.alpha + bottom[index]! * (1 - top.alpha),
  ) as Rgb;
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Text tokens and the backgrounds they sit on in the components. */
const TEXT_PAIRS: [text: string, background: string][] = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'popover'],
  ['muted-foreground', 'sidebar'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
];

/** How opaque the destructive button and badge are in the dark theme (`dark:bg-destructive/<n>`). */
function darkDestructiveAlpha(source: string): number {
  const match = /dark:bg-destructive\/(\d+)/.exec(source);
  if (!match) throw new Error('no dark destructive background');
  return Number(match[1]) / 100;
}

const THEMES = [
  ['light', tokens(':root')],
  ['dark', { ...tokens(':root'), ...tokens('.dark') }],
] as const;

describe.each(THEMES)('the %s theme', (theme, values) => {
  const colour = (name: string) => {
    const value = values[name];
    if (!value) throw new Error(`no --${name} token`);
    return parseOklch(value);
  };
  const page = colour('background').rgb;

  it.each(TEXT_PAIRS)('%s on %s meets AA for body text (4.5:1)', (text, background) => {
    const behind = over(colour(background), page);
    expect(contrast(over(colour(text), behind), behind)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['button', 'badge'])('white text on a destructive %s meets AA', (component) => {
    const source = readFileSync(
      new URL(`../src/components/ui/${component}.tsx`, import.meta.url),
      'utf8',
    );
    const fill = colour('destructive');
    const behind =
      theme === 'dark'
        ? over({ rgb: fill.rgb, alpha: darkDestructiveAlpha(source) }, page)
        : over(fill, page);
    expect(contrast(WHITE.rgb, behind)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the contrast check', () => {
  it('measures black on white as 21:1 and a colour on itself as 1:1', () => {
    expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
    expect(contrast([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBe(1);
  });

  it('reads oklch white, black and a translucent colour', () => {
    expect(parseOklch('oklch(1 0 0)').rgb.map((value) => value.toFixed(3))).toEqual([
      '1.000',
      '1.000',
      '1.000',
    ]);
    expect(parseOklch('oklch(0 0 0)').rgb).toEqual([0, 0, 0]);
    expect(parseOklch('oklch(1 0 0 / 10%)').alpha).toBeCloseTo(0.1);
  });
});

describe('reduced motion', () => {
  it('turns off animations, transitions and smooth scrolling in globals.css (#30)', () => {
    for (const utility of [
      'motion-reduce:animate-none!',
      'motion-reduce:transition-none!',
      'motion-reduce:scroll-auto!',
    ]) {
      expect(css).toContain(utility);
    }
  });
});
