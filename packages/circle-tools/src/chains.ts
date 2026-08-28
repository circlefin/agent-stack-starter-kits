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
 * The chains this package names, which is a far smaller question than the one
 * the agent answers.
 *
 * Nothing here constrains what the agent can pay on: it runs `circle` in a
 * shell, and the CLI settles on whatever the seller and the wallet support.
 * These are the chains the *terminal UI* reads balances on, so a readout has
 * something to say before any service has been chosen.
 */
export type Chain = 'BASE' | 'POLYGON';

/** Chain used for wallet and Gateway reads that are not bound to a service. */
export const DEFAULT_CHAIN: Chain = 'BASE';

interface ChainInfo {
  /** Value passed to the Circle CLI `--chain` flag. */
  cli: string;
  /** Human label for log lines and readouts. */
  label: string;
  /**
   * x402 `accepts[].network` identifiers that name this chain, lowercased. A
   * seller may use the CAIP-2 chain id or the x402 short name, so both are
   * recognised as the same chain.
   */
  networks: string[];
}

const CHAINS: Record<Chain, ChainInfo> = {
  BASE: {
    cli: 'BASE',
    label: 'Base',
    networks: ['eip155:8453', 'base'],
  },
  POLYGON: {
    cli: 'MATIC',
    label: 'Polygon',
    networks: ['eip155:137', 'polygon', 'matic'],
  },
};

/** Order a price is quoted in when a listing offers more than one chain. */
export const CHAIN_PREFERENCE: readonly Chain[] = ['BASE', 'POLYGON'];

/** The Circle CLI `--chain` value for a chain. */
export function chainCli(chain: Chain): string {
  return CHAINS[chain].cli;
}

/** Human label for a chain, for log lines and readouts. */
export function chainLabel(chain: Chain): string {
  return CHAINS[chain].label;
}

/**
 * Map an x402 `accepts[].network` value to a chain this package names, or null
 * for anything else. Null does not mean "unpayable" — only "not one of the two
 * this package quotes a listing price in".
 */
export function chainFromNetwork(network: string): Chain | null {
  const n = network.toLowerCase();
  for (const chain of CHAIN_PREFERENCE) {
    if (CHAINS[chain].networks.includes(n)) return chain;
  }
  return null;
}
