'use client';

import { DownloadIcon, ImageUpIcon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { notifyImagesChanged } from '../lib/images_changed';
import { editImagePath } from '../lib/site';
import {
  browserUploadClient,
  UploadError,
  type UploadClient,
  type UploadedImage,
} from '../lib/upload_client';
import { UPLOAD_ACCEPT, uploadFileError } from '../lib/upload_files';

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string; percent: number }
  | { phase: 'checking'; fileName: string }
  | { phase: 'done'; image: UploadedImage }
  | { phase: 'error'; message: string };

/**
 * The upload step of an edit (EDIT-2): pick or drop a JPEG, PNG or WebP of up to 10 MB. The file is checked
 * here first, sent straight to S3 with a progress bar, then checked and moderated by the app, and becomes
 * version 1 of a new image. Uploads cost no points.
 */
export function UploadImage({ client = browserUploadClient }: { client?: UploadClient }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const [dragging, setDragging] = useState(false);
  const busy = state.phase === 'uploading' || state.phase === 'checking';

  async function upload(file: File) {
    const invalid = uploadFileError(file);
    if (invalid) {
      setState({ phase: 'error', message: invalid });
      return;
    }
    setState({ phase: 'uploading', fileName: file.name, percent: 0 });
    try {
      const ticket = await client.start(file);
      await client.send(ticket, file, (percent) =>
        setState({ phase: 'uploading', fileName: file.name, percent }),
      );
      setState({ phase: 'checking', fileName: file.name });
      const image = await client.complete(ticket.uploadId);
      setState({ phase: 'done', image });
      notifyImagesChanged();
    } catch (error) {
      setState({
        phase: 'error',
        message:
          error instanceof UploadError
            ? error.message
            : "We couldn't upload your image. Please try again.",
      });
    }
  }

  function chooseFile() {
    input.current?.click();
  }

  function dragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!busy) setDragging(true);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }

  return (
    <Card data-slot="upload-image" aria-labelledby="upload-heading" role="region">
      <CardHeader>
        <CardTitle>
          <h2 id="upload-heading" className="text-lg font-semibold">
            Start from your own image
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div
          className={cn(
            'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors',
            dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/30',
          )}
          data-testid="drop-zone"
          data-dragging={dragging ? 'true' : undefined}
          onDragOver={dragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <ImageUpIcon className="size-10 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm">Drag a JPEG, PNG or WebP image of up to 10 MB here, or</p>
          <Button type="button" onClick={chooseFile} disabled={busy}>
            Upload image
          </Button>
          <input
            ref={input}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            aria-label="Choose an image to upload"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so picking the same file again still uploads it.
              event.target.value = '';
              if (file) void upload(file);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Uploads are free and are checked against our content policy.
          </p>
        </div>

        {state.phase === 'uploading' && (
          <div className="flex flex-col gap-2" role="status">
            <p id="upload-progress-label" className="text-sm">
              Uploading {state.fileName}… {state.percent}%
            </p>
            <Progress aria-labelledby="upload-progress-label" value={state.percent} />
          </div>
        )}
        {state.phase === 'checking' && (
          <p className="text-sm text-muted-foreground" role="status">
            Checking {state.fileName}…
          </p>
        )}
        {state.phase === 'error' && (
          <p className="text-sm text-destructive" role="alert">
            {state.message}
          </p>
        )}
        {state.phase === 'done' && (
          <figure className="flex flex-col gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
            <img
              src={state.image.url}
              alt="Your uploaded image"
              width={state.image.width}
              height={state.image.height}
              className="h-auto max-h-[60svh] w-full rounded-lg border bg-muted object-contain"
            />
            <figcaption role="status" className="text-sm text-muted-foreground">
              Uploaded. It&apos;s saved as version 1 of a new image.
            </figcaption>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href={editImagePath(state.image.imageId)}>
                  <PencilIcon aria-hidden="true" />
                  Edit this image
                </Link>
              </Button>
              <Button asChild variant="outline">
                <a href={state.image.downloadUrl}>
                  <DownloadIcon aria-hidden="true" />
                  Download PNG
                </a>
              </Button>
            </div>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}
