// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MAX_UPLOAD_BYTES } from '@pictora/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadImage } from '../src/components/upload_image';
import {
  S3_REJECTED_MESSAGE,
  UploadError,
  browserUploadClient,
  type UploadClient,
  type UploadedImage,
  type UploadTicket,
} from '../src/lib/upload_client';
import { TOO_LARGE_MESSAGE, WRONG_TYPE_MESSAGE } from '../src/lib/upload_files';

const TICKET: UploadTicket = {
  uploadId: '01JAPKAD0000000000000000AA',
  url: 'https://bucket.s3.us-west-2.amazonaws.com/',
  fields: { key: 'uploads/sub/01JAPKAD0000000000000000AA', 'Content-Type': 'image/jpeg' },
};
const IMAGE: UploadedImage = {
  imageId: TICKET.uploadId,
  version: 1,
  width: 800,
  height: 600,
  url: 'https://signed.example/v1.png',
  downloadUrl: 'https://signed.example/v1.png?download',
};

/** A file of the given type that reports `size` bytes without allocating them. */
function file(name: string, type: string, size = 1024): File {
  const value = new File(['x'], name, { type });
  Object.defineProperty(value, 'size', { value: size });
  return value;
}

function fakeClient(overrides: Partial<UploadClient> = {}): UploadClient {
  return {
    start: vi.fn(async () => TICKET),
    send: vi.fn(async () => {}),
    complete: vi.fn(async () => IMAGE),
    ...overrides,
  };
}

function pick(selected: File) {
  fireEvent.change(screen.getByLabelText('Choose an image to upload'), {
    target: { files: [selected] },
  });
}

describe('UploadImage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers an Upload image button that opens the file picker for JPEG, PNG and WebP', () => {
    render(<UploadImage client={fakeClient()} />);
    const input = screen.getByLabelText<HTMLInputElement>('Choose an image to upload');
    expect(input.accept).toBe('image/jpeg,image/png,image/webp');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
    expect(click).toHaveBeenCalled();
  });

  it.each([
    ['a PDF', file('doc.pdf', 'application/pdf'), WRONG_TYPE_MESSAGE],
    ['a GIF', file('cat.gif', 'image/gif'), WRONG_TYPE_MESSAGE],
    ['an 11 MB JPEG', file('big.jpg', 'image/jpeg', 11 * 1024 * 1024), TOO_LARGE_MESSAGE],
    ['an empty file', file('empty.png', 'image/png', 0), 'That file is empty. Pick another image.'],
  ])('refuses %s before uploading anything', (_name, selected, message) => {
    const client = fakeClient();
    render(<UploadImage client={client} />);
    pick(selected);
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(client.start).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly 10 MB', async () => {
    const client = fakeClient();
    render(<UploadImage client={client} />);
    pick(file('max.webp', 'image/webp', MAX_UPLOAD_BYTES));
    await screen.findByAltText('Your uploaded image');
    expect(client.start).toHaveBeenCalled();
  });

  it('shows upload progress, then the check, then the new image', async () => {
    let progress: (percent: number) => void = () => {};
    let finishSend: () => void = () => {};
    let finishComplete: (image: UploadedImage) => void = () => {};
    const client = fakeClient({
      send: vi.fn(
        (_ticket, _file, onProgress) =>
          new Promise<void>((resolve) => {
            progress = onProgress;
            finishSend = resolve;
          }),
      ),
      complete: vi.fn(() => new Promise<UploadedImage>((resolve) => (finishComplete = resolve))),
    });
    render(<UploadImage client={client} />);
    const photo = file('photo.jpg', 'image/jpeg', 5 * 1024 * 1024);
    pick(photo);

    await screen.findByText('Uploading photo.jpg… 0%');
    expect(client.start).toHaveBeenCalledWith(photo);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Upload image' }).disabled).toBe(
      true,
    );
    progress(42);
    await screen.findByText('Uploading photo.jpg… 42%');
    expect(screen.getByRole<HTMLProgressElement>('progressbar').value).toBe(42);

    finishSend();
    await screen.findByText('Checking photo.jpg…');
    expect(client.complete).toHaveBeenCalledWith(TICKET.uploadId);

    finishComplete(IMAGE);
    const image = await screen.findByAltText<HTMLImageElement>('Your uploaded image');
    expect(image.src).toBe(IMAGE.url);
    expect(screen.getByText(/saved as version 1 of a new image/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download PNG' }).getAttribute('href')).toBe(
      IMAGE.downloadUrl,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Upload image' }).disabled).toBe(
      false,
    );
  });

  it('says edit is coming soon', async () => {
    render(<UploadImage client={fakeClient()} />);
    pick(file('photo.png', 'image/png'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit this image' }));
    expect(screen.getByText('Edit coming soon.')).toBeTruthy();
  });

  it('shows why a blocked upload was refused', async () => {
    const client = fakeClient({
      complete: vi.fn(async () => {
        throw new UploadError('This image was blocked by our content policy.');
      }),
    });
    render(<UploadImage client={client} />);
    pick(file('photo.png', 'image/png'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This image was blocked by our content policy.',
      ),
    );
  });

  it('shows a refusal from S3', async () => {
    const client = fakeClient({
      send: vi.fn(async () => {
        throw new UploadError(S3_REJECTED_MESSAGE);
      }),
    });
    render(<UploadImage client={client} />);
    pick(file('photo.png', 'image/png'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(S3_REJECTED_MESSAGE));
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('uploads a dropped file', async () => {
    const client = fakeClient();
    render(<UploadImage client={client} />);
    const zone = screen.getByTestId('drop-zone');
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(zone.className).toContain('drop-zone-active');
    const dropped = file('dropped.webp', 'image/webp');
    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } });
    await screen.findByAltText('Your uploaded image');
    expect(client.start).toHaveBeenCalledWith(dropped);
    expect(zone.className).not.toContain('drop-zone-active');
  });

  it('checks a dropped file the same way', () => {
    const client = fakeClient();
    render(<UploadImage client={client} />);
    fireEvent.drop(screen.getByTestId('drop-zone'), {
      dataTransfer: { files: [file('notes.pdf', 'application/pdf')] },
    });
    expect(screen.getByRole('alert').textContent).toBe(WRONG_TYPE_MESSAGE);
    expect(client.start).not.toHaveBeenCalled();
  });
});

