import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type ChildNode, type Container } from 'postcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The styling rules of tech design 3.3: Tailwind utilities and shadcn/ui components only, so no stylesheet but
// globals.css, no inline styles, and nothing in globals.css beyond the Tailwind and shadcn setup.

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const GLOBALS = 'app/globals.css';

/**
 * shadcn/ui sources that set inline styles, each for a value utilities can't express. Any other file with a style
 * prop fails the guard.
 */
const INLINE_STYLE_ALLOWED: Record<string, string> = {
  'components/ui/sidebar.tsx': "the sidebar's widths as CSS variables, which its utilities read",
  'components/ui/progress.tsx': "the indicator's transform, computed from the value prop",
  'components/ui/toggle_group.tsx':
    'the gap between items as a CSS variable, from the spacing prop',
  'components/ui/sonner.tsx': "Sonner's colour variables, mapped to the theme tokens",
};

/** Paths under app/src, with forward slashes. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [relative(SRC, path).split(sep).join('/')];
  });
}

/** Stylesheets other than globals.css. */
function strayStylesheets(files: string[]): string[] {
  return files.filter((file) => /\.(css|scss|sass|less|styl)$/.test(file) && file !== GLOBALS);
}

/** Each `style` prop and `<style>` element in a TSX source, as `line: what`. */
function inlineStyles(source: string): string[] {
  const file = ts.createSourceFile(
    'file.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'style') {
      found.push(`${line(node)}: style prop`);
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === 'style'
    ) {
      found.push(`${line(node)}: <style> element`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const ALLOWED_IMPORTS = new Set(["'tailwindcss'", "'tw-animate-css'"]);
const BASE_SELECTORS = new Set(['*', 'html', 'body']);

/** Everything in globals.css outside the Tailwind and shadcn setup, as `line: what`. */
function globalsViolations(css: string): string[] {
  const violations: string[] = [];
  const flag = (node: ChildNode, what: string) =>
    violations.push(`${node.source?.start?.line ?? '?'}: ${what}`);
  // Token blocks hold custom properties only.
  const tokensOnly = (container: Container, where: string) => {
    for (const child of container.nodes ?? []) {
      if (child.type === 'comment') continue;
      if (child.type !== 'decl' || !child.prop.startsWith('--'))
        flag(child, `not a custom property in ${where}`);
    }
  };

  for (const node of postcss.parse(css).nodes) {
    if (node.type === 'comment') continue;
    if (node.type === 'rule') {
      if (node.selector === ':root' || node.selector === '.dark') tokensOnly(node, node.selector);
      else flag(node, `rule ${node.selector}`);
      continue;
    }
    if (node.type !== 'atrule') {
      flag(node, 'unexpected declaration');
      continue;
    }
    const at = `@${node.name} ${node.params}`;
    if (node.name === 'import' && ALLOWED_IMPORTS.has(node.params)) continue;
    if (node.name === 'plugin' && node.params === "'@tailwindcss/typography'") continue;
    if (node.name === 'custom-variant' && node.params.startsWith('dark ')) continue;
    if (node.name === 'theme' && node.params === 'inline') {
      tokensOnly(node, at);
      continue;
    }
    if (node.name === 'layer' && node.params === 'base' && node.nodes) {
      // shadcn's base rules: @apply on the universal selector and the document's elements, nothing else.
      for (const rule of node.nodes) {
        if (rule.type === 'comment') continue;
        if (
          rule.type !== 'rule' ||
          !rule.selectors.every((selector) => BASE_SELECTORS.has(selector))
        ) {
          flag(rule, `${rule.type === 'rule' ? `rule ${rule.selector}` : 'node'} in @layer base`);
          continue;
        }
        for (const child of rule.nodes) {
          if (child.type !== 'comment' && (child.type !== 'atrule' || child.name !== 'apply')) {
            flag(child, `not an @apply in ${rule.selector}`);
          }
        }
      }
      continue;
    }
    flag(node, at);
  }
  return violations;
}

describe('the style guard', () => {
  it('catches a stylesheet other than globals.css', () => {
    expect(
      strayStylesheets([
        GLOBALS,
        'components/gallery.tsx',
        'components/gallery.module.css',
        'app/extra.scss',
      ]),
    ).toEqual(['components/gallery.module.css', 'app/extra.scss']);
  });

  it('catches a style prop and a <style> element', () => {
    const source = [
      'export function Tile() {',
      '  return (',
      '    <div className="p-2" style={{ color: "red" }}>',
      '      <style>{".tile { color: red }"}</style>',
      '      <span style={undefined} />',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    expect(inlineStyles(source)).toEqual(['3: style prop', '4: <style> element', '5: style prop']);
  });

  it('passes class names, and props or text that only mention style', () => {
    const source = [
      'const STYLE_CLASS = "style-none";',
      'export function Tile({ styleName }: { styleName: string }) {',
      '  return <Chip styleName={styleName} className={STYLE_CLASS}>style=</Chip>;',
      '}',
    ].join('\n');
    expect(inlineStyles(source)).toEqual([]);
  });

  it('catches hand-written rules in globals.css', () => {
    const css = [
      "@import 'tailwindcss';",
      "@import './legacy.css';",
      '.gallery { display: grid; }',
      ':root { --radius: 0.5rem; color-scheme: light; }',
      '@layer base { .card { @apply p-2; } body { margin: 0; } }',
      '@layer legacy { body { margin: 0; } }',
      '@media (min-width: 40rem) { body { padding: 1rem; } }',
    ].join('\n');
    expect(globalsViolations(css)).toEqual([
      "2: @import './legacy.css'",
      '3: rule .gallery',
      '4: not a custom property in :root',
      '5: rule .card in @layer base',
      '5: not an @apply in body',
      '6: @layer legacy',
      '7: @media (min-width: 40rem)',
    ]);
  });

  it('passes the Tailwind and shadcn setup', () => {
    const css = [
      '/* tokens */',
      "@import 'tailwindcss';",
      "@import 'tw-animate-css';",
      "@plugin '@tailwindcss/typography';",
      '@custom-variant dark (&:is(.dark *));',
      ':root { --radius: 0.625rem; --background: oklch(1 0 0); }',
      '.dark { --background: oklch(0.145 0 0); }',
      '@theme inline { --color-background: var(--background); }',
      '@layer base { * { @apply border-border; } body { @apply bg-background text-foreground; } }',
    ].join('\n');
    expect(globalsViolations(css)).toEqual([]);
  });
});

describe('app/src', () => {
  const files = sourceFiles();

  it('has no stylesheet but globals.css', () => {
    expect(files).toContain(GLOBALS);
    expect(strayStylesheets(files)).toEqual([]);
  });

  it('has no inline styles outside the allowed shadcn/ui sources', () => {
    const found = files
      .filter((file) => file.endsWith('.tsx') && !(file in INLINE_STYLE_ALLOWED))
      .flatMap((file) =>
        inlineStyles(readFileSync(join(SRC, file), 'utf8')).map((at) => `${file}:${at}`),
      );
    expect(found).toEqual([]);
  });

  it('allows inline styles only in files that still have them', () => {
    for (const file of Object.keys(INLINE_STYLE_ALLOWED)) {
      expect(inlineStyles(readFileSync(join(SRC, file), 'utf8')), file).not.toEqual([]);
    }
  });

  it('keeps globals.css to the Tailwind and shadcn setup', () => {
    expect(globalsViolations(readFileSync(join(SRC, GLOBALS), 'utf8'))).toEqual([]);
  });
});
