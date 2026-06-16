import { execFileSync } from 'node:child_process';

export interface CliOptions {
  /** Append `--output json` if not already present. */
  json?: boolean;
  /** Working directory for the child process. */
  cwd?: string;
  /** Override the `circle` binary path (defaults to `circle` on PATH). */
  binary?: string;
  /** Extra environment variables for the child process. */
  env?: NodeJS.ProcessEnv;
  /**
   * Number of extra attempts on a *transient* failure (network blip,
   * timeout). 0 = no retry. Only safe for idempotent read commands.
   * Mutating commands (`wallet create`, `services pay`) must leave this 0
   * so a dropped connection never double-creates or double-pays.
   */
  retries?: number;
}

/**
 * Failure substrings that mean the request never got a real answer. The
 * `circle` CLI's internal `fetch` (undici) raises a bare `Error: fetch failed`
 * on DNS/connection/socket faults. These are safe to retry for read commands.
 *
 * HTTP 429 (rate limit) and 502/503/504 (gateway) are included too: a burst of
 * read calls can trip the Discovery API rate limiter, and a backoff retry
 * clears it. Retried only for idempotent reads; see `retries` above.
 */
const TRANSIENT_ERROR_PATTERNS = [
  'fetch failed',
  'etimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network error',
  'request timed out',
  'http 429',
  'too many requests',
  'rate limit',
  'http 502',
  'http 503',
  'http 504',
];

function isTransientFailure(detail: string): boolean {
  const lower = detail.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Block the thread for `ms`. `runCircle` is already synchronous (`execFileSync`),
 * so the retry backoff stays synchronous too. `Atomics.wait` sleeps without a
 * busy-loop and without needing the call site to become async.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class CircleCliError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'CircleCliError';
  }
}

/**
 * Invoke the Circle CLI synchronously with the given args and return stdout.
 * Wraps `child_process.execFileSync` against the globally installed `circle` binary
 * (`bun add -g @circle-fin/cli`).
 *
 * Uses `execFileSync` rather than `execSync`: arguments like service URLs,
 * keywords, and JSON payloads pass through verbatim with no shell parsing,
 * preventing shell metacharacters in untrusted input from being interpreted.
 */
export function runCircle(args: readonly string[], options: CliOptions = {}): string {
  const finalArgs =
    options.json && !args.includes('--output') ? [...args, '--output', 'json'] : [...args];
  const binary = options.binary ?? 'circle';
  const maxAttempts = Math.max(1, (options.retries ?? 0) + 1);

  let lastError: CircleCliError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execFileSync(binary, finalArgs, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      const e = err as {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
        status?: number | null;
        message: string;
      };
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      const detail = stderr.trim() || stdout.trim() || e.message;
      lastError = new CircleCliError(
        `circle ${finalArgs.join(' ')} failed: ${detail}`,
        finalArgs,
        stdout,
        stderr,
        e.status ?? null,
      );
      // Retry only transient network faults; a real CLI error (bad args,
      // auth, validation) fails fast on the first attempt.
      if (attempt < maxAttempts && isTransientFailure(detail)) {
        sleepSync(300 * 3 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  // The non-null assertion satisfies TS control-flow; lastError is always set.
  throw lastError!;
}

/** Run the CLI with `--output json` and parse the resulting JSON payload. */
export function runCircleJson<T>(args: readonly string[], options: CliOptions = {}): T {
  const out = runCircle(args, { ...options, json: true });
  const trimmed = out.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new CircleCliError(
      `Failed to parse JSON output from circle ${args.join(' ')}: ${(err as Error).message}`,
      args,
      out,
      '',
      0,
    );
  }
}
