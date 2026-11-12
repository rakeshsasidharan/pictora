'use client';

import { MAX_TAG_LENGTH, tagSchema } from '@pictora/core';
import { PlusIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TagBody } from '../lib/collections';

export interface TagInputProps {
  /** The caller's tags, offered as suggestions; undefined until they load. */
  suggestions?: TagBody[];
  /** Tags not to suggest, such as the image's own. */
  exclude?: readonly string[];
  /** Called with a valid, normalised tag; resolves once it's added. */
  onAdd: (tag: string) => Promise<void> | void;
  /** Called when the field is first focused, to load the suggestions. */
  onFocus?: () => void;
  disabled?: boolean;
  label?: string;
}

/**
 * A field to add a tag (tech design 4.2), with the user's own tags as suggestions (a `datalist`, so the browser
 * shows and filters them). The tag is checked as the API checks it, and the reason shown when it isn't valid.
 */
export function TagInput({
  suggestions,
  exclude = [],
  onAdd,
  onFocus,
  disabled = false,
  label = 'Add a tag',
}: TagInputProps) {
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const offered = (suggestions ?? []).filter((tag) => !exclude.includes(tag.tag));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = tagSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a tag.');
      return;
    }
    setError(undefined);
    setAdding(true);
    try {
      await onAdd(parsed.data);
      setValue('');
    } finally {
      setAdding(false);
    }
  }

  return (
    <form className="flex flex-col gap-1" onSubmit={(event) => void submit(event)} noValidate>
      <label htmlFor={`${id}-tag`} className="sr-only">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={`${id}-tag`}
          list={`${id}-suggestions`}
          value={value}
          maxLength={MAX_TAG_LENGTH}
          placeholder={label}
          autoComplete="off"
          disabled={disabled || adding}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onFocus={onFocus}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
          className="h-8"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={disabled || adding || value.trim() === ''}
        >
          <PlusIcon aria-hidden="true" />
          Add
        </Button>
      </div>
      <datalist id={`${id}-suggestions`}>
        {offered.map((tag) => (
          <option key={tag.tag} value={tag.tag} />
        ))}
      </datalist>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
