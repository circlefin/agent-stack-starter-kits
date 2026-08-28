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
 * Vercel-kit-specific retry policy tweak.
 *
 * The shared `withRetry` (in @agent-stack-starter-kits/agent-cli) handles the
 * generic retry + per-attempt timeout. This kit layers on one extra rule via
 * its `shouldRetry` hook: a 429 that signals an *exhausted* quota or billing
 * limit will not clear on retry, so we fast-fail it — that lets the
 * provider-fallback logic in `runAgentTurn` switch to the secondary provider
 * immediately instead of burning the whole retry budget (~15 s of backoff)
 * first.
 */

/**
 * True when a 429 signals an exhausted quota or billing limit rather than a
 * transient rate-limit.
 */
export function isQuotaExhausted(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    msg.includes('usage limit') ||
    msg.includes('quota') ||
    msg.includes('regain access') ||
    msg.includes('billing') ||
    msg.includes('workspace api usage')
  );
}
