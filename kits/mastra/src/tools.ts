import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  createWallet,
  listWallets,
  getBalance,
  deployWallet,
  fundWalletFiat,
  isWalletDeployed,
  gatewayBalance,
  gatewayDeposit,
  searchServices,
  inspectService,
  fetchService,
  payService,
  getServiceAccepts,
  preferredChain,
  sellerRequiresGateway,
  chainLabel,
  ensureSession,
  logout,
  runCircle,
  type Chain,
} from '@agent-stack-ecosystem-kits/circle-tools';
import {
  fetchSetupSkill,
  fetchSubSkill,
  SETUP_SKILL_URL,
  SUB_SKILLS,
  SUB_SKILL_NAMES,
  type SubSkillName,
} from './skill';
import { bold, toolLine } from './theme';

const CHAIN = process.env['CIRCLE_CHAIN'] ?? 'BASE';
const chainEnum = z.enum(['BASE', 'POLYGON']);

function log(line: string): void {
  console.log(toolLine(line));
}

function preview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export const fetchSetupSkillTool = createTool({
  id: 'fetch_setup_skill',
  description: `Fetch the Circle Agent setup skill from ${SETUP_SKILL_URL}. Returns the raw markdown setup instructions to follow.`,
  inputSchema: z.object({}),
  execute: async () => {
    log(`fetch_setup_skill → ${SETUP_SKILL_URL}`);
    try {
      const body = await fetchSetupSkill();
      log(`fetch_setup_skill ← ${body.length} bytes`);
      return body;
    } catch (e) {
      log(`fetch_setup_skill ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

const subSkillEnum = z.enum(SUB_SKILL_NAMES as [SubSkillName, ...SubSkillName[]]);
const subSkillCatalog = SUB_SKILL_NAMES.map((n) => `- ${n} → ${SUB_SKILLS[n]}`).join('\n');

export const fetchSubSkillTool = createTool({
  id: 'fetch_sub_skill',
  description: `Fetch a Circle Agent sub-skill markdown by name. Call this when setup.md (or a tool error) references one of these sub-skills:\n${subSkillCatalog}`,
  inputSchema: z.object({
    name: subSkillEnum.describe('Sub-skill name, without the .md extension.'),
  }),
  execute: async (input) => {
    log(`fetch_sub_skill name=${input.name}`);
    try {
      const body = await fetchSubSkill(input.name);
      log(`fetch_sub_skill ← ${body.length} bytes`);
      return body;
    } catch (e) {
      log(`fetch_sub_skill ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleCreateWallet = createTool({
  id: 'circle_create_wallet',
  description: 'Create a new agent-controlled wallet on BASE via the Circle CLI.',
  inputSchema: z.object({}),
  execute: async () => {
    log(`circle_create_wallet`);
    try {
      const result = await createWallet();
      log(`circle_create_wallet ← ${(result as { address: string }).address}`);
      return result;
    } catch (e) {
      log(`circle_create_wallet ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleListWallets = createTool({
  id: 'circle_list_wallets',
  description: 'List existing agent wallets on BASE.',
  inputSchema: z.object({}),
  execute: async () => {
    log(`circle_list_wallets`);
    try {
      const result = await listWallets();
      log(`circle_list_wallets ← ${(result as unknown[]).length} wallet(s)`);
      return result;
    } catch (e) {
      log(`circle_list_wallets ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleGetBalance = createTool({
  id: 'circle_get_balance',
  description: 'Check USDC and token balances for an agent wallet. Defaults to Base; pass chain "POLYGON" to read the Polygon balance.',
  inputSchema: z.object({
    address: z.string().describe('The wallet address to check'),
    chain: chainEnum.optional().describe('Chain to read the balance on. Defaults to BASE.'),
  }),
  execute: async (input) => {
    log(`circle_get_balance address=${input.address} chain=${input.chain ?? 'BASE'}`);
    try {
      const result = await getBalance({ address: input.address, chain: input.chain as Chain | undefined });
      const tokens = (result as { tokens: Array<{ symbol?: string; amount?: string }> }).tokens;
      const usdc = tokens.find((t) => t.symbol?.toUpperCase() === 'USDC');
      log(`circle_get_balance ← USDC=${usdc?.amount ?? '0'} (${tokens.length} token(s))`);
      return result;
    } catch (e) {
      log(`circle_get_balance ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleWalletFund = createTool({
  id: 'circle_wallet_fund',
  description: 'Fund an agent wallet with testnet USDC using the Circle faucet (BASE only).',
  inputSchema: z.object({
    address: z.string().describe('The wallet address to fund'),
  }),
  execute: async (input) => {
    log(`circle_wallet_fund address=${input.address}`);
    try {
      const out = runCircle([
        'wallet',
        'fund',
        '--address',
        input.address,
        '--chain',
        'BASE',
        '--output',
        'json',
      ]);
      log(`circle_wallet_fund ← done`);
      return out;
    } catch (e) {
      log(`circle_wallet_fund ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleDeployWallet = createTool({
  id: 'circle_deploy_wallet',
  description:
    `Deploy an agent wallet's Smart Contract Account on-chain via a one-time, ` +
    'zero-value self-transfer. A freshly created wallet is counterfactual: it can receive ' +
    'USDC but cannot sign x402 payments until deployed. Deployment is per-chain, so deploy on ' +
    'the chain the payment will settle on (defaults to Base; pass chain "POLYGON" for a ' +
    'Polygon-only service). Idempotent and gas-abstracted (spends nothing), and safe to call ' +
    'on an already-deployed wallet, where it sends no transaction. Call this before ' +
    'circle_pay_service for any wallet that has never sent a transaction on that chain.',
  inputSchema: z.object({
    address: z.string().describe('Agent wallet address to deploy (0x...).'),
    chain: chainEnum.optional().describe('Chain to deploy the SCA on. Defaults to BASE.'),
  }),
  execute: async (input) => {
    log(`circle_deploy_wallet address=${input.address} chain=${input.chain ?? 'BASE'}`);
    try {
      const result = await deployWallet({ address: input.address, chain: input.chain as Chain | undefined });
      if (result.alreadyDeployed) {
        log(`circle_deploy_wallet ← already deployed`);
      } else if (result.deployed) {
        log(`circle_deploy_wallet ← deployed tx=${result.txId ?? 'n/a'}`);
      } else {
        log(`circle_deploy_wallet ← submitted, on-chain confirmation pending tx=${result.txId ?? 'n/a'}`);
      }
      return result;
    } catch (e) {
      log(`circle_deploy_wallet ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const fundFiatTool = createTool({
  id: 'circle_fund_fiat',
  description:
    'Fund a wallet with a fiat (card / bank) purchase via the Transak on-ramp. ' +
    'Returns a Transak `url` to give the user as a link to open: they complete the ' +
    'purchase there and the tokens deposit to the wallet on the chosen chain (defaults ' +
    'to Base). This tool only generates the URL and moves no USDC itself, so it needs ' +
    'no approval; the user pays inside the on-ramp. Use this when the user wants to buy ' +
    'USDC with money they do not yet hold in crypto. After the user reports the purchase ' +
    'complete, confirm with circle_get_balance. Mainnet only.',
  inputSchema: z.object({
    address: z.string().describe('Destination agent wallet address (0x...).'),
    amount: z.number().positive().describe('Amount of token to buy, in human units (e.g. 10 for $10 of USDC).'),
    chain: chainEnum.optional().describe('Chain the funds deposit on. Defaults to BASE.'),
    token: z
      .enum(['usdc', 'eurc', 'eth', 'native'])
      .optional()
      .describe('Token to buy. Defaults to usdc.'),
  }),
  execute: async (input) => {
    log(`circle_fund_fiat address=${input.address} amount=${input.amount} chain=${input.chain ?? 'BASE'} token=${input.token ?? 'usdc'}`);
    try {
      const result = await fundWalletFiat({ address: input.address, amount: input.amount, chain: input.chain, token: input.token, open: true });
      log(`circle_fund_fiat ← ${preview(result.url, 80)}`);
      return result;
    } catch (e) {
      log(`circle_fund_fiat ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const fetchServiceTool = createTool({
  id: 'fetch_service',
  description:
    'GET a service endpoint with no payment: the free-tier path. Try this FIRST ' +
    'for any endpoint a user names. A free endpoint (e.g. a catalog or index) ' +
    'returns its data directly with HTTP 200; use that body as the answer. If the ' +
    'result has paymentRequired=true (HTTP 402), the endpoint is paid: call ' +
    'circle_inspect_service then circle_pay_service instead.',
  inputSchema: z.object({
    url: z.string().describe('The service endpoint URL to GET.'),
  }),
  execute: async (input) => {
    log(`fetch_service url=${input.url}`);
    try {
      const result = await fetchService({ url: input.url });
      if (result.paymentRequired) {
        log(`fetch_service ← HTTP 402, payment required`);
      } else {
        log(`fetch_service ← HTTP ${result.status} ${result.body.length} bytes`);
      }
      return result;
    } catch (e) {
      log(`fetch_service ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleSearchServices = createTool({
  id: 'circle_search_services',
  description: 'Discover x402-compatible services on the Circle Agent Marketplace.',
  inputSchema: z.object({
    keyword: z.string().describe('Search keyword for service discovery'),
  }),
  execute: async (input) => {
    log(`circle_search_services keyword="${input.keyword}"`);
    try {
      const result = await searchServices({ keyword: input.keyword });
      log(`circle_search_services ← ${(result as unknown[]).length} hit(s)`);
      return result;
    } catch (e) {
      log(`circle_search_services ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleInspectService = createTool({
  id: 'circle_inspect_service',
  description:
    'Inspect an x402 service. Returns pricing, input schema, HTTP method, and health. Always ' +
    'call this before circle_pay_service so both the payload matches the schema and the ' +
    "`method` is passed through (a GET service's input goes in the query string, not a body).",
  inputSchema: z.object({
    url: z.string().describe('The service URL to inspect'),
  }),
  execute: async (input) => {
    log(`circle_inspect_service url=${input.url}`);
    try {
      const result = await inspectService({ url: input.url });
      log(`circle_inspect_service ← ${preview(JSON.stringify(result))}`);
      return result;
    } catch (e) {
      log(`circle_inspect_service ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleGetGatewayBalance = createTool({
  id: 'circle_get_gateway_balance',
  description:
    "Check the wallet's Circle Gateway balance: the off-chain batched-payment pool, " +
    'separate from the on-chain wallet balance reported by circle_get_balance. Defaults to ' +
    'Base; pass chain "POLYGON" to read the Polygon Gateway balance.',
  inputSchema: z.object({
    address: z.string().describe('EVM wallet address (0x...).'),
    chain: chainEnum.optional().describe('Chain to read the Gateway balance on. Defaults to BASE.'),
  }),
  execute: async (input) => {
    log(`circle_get_gateway_balance address=${input.address} chain=${input.chain ?? 'BASE'}`);
    try {
      const result = await gatewayBalance({ address: input.address, chain: input.chain as Chain | undefined });
      log(`circle_get_gateway_balance ← total=${result.total} USDC`);
      return result;
    } catch (e) {
      log(`circle_get_gateway_balance ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circlePayService = createTool({
  id: 'circle_pay_service',
  description:
    'Pay for an x402 service with a Circle USDC payment. The kit reads the ' +
    "service's published payment options and pays under the right scheme automatically: " +
    'vanilla x402, or Circle Gateway when the seller requires it. It also picks the chain: ' +
    'Base when the seller offers it, otherwise Polygon (the kit supports Base and Polygon). ' +
    'If the seller requires Gateway and the wallet has no Gateway balance, this fails with an ' +
    'actionable message: call circle_gateway_deposit for the same URL, then retry circle_pay_service. ' +
    'Pass the `method` from circle_inspect_service: a GET service reads data as URL ' +
    'query parameters, a POST/PUT/PATCH service reads it as a JSON body. Sending the wrong ' +
    'one makes the server see no input and still spends USDC, so always copy the inspected method.',
  inputSchema: z.object({
    url: z.string().describe('The service URL to pay'),
    address: z.string().describe('The wallet address to pay from'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .optional()
      .describe(
        "HTTP method the service expects, copied from circle_inspect_service's `method` " +
          'field. Defaults to GET if omitted.',
      ),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        'Payload object matching the service input schema. For a GET service these become ' +
          'query parameters; for POST/PUT/PATCH they become the JSON request body.',
      ),
  }),
  execute: async (input) => {
    const httpMethod = (input.method ?? 'GET').toUpperCase();
    log(`circle_pay_service url=${input.url} from=${input.address} method=${httpMethod}`);

    // Confirm the seller publishes a payment option on a chain the kit can pay,
    // and pick which chain to use. Base is preferred; Polygon is the fallback
    // when the seller offers no Base option.
    let chain: Chain;
    try {
      const accepts = await getServiceAccepts(input.url, httpMethod);
      const picked = preferredChain(accepts);
      if (!picked) {
        const offered = accepts.unsupportedNetworks.join(', ') || 'none';
        log(`circle_pay_service ✗ no supported pay option (seller offers: ${offered})`);
        throw new Error(
          `This service offers no payment option on a chain the kit supports (Base or Polygon). ` +
            `Seller networks: ${offered}.`,
        );
      }
      chain = picked;
    } catch (e) {
      log(`circle_pay_service ✗ ${(e as Error).message}`);
      throw e;
    }

    // Pre-flight: a counterfactual (undeployed) SCA cannot sign an x402 payment.
    // Deployment is per-chain, so check the chain being paid.
    try {
      if (!(await isWalletDeployed({ address: input.address, chain }))) {
        log(`circle_pay_service ✗ wallet not deployed on ${chain}`);
        throw new Error(
          `Wallet ${input.address} is not deployed on-chain on ${chainLabel(chain)} yet, so it ` +
            `cannot sign x402 payments there. Call circle_deploy_wallet with this address and ` +
            `chain "${chain}" first, then retry circle_pay_service.`,
        );
      }
    } catch (e) {
      if ((e as Error).message.includes('circle_deploy_wallet')) {
        log(`circle_pay_service ✗ ${(e as Error).message}`);
        throw e;
      }
      // Detection is best-effort: a flaky RPC must not block a real payment.
      log(`circle_pay_service: deployment check skipped (${(e as Error).message})`);
    }

    try {
      const result = await payService({
        url: input.url,
        address: input.address,
        data: input.data,
        method: httpMethod,
        chain,
      });
      const tx = (result as { txHash?: string }).txHash
        ? ` txHash=${(result as { txHash?: string }).txHash}`
        : '';
      log(`circle_pay_service ← paid on ${chainLabel(chain)}${tx}`);
      return result;
    } catch (e) {
      log(`circle_pay_service ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleGatewayDeposit = createTool({
  id: 'circle_gateway_deposit',
  description:
    "Fund the wallet's Circle Gateway balance so it can pay a seller that requires " +
    'Gateway (batched) x402 payments. Pass the service URL; the kit confirms the seller ' +
    'requires Gateway and picks the chain (Base preferred, else Polygon), then makes a direct ' +
    'deposit on that chain (slower, 13-19 min, and it consumes gas on that chain). Spends USDC ' +
    '(the deposit amount plus fee). After it succeeds, retry circle_pay_service for the same URL.',
  inputSchema: z.object({
    url: z.string().describe('The service URL this deposit is for.'),
    address: z.string().describe('Agent wallet address to deposit from (0x...).'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .optional()
      .describe(
        "HTTP method the service expects, copied from circle_inspect_service's `method` " +
          "field. Needed so the seller's Gateway requirement is read with the right " +
          'method. Defaults to GET.',
      ),
    amount: z
      .number()
      .positive()
      .describe(
        'USDC amount to move into Gateway. Size it to cover the expected paid calls ' +
          'plus the ~$0.03 fee; a Gateway minimum deposit may apply.',
      ),
  }),
  execute: async (input) => {
    const httpMethod = (input.method ?? 'GET').toUpperCase();
    log(`circle_gateway_deposit url=${input.url} address=${input.address} amount=${input.amount}`);
    // Only deposit when the seller actually requires a Gateway payment; for a
    // vanilla-x402 seller a deposit would not help. Deposit on the chain the
    // payment will settle on (Base preferred, else Polygon).
    let chain: Chain;
    try {
      const accepts = await getServiceAccepts(input.url, httpMethod);
      const picked = preferredChain(accepts);
      if (!picked || !sellerRequiresGateway(accepts, picked)) {
        log(`circle_gateway_deposit ✗ seller offers no Gateway option on a supported chain`);
        throw new Error(
          `${input.url} does not require a Circle Gateway payment on a chain the kit supports, so a ` +
            'Gateway deposit would not help. Pay it with circle_pay_service directly.',
        );
      }
      chain = picked;
    } catch (e) {
      log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
      throw e;
    }

    try {
      const result = await gatewayDeposit({ address: input.address, amount: input.amount, chain });
      log(`circle_gateway_deposit ← ${result.amount} USDC on ${chainLabel(chain)} tx=${result.txId ?? 'n/a'}`);
      return result;
    } catch (e) {
      log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const callFreeService = createTool({
  id: 'call_free_service',
  description:
    'Call a free (no-payment) service endpoint via HTTP with custom parameters. ' +
    'For simple GET probing, prefer fetch_service which also detects payment requirements. ' +
    'Use this for free endpoints that need POST or custom query parameters.',
  inputSchema: z.object({
    url: z.string().describe('The endpoint URL to call'),
    method: z.enum(['GET', 'POST']).default('GET').describe('HTTP method'),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Query params (GET) or JSON body (POST)'),
  }),
  execute: async (input) => {
    const method = input.method ?? 'GET';
    log(`call_free_service url=${input.url} method=${method}`);
    try {
      let url = input.url;
      const init: RequestInit = { method };

      if (method === 'GET' && input.params) {
        const qs = new URLSearchParams(
          Object.entries(input.params).map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString();
        url = `${url}?${qs}`;
      } else if (method === 'POST' && input.params) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(input.params);
      }

      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      log(`call_free_service ← HTTP ${res.status} ${text.length} bytes`);
      return text;
    } catch (e) {
      log(`call_free_service ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export function buildAuthTools(ask: (q: string) => Promise<string>) {
  const loginTool = createTool({
    id: 'circle_login',
    description:
      'Log in to the Circle agent wallet via email + OTP, or confirm an existing session. ' +
      'Use this whenever the user wants to log in or log back in, or when another tool fails ' +
      'because the session is missing or expired. The kit prompts the user in the terminal ' +
      'for their email and the OTP from their inbox (never stored); it does not accept the ' +
      'Terms of Use on their behalf. If a session is already valid this is a no-op that ' +
      'reports so. After it succeeds, retry whatever the user originally asked for.',
    inputSchema: z.object({}),
    execute: async () => {
      log('circle_login');
      try {
        const result = await ensureSession({ ask, log, bold });
        const message =
          result.status === 'already-valid'
            ? 'Already logged in; the Circle session is valid.'
            : 'Logged in. The Circle session is now valid.';
        log(`circle_login ← ${result.status}`);
        return { status: result.status, message };
      } catch (e) {
        log(`circle_login ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const logoutTool = createTool({
    id: 'circle_logout',
    description:
      'Log out of the Circle agent wallet and clear the stored credentials. Use this when the ' +
      'user wants to log out or switch accounts. Safe to call when no session exists (reports ' +
      'that nothing was logged out). After this, the user must circle_login again before any ' +
      'wallet or payment tool will work.',
    inputSchema: z.object({}),
    execute: async () => {
      log('circle_logout');
      try {
        logout(log);
        return { message: 'Logged out; Circle credentials cleared.' };
      } catch (e) {
        log(`circle_logout ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  return { loginTool, logoutTool };
}
