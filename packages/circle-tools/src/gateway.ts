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
 * Reading the Gateway balance, for the `/gateway` command.
 *
 * Depositing into Gateway is not here. It moves USDC, which makes it the
 * agent's job under an approval gate — `circle gateway deposit` is on
 * kit-core's approval list, so it stops for the user before it runs, and the
 * choice between the eco and direct methods comes from Circle's own skills
 * rather than from a rule encoded here.
 */
import { runCircleJson } from './cli';
import { chainCli, DEFAULT_CHAIN, type Chain } from './chains';
import type { GatewayBalance } from './types';

/** Extra attempts for idempotent read commands when the network blips. */
const READ_RETRIES = 3;

export interface GatewayBalanceInput {
  address: string;
  /** Chain to read the Gateway balance on. Defaults to Base. */
  chain?: Chain;
}

interface RawGatewayData {
  address?: string;
  total?: string | number;
  balances?: Array<{ balance?: string | number }>;
}

/** Strip a `{ data: ... }` envelope if present. */
function unwrap(raw: unknown): RawGatewayData {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  if (o.data && typeof o.data === 'object') return o.data as RawGatewayData;
  return o as RawGatewayData;
}

function toNumber(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the wallet's Circle Gateway balance: the off-chain, batched-payment
 * pool, separate from the on-chain wallet balance.
 *
 * `circle gateway balance --address <addr> --chain <chain> --output json`
 */
export async function gatewayBalance(input: GatewayBalanceInput): Promise<GatewayBalance> {
  const raw = await runCircleJson<unknown>(
    [
      'gateway',
      'balance',
      '--address',
      input.address,
      '--chain',
      chainCli(input.chain ?? DEFAULT_CHAIN),
      '--output',
      'json',
    ],
    { retries: READ_RETRIES },
  );
  const data = unwrap(raw);
  const total =
    data.total !== undefined
      ? String(data.total)
      : String((data.balances ?? []).reduce((sum, r) => sum + toNumber(r.balance), 0));
  return { address: data.address ?? input.address, total };
}
