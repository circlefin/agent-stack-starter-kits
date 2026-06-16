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
  price?: string;
}

export interface ServiceInspection extends Service {
  schema?: unknown;
  health?: 'healthy' | 'degraded' | 'down' | string;
  /**
   * HTTP method the service expects (GET, POST, ...). A GET service reads its
   * input from the URL query string; a POST/PUT/PATCH service reads it from the
   * request body. Sending the input the wrong way makes the server see no input.
   */
  method?: string;
}

export interface PaymentResult {
  /**
   * The paid service's response body: the data the caller actually paid for.
   * JSON is re-stringified compact; non-JSON is passed through verbatim.
   */
  response: string;
  /**
   * On-chain settlement tx hash, when one can be parsed from the payment
   * receipt. Best-effort: a successful payment may still omit it, so success is
   * decided by the CLI exit code, not by this field's presence.
   */
  txHash?: string;
  serviceUrl: string;
  amount: string;
}

export interface GatewayBalance {
  address: string;
  /** Total USDC held in the wallet's Base Gateway balance. */
  total: string;
}

export interface GatewayDepositResult {
  amount: string;
  /** Circle transaction id / on-chain hash of the deposit, when one is parsed. */
  txId?: string;
  /**
   * The CLI `--method` actually used. `'direct'` deposits source==destination
   * on the requested chain (13-19 min). `'eco'` is fast (~30s) but is fixed by
   * the CLI: source=BASE, destination=Polygon Gateway, so it is only valid for
   * Polygon-settling Gateway sellers.
   */
  method?: 'direct' | 'eco';
}

/** Result of a plain, unpaid GET of a service endpoint. */
export interface FetchServiceResult {
  url: string;
  /** HTTP status of the GET. */
  status: number;
  /** True when the endpoint answered HTTP 402; the caller should route to payService. */
  paymentRequired: boolean;
  /** Response `content-type`, when the server sent one. */
  contentType?: string;
  /** Response body as text; JSON is re-stringified compact, other types passed through. */
  body: string;
}

/** Whether an x402 payment option is plain x402 or Circle Gateway batched. */
export type AcceptKind = 'vanilla' | 'gateway';

/** One payment option from a service's x402 challenge, on a chain the kit supports. */
export interface AcceptOption {
  kind: AcceptKind;
  /** The chain this option settles on (Base or Polygon). */
  chain: Chain;
  /** Price in atomic USDC units (6 decimals). */
  amountAtomic: string;
}

/** A service's x402 payment options, normalised to what the kit can act on. */
export interface ServiceAccepts {
  url: string;
  /** Payment options the kit can pay, across every supported chain (Base, Polygon). */
  options: AcceptOption[];
  /** CAIP-2 networks the seller offers but the kit cannot use (e.g. Solana, Ethereum). */
  unsupportedNetworks: string[];
}
