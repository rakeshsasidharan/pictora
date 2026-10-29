'use client';

import { CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll_area';
import { cn } from '@/lib/utils';
import { versionDescription } from '../lib/edit_options';
import type { ImageVersionBody } from '../lib/images';

/** The words a version was made with: its edit instruction, or the original prompt. */
export function versionPrompt(version: ImageVersionBody): string | undefined {
  return version.editInstruction ?? version.prompt;
}

/** Copies a version's prompt or edit instruction, confirming either way with a toast. */
export async function copyPrompt(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Prompt copied');
  } catch {
    toast.error("Couldn't copy the prompt. Select the text and copy it instead.");
  }
}

export interface VersionCardProps {
  version: ImageVersionBody;
  selected: boolean;
  onSelect: (version: number) => void;
}

/**
 * One version in the edit panel's history (#125): a button to select it, with its thumbnail and what it was
 * edited from; its prompt or instruction in a short box that scrolls when the text is long, so every card stays
 * the same size; and a button that copies that text.
 */
export function VersionCard({ version, selected, onSelect }: VersionCardProps) {
  const prompt = versionPrompt(version);
  return (
    <li
      data-slot="version-card"
      className={cn(
        'rounded-lg border bg-card p-2 text-card-foreground',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
    >
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          aria-pressed={selected}
          aria-label={`Version ${version.version}`}
          onClick={() => onSelect(version.version)}
          className="h-auto min-w-0 flex-1 justify-start gap-3 p-0 text-left text-base font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
          <img
            src={version.thumbUrl}
            alt=""
            width={48}
            height={48}
            className="size-12 shrink-0 rounded bg-muted object-cover"
          />
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold">Version {version.version}</span>
            {version.parentVersion !== undefined && (
              <span className="text-xs text-muted-foreground">
                Edited from version {version.parentVersion}
              </span>
            )}
          </span>
        </Button>
        {prompt && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy the prompt of version ${version.version}`}
            title="Copy prompt"
            onClick={() => void copyPrompt(prompt)}
          >
            <CopyIcon />
          </Button>
        )}
      </div>
      <ScrollArea
        type="auto"
        className="mt-2"
        viewportProps={{
          // Focusable, so the text can be scrolled from the keyboard.
          tabIndex: 0,
          role: 'group',
          'aria-label': `Prompt of version ${version.version}`,
          className: 'max-h-20 rounded',
        }}
      >
        <p className="pr-3 text-sm break-words whitespace-pre-wrap">
          {versionDescription(version)}
        </p>
      </ScrollArea>
    </li>
  );
}