describe('browserUploadClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts an upload with the file type and size', async () => {
    const fetchMock = vi.fn(async () => Response.json(TICKET));
    vi.stubGlobal('fetch', fetchMock);
    const ticket = await browserUploadClient.start(file('photo.jpg', 'image/jpeg', 2048));
    expect(ticket).toEqual(TICKET);
    expect(fetchMock).toHaveBeenCalledWith('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', size: 2048 }),
    });
  });

  it("throws the API's message when the upload is refused", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'Only JPEG, PNG or WebP images can be uploaded.' }, { status: 400 }),
      ),
    );
    await expect(browserUploadClient.start(file('a.pdf', 'application/pdf'))).rejects.toEqual(
      new UploadError('Only JPEG, PNG or WebP images can be uploaded.'),
    );
  });

  it('completes an upload and returns the image', async () => {
    const fetchMock = vi.fn(async () => Response.json({ image: IMAGE }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await browserUploadClient.complete(TICKET.uploadId)).toEqual(IMAGE);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/uploads/${TICKET.uploadId}/complete`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  /** A stand-in for XMLHttpRequest that answers with `status` after reporting progress. */
  function fakeXhr(status: number) {
    const sent: { url?: string; body?: FormData } = {};
    class FakeXhr {
      status = 0;
      private listeners: Record<string, (() => void)[]> = {};
      private uploadListeners: ((event: Partial<ProgressEvent>) => void)[] = [];
      upload = {
        addEventListener: (_type: string, listener: (event: Partial<ProgressEvent>) => void) =>
          this.uploadListeners.push(listener),
      };
      addEventListener(type: string, listener: () => void) {
        (this.listeners[type] ??= []).push(listener);
      }
      open(_method: string, url: string) {
        sent.url = url;
      }
      send(body: FormData) {
        sent.body = body;
        for (const listener of this.uploadListeners) {
          listener({ lengthComputable: true, loaded: 50, total: 100 });
        }
        this.status = status;
        for (const listener of this.listeners.load ?? []) listener();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    return sent;
  }

  it('posts the fields then the file to S3, reporting progress', async () => {
    const sent = fakeXhr(204);
    const progress = vi.fn();
    const photo = file('photo.jpg', 'image/jpeg');
    await browserUploadClient.send(TICKET, photo, progress);
    expect(sent.url).toBe(TICKET.url);
    expect([...sent.body!.keys()]).toEqual(['key', 'Content-Type', 'file']);
    expect(progress).toHaveBeenCalledWith(50);
  });

  it('reports a refusal from S3', async () => {
    fakeXhr(403);
    await expect(
      browserUploadClient.send(TICKET, file('photo.jpg', 'image/jpeg'), () => {}),
    ).rejects.toEqual(new UploadError(S3_REJECTED_MESSAGE));
  });
});
