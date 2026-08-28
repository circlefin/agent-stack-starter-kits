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
 * Wallet reads for the kit's own chrome: the pinned USDC readout and the
 * `/wallets` and `/balance` commands.
 *
 * Reads only. Creating a wallet, funding one, deploying its Smart Contract
 * Account and transferring out of it are all things the agent does now, by
 * running `circle` in its shell under the guidance of Circle's skills — the
 * versions of them that used to live here were wrappers that existed solely so
 * a typed tool had something to call.
 */
import { runCircleJson } from './cli';
import { chainCli, chainLabel, DEFAULT_CHAIN, type Chain } from './chains';
import type { AgentWallet, TokenBalance, WalletBalance } from './types';

/**
 * Chain used when listing wallets. Agent wallets share one SCA address across
 * every EVM chain, so listing on Base returns the address that is also valid
 * elsewhere.
 */
const WALLET_LIST_CHAIN = chainCli(DEFAULT_CHAIN);

/** Extra attempts for idempotent read commands when the network blips. */
const READ_RETRIES = 3;

export interface GetBalanceInput {
  address: string;
  /** Chain to read the balance on. Defaults to Base. */
  chain?: Chain;
}

interface RawWallet {
  address: string;
  blockchain?: string;
}

/** The Circle CLI wraps every `--output json` payload in a `{ data: ... }` envelope. */
interface CircleEnvelope<T> {
  data?: T;
}

interface RawWalletList {
  wallets?: RawWallet[];
}

/**
 * A balance entry as the CLI emits it: the amount sits at the top level and the
 * symbol is nested under `token` (`{ amount, token: { symbol } }`), not flat.
 */
interface RawTokenBalance {
  amount?: string;
  token?: { symbol?: string };
  symbol?: string;
}

interface RawBalance {
  address?: string;
  blockchain?: string;
  tokens?: RawTokenBalance[];
  balances?: RawTokenBalance[];
}

/** `circle wallet list --chain BASE --type agent --output json` */
export async function listWallets(): Promise<AgentWallet[]> {
  const raw = await runCircleJson<CircleEnvelope<RawWalletList>>(
    ['wallet', 'list', '--chain', WALLET_LIST_CHAIN, '--type', 'agent', '--output', 'json'],
    { retries: READ_RETRIES },
  );
  const list = raw.data?.wallets ?? [];
  return list.map((w) => ({ address: w.address }));
}

/** `circle wallet balance --address <addr> --chain <chain> --output json` */
export async function getBalance(input: GetBalanceInput): Promise<WalletBalance> {
  const raw = await runCircleJson<CircleEnvelope<RawBalance>>(
    [
      'wallet',
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
  const rawTokens = raw.data?.balances ?? raw.data?.tokens ?? [];
  const tokens: TokenBalance[] = rawTokens.map((t) => ({
    symbol: (t.token?.symbol ?? t.symbol ?? '').toUpperCase(),
    amount: t.amount ?? '0',
  }));
  return {
    address: raw.data?.address ?? input.address,
    tokens,
  };
}

export interface UsdcBalanceSummary {
  address: string;
  /** Human USDC amount, e.g. "2.85". */
  usdc: string;
  chain: Chain;
}

/**
 * How long the chosen wallet is reused before the next summary rescans them all.
 * Bounds how stale the pick can get when funds land in a *different* wallet.
 */
const WALLET_PICK_TTL_MS = 60_000;

/** The wallet the last summary settled on, reused to keep the refresh cheap. */
let walletPick: { address: string; chain: Chain; at: number } | null = null;

/**
 * Forget the cached wallet pick, forcing the next summary to rescan.
 *
 * Called wherever the set of wallets may have changed under us — a login, or a
 * shell command that created or funded a wallet. Cheap to call: the cost is one
 * extra `wallet list` on the following refresh.
 */
export function invalidateWalletPick(): void {
  walletPick = null;
}

/** Read a wallet's USDC amount, treating any failure as "0" so one bad RPC
 * read never sinks the whole summary. */
async function usdcAmountOf(address: string, chain: Chain): Promise<string> {
  try {
    const balance = await getBalance({ address, chain });
    return balance.tokens.find((t) => t.symbol === 'USDC')?.amount ?? '0';
  } catch {
    return '0';
  }
}

/**
 * Fetch a compact USDC balance summary for the agent's *funded* wallet, for UI
 * display. Scans every wallet and surfaces the one holding the most USDC, so
 * the readout reflects the wallet actually worth using rather than always the
 * first-listed wallet (which is frequently empty). Falls back to the first
 * wallet when none hold USDC. Returns null when no wallet exists yet (e.g.
 * before setup) so a caller can simply hide the readout. Best-effort: a caller
 * should treat a throw as "unknown" and never break the session over a balance
 * read.
 *
 * The full scan costs one `wallet list` plus one `wallet balance` per wallet,
 * and every CLI call is a process spawn and a network round trip — a cost paid
 * on each refresh, i.e. after every agent turn. So the wallet it settles on is
 * remembered and re-read on its own for `WALLET_PICK_TTL_MS`, which is the
 * common case (funds stay in the wallet the agent spends from) and costs a
 * single call. The scan returns whenever the pick expires, reads empty, or is
 * invalidated, so a wrong pick corrects itself rather than sticking.
 */
export async function walletUsdcBalance(
  chain: Chain = DEFAULT_CHAIN,
): Promise<UsdcBalanceSummary | null> {
  const cached = walletPick;
  if (cached && cached.chain === chain && Date.now() - cached.at < WALLET_PICK_TTL_MS) {
    const usdc = await usdcAmountOf(cached.address, chain);
    // Zero reads as "this may no longer be the wallet worth showing" — funds
    // could have landed in another one — so it falls through to a full scan,
    // which costs exactly what an unconditional scan would have.
    if (Number(usdc) > 0) return { address: cached.address, usdc, chain };
    walletPick = null;
  }

  const wallets = await listWallets();
  if (wallets.length === 0) return null;
  const balances = await Promise.all(
    wallets.map(async (w) => ({ address: w.address, usdc: await usdcAmountOf(w.address, chain) })),
  );
  // Highest USDC wins; the first wallet is the fallback when every wallet is
  // empty (reduce seeds with balances[0], so a no-funds scan returns it).
  const chosen = balances.reduce((best, cur) =>
    Number(cur.usdc) > Number(best.usdc) ? cur : best,
  );
  walletPick = { address: chosen.address, chain, at: Date.now() };
  return { address: chosen.address, usdc: chosen.usdc, chain };
}

/** Abbreviate an EVM address for display, e.g. `0x6be2…fbb5`. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * One-line USDC balance readout for a status bar, including the chain, e.g.
 * `$2.85 USDC on Base · 0x6be2…fbb5`.
 */
export function formatUsdcBalance(summary: UsdcBalanceSummary): string {
  return `$${summary.usdc} USDC on ${chainLabel(summary.chain)} · ${shortAddress(summary.address)}`;
}
