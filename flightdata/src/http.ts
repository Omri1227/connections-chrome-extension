// Polite HTTP for adapters: per-host spacing, timeouts, bounded retries with exponential backoff and jitter, and
// Retry-After on 429/503. No proxy rotation, no spoofed browser identity: requests identify the project honestly.

export const USER_AGENT = 'CDG-Navigator-flightdata/0.1 (research data collection)';

export interface HttpOptions {
  timeoutMs?: number;      // per attempt
  retries?: number;        // extra attempts after the first
  baseDelayMs?: number;    // backoff base
  minSpacingMs?: number;   // minimum gap between requests to the same host
  headers?: Record<string, string>;
  /** Which outcomes are retried (default `retryable`). Paid APIs pass a stricter rule: a 429 there usually means the quota is spent. */
  retryOn?: (status: number | null) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface HttpResult { ok: boolean; status: number | null; body: string; bytes: number; attempts: number; error: string | null }

const lastByHost = new Map<string, number>();
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Status codes worth retrying; other 4xx (auth, not found, forbidden) are final — retrying would not help and could look abusive. */
export const retryable = (s: number | null) => s === null || s === 408 || s === 425 || s === 429 || s >= 500;

export async function politeGet(fetchFn: typeof fetch, url: string, o: HttpOptions = {}): Promise<HttpResult> {
  const { timeoutMs = 30_000, retries = 3, baseDelayMs = 2_000, minSpacingMs = 1_500, sleep = realSleep, random = Math.random, retryOn = retryable } = o;
  const host = new URL(url).host;
  let attempt = 0, last: HttpResult = { ok: false, status: null, body: '', bytes: 0, attempts: 0, error: 'not attempted' };
  while (attempt <= retries) {
    const wait = (lastByHost.get(host) ?? 0) + minSpacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastByHost.set(host, Date.now());
    attempt++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let retryAfterMs = 0;
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...o.headers }, signal: ctl.signal });
      const body = await res.text();
      last = { ok: res.ok, status: res.status, body, bytes: Buffer.byteLength(body), attempts: attempt, error: res.ok ? null : `HTTP ${res.status}` };
      if (res.ok || !retryOn(res.status)) { lastByHost.set(host, Date.now()); return last; }
      const ra = res.headers.get('retry-after');
      if (ra) retryAfterMs = /^\d+$/.test(ra) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
    } catch (e) {
      last = { ok: false, status: null, body: '', bytes: 0, attempts: attempt, error: (e as Error).name === 'AbortError' ? `timeout after ${timeoutMs} ms` : (e as Error).message };
    } finally {
      clearTimeout(timer);
      // Spacing counts from the END of the previous request: per-second rate limits (API.Market: 1 request/s)
      // otherwise reject a request that starts just after a slow response.
      lastByHost.set(host, Date.now());
    }
    if (!retryOn(last.status)) return last;
    if (attempt > retries) break;
    const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.75 + random() * 0.5);
    await sleep(Math.min(Math.max(backoff, retryAfterMs), 5 * 60_000));
  }
  return last;
}

/** Parses JSON, reporting a format change instead of throwing. */
export function parseJson(body: string): { value: unknown; error: string | null } {
  try { return { value: JSON.parse(body), error: null }; } catch (e) { return { value: null, error: `response is not JSON (${(e as Error).message.slice(0, 80)}); first bytes: ${JSON.stringify(body.slice(0, 120))}` }; }
}
