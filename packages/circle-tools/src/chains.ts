/**
 * The EVM chains the kit can pay on. The kit prefers Base and falls back to
 * Polygon only when a seller does not offer Base (see CHAIN_PREFERENCE).
 */
export type Chain = 'BASE' | 'POLYGON';

/** Chain used by default for wallet/gateway reads that are not service-bound. */
export const DEFAULT_CHAIN: Chain = 'BASE';

interface ChainInfo {
  /** Value passed to the Circle CLI `--chain` flag. */
  cli: string;
  /** Human label for log lines and error messages. */
  label: string;
  /** Public JSON-RPC endpoint, used to detect Smart Contract Account deployment. */
  rpcUrl: string;
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
    rpcUrl: 'https://mainnet.base.org',
    networks: ['eip155:8453', 'base'],
  },
  POLYGON: {
    cli: 'MATIC',
    label: 'Polygon',
    rpcUrl: 'https://polygon-rpc.com',
    networks: ['eip155:137', 'polygon', 'matic'],
  },
};

/**
 * Order the kit picks a chain in. Base comes first, so a service that publishes
 * both Base and Polygon options is paid on Base; Polygon is used only when Base
 * is not offered.
 */
export const CHAIN_PREFERENCE: readonly Chain[] = ['BASE', 'POLYGON'];

/** The Circle CLI `--chain` value for a chain. */
export function chainCli(chain: Chain): string {
  return CHAINS[chain].cli;
}

/** Human label for a chain, for log lines and error messages. */
export function chainLabel(chain: Chain): string {
  return CHAINS[chain].label;
}

/** Public JSON-RPC endpoint for a chain. */
export function chainRpcUrl(chain: Chain): string {
  return CHAINS[chain].rpcUrl;
}

/**
 * Map an x402 `accepts[].network` value to a supported Chain, or null when the
 * network is one the kit cannot pay (Solana, Ethereum, Arbitrum, ...).
 */
export function chainFromNetwork(network: string): Chain | null {
  const n = network.toLowerCase();
  for (const chain of CHAIN_PREFERENCE) {
    if (CHAINS[chain].networks.includes(n)) return chain;
  }
  return null;
}
