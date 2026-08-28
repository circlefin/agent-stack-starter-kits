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
 * Reading a marketplace search result.
 *
 * Inspecting a service, probing it unpaid, choosing a settlement chain, binding
 * path placeholders, validating a payload and paying — all of that used to live
 * in this file, because a typed `circle_pay_service` tool had to do in
 * TypeScript what `circle services pay` does in the CLI. The agent calls the CLI
 * itself now, so what is left is the one thing the kit still renders on its own:
 * a search listing.
 *
 * It is exported in two forms. `searchServices` runs the search, for the
 * `/discover` command. `parseServiceSearch` reads a search payload the *agent*
 * produced in its shell, which is what keeps a numbered quick-pick pointing at
 * whichever search actually ran last (see kit-core's `recordServiceSearch`).
 */
import { runCircleJson } from './cli';
import { CHAIN_PREFERENCE, chainFromNetwork, type Chain } from './chains';
import type { Service } from './types';

/** Extra attempts for idempotent read commands when the network blips. */
const READ_RETRIES = 3;

/** USDC has 6 decimals; the marketplace quotes payment amounts in atomic units. */
const USDC_DECIMALS = 6;

export interface SearchServicesInput {
  keyword: string;
}

/**
 * Loose shape of one item in `circle services search` JSON output. Every field
 * is optional so a CLI shape change degrades gracefully instead of throwing.
 */
interface RawSearchItem {
  resource?: string;
  accepts?: Array<{ amount?: string; network?: string }>;
  metadata?: {
    provider?: { name?: string; description?: string };
    description?: string;
    path?: string;
    method?: string;
  };
}

/** Format an atomic USDC amount (e.g. "4000") as a human string ("0.004 USDC"). */
function formatUsdc(atomic: string | undefined): string | undefined {
  if (!atomic) return undefined;
  const n = Number(atomic);
  return Number.isFinite(n) ? `${n / 10 ** USDC_DECIMALS} USDC` : undefined;
}

/**
 * Pull the result array out of `circle services search` output. The CLI wraps
 * results as `{ data: { items: [...] } }`; a bare `{ items: [...] }` is also
 * tolerated so a minor CLI change does not silently zero out results.
 */
function extractSearchItems(raw: unknown): RawSearchItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const data = o.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.items)) return data.items as RawSearchItem[];
  if (Array.isArray(o.items)) return o.items as RawSearchItem[];
  return [];
}

/**
 * Pick the option a price is quoted from, in CHAIN_PREFERENCE order. Quoting
 * `accepts[0]` blindly misprices any listing whose first option is a network
 * this package does not name (Solana leads several marketplace entries), so
 * those are skipped rather than reported as the price.
 */
function preferredAccept(
  accepts: Array<{ amount?: string; network?: string }> | undefined,
): { amount?: string; chain: Chain } | null {
  if (!accepts?.length) return null;
  for (const chain of CHAIN_PREFERENCE) {
    const match = accepts.find((a) => a.network && chainFromNetwork(a.network) === chain);
    if (match) return { amount: match.amount, chain };
  }
  return null;
}

function mapSearchItem(item: RawSearchItem): Service {
  const meta = item.metadata ?? {};
  const provider = meta.provider ?? {};
  const accept = preferredAccept(item.accepts);
  return {
    url: item.resource ?? '',
    name: provider.name ?? meta.path ?? item.resource ?? 'unknown service',
    description: meta.description ?? provider.description,
    price: formatUsdc(accept?.amount),
    chain: accept?.chain,
    method: meta.method ? meta.method.toUpperCase() : undefined,
  };
}

/**
 * Read an already-fetched `circle services search --output json` payload.
 *
 * Takes the raw text so a caller can hand over a shell command's stdout without
 * knowing the envelope, and never throws: text that is not a search payload
 * yields an empty list. That matters because the caller is a sniffer over
 * arbitrary shell output, not a command it issued itself.
 */
export function parseServiceSearch(stdout: string): Service[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  return extractSearchItems(raw)
    .map(mapSearchItem)
    .filter((s) => s.url.length > 0);
}

/** `circle services search "<keyword>" --output json` */
export async function searchServices(input: SearchServicesInput): Promise<Service[]> {
  const raw = await runCircleJson<unknown>(
    ['services', 'search', input.keyword, '--output', 'json'],
    { retries: READ_RETRIES },
  );
  // Same empty-`url` filter as `parseServiceSearch`: a malformed entry with no
  // resource URL is not a service `/discover` can hand off to the agent.
  return extractSearchItems(raw)
    .map(mapSearchItem)
    .filter((s) => s.url.length > 0);
}
