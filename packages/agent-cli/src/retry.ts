/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared retry + per-attempt timeout wrapper for the agent kits.
 *
 * Why this lives in the shared package: every kit needs the same two
 * guarantees around a model turn, and they used to be copy-pasted (or missing).
 *
 *  1. RETRY transient provider failures (429, 5xx/overloaded, network resets).
 *  2. TIME OUT a *stalled* turn. This is the important one: a connection that
 *     opens but never sends a response never throws, so a plain try/catch retry
 *     loop waits forever (the "it just froze at `working…`" symptom). Each
 *     attempt runs under an AbortController; if it makes no progress within
 *     `timeoutMs` we abort it (so no zombie request keeps running and races the
 *     retry) and treat the timeout as a retryable error.
 *
 * `fn` receives the attempt's AbortSignal and MUST forward it to the SDK call
 * (`run(agent, input, { signal })`, `generateText({ abortSignal: signal })`,
 * `agent.invoke(input, { signal })`, `agent.generate(msgs, { abortSignal })`),
 * otherwise the timeout can fire but the underlying request keeps going.
 */

/** Wrap a string in yellow ANSI so a retry notice stands out as "not frozen".
 * Kept local so this package needn't import any kit's theme module. */
function yellow(text: string): string {
  return `[33m${text}[39m`;
}

export const DEFAULT_MAX_RETRIES = 4;

/** Per-attempt timeout. Deliberately generous: a single agent turn can make
 * several model + tool round-trips and legitimately run for a minute or more,
 * so this is a hang safety-net, not a tight SLA. Override per call or globally
 * via AGENT_TURN_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env['AGENT_TURN_TIMEOUT_MS'];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
})();

/** Thrown when an attempt is aborted because it exceeded `timeoutMs`. */
export class TurnTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}: no response after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'TurnTimeoutError';
  }
}

export interface WithRetryOptions {
  /** Namespace for log lines, e.g. "agent" or a provider name. */
  label: string;
  /** Max retry attempts after the first try. Default DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
  /** Per-attempt hang timeout in ms. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Sink for retry notices. Defaults to console.log (the kits patch
   * console.log into their scrollback, so notices land in the UI). */
  log?: (line: string) => void;
  /** Override retryability. Return true to retry, false to fail fast. Lets a
   * kit fast-fail cases the default treats as transient (e.g. Vercel's
   * quota-exhausted 429s that should trigger provider fallback immediately).
   * Timeouts are always retryable and bypass this hook. */
  shouldRetry?: (error: unknown) => boolean;
}

interface MaybeStatusError {
  status?: number;
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * Walk the error cause chain to find an HTTP status code. SDKs wrap the
 * original API error; unwrapping the `.cause` chain is usually enough.
 */
function statusOf(error: unknown): number | undefined {
  const e = error as MaybeStatusError;
  if (typeof e?.status === 'number') return e.status;
  if (e?.cause !== undefined) return statusOf(e.cause);
  return undefined;
}

/**
 * Parse how long the provider wants us to wait from a 429 response: response
 * headers first (most accurate), then the "Please try again in X.Xs" text in
 * the error message.
 */
function retryAfterMs(error: unknown): number | undefined {
  const e = error as MaybeStatusError;
  const headers = e?.headers;
  if (headers) {
    const raw = headers['retry-after'] ?? headers['x-ratelimit-reset-tokens'];
    if (raw !== undefined) {
      const secs = parseFloat(raw);
      if (!isNaN(secs)) return Math.ceil(secs) * 1_000;
    }
  }
  const msg = error instanceof Error ? error.message : '';
  const m = /try again in ([\d.]+)s/i.exec(msg);
  if (m?.[1]) return Math.ceil(parseFloat(m[1])) * 1_000;
  if (e?.cause !== undefined) return retryAfterMs(e.cause);
  return undefined;
}

/**
 * Default retryability: 429 (rate limit), 5xx (server errors including 529
 * overloaded), network-level failures with no status code, and our own turn
 * timeouts. Fails fast on 4xx client errors (bad key, bad request) so a broken
 * call does not burn the whole retry budget.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof TurnTimeoutError) return true;
  const status = statusOf(error);
  if (typeof status === 'number') return status === 429 || status >= 500;
  const msg = error instanceof Error ? error.message.toLowerCase() : '';
  return msg.includes('overloaded') || msg.includes('529') || msg.includes('econnreset');
}

/** Run one attempt under an AbortController that fires after `timeoutMs`. A
 * timeout aborts the attempt (cancelling the in-flight request so it can't race
 * a later retry) and surfaces as a retryable TurnTimeoutError. */
async function runAttempt<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    // An abort we triggered becomes a timeout regardless of how the SDK
    // surfaces the cancellation (AbortError, "aborted", etc.).
    if (timedOut) throw new TurnTimeoutError(label, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `fn`, retrying up to `maxRetries` times on transient provider errors or
 * a stalled (timed-out) turn. Logs each retry in yellow so the user knows the
 * app is not frozen. Delay: the provider's retry-after hint when available,
 * otherwise exponential backoff (1 s, 2 s, 4 s, 8 s); ±25% jitter in both cases
 * to avoid synchronized retries.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: WithRetryOptions | string,
): Promise<T> {
  const opts: WithRetryOptions = typeof options === 'string' ? { label: options } : options;
  const label = opts.label;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const isRetryable = opts.shouldRetry ?? isRetryableError;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await runAttempt(fn, label, timeoutMs);
    } catch (error) {
      if (!isRetryable(error) || attempt >= maxRetries) throw error;
      attempt++;
      const reason =
        error instanceof TurnTimeoutError
          ? 'stalled'
          : statusOf(error) === 529
            ? 'overloaded'
            : statusOf(error) !== undefined
              ? `HTTP ${statusOf(error)}`
              : 'unreachable';
      log(yellow(`${label}: model ${reason} — retrying (${attempt}/${maxRetries}) …`));
      const base = retryAfterMs(error) ?? 1_000 * 2 ** (attempt - 1);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      await new Promise((r) => setTimeout(r, Math.max(0, Math.round(base + jitter))));
    }
  }
}
