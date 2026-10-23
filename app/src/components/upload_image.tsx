'use client';

import Link from 'next/link';
import { useRef, useState, type DragEvent } from 'react';
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
    <section className="upload-image" aria-labelledby="upload-heading">
      <h2 id="upload-heading">Start from your own image</h2>
      <div
        className={dragging ? 'drop-zone drop-zone-active' : 'drop-zone'}
        data-testid="drop-zone"
        onDragOver={dragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <p>Drag a JPEG, PNG or WebP image of up to 10 MB here, or</p>
        <button
          type="button"
          className="button button-primary"
          onClick={chooseFile}
          disabled={busy}
        >
          Upload image
        </button>
        <input
          ref={input}
          type="file"
          accept={UPLOAD_ACCEPT}
          className="visually-hidden"
          aria-label="Choose an image to upload"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared, so picking the same file again still uploads it.
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
        <p className="field-hint">Uploads are free and are checked against our content policy.</p>
      </div>

      {state.phase === 'uploading' && (
        <div className="upload-progress" role="status">
          <label htmlFor="upload-progress">
            Uploading {state.fileName}… {state.percent}%
          </label>
          <progress id="upload-progress" max={100} value={state.percent} />
        </div>
      )}
      {state.phase === 'checking' && (
        <p className="upload-progress" role="status">
          Checking {state.fileName}…
        </p>
      )}
      {state.phase === 'error' && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
      {state.phase === 'done' && (
        <figure className="uploaded-image">
          {/* eslint-disable-next-line @next/next/no-img-element -- presigned S3 URLs change on every request, so the image optimiser can't cache them */}
          <img
            src={state.image.url}
            alt="Your uploaded image"
            width={state.image.width}
            height={state.image.height}
          />
          <figcaption role="status">
            Uploaded. It&apos;s saved as version 1 of a new image.
          </figcaption>
          <div className="result-actions">
            <Link className="button button-primary" href={editImagePath(state.image.imageId)}>
              Edit this image
            </Link>
            <a className="button" href={state.image.downloadUrl}>
              Download PNG
            </a>
          </div>
        </figure>
      )}
    </section>
  );
}
