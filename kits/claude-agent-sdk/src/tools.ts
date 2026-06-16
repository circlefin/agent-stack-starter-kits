import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as circle from '@agent-stack-ecosystem-kits/circle-tools';
import { z } from 'zod';

import {
  fetchSetupSkill,
  fetchSubSkill,
  SETUP_SKILL_URL,
  SUB_SKILLS,
  SUB_SKILL_NAMES,
  type SubSkillName,
} from './skill';
import { bold, toolLine } from './theme';

/**
 * The Circle tools run as an in-process MCP server (`createSdkMcpServer`), the
 * Claude Agent SDK's native way to expose custom tools. Each tool is named
 * `<TOOL>` here but the SDK addresses it as `mcp__circle__<TOOL>` once the
 * server is mounted under MCP_SERVER_NAME, so the entry point and `canUseTool`
 * use the fully-qualified names below.
 */
export const MCP_SERVER_NAME = 'circle';

/** Fully-qualified MCP name for a tool on this server. */
function fq(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/**
 * The two tools that move USDC. The entry point routes these through human
 * approval in `canUseTool`; every other tool runs without a pause. Listed by
 * fully-qualified name to match what the SDK passes to `canUseTool`.
 */
export const SPEND_TOOLS = [fq('circle_pay_service'), fq('circle_gateway_deposit')] as const;

/** A tool result is plain text the model reads back: JSON for our tools. */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function log(line: string): void {
  console.log(toolLine(line));
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function err(e: unknown): ToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function preview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

const subSkillEnum = z.enum(SUB_SKILL_NAMES as [SubSkillName, ...SubSkillName[]]);
const subSkillCatalog = SUB_SKILL_NAMES.map((n) => `- ${n} → ${SUB_SKILLS[n]}`).join('\n');
const chainEnum = z.enum(['BASE', 'POLYGON']);

const fetchSetupSkillTool = tool(
  'fetch_setup_skill',
  `Fetch the Circle Agent setup skill from ${SETUP_SKILL_URL}. Equivalent to "curl -sL ${SETUP_SKILL_URL}". Returns the raw markdown setup instructions to follow.`,
  {},
  async (): Promise<ToolResult> => {
    log(`fetch_setup_skill → ${SETUP_SKILL_URL}`);
    try {
      const body = await fetchSetupSkill();
      log(`fetch_setup_skill ← ${body.length} bytes`);
      return { content: [{ type: 'text', text: body }] };
    } catch (e) {
      log(`fetch_setup_skill ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const fetchSubSkillTool = tool(
  'fetch_sub_skill',
  `Fetch a Circle Agent sub-skill markdown by name. Call this when setup.md (or a tool error) references one of these sub-skills:\n${subSkillCatalog}`,
  { name: subSkillEnum.describe('Sub-skill name, without the .md extension.') },
  async ({ name }): Promise<ToolResult> => {
    log(`fetch_sub_skill name=${name}`);
    try {
      const body = await fetchSubSkill(name);
      log(`fetch_sub_skill ← ${body.length} bytes`);
      return { content: [{ type: 'text', text: body }] };
    } catch (e) {
      log(`fetch_sub_skill ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const listAgentWallets = tool(
  'circle_list_wallets',
  `List existing Circle agent wallets on Base. Returns an array of { address }.`,
  {},
  async (): Promise<ToolResult> => {
    log(`circle_list_wallets`);
    try {
      const result = await circle.listWallets();
      log(`circle_list_wallets ← ${result.length} wallet(s)`);
      return ok(result);
    } catch (e) {
      log(`circle_list_wallets ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const createAgentWallet = tool(
  'circle_create_wallet',
  `Create a new Circle agent wallet on Base. Returns { address }.`,
  {},
  async (): Promise<ToolResult> => {
    log(`circle_create_wallet`);
    try {
      const result = await circle.createWallet();
      log(`circle_create_wallet ← ${result.address}`);
      return ok(result);
    } catch (e) {
      log(`circle_create_wallet ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const getWalletBalance = tool(
  'circle_get_balance',
  `Check USDC and token balances for a wallet address. Defaults to Base; pass chain "POLYGON" to read the Polygon balance.`,
  {
    address: z.string().describe('EVM wallet address (0x...).'),
    chain: chainEnum.optional().describe('Chain to read the balance on. Defaults to BASE.'),
  },
  async ({ address, chain }): Promise<ToolResult> => {
    log(`circle_get_balance address=${address} chain=${chain ?? 'BASE'}`);
    try {
      const result = await circle.getBalance({ address, chain });
      const usdc = result.tokens.find((t) => t.symbol?.toUpperCase() === 'USDC');
      log(`circle_get_balance ← USDC=${usdc?.amount ?? '0'} (${result.tokens.length} token(s))`);
      return ok(result);
    } catch (e) {
      log(`circle_get_balance ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const deployWalletTool = tool(
  'circle_deploy_wallet',
  `Deploy an agent wallet's Smart Contract Account on-chain via a one-time, ` +
    'zero-value self-transfer. A freshly created wallet is counterfactual: it can receive ' +
    'USDC but cannot sign x402 payments until deployed. Deployment is per-chain, so deploy on ' +
    'the chain the payment will settle on (defaults to Base; pass chain "POLYGON" for a ' +
    'Polygon-only service). Idempotent and gas-abstracted (spends nothing), and safe to call ' +
    'on an already-deployed wallet, where it sends no transaction. Call this before ' +
    'circle_pay_service for any wallet that has never sent a transaction on that chain.',
  {
    address: z.string().describe('Agent wallet address to deploy (0x...).'),
    chain: chainEnum.optional().describe('Chain to deploy the SCA on. Defaults to BASE.'),
  },
  async ({ address, chain }): Promise<ToolResult> => {
    log(`circle_deploy_wallet address=${address} chain=${chain ?? 'BASE'}`);
    try {
      const result = await circle.deployWallet({ address, chain });
      if (result.alreadyDeployed) {
        log(`circle_deploy_wallet ← already deployed`);
      } else if (result.deployed) {
        log(`circle_deploy_wallet ← deployed tx=${result.txId ?? 'n/a'}`);
      } else {
        log(
          `circle_deploy_wallet ← submitted, on-chain confirmation pending tx=${result.txId ?? 'n/a'}`,
        );
      }
      return ok(result);
    } catch (e) {
      log(`circle_deploy_wallet ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const fundFiatTool = tool(
  'circle_fund_fiat',
  'Fund a wallet with a fiat (card / bank) purchase via the Transak on-ramp. ' +
    'Returns a Transak `url` to give the user as a link to open: they complete the ' +
    'purchase there and the tokens deposit to the wallet on the chosen chain (defaults ' +
    'to Base). This tool only generates the URL and moves no USDC itself, so it needs ' +
    'no approval; the user pays inside the on-ramp. Use this when the user wants to buy ' +
    'USDC with money they do not yet hold in crypto. After the user reports the purchase ' +
    'complete, confirm with circle_get_balance. Mainnet only.',
  {
    address: z.string().describe('Destination agent wallet address (0x...).'),
    amount: z.number().positive().describe('Amount of token to buy, in human units (e.g. 10 for $10 of USDC).'),
    chain: chainEnum.optional().describe('Chain the funds deposit on. Defaults to BASE.'),
    token: z
      .enum(['usdc', 'eurc', 'eth', 'native'])
      .optional()
      .describe('Token to buy. Defaults to usdc.'),
  },
  async ({ address, amount, chain, token }): Promise<ToolResult> => {
    log(`circle_fund_fiat address=${address} amount=${amount} chain=${chain ?? 'BASE'} token=${token ?? 'usdc'}`);
    try {
      // Local interactive demo: open the Transak page in the user's browser so
      // they can complete the purchase. Best-effort and a no-op on headless.
      const result = await circle.fundWalletFiat({ address, amount, chain, token, open: true });
      log(`circle_fund_fiat ← ${preview(result.url, 80)}`);
      return ok(result);
    } catch (e) {
      log(`circle_fund_fiat ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const searchServices = tool(
  'circle_search_services',
  'Discover x402-compatible services on the Circle Agent Marketplace matching a keyword.',
  { keyword: z.string().describe('Search keyword, e.g. "weather", "image", "geocode".') },
  async ({ keyword }): Promise<ToolResult> => {
    log(`circle_search_services keyword="${keyword}"`);
    try {
      const result = await circle.searchServices({ keyword });
      log(`circle_search_services ← ${result.length} hit(s)`);
      return ok(result);
    } catch (e) {
      log(`circle_search_services ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const inspectService = tool(
  'circle_inspect_service',
  'Inspect an x402 service. Returns pricing, input schema, HTTP method, and health. Always ' +
    'call this before circle_pay_service so both the payload matches the schema and the ' +
    "`method` is passed through (a GET service's input goes in the query string, not a body).",
  { url: z.string().describe('The service URL returned by circle_search_services.') },
  async ({ url }): Promise<ToolResult> => {
    log(`circle_inspect_service url=${url}`);
    try {
      const result = await circle.inspectService({ url });
      log(`circle_inspect_service ← ${preview(JSON.stringify(result))}`);
      return ok(result);
    } catch (e) {
      log(`circle_inspect_service ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const fetchServiceTool = tool(
  'fetch_service',
  'GET a service endpoint with no payment: the free-tier path. Try this FIRST ' +
    'for any endpoint a user names. A free endpoint (e.g. a catalog or index) ' +
    'returns its data directly with HTTP 200; use that body as the answer. If the ' +
    'result has paymentRequired=true (HTTP 402), the endpoint is paid: call ' +
    'circle_inspect_service then circle_pay_service instead. Free endpoints publish no x402 ' +
    'payment options, so circle_pay_service can never be used on them.',
  { url: z.string().describe('The service endpoint URL to GET.') },
  async ({ url }): Promise<ToolResult> => {
    log(`fetch_service url=${url}`);
    try {
      const result = await circle.fetchService({ url });
      if (result.paymentRequired) {
        log(`fetch_service ← HTTP 402, payment required`);
      } else {
        log(`fetch_service ← HTTP ${result.status} ${result.body.length} bytes`);
      }
      return ok(result);
    } catch (e) {
      log(`fetch_service ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const payService = tool(
  'circle_pay_service',
  'Pay for an x402 service with a Circle USDC payment. The kit reads the ' +
    "service's published payment options and pays under the right scheme automatically: " +
    'vanilla x402, or Circle Gateway when the seller requires it. It also picks the chain: ' +
    'Base when the seller offers it, otherwise Polygon (the kit supports Base and Polygon). ' +
    'If the seller requires ' +
    'Gateway and the wallet has no Gateway balance, this fails with an actionable ' +
    'message: call circle_gateway_deposit for the same URL, then retry circle_pay_service. ' +
    'Pass the `method` from circle_inspect_service: a GET service reads dataJson as URL ' +
    'query parameters, a POST/PUT/PATCH service reads it as a JSON body. Sending the wrong ' +
    'one makes the server see no input and still spends USDC, so always copy the inspected method.',
  {
    url: z.string().describe('Service URL.'),
    address: z.string().describe('Paying agent wallet address (0x...).'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .optional()
      .describe(
        "HTTP method the service expects, copied from circle_inspect_service's `method` " +
          'field. Defaults to GET if omitted.',
      ),
    dataJson: z
      .string()
      .describe(
        'JSON-encoded payload object matching the service input schema, e.g. \'{"city":"NYC"}\'. ' +
          'For a GET service these become query parameters (arrays repeat the key, e.g. ' +
          'symbols=ETH&symbols=BTC); for POST/PUT/PATCH they become the JSON request body.',
      ),
  },
  async ({ url, address, dataJson, method }): Promise<ToolResult> => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    log(
      `circle_pay_service url=${url} from=${address} method=${httpMethod} data=${preview(dataJson, 80)}`,
    );
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataJson) as Record<string, unknown>;
    } catch (e) {
      log(`circle_pay_service ✗ invalid dataJson`);
      return err(
        new Error(
          `dataJson is not valid JSON: ${(e as Error).message}. Re-check the service schema from circle_inspect_service.`,
        ),
      );
    }

    // Confirm the seller publishes a payment option on a chain the kit can pay,
    // and pick which chain to use. Base is preferred; Polygon is the fallback
    // when the seller offers no Base option. A Solana- or Ethereum-only service
    // is rejected here with the networks it actually offers.
    let chain: circle.Chain;
    try {
      const accepts = await circle.getServiceAccepts(url, httpMethod);
      const picked = circle.preferredChain(accepts);
      if (!picked) {
        const offered = accepts.unsupportedNetworks.join(', ') || 'none';
        log(`circle_pay_service ✗ no supported pay option (seller offers: ${offered})`);
        return err(
          new Error(
            `This service offers no payment option on a chain the kit supports (Base or Polygon). ` +
              `Seller networks: ${offered}.`,
          ),
        );
      }
      chain = picked;
    } catch (e) {
      log(`circle_pay_service ✗ ${(e as Error).message}`);
      return err(e);
    }

    // Pre-flight: a counterfactual (undeployed) SCA cannot sign an x402 payment.
    // Deployment is per-chain, so check the chain being paid. Catch it here with
    // an actionable message instead of the CLI's opaque "Could not sign payment
    // authorization" failure.
    try {
      if (!(await circle.isWalletDeployed({ address, chain }))) {
        log(`circle_pay_service ✗ wallet not deployed on ${chain}`);
        return err(
          new Error(
            `Wallet ${address} is not deployed on-chain on ${circle.chainLabel(chain)} yet, so it ` +
              `cannot sign x402 payments there. Call circle_deploy_wallet with this address and ` +
              `chain "${chain}" first, then retry circle_pay_service.`,
          ),
        );
      }
    } catch (e) {
      // Detection is best-effort: a flaky RPC must not block a real payment.
      log(`circle_pay_service: deployment check skipped (${(e as Error).message})`);
    }

    try {
      const result = await circle.payService({ url, address, data, method: httpMethod, chain });
      const tx = result.txHash ? ` txHash=${result.txHash}` : '';
      log(`circle_pay_service ← paid on ${circle.chainLabel(chain)}${tx} ${result.response.length} bytes`);
      return ok(result);
    } catch (e) {
      log(`circle_pay_service ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const getGatewayBalance = tool(
  'circle_get_gateway_balance',
  "Check the wallet's Circle Gateway balance: the off-chain batched-payment pool, " +
    'separate from the on-chain wallet balance reported by circle_get_balance. Defaults to ' +
    'Base; pass chain "POLYGON" to read the Polygon Gateway balance.',
  {
    address: z.string().describe('EVM wallet address (0x...).'),
    chain: chainEnum.optional().describe('Chain to read the Gateway balance on. Defaults to BASE.'),
  },
  async ({ address, chain }): Promise<ToolResult> => {
    log(`circle_get_gateway_balance address=${address} chain=${chain ?? 'BASE'}`);
    try {
      const result = await circle.gatewayBalance({ address, chain });
      log(`circle_get_gateway_balance ← total=${result.total} USDC`);
      return ok(result);
    } catch (e) {
      log(`circle_get_gateway_balance ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const gatewayDepositTool = tool(
  'circle_gateway_deposit',
  "Fund the wallet's Circle Gateway balance so it can pay a seller that requires " +
    'Gateway (batched) x402 payments. Pass the service URL; the kit confirms the seller ' +
    'requires Gateway and picks the chain (Base preferred, else Polygon), then deposits on ' +
    'that chain. Method auto-selected: Polygon sellers use the fast eco path (~30s, no gas on ' +
    "source, USDC sourced from the wallet's Base USDC balance and landed in the Polygon " +
    'Gateway pool); Base sellers use direct (13-19 min, consumes gas on Base). Spends USDC ' +
    '(the deposit amount plus fee) and pauses for human approval. After it succeeds, retry ' +
    'circle_pay_service for the same URL.',
  {
    url: z.string().describe('The service URL this deposit is for.'),
    address: z.string().describe('Agent wallet address to deposit from (0x...).'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .optional()
      .describe(
        "HTTP method the service expects, copied from circle_inspect_service's `method` " +
          'field. Needed so the seller\'s Gateway requirement is read with the right ' +
          'method (a POST-only endpoint answers 405 to a GET probe). Defaults to GET.',
      ),
    amount: z
      .number()
      .positive()
      .describe(
        'USDC amount to move into Gateway. Size it to cover the expected paid calls ' +
          'plus the ~$0.03 fee; a Gateway minimum deposit may apply.',
      ),
  },
  async ({ url, address, amount, method }): Promise<ToolResult> => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    log(`circle_gateway_deposit url=${url} address=${address} amount=${amount}`);
    // Only deposit when the seller actually requires a Gateway payment; for a
    // vanilla-x402 seller a deposit would not help. Deposit on the chain the
    // payment will settle on (Base preferred, else Polygon).
    let chain: circle.Chain;
    try {
      const accepts = await circle.getServiceAccepts(url, httpMethod);
      const picked = circle.preferredChain(accepts);
      if (!picked || !circle.sellerRequiresGateway(accepts, picked)) {
        log(`circle_gateway_deposit ✗ seller offers no Gateway option on a supported chain`);
        return err(
          new Error(
            `${url} does not require a Circle Gateway payment on a chain the kit supports, so a ` +
              'Gateway deposit would not help. Pay it with circle_pay_service directly.',
          ),
        );
      }
      chain = picked;
    } catch (e) {
      log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
      return err(e);
    }

    // Pick deposit method: Polygon Gateway sellers get the fast (~30s) eco
    // method, which sources Base USDC and lands on Polygon. Base Gateway
    // sellers must use direct (13-19 min) because eco's destination is
    // hardcoded to Polygon by the CLI.
    const depositMethod: circle.GatewayDepositMethod = chain === 'POLYGON' ? 'eco' : 'direct';
    try {
      const result = await circle.gatewayDeposit({
        address,
        amount,
        chain,
        method: depositMethod,
      });
      log(
        `circle_gateway_deposit ← ${result.amount} USDC on ${circle.chainLabel(chain)} via ${depositMethod} tx=${result.txId ?? 'n/a'}`,
      );
      return ok(result);
    } catch (e) {
      log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const ALL_TOOLS = [
  fetchSetupSkillTool,
  fetchSubSkillTool,
  listAgentWallets,
  createAgentWallet,
  getWalletBalance,
  getGatewayBalance,
  deployWalletTool,
  fundFiatTool,
  searchServices,
  inspectService,
  fetchServiceTool,
  payService,
  gatewayDepositTool,
];

/**
 * The in-process MCP server exposing the Circle tools to the agent.
 *
 * The login/logout tools are built here, not at module scope, because they need
 * the demo's terminal `ask` to prompt the human for their email + OTP inline
 * (the kit never stores either). They let the agent recover an expired or
 * logged-out session mid-conversation instead of dead-ending on "run it
 * yourself" with no tool to call.
 */
export function buildCircleServer(ask: (q: string) => Promise<string>) {
  const loginTool = tool(
    'circle_login',
    'Log in to the Circle agent wallet via email + OTP, or confirm an existing session. ' +
      'Use this whenever the user wants to log in or log back in, or when another tool fails ' +
      'because the session is missing or expired. The kit prompts the user in the terminal ' +
      'for their email and the OTP from their inbox (never stored); it does not accept the ' +
      'Terms of Use on their behalf. If a session is already valid this is a no-op that ' +
      'reports so. After it succeeds, retry whatever the user originally asked for.',
    {},
    async (): Promise<ToolResult> => {
      log('circle_login');
      try {
        const result = await circle.ensureSession({ ask, log, bold });
        const message =
          result.status === 'already-valid'
            ? 'Already logged in; the Circle session is valid.'
            : 'Logged in. The Circle session is now valid.';
        log(`circle_login ← ${result.status}`);
        return ok({ status: result.status, message });
      } catch (e) {
        log(`circle_login ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
  );

  const logoutTool = tool(
    'circle_logout',
    'Log out of the Circle agent wallet and clear the stored credentials. Use this when the ' +
      'user wants to log out or switch accounts. Safe to call when no session exists (reports ' +
      'that nothing was logged out). After this, the user must circle_login again before any ' +
      'wallet or payment tool will work.',
    {},
    async (): Promise<ToolResult> => {
      log('circle_logout');
      try {
        circle.logout(log);
        return ok({ message: 'Logged out; Circle credentials cleared.' });
      } catch (e) {
        log(`circle_logout ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
  );

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.0.0',
    tools: [...ALL_TOOLS, loginTool, logoutTool],
  });
}
