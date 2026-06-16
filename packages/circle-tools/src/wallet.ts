import { runCircle, runCircleJson } from './cli';
import { openInBrowser } from './browser';
import { chainCli, chainRpcUrl, DEFAULT_CHAIN, type Chain } from './chains';
import type { AgentWallet, TokenBalance, WalletBalance } from './types';

/**
 * Chain used when listing/creating wallets. Agent wallets share one SCA address
 * across every EVM chain, so listing on Base returns the address that is also
 * valid on Polygon.
 */
const WALLET_LIST_CHAIN = chainCli(DEFAULT_CHAIN);
const EVM_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/;
const TX_HASH_REGEX = /0x[a-fA-F0-9]{64}/;
const HTTPS_URL_REGEX = /https?:\/\/[^\s"']+/;
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Extra attempts for idempotent read commands when the network blips. */
const READ_RETRIES = 3;

/** After the bootstrap transfer, poll eth_getCode until the SCA appears. */
const DEPLOY_POLL_INTERVAL_MS = 1_500;
const DEPLOY_POLL_TIMEOUT_MS = 45_000;

export interface GetBalanceInput {
  address: string;
  /** Chain to read the balance on. Defaults to Base. */
  chain?: Chain;
}

export interface DeployWalletInput {
  address: string;
  /** Chain to deploy / check the SCA on. Defaults to Base. */
  chain?: Chain;
}

/** Tokens the fiat on-ramp can buy. `usdc` is the default. */
export type FundToken = 'usdc' | 'eurc' | 'eth' | 'native';

export interface FundFiatInput {
  /** Destination wallet address; must be one of the agent's own wallets. */
  address: string;
  /** Amount of `token` to buy, in human units (e.g. 10 for $10 of USDC). */
  amount: number | string;
  /** Chain the funds deposit on. Defaults to Base. */
  chain?: Chain;
  /** Token to buy. Defaults to `usdc`. */
  token?: FundToken;
  /**
   * Local-run convenience: also open the Transak URL in the user's default
   * browser. Best-effort and a no-op on a headless / remote host. Off by
   * default; agents should leave this off and hand the user the returned `url`.
   */
  open?: boolean;
}

export interface FundFiatResult {
  address: string;
  chain: Chain;
  amount: string;
  token: FundToken;
  /**
   * The Transak on-ramp URL. Hand this to the user as a link to open; they
   * complete the card / bank purchase there and the tokens deposit to `address`.
   * Generating this URL moves no money on its own.
   */
  url: string;
}

export interface DeployWalletResult {
  address: string;
  /** True once the SCA contract is confirmed on-chain. */
  deployed: boolean;
  /** True when the wallet was already deployed and no transaction was sent. */
  alreadyDeployed: boolean;
  /** Circle transaction id of the bootstrap transfer, when one was sent. */
  txId?: string;
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

/** Strip a `{ data: T }` envelope if present. */
function unwrap<T>(raw: { data?: T } | T): T {
  return (raw as { data?: T }).data ?? (raw as T);
}

/** Creates a new agent-controlled wallet on Base via `circle wallet create`. */
export async function createWallet(): Promise<AgentWallet> {
  const out = runCircle(['wallet', 'create', '--chain', WALLET_LIST_CHAIN, '--output', 'json']);
  const trimmed = out.trim();
  let address: string | undefined;
  try {
    const raw = JSON.parse(trimmed) as CircleEnvelope<RawWalletList>;
    const wallets = raw.data?.wallets ?? [];
    // `circle wallet create` provisions one address across every chain; pick the
    // Base entry so the returned wallet is the Base address.
    const match =
      wallets.find((w) => w.blockchain?.toUpperCase() === WALLET_LIST_CHAIN) ?? wallets[0];
    address = match?.address;
  } catch {
    address = trimmed.match(EVM_ADDRESS_REGEX)?.[0];
  }
  if (!address) {
    throw new Error(`circle wallet create returned no address. Raw output:\n${out}`);
  }
  return { address };
}

/** `circle wallet list --chain BASE --type agent --output json` */
export async function listWallets(): Promise<AgentWallet[]> {
  const raw = runCircleJson<CircleEnvelope<RawWalletList>>(
    ['wallet', 'list', '--chain', WALLET_LIST_CHAIN, '--type', 'agent', '--output', 'json'],
    { retries: READ_RETRIES },
  );
  const list = raw.data?.wallets ?? [];
  return list.map((w) => ({ address: w.address }));
}

/** `circle wallet balance --address <addr> --chain <chain> --output json` */
export async function getBalance(input: GetBalanceInput): Promise<WalletBalance> {
  const raw = runCircleJson<CircleEnvelope<RawBalance>>(
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

/**
 * Generate a fiat on-ramp (Transak) purchase URL for funding a wallet with a
 * card or bank transfer, via `circle wallet fund --method fiat`.
 *
 * Runs with `--no-open` so the CLI prints the Transak URL instead of trying to
 * launch a browser: an agent process has no browser to open, and a server-side
 * `--open` would do nothing useful. The caller hands the returned `url` to the
 * user as a link to click. This call only mints the URL; no USDC moves until
 * the user completes the purchase in the on-ramp.
 *
 * Mainnet only: fiat on-ramp is not available on testnet chains (the CLI drips
 * from a faucet there instead).
 */
export async function fundWalletFiat(input: FundFiatInput): Promise<FundFiatResult> {
  const chain = input.chain ?? DEFAULT_CHAIN;
  const token: FundToken = input.token ?? 'usdc';
  const amount = String(input.amount);

  // `--no-open` prints the Transak URL rather than opening a browser; `--method
  // fiat` and `--amount` are both required in non-interactive (agent) use.
  const out = runCircle([
    'wallet',
    'fund',
    '--address',
    input.address,
    '--chain',
    chainCli(chain),
    '--amount',
    amount,
    '--token',
    token,
    '--method',
    'fiat',
    '--no-open',
    '--output',
    'json',
  ]);

  const url = extractFundUrl(out);
  if (!url) {
    throw new Error(`circle wallet fund returned no on-ramp URL. Raw output:\n${out}`);
  }
  if (input.open) openInBrowser(url);
  return { address: input.address, chain, amount, token, url };
}

/**
 * Pull the Transak widget URL out of `circle wallet fund` output. The CLI nests
 * it at `data.widgetUrl`; fall back to the first https URL in the raw text in
 * case the field is ever renamed.
 */
function extractFundUrl(out: string): string | undefined {
  const trimmed = out.trim();
  try {
    const env = JSON.parse(trimmed) as { data?: Record<string, unknown> };
    const url = env.data?.widgetUrl ?? env.data?.url;
    if (typeof url === 'string' && url.length > 0) return url;
  } catch {
    // fall through to regex extraction
  }
  return trimmed.match(HTTPS_URL_REGEX)?.[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull a transaction id/hash out of `circle wallet transfer` output. Agent
 * wallets return a Circle transaction UUID; an on-chain hash is also tolerated.
 */
function extractTxId(out: string): string | undefined {
  const trimmed = out.trim();
  try {
    const env = JSON.parse(trimmed) as { data?: Record<string, unknown> };
    const data = env.data ?? {};
    const id = data.id ?? data.transactionId ?? data.txHash ?? data.transactionHash;
    if (typeof id === 'string') return id;
  } catch {
    // fall through to regex extraction
  }
  return trimmed.match(TX_HASH_REGEX)?.[0] ?? trimmed.match(UUID_REGEX)?.[0];
}

/**
 * Check whether a wallet's Smart Contract Account is deployed on-chain.
 *
 * A Circle agent wallet address is *counterfactual*: deterministically derived
 * from the account factory until its first outbound transaction. Until then
 * `eth_getCode` returns empty ("0x"), and x402 payment signing (validated via
 * EIP-1271 against the wallet contract) fails. Receiving USDC does not deploy
 * the contract; only an outbound transaction does.
 */
export async function isWalletDeployed(input: DeployWalletInput): Promise<boolean> {
  const res = await fetch(chainRpcUrl(input.chain ?? DEFAULT_CHAIN), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getCode',
      params: [input.address, 'latest'],
    }),
  });
  if (!res.ok) {
    throw new Error(`eth_getCode failed for ${input.address}: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) {
    throw new Error(`eth_getCode error for ${input.address}: ${body.error.message ?? 'unknown'}`);
  }
  // Empty code ("0x") means the SCA contract has not been deployed yet.
  const code = body.result ?? '0x';
  return code.length > 2 && code !== '0x0';
}

/**
 * Deploy an agent wallet's Smart Contract Account by sending a zero-value
 * self-transfer, the wallet's first outbound transaction. Idempotent: if the
 * wallet is already deployed, no transaction is sent. After submitting, polls
 * `eth_getCode` until the contract is confirmed on-chain, so a caller can pay
 * immediately afterward without a deploy/pay race.
 */
export async function deployWallet(input: DeployWalletInput): Promise<DeployWalletResult> {
  const { address } = input;
  const chain = input.chain ?? DEFAULT_CHAIN;

  if (await isWalletDeployed({ address, chain })) {
    return { address, deployed: true, alreadyDeployed: true };
  }

  // Zero-value self-transfer. Mutating, so runCircle keeps retries at 0 (default)
  // so a dropped connection never double-sends.
  const out = runCircle([
    'wallet',
    'transfer',
    address,
    '--amount',
    '0',
    '--address',
    address,
    '--chain',
    chainCli(chain),
    '--output',
    'json',
  ]);
  const txId = extractTxId(out);

  // The SCA appears on-chain a few seconds after the transfer lands. Poll so
  // the wallet is provably deployed before this returns.
  const deadline = Date.now() + DEPLOY_POLL_TIMEOUT_MS;
  let deployed = false;
  while (Date.now() < deadline) {
    await sleep(DEPLOY_POLL_INTERVAL_MS);
    if (await isWalletDeployed({ address, chain })) {
      deployed = true;
      break;
    }
  }

  return { address, deployed, alreadyDeployed: false, txId };
}
