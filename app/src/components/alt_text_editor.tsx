'use client';

import { MAX_ALT_TEXT_OVERRIDE_LENGTH } from '@pictora/core';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { defaultAltText, versionAltText } from '../lib/edit_options';
import type { ImageVersionBody, VersionAltTextBody } from '../lib/images';

/** Shown once the alt text is saved or reset. */
export const ALT_TEXT_SAVED_MESSAGE = 'Alt text saved.';

/** Where a version's alt text comes from, under it. */
export function altTextSource(version: ImageVersionBody): string {
  if (version.altText !== undefined) return 'Written by you.';
  if (version.editInstruction) return 'From the edit instruction.';
  if (version.source === 'upload') return 'The default for an upload.';
  return 'From the prompt.';
}

export interface AltTextEditorProps {
  imageId: string;
  version: ImageVersionBody;
  /** Called with the version's own alt text once saved, or undefined once it is back to the default. */
  onSaved: (altText: string | undefined) => void;
}

/**
 * The alt text of a version in the detail view (accessibility, #30): what screen readers read for the picture,
 * which is the prompt or edit instruction unless the user wrote their own. Edit opens a text box; Save sends it
 * to `PATCH /api/images/:id/versions/:n`, and "Use the default" goes back to the prompt or instruction.
 */
export function AltTextEditor({ imageId, version, onSaved }: AltTextEditorProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const current = versionAltText(version);
  const own = version.altText !== undefined;

  function start() {
    setDraft(current);
    setError(undefined);
    setEditing(true);
  }

  async function save(altText: string | null) {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/images/${encodeURIComponent(imageId)}/versions/${version.version}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ altText }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as Partial<VersionAltTextBody> & {
        error?: string;
      };
      if (!response.ok) {
        setError(body.error ?? "We couldn't save the alt text. Please try again.");
        return;
      }
      onSaved(body.altText ?? undefined);
      setEditing(false);
      toast.success(ALT_TEXT_SAVED_MESSAGE);
    } catch {
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('Write some alt text, or use the default.');
      return;
    }
    // Saving the default as it is keeps following the prompt.
    void save(trimmed === defaultAltText(version) && !own ? null : trimmed);
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="break-words whitespace-pre-wrap">{current}</p>
        <p className="text-xs text-muted-foreground">{altTextSource(version)}</p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={start}>
          Edit alt text
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} aria-label="Alt text">
      <Label htmlFor={`${id}-alt`} className="sr-only">
        Alt text
      </Label>
      <Textarea
        id={`${id}-alt`}
        value={draft}
        maxLength={MAX_ALT_TEXT_OVERRIDE_LENGTH}
        autoFocus
        aria-describedby={`${id}-hint`}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Describe the picture for people who can&apos;t see it. Up to {MAX_ALT_TEXT_OVERRIDE_LENGTH}{' '}
        characters.
      </p>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
        {own && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void save(null)}
          >
            Use the default
          </Button>
        )}
      </div>
    </form>
  );
}
