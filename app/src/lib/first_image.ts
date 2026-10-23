/**
 * Time to first image (PRD success metrics, tech design 11.1), measured in the browser: from the first page load
 * in this tab (kept in session storage, so it survives the sign-in redirect to Cognito and back) to the first
 * image shown. Reported once per browser to `POST /api/metrics/ttfi`; the server keeps one per user.
 */
export const LANDED_AT_KEY = 'pictora:landedAt';
export const TTFI_SENT_KEY = 'pictora:ttfiSent';
export const TTFI_PATH = '/api/metrics/ttfi';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/** Storage can be missing or throw (private windows, blocked site data); metrics then just aren't taken. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Remembers when this tab first loaded a page (epoch milliseconds), unless it already has. */
export function markLanding(
  session: KeyValueStore | undefined = safely(() => window.sessionStorage),
  loadedAt: number = Math.round(performance.timeOrigin),
): void {
  if (!session) return;
  safely(() => {
    if (!session.getItem(LANDED_AT_KEY)) session.setItem(LANDED_AT_KEY, String(loadedAt));
  });
}

let reporting = false;

/**
 * Sends the time from landing to now, the first time an image is shown in this browser. Does nothing without a
 * landing time, or once sent. A network failure leaves it unsent, to try with the next image.
 */
export async function reportFirstImage(
  options: {
    now?: number;
    session?: KeyValueStore;
    local?: KeyValueStore;
    fetchFn?: typeof fetch;
  } = {},
): Promise<boolean> {
  const session = options.session ?? safely(() => window.sessionStorage);
  const local = options.local ?? safely(() => window.localStorage);
  if (!session || !local || reporting) return false;
  if (safely(() => local.getItem(TTFI_SENT_KEY))) return false;
  const landedAt = Number(safely(() => session.getItem(LANDED_AT_KEY)));
  const now = options.now ?? Date.now();
  if (!Number.isFinite(landedAt) || landedAt <= 0 || now < landedAt) return false;

  reporting = true;
  try {
    const response = await (options.fetchFn ?? fetch)(TTFI_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: Math.round(now - landedAt) }),
    });
    // Anything but a refusal to take more requests means the server has decided; don't send again.
    if (response.status !== 429) safely(() => local.setItem(TTFI_SENT_KEY, '1'));
    return response.ok;
  } catch {
    return false;
  } finally {
    reporting = false;
  }
}
