import { runCircle, runCircleJson } from './cli';
import { chainCli, DEFAULT_CHAIN, type Chain } from './chains';
import type { GatewayBalance, GatewayDepositResult } from './types';

/** Extra attempts for idempotent read commands when the network blips. */
const READ_RETRIES = 3;
const TX_HASH_REGEX = /0x[a-fA-F0-9]{64}/;
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface GatewayBalanceInput {
  address: string;
  /** Chain to read the Gateway balance on. Defaults to Base. */
  chain?: Chain;
}

/**
 * Deposit method passed to `circle gateway deposit --method <method>`.
 *
 * - `direct` (default): source == destination == `chain`. Compatible with any
 *   chain the kit supports; slower (13-19 min finality) and consumes gas on the
 *   source chain.
 * - `eco`: ~30s finality, no gas on source. The CLI forces the source to BASE
 *   (the only mainnet source eco supports) and the destination to Polygon
 *   (Gateway domain 7). So `method='eco'` is ONLY valid together with
 *   `chain='POLYGON'` (the settlement chain). USDC is pulled from the wallet's
 *   on-chain Base USDC balance and lands in the Polygon Gateway pool.
 *
 * Pick `eco` when settling Gateway on Polygon AND the wallet has spendable Base
 * USDC. Pick `direct` otherwise.
 */
export type GatewayDepositMethod = 'direct' | 'eco';

export interface GatewayDepositInput {
  address: string;
  /** USDC amount to move into the Gateway balance. */
  amount: number;
  /**
   * Chain the deposit settles on (i.e. the Gateway domain whose balance grows).
   * Defaults to Base. For `method='eco'` this must be `'POLYGON'`.
   */
  chain?: Chain;
  /**
   * Deposit method. Defaults to `'direct'`. See {@link GatewayDepositMethod} for
   * constraints. `'eco'` silently forces the source chain to BASE. If
   * `'eco'` is paired with a non-Polygon `chain`, the function falls back to
   * `'direct'` (eco cannot land on the requested chain). The actual method
   * used is reported on `GatewayDepositResult.method`.
   */
  method?: GatewayDepositMethod;
}

/** Loose shape of one per-chain row in `circle gateway balance` JSON output. */
interface RawGatewayRow {
  network?: string;
  domain?: number;
  balance?: string | number;
}

/** Loose shape of the `circle gateway balance` JSON `data` object (CLI 0.0.3). */
interface RawGatewayData {
  address?: string;
  total?: string | number;
  balances?: RawGatewayRow[];
}

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Unwrap the `{ data: ... }` envelope the CLI puts around JSON output. */
function unwrap(raw: unknown): RawGatewayData {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  if (o.data && typeof o.data === 'object') return o.data as RawGatewayData;
  return o as RawGatewayData;
}

/**
 * Read the wallet's Base Circle Gateway balance: the off-chain, batched-payment
 * pool, separate from the on-chain wallet balance.
 *
 * `circle gateway balance --address <addr> --chain BASE --output json`
 */
export async function gatewayBalance(input: GatewayBalanceInput): Promise<GatewayBalance> {
  const raw = runCircleJson<unknown>(
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

/** Pull a transaction id / hash out of `circle gateway deposit` output. */
function extractDepositId(out: string): string | undefined {
  return out.match(TX_HASH_REGEX)?.[0] ?? out.match(UUID_REGEX)?.[0];
}

/**
 * Make a Gateway deposit so the wallet can pay a seller that requires a Gateway
 * (batched) payment.
 *
 * Two methods are supported (see {@link GatewayDepositMethod}):
 *
 * - `direct` (default): deposit on the seller's settlement chain. Source ==
 *   destination == `chain`. Works for any supported chain; 13-19 min finality,
 *   consumes gas on the source chain.
 * - `eco`: fast (~30s), no gas on source. ONLY valid when `chain='POLYGON'`
 *   because the CLI hardcodes eco's destination to the Polygon Gateway domain;
 *   the source is forced to BASE (eco's only supported mainnet source). Pulls
 *   from the wallet's on-chain Base USDC balance and lands in the Polygon
 *   Gateway pool.
 *
 * Why eco is gated, not the default: callers in this repo use the seller's
 * preferred settlement chain (Base preferred, Polygon fallback) as `chain`, and
 * read the resulting Gateway balance back on that same chain. Forcing eco for a
 * Base seller would land USDC in the Polygon Gateway pool instead of Base, and
 * the subsequent Base Gateway balance read + payment would fail. So opt in
 * explicitly per call.
 *
 * Graceful degradation: if `method='eco'` is requested with a non-Polygon
 * `chain`, the function silently falls back to `'direct'` rather than throwing
 * (eco would deposit on the wrong chain anyway). The actual method used is
 * surfaced on the returned `GatewayDepositResult.method` so callers can log it
 * or react to the downgrade.
 *
 * Mutating: `runCircle` keeps retries at 0 so a dropped connection never
 * double-deposits.
 */
export async function gatewayDeposit(input: GatewayDepositInput): Promise<GatewayDepositResult> {
  const destChain = input.chain ?? DEFAULT_CHAIN;
  const requestedMethod: GatewayDepositMethod = input.method ?? 'direct';

  // Graceful degradation: eco only lands on Polygon (CLI hardcoded). If the
  // caller asked for eco against a non-Polygon settlement chain, depositing
  // via eco would land USDC on the wrong Gateway domain and the subsequent
  // pay/balance flow on destChain would fail. Fall back to direct so the
  // deposit still works on the requested chain (just slower). The actual
  // method used is surfaced on the result so callers can log / react.
  const method: GatewayDepositMethod =
    requestedMethod === 'eco' && destChain !== 'POLYGON' ? 'direct' : requestedMethod;

  // eco forces source=BASE (its only supported mainnet source); direct uses
  // the destination chain as both source and destination.
  const cliSourceChain = method === 'eco' ? chainCli('BASE') : chainCli(destChain);

  const out = runCircle([
    'gateway',
    'deposit',
    '--amount',
    String(input.amount),
    '--address',
    input.address,
    '--chain',
    cliSourceChain,
    '--method',
    method,
    '--output',
    'json',
  ]);
  return {
    amount: String(input.amount),
    txId: extractDepositId(out.trim()),
    method,
  };
}
