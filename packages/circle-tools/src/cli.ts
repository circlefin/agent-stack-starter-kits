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

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** Cap on captured stdout/stderr, mirroring the old `maxBuffer`. */
const MAX_OUTPUT_CHARS = 10 * 1024 * 1024;

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
 * Node's process warnings — `(node:1234) [DEP0040] DeprecationWarning: …` and the
 * `(Use \`node --trace-deprecation …\`)` hint that follows — which the CLI's own
 * dependencies emit on stderr at startup, on every run, success or failure.
 */
const NODE_WARNING_LINE = /^\(node:\d+\)|^\(Use `node /;

/**
 * Drop Node's own warnings from captured stderr.
 *
 * Failure messages are built from stderr, so those warnings were being prepended
 * to every CLI error: the real cause ended up as the last line of a block whose
 * first two lines are unrelated boilerplate, both for a human reading the log and
 * for an agent reading the tool result. Only the noise lines are removed, and
 * only from the text used to explain the failure — `CircleCliError.stderr` still
 * carries the raw stream for anyone who wants it.
 */
function withoutNodeWarnings(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !NODE_WARNING_LINE.test(line.trimStart()))
    .join('\n')
    .trim();
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
 * Serializes every CLI invocation: each call chains onto the previous one, so
 * exactly one `circle` process runs at a time.
 *
 * This preserves a guarantee the old `execFileSync` gave for free. Blocking the
 * thread meant two tool calls could never overlap; going async removes that, and
 * agent frameworks do dispatch tool calls in parallel. Two concurrent
 * `services pay` runs against one wallet is a double-spend, so the ordering is
 * kept deliberately rather than inherited.
 */
let cliQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = cliQueue.then(task);
  // The tail the next caller waits on swallows the result: a command that
  // throws must not reject the chain and take every command behind it with it.
  cliQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface CliResult {
  stdout: string;
  stderr: string;
  /** Exit status, or null when the child was terminated by a signal. */
  code: number | null;
}

/**
 * One `circle` run, resolved when the process closes — non-zero exits included,
 * which the caller turns into a `CircleCliError`. Rejects only when the process
 * could not be run at all (missing binary) or outran the output cap.
 *
 * `spawn` rather than `execFile`: stdin must be 'ignore', the way the sync path
 * had it. `execFile` leaves stdin an open pipe, so a CLI subcommand that reads
 * it (a Terms-of-Use confirmation, say) would wait forever on input no agent is
 * there to type, instead of seeing EOF immediately.
 */
function spawnCircle(
  binary: string,
  args: readonly string[],
  options: CliOptions,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let overflowed = false;
    const collect = (chunk: string, into: 'out' | 'err'): void => {
      if (into === 'out') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > MAX_OUTPUT_CHARS && !overflowed) {
        overflowed = true;
        child.kill();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect(chunk, 'out'));
    child.stderr.on('data', (chunk: string) => collect(chunk, 'err'));

    child.on('error', reject);
    child.on('close', (code) => {
      if (overflowed) {
        reject(new Error(`circle ${args.join(' ')} produced more than ${MAX_OUTPUT_CHARS} bytes`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Invoke the Circle CLI with the given args and resolve with stdout, against
 * the globally installed `circle` binary (`bun add -g @circle-fin/cli`).
 *
 * Asynchronous on purpose: the CLI shells out for seconds at a time (payments,
 * discovery, balance reads), and the sync variant froze the whole process
 * meanwhile — the chat UI's spinner stopped mid-animation and the terminal
 * stopped repainting until the child exited. Calls are still serialized (see
 * `enqueue`), so only the event loop was given back, not the ordering.
 *
 * Spawns the binary directly, with no shell: arguments like service URLs,
 * keywords, and JSON payloads pass through verbatim, so shell metacharacters in
 * untrusted input are never interpreted.
 */
export async function runCircle(
  args: readonly string[],
  options: CliOptions = {},
): Promise<string> {
  const finalArgs =
    options.json && !args.includes('--output') ? [...args, '--output', 'json'] : [...args];
  const binary = options.binary ?? 'circle';
  const maxAttempts = Math.max(1, (options.retries ?? 0) + 1);

  let lastError: CircleCliError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let detail: string;
    try {
      const result = await enqueue(() => spawnCircle(binary, finalArgs, options));
      if (result.code === 0) return result.stdout;
      ({ stdout, stderr } = result);
      exitCode = result.code;
      detail =
        withoutNodeWarnings(stderr) || stdout.trim() || `exited with code ${String(result.code)}`;
    } catch (err) {
      // The process never ran (missing binary, output cap): no streams to read.
      detail = err instanceof Error ? err.message : String(err);
    }

    lastError = new CircleCliError(
      `circle ${finalArgs.join(' ')} failed: ${detail}`,
      finalArgs,
      stdout,
      stderr,
      exitCode,
    );
    // Retry only transient network faults; a real CLI error (bad args,
    // auth, validation) fails fast on the first attempt.
    if (attempt < maxAttempts && isTransientFailure(detail)) {
      await sleep(300 * 3 ** (attempt - 1));
      continue;
    }
    throw lastError;
  }
  // Unreachable: the loop either returns or throws on the final attempt.
  // The non-null assertion satisfies TS control-flow; lastError is always set.
  throw lastError!;
}

/** Run the CLI with `--output json` and parse the resulting JSON payload. */
export async function runCircleJson<T>(
  args: readonly string[],
  options: CliOptions = {},
): Promise<T> {
  const out = await runCircle(args, { ...options, json: true });
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
