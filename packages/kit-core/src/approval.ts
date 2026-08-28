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
 * Which shell commands stop for the user first.
 *
 * The kits used to gate on a tool *name*: two of the sixteen tools moved USDC,
 * so those two were the ones the framework paused on. With a shell there is one
 * tool and every command on the machine behind it, so the gate moved to the
 * command string — which is also the honest place for it, since the thing worth
 * stopping was never "this tool" but "this spend".
 *
 * Most of what the agent does is recoverable, so the default is to run. What
 * stops is what cannot be taken back: a stablecoin transfer has no chargeback,
 * and x402 settles before the seller answers.
 *
 * This is not a sandbox. It does not stop the agent deleting files, installing
 * packages, or fetching from anywhere — the shell can do all of that, and a
 * marketplace response that talks it into one of them will not ask first. For a
 * ceiling no instruction can argue past, cap the wallet itself with
 * `circle wallet limit set`, which confirms by one-time code and therefore has
 * to be run by a human.
 */

import { isKitLoggedIn } from './session';

/** Matched anywhere in a segment, so a pipe or a `$(…)` cannot slip one through. */
const NEEDS_APPROVAL: readonly RegExp[] = [
  // Buying from a seller. x402 charges before the request resolves, so this is
  // spent on send.
  /\bcircle services pay\b/,
  // Sending USDC to an address, with no seller to check the destination against.
  /\bcircle wallet transfer\b/,
  /\bcircle bridge transfer\b/,
  // Moving USDC into or out of the Gateway pool, which costs the amount plus a fee.
  /\bcircle gateway (deposit|withdraw)\b/,
  // A signature can authorise a later transfer, so it spends just as surely,
  // only afterwards.
  /\bcircle wallet (swap|execute|sign)\b/,
  // The ceiling every other entry here relies on.
  /\bcircle wallet limit (set|reset)\b/,
  // Circle's own rules: the agent must never accept the Terms of Use for the
  // user. Login is gated too, but for a second reason — the kit runs its own
  // email + OTP login through the chat UI before the agent starts, and the
  // CLI's login prompt would sit unanswered in a shell whose stdin is closed.
  /\bcircle terms (accept|reset)\b/,
  /\bcircle wallet login\b/,
];

/**
 * The login label is the reason the session flag in `./session` exists: it used
 * to assert "this kit already logged you in" unconditionally — including on the
 * turn straight after the agent ran `circle wallet logout`, where it is false
 * and talks the user out of approving the one command that would fix it.
 */
const LOGIN_LABEL = (): string =>
  isKitLoggedIn()
    ? 'log in — this kit already logged you in, and the CLI prompt cannot be answered from here'
    : 'log in — you are logged out; the CLI prompt cannot be answered from here, so this has to ' +
      'use --init and an OTP you read back from your email';

/**
 * Human labels for the gated commands, for the approval prompt. A label may be
 * a function when what it should say depends on the state of the session.
 */
const SPEND_LABELS: ReadonlyArray<readonly [RegExp, string | (() => string)]> = [
  [/\bcircle services pay\b/, 'pay a marketplace seller (settles before the seller answers)'],
  [/\bcircle wallet transfer\b/, 'send USDC to an address'],
  [/\bcircle bridge transfer\b/, 'bridge USDC to another chain'],
  [
    /\bcircle gateway deposit\b/,
    "move USDC into the Gateway pool (amount plus a fee) — check --method: eco's destination is fixed to Polygon, so an eco deposit meant for another chain lands on the wrong one",
  ],
  [/\bcircle gateway withdraw\b/, 'move USDC out of the Gateway pool'],
  [/\bcircle wallet swap\b/, 'swap tokens'],
  [/\bcircle wallet execute\b/, 'execute a contract call'],
  [/\bcircle wallet sign\b/, 'sign a message, which can authorise a later transfer'],
  [/\bcircle wallet limit (set|reset)\b/, "change the wallet's spending caps"],
  [/\bcircle terms (accept|reset)\b/, 'change Terms of Use acceptance — this is yours to do, not the agent\'s'],
  [/\bcircle wallet login\b/, LOGIN_LABEL],
];

// `circle services pay --estimate` returns a price without signing, and `--help`
// prints text. Prompting for either trains the user to approve payment dialogs
// without reading them.
const ESTIMATE = /(?:^| )--estimate(?: |$)/;
const HELP = /(?:^| )(?:--help|-h)(?: |$)/;

/**
 * Remove quoting and backslash-escaping outside single quotes, the way the
 * shell does when it assembles a word — so `c""ircle wallet transfer` and
 * `c\i\rcle wallet transfer` both normalize to `circle wallet transfer` before
 * they ever reach the gate. This does not evaluate `$(...)`, `` ` `` or `$VAR`;
 * it only removes the quote marks themselves, which is enough to stop the
 * common trick of splicing empty or single-character quotes into a command
 * name to dodge a literal-string match.
 */
function normalizeShellEscaping(command: string): string {
  let result = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else result += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      // Outside single quotes, a backslash escapes the next character —
      // dropping both the backslash and the character's special meaning.
      result += command[i + 1];
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else result += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Split a shell line into the commands it actually runs.
 *
 * A line is not one command, so each piece is judged on its own: any one of them
 * is enough to stop the whole line.
 */
export function segmentsOf(command: string): string[] {
  return normalizeShellEscaping(command)
    .split(/\|\||&&|[;|\n]/)
    .map((segment) => segment.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/** Whether a segment only asks a command to describe itself. */
export function isHelpInvocation(segment: string): boolean {
  return HELP.test(segment);
}

/**
 * Whether a single command — no chaining left in it — spends nothing despite
 * naming a gated command.
 *
 * The segment has to *start* with the gated command, so a payment hidden inside
 * a substitution (`echo $(circle services pay …) --estimate`) stays gated.
 */
function isReadOnlyInvocation(segment: string): boolean {
  if (HELP.test(segment)) return true;
  if (!segment.startsWith('circle services pay ')) return false;
  // One payment per segment: `circle services pay X --estimate $(circle services
  // pay Y)` reads as an estimate but contains a real purchase.
  const payments = segment.match(/\bcircle services pay\b/g) ?? [];
  return payments.length === 1 && ESTIMATE.test(segment);
}

/**
 * Whether `command` needs the user to approve it before it runs. Everything not
 * listed above runs immediately.
 */
export function requiresApproval(command: string): boolean {
  return segmentsOf(command).some(
    (segment) => NEEDS_APPROVAL.some((pattern) => pattern.test(segment)) && !isReadOnlyInvocation(segment),
  );
}

/**
 * A plain-language summary of why a command stopped, for the approval prompt.
 *
 * The command itself is always shown alongside this and is the authority; this
 * only says what kind of thing it is, so a user who is not fluent in the CLI can
 * still judge it. Returns null when nothing in the line is gated.
 */
export function describeApproval(command: string): string | null {
  const reasons = new Set<string>();
  for (const segment of segmentsOf(command)) {
    if (isReadOnlyInvocation(segment)) continue;
    for (const [pattern, label] of SPEND_LABELS) {
      if (pattern.test(segment)) reasons.add(typeof label === 'function' ? label() : label);
    }
  }
  return reasons.size > 0 ? [...reasons].join('; ') : null;
}
