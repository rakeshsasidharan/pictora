import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Tech design 3.3: screens are built from the shadcn/ui components in components/ui, so no file outside it renders
// a raw control that has a shadcn equivalent, or a hand-built dialog.

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const UI_DIR = 'components/ui/';

/** Raw elements with a shadcn equivalent (Input, Textarea, Select, Button, Dialog, Collapsible, Progress). */
const RAW_CONTROLS = new Set([
  'input',
  'textarea',
  'select',
  'button',
  'dialog',
  'details',
  'progress',
]);
const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

/** Raw controls allowed outside components/ui, by file and element, each with its reason. */
const ALLOWED: Record<string, Record<string, string>> = {
  'components/upload_image.tsx': {
    input:
      'a visually hidden file input behind the shadcn Upload image Button; only a native input opens the file picker',
  },
  'components/edit_panel.tsx': {
    input:
      'a visually hidden file input behind the shadcn Upload reference Button; only a native input opens the file picker',
  },
};

/** Paths of the .tsx files under app/src, outside components/ui, with forward slashes. */
function screenFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return screenFiles(path);
    const file = relative(SRC, path).split(sep).join('/');
    return file.endsWith('.tsx') && !file.startsWith(UI_DIR) ? [file] : [];
  });
}

interface Finding {
  line: number;
  /** The raw element's tag, or `role="dialog"` for a hand-built dialog. */
  what: string;
}

/** Each raw control and hand-set dialog role in a TSX source. */
function rawControls(source: string): Finding[] {
  const file = ts.createSourceFile(
    'file.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: Finding[] = [];
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      if (RAW_CONTROLS.has(tag)) found.push({ line: line(node), what: tag });
    }
    if (ts.isJsxAttribute(node) && node.name.getText() === 'role' && node.initializer) {
      const value = ts.isStringLiteral(node.initializer)
        ? node.initializer.text
        : ts.isJsxExpression(node.initializer) &&
            node.initializer.expression &&
            ts.isStringLiteralLike(node.initializer.expression)
          ? node.initializer.expression.text
          : undefined;
      if (value && DIALOG_ROLES.has(value))
        found.push({ line: line(node), what: `role="${value}"` });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The findings in `file` that its allow-list entry doesn't cover, as `file:line: what`. */
function disallowed(
  file: string,
  source: string,
  allowed: Record<string, Record<string, string>> = ALLOWED,
): string[] {
  return rawControls(source)
    .filter((finding) => !allowed[file]?.[finding.what])
    .map((finding) => `${file}:${finding.line}: ${finding.what}`);
}

describe('the control guard', () => {
  it('catches raw controls and hand-built dialogs', () => {
    const source = [
      'export function Panel() {',
      '  return (',
      '    <div role="dialog">',
      '      <button type="button">Save</button>',
      '      <select><option>One</option></select>',
      '      <input type="text" />',
      '      <textarea />',
      '      <details><summary>More</summary></details>',
      '      <progress value={1} />',
      '      <dialog open />',
      "      <section role={'alertdialog'} />",
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    expect(disallowed('components/panel.tsx', source)).toEqual([
      'components/panel.tsx:3: role="dialog"',
      'components/panel.tsx:4: button',
      'components/panel.tsx:5: select',
      'components/panel.tsx:6: input',
      'components/panel.tsx:7: textarea',
      'components/panel.tsx:8: details',
      'components/panel.tsx:9: progress',
      'components/panel.tsx:10: dialog',
      'components/panel.tsx:11: role="alertdialog"',
    ]);
  });

  it('passes shadcn components, other roles, and text that only mentions a control', () => {
    const source = [
      'export function Panel() {',
      '  return (',
      '    <Dialog>',
      '      <Button type="button">button</Button>',
      '      <Input type="text" />',
      '      <p role="status">Use the select below, or press the button.</p>',
      '    </Dialog>',
      '  );',
      '}',
    ].join('\n');
    expect(disallowed('components/panel.tsx', source)).toEqual([]);
  });

  it('accepts an allow-listed control only in its file, and only that element', () => {
    const source = '<><input type="file" className="sr-only" /><button type="button" /></>';
    const allowed = { 'components/upload.tsx': { input: 'a hidden file input behind a Button' } };
    expect(disallowed('components/upload.tsx', source, allowed)).toEqual([
      'components/upload.tsx:1: button',
    ]);
    expect(disallowed('components/other.tsx', source, allowed)).toEqual([
      'components/other.tsx:1: input',
      'components/other.tsx:1: button',
    ]);
  });
});

describe('app/src', () => {
  const files = screenFiles();

  it('renders no raw controls outside components/ui, apart from the allow-listed ones', () => {
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) => disallowed(file, readFileSync(join(SRC, file), 'utf8')));
    expect(found).toEqual([]);
  });

  it('allow-lists only controls that are still there', () => {
    for (const [file, elements] of Object.entries(ALLOWED)) {
      const present = rawControls(readFileSync(join(SRC, file), 'utf8')).map(
        (finding) => finding.what,
      );
      for (const element of Object.keys(elements))
        expect(present, `${file}: ${element}`).toContain(element);
    }
  });
});
