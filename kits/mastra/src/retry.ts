import { kitLine, yellow } from './theme';

export const MAX_RETRIES = 4;

interface MaybeStatusError {
  status?: number;
  cause?: unknown;
}

/**
 * Walk the error cause chain to find an HTTP status code. Vercel AI SDK wraps
 * the original provider error in a RetryError whose `.cause` is the real error.
 */
function statusOf(error: unknown): number | undefined {
  const e = error as MaybeStatusError;
  if (typeof e?.status === 'number') return e.status;
  if (e?.cause !== undefined) return statusOf(e.cause);
  return undefined;
}

/**
 * True when the error is worth retrying: 429 (rate limit), 5xx (server errors
 * including 529 overloaded), or network-level failures with no status code.
 * Fails fast on 4xx client errors (bad key, bad request) so a broken call
 * does not burn all retry budget.
 */
function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (typeof status === 'number') return status === 429 || status >= 500;
  // No status → network / unreachable; check message as last resort.
  const msg = error instanceof Error ? error.message.toLowerCase() : '';
  return msg.includes('overloaded') || msg.includes('529') || msg.includes('econnreset');
}

/**
 * Run `fn`, retrying up to MAX_RETRIES times on transient provider errors.
 * Logs each retry in yellow so the user knows the app is not frozen.
 * Uses exponential backoff (1 s, 2 s, 4 s, 8 s).
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= MAX_RETRIES) throw error;
      attempt++;
      const status = statusOf(error);
      const reason =
        status === 529 ? 'overloaded' : status !== undefined ? `HTTP ${status}` : 'unreachable';
      const last = attempt >= MAX_RETRIES;
      const tail = last ? 'giving up' : `retrying (${attempt}/${MAX_RETRIES}) …`;
      console.log(kitLine(yellow(`${label}: model ${reason} — ${tail}`)));
      if (last) throw error;
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** (attempt - 1)));
    }
  }
}
