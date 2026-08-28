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
 * The shapes the terminal UI reads.
 *
 * This package used to model the whole payment surface — x402 challenges,
 * accept options, payment receipts, service schemas — because a typed tool had
 * to hand each of them to the model. The agent now runs `circle` directly and
 * reads its JSON itself, so the only shapes left are the ones the *kit's own
 * chrome* renders: the pinned balance readout and the slash commands.
 */
import type { Chain } from './chains';

export interface AgentWallet {
  address: string;
}

export interface TokenBalance {
  symbol: string;
  amount: string;
}

export interface WalletBalance {
  address: string;
  tokens: TokenBalance[];
}

export interface Service {
  url: string;
  name: string;
  description?: string;
  /**
   * Price on `chain`, e.g. "0.03 USDC". Quoted for a chain the wallet can
   * plausibly settle on rather than merely the seller's first-listed option, so
   * a listing that leads with a network this package does not name still shows
   * a price the reader can act on.
   */
  price?: string;
  /** Chain `price` is quoted on, when the seller offers one this package names. */
  chain?: Chain;
  /** HTTP method the service expects, when the marketplace publishes it. */
  method?: string;
}

export interface GatewayBalance {
  address: string;
  /** Total USDC held in the wallet's Gateway balance on the chain read. */
  total: string;
}
