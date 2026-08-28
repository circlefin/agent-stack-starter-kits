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
 * How every kit ends a run that threw.
 *
 * Each entry point used to carry its own copy of this, and the copies had
 * drifted: three classified an overloaded provider and three printed the raw
 * message, so the same outage read as a kit bug in half the kits. One
 * implementation, one wording.
 */
import { red, yellow } from './theme';

/**
 * True when the failure is the LLM provider being overloaded rather than
 * anything wrong with the kit.
 *
 * Matched on both the HTTP status and the message text: the providers' SDKs
 * surface 529 as a `status` field, while a subprocess (the Claude Agent SDK's
 * Claude Code child) only ever hands back the string.
 */
export function isProviderOverloaded(error: unknown): boolean {
  if ((error as { status?: number })?.status === 529) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('529') || /overloaded/i.test(message);
}

/**
 * Print a fatal error and nothing else. The caller tears the chat UI down
 * first — otherwise Ink's frame swallows these lines — and sets the exit code
 * afterwards, so this function stays a pure report.
 *
 * `kitLine` is the caller's own `[<kit>-kit]` tagger, which is the only part
 * that differs between kits.
 */
export function reportFatal(error: unknown, kitLine: (line: string) => string): void {
  if (isProviderOverloaded(error)) {
    console.error(
      kitLine(red('FATAL: the LLM provider is overloaded (HTTP 529) and retries were exhausted.')),
    );
    console.error(kitLine(yellow('This is transient on the provider side. Re-run in a moment.')));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(kitLine(red(`FATAL: ${message}`)));
}
