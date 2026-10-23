import { describe, expect, it, vi } from 'vitest';
import {
  LANDED_AT_KEY,
  TTFI_PATH,
  TTFI_SENT_KEY,
  markLanding,
  reportFirstImage,
} from '../src/lib/first_image';

/** An in-memory stand-in for session or local storage. */
function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe('markLanding', () => {
  it('keeps the first page load of the tab, not later ones', () => {
    const session = store();
    markLanding(session, 1_000);
    markLanding(session, 5_000);
    expect(session.getItem(LANDED_AT_KEY)).toBe('1000');
  });

  it('does nothing when storage is unavailable or throws', () => {
    expect(() => markLanding(undefined, 1_000)).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(() => markLanding(broken, 1_000)).not.toThrow();
  });
});

describe('reportFirstImage', () => {
  const ok = () => vi.fn(async () => new Response('{"recorded":true}', { status: 200 }));

  it('sends the time from landing to the first image once per browser', async () => {
    const session = store({ [LANDED_AT_KEY]: '10000' });
    const local = store();
    const fetchFn = ok();
    expect(await reportFirstImage({ now: 52_400, session, local, fetchFn })).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(TTFI_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: 42_400 }),
    });
    expect(local.getItem(TTFI_SENT_KEY)).toBe('1');
    expect(await reportFirstImage({ now: 60_000, session, local, fetchFn })).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends nothing without a landing time, or with a clock that went backwards', async () => {
    const fetchFn = ok();
    expect(await reportFirstImage({ now: 1, session: store(), local: store(), fetchFn })).toBe(
      false,
    );
    expect(
      await reportFirstImage({
        now: 1,
        session: store({ [LANDED_AT_KEY]: '5000' }),
        local: store(),
        fetchFn,
      }),
    ).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('tries again after a network failure or a 429, and not after the server decided', async () => {
    const session = store({ [LANDED_AT_KEY]: '100' });
    const local = store();
    const failing = vi.fn(async () => {
      throw new TypeError('offline');
    });
    expect(await reportFirstImage({ now: 1_000, session, local, fetchFn: failing })).toBe(false);
    const limited = vi.fn(async () => new Response('{}', { status: 429 }));
    await reportFirstImage({ now: 1_000, session, local, fetchFn: limited });
    expect(local.getItem(TTFI_SENT_KEY)).toBeNull();
    const refused = vi.fn(async () => new Response('{}', { status: 400 }));
    await reportFirstImage({ now: 1_000, session, local, fetchFn: refused });
    expect(local.getItem(TTFI_SENT_KEY)).toBe('1');
  });
});
