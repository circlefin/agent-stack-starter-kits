import { tool } from 'ai';
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
  sellerRequiresGateway,
  ensureSession,
  logout,
  runCircle,
  DEFAULT_CHAIN,
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
import { bold, colorizeJson, green, red, toolLine, yellow } from './theme';

export type AskFn = (q: string) => Promise<string>;

const CHAIN = (process.env['CIRCLE_CHAIN'] ?? DEFAULT_CHAIN) as Chain;

function log(line: string): void {
  console.log(toolLine(line));
}

function preview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Helper to format a caught error for return.
 *
 * In the Vercel AI SDK, when a tool's `execute` function *throws*, the error
 * bubbles up through `generateText` all the way to the caller — the model never
 * sees it and the process crashes. Returning `{ error }` instead gives the model
 * the failure information as a tool result so it can diagnose and recover without
 * any external retry or interruption mechanism.
 */
function toolError(e: unknown): { error: string } {
  return { error: e instanceof Error ? e.message : String(e) };
}

/**
 * Build the Vercel AI SDK tool set.
 *
 * The `ask` parameter is threaded into the two spend tools
 * (circle_pay_service, circle_gateway_deposit) so they can pause and ask the
 * human for approval before touching USDC. This is the Vercel AI SDK approach
 * to human-in-the-loop: approval logic lives INSIDE the `execute` function of
 * the tool itself, rather than in an external hook like LangChain's
 * `interruptOn` or the Claude Agent SDK's `canUseTool`.
 */
export function buildTools(ask: AskFn) {
  const subSkillEnum = z.enum(SUB_SKILL_NAMES as [SubSkillName, ...SubSkillName[]]);
  const subSkillCatalog = SUB_SKILL_NAMES.map((n) => `- ${n} → ${SUB_SKILLS[n]}`).join('\n');

  return {
    // ── Auth tools ────────────────────────────────────────────────────────────

    circle_login: tool({
      description:
        'Log in to the Circle agent wallet via email + OTP, or confirm an existing session. ' +
        'Use this whenever the user wants to log in or log back in, or when another tool fails ' +
        'because the session is missing or expired. The kit prompts the user in the terminal ' +
        'for their email and the OTP from their inbox (never stored); it does not accept the ' +
        'Terms of Use on their behalf. If a session is already valid this is a no-op that ' +
        'reports so. After it succeeds, retry whatever the user originally asked for.',
      parameters: z.object({}),
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
          return toolError(e);
        }
      },
    }),

    circle_logout: tool({
      description:
        'Log out of the Circle agent wallet and clear the stored credentials. Use this when the ' +
        'user wants to log out or switch accounts. Safe to call when no session exists (reports ' +
        'that nothing was logged out). After this, the user must circle_login again before any ' +
        'wallet or payment tool will work.',
      parameters: z.object({}),
      execute: async () => {
        log('circle_logout');
        try {
          logout(log);
          return { message: 'Logged out; Circle credentials cleared.' };
        } catch (e) {
          log(`circle_logout ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    // ── Skill fetchers ────────────────────────────────────────────────────────

    fetch_setup_skill: tool({
      description: `Fetch the Circle Agent setup skill from ${SETUP_SKILL_URL}. Returns the raw markdown setup instructions to follow.`,
      parameters: z.object({}),
      execute: async () => {
        log(`fetch_setup_skill → ${SETUP_SKILL_URL}`);
        try {
          const body = await fetchSetupSkill();
          log(`fetch_setup_skill ← ${body.length} bytes`);
          return body;
        } catch (e) {
          log(`fetch_setup_skill ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    fetch_sub_skill: tool({
      description:
        `Fetch a Circle Agent sub-skill markdown by name. Call this when setup.md (or a tool ` +
        `error) references one of these sub-skills:\n${subSkillCatalog}`,
      parameters: z.object({
        name: subSkillEnum.describe('Sub-skill name, without the .md extension.'),
      }),
      execute: async ({ name }) => {
        log(`fetch_sub_skill name=${name}`);
        try {
          const body = await fetchSubSkill(name);
          log(`fetch_sub_skill ← ${body.length} bytes`);
          return body;
        } catch (e) {
          log(`fetch_sub_skill ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    // ── Wallet tools ──────────────────────────────────────────────────────────

    circle_list_wallets: tool({
      description: 'List existing agent wallets on BASE.',
      parameters: z.object({}),
      execute: async () => {
        log(`circle_list_wallets`);
        try {
          const result = await listWallets();
          log(`circle_list_wallets ← ${(result as unknown[]).length} wallet(s)`);
          return result;
        } catch (e) {
          log(`circle_list_wallets ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_create_wallet: tool({
      description: 'Create a new agent-controlled wallet on BASE via the Circle CLI.',
      parameters: z.object({}),
      execute: async () => {
        log(`circle_create_wallet`);
        try {
          const result = await createWallet();
          log(`circle_create_wallet ← ${(result as { address: string }).address}`);
          return result;
        } catch (e) {
          log(`circle_create_wallet ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_get_balance: tool({
      description: 'Check USDC and token balances for an agent wallet on BASE.',
      parameters: z.object({
        address: z.string().describe('The wallet address to check'),
      }),
      execute: async ({ address }) => {
        log(`circle_get_balance address=${address}`);
        try {
          const result = await getBalance({ address });
          const tokens = (result as { tokens: Array<{ symbol?: string; amount?: string }> }).tokens;
          const usdc = tokens.find((t) => t.symbol?.toUpperCase() === 'USDC');
          log(`circle_get_balance ← USDC=${usdc?.amount ?? '0'} (${tokens.length} token(s))`);
          return result;
        } catch (e) {
          log(`circle_get_balance ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_deploy_wallet: tool({
      description:
        `Deploy a Base agent wallet's Smart Contract Account on-chain via a one-time, ` +
        'zero-value self-transfer. A freshly created wallet is counterfactual: it can receive ' +
        'USDC but cannot sign x402 payments until deployed. Idempotent and gas-abstracted ' +
        '(spends nothing), and safe to call on an already-deployed wallet, where it sends no ' +
        'transaction. Call this before circle_pay_service for any wallet that has never sent a transaction.',
      parameters: z.object({
        address: z.string().describe('Agent wallet address to deploy (0x...).'),
      }),
      execute: async ({ address }) => {
        log(`circle_deploy_wallet address=${address}`);
        try {
          const result = await deployWallet({ address });
          if (result.alreadyDeployed) {
            log(`circle_deploy_wallet ← already deployed`);
          } else if (result.deployed) {
            log(`circle_deploy_wallet ← deployed tx=${result.txId ?? 'n/a'}`);
          } else {
            log(
              `circle_deploy_wallet ← submitted, on-chain confirmation pending tx=${result.txId ?? 'n/a'}`,
            );
          }
          return result;
        } catch (e) {
          log(`circle_deploy_wallet ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_wallet_fund: tool({
      description:
        'Fund an agent wallet with testnet USDC using the Circle faucet (BASE only). ' +
        'Use method="crypto" for the free testnet faucet (recommended for demos). ' +
        'Use method="fiat" for the test card flow.',
      parameters: z.object({
        address: z.string().describe('The wallet address to fund'),
        method: z
          .enum(['crypto', 'fiat'])
          .default('crypto')
          .describe('"crypto" uses the testnet faucet; "fiat" uses a test card.'),
      }),
      execute: async ({ address, method }) => {
        log(`circle_wallet_fund address=${address} method=${method}`);
        try {
          const out = runCircle([
            'wallet',
            'fund',
            '--address',
            address,
            '--chain',
            CHAIN,
            '--method',
            method,
            '--output',
            'json',
          ]);
          log(`circle_wallet_fund ← done`);
          return out;
        } catch (e) {
          log(`circle_wallet_fund ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_fund_fiat: tool({
      description:
        'Fund a wallet with a fiat (card / bank) purchase via the Transak on-ramp. ' +
        'Returns a Transak `url` to give the user as a link to open: they complete the ' +
        'purchase there and the tokens deposit to the wallet on the chosen chain (defaults ' +
        'to Base). This tool only generates the URL and moves no USDC itself, so it needs ' +
        'no approval; the user pays inside the on-ramp. Use this when the user wants to buy ' +
        'USDC with money they do not yet hold in crypto. After the user reports the purchase ' +
        'complete, confirm with circle_get_balance. Mainnet only.',
      parameters: z.object({
        address: z.string().describe('Destination agent wallet address (0x...).'),
        amount: z.number().positive().describe('Amount of token to buy, in human units (e.g. 10 for $10 of USDC).'),
        chain: z
          .enum(['BASE', 'POLYGON'])
          .optional()
          .describe('Chain the funds deposit on. Defaults to BASE.'),
        token: z
          .enum(['usdc', 'eurc', 'eth', 'native'])
          .optional()
          .describe('Token to buy. Defaults to usdc.'),
      }),
      execute: async ({ address, amount, chain, token }) => {
        log(`circle_fund_fiat address=${address} amount=${amount} chain=${chain ?? 'BASE'} token=${token ?? 'usdc'}`);
        try {
          const result = await fundWalletFiat({ address, amount, chain: chain as Chain | undefined, token, open: true });
          log(`circle_fund_fiat ← ${preview(result.url, 80)}`);
          return result;
        } catch (e) {
          log(`circle_fund_fiat ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    // ── Service discovery tools ───────────────────────────────────────────────

    circle_search_services: tool({
      description: 'Discover x402-compatible services on the Circle Agent Marketplace.',
      parameters: z.object({
        keyword: z.string().describe('Search keyword for service discovery'),
      }),
      execute: async ({ keyword }) => {
        log(`circle_search_services keyword="${keyword}"`);
        try {
          const result = await searchServices({ keyword });
          log(`circle_search_services ← ${(result as unknown[]).length} hit(s)`);
          return result;
        } catch (e) {
          log(`circle_search_services ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_inspect_service: tool({
      description:
        'Inspect an x402 service. Returns pricing, input schema, HTTP method, and health. Always ' +
        'call this before circle_pay_service so both the payload matches the schema and the ' +
        "`method` is passed through (a GET service's input goes in the query string, not a body).",
      parameters: z.object({
        url: z.string().describe('The service URL to inspect'),
      }),
      execute: async ({ url }) => {
        log(`circle_inspect_service url=${url}`);
        try {
          const result = await inspectService({ url });
          log(`circle_inspect_service ← ${preview(JSON.stringify(result))}`);
          return result;
        } catch (e) {
          log(`circle_inspect_service ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    fetch_service: tool({
      description:
        'GET a service endpoint with no payment: the free-tier path. Try this FIRST ' +
        'for any endpoint a user names. A free endpoint (e.g. a catalog or index) ' +
        'returns its data directly with HTTP 200; use that body as the answer. If the ' +
        'result has paymentRequired=true (HTTP 402), the endpoint is paid: call ' +
        'circle_inspect_service then circle_pay_service instead.',
      parameters: z.object({
        url: z.string().describe('The service endpoint URL to GET.'),
      }),
      execute: async ({ url }) => {
        log(`fetch_service url=${url}`);
        try {
          const result = await fetchService({ url });
          if (result.paymentRequired) {
            log(`fetch_service ← HTTP 402, payment required`);
          } else {
            log(`fetch_service ← HTTP ${result.status} ${result.body.length} bytes`);
          }
          return result;
        } catch (e) {
          log(`fetch_service ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_get_gateway_balance: tool({
      description:
        "Check the wallet's Base Circle Gateway balance: the off-chain batched-payment pool, " +
        'separate from the on-chain wallet balance reported by circle_get_balance.',
      parameters: z.object({
        address: z.string().describe('EVM wallet address (0x...).'),
      }),
      execute: async ({ address }) => {
        log(`circle_get_gateway_balance address=${address}`);
        try {
          const result = await gatewayBalance({ address });
          log(`circle_get_gateway_balance ← total=${result.total} USDC`);
          return result;
        } catch (e) {
          log(`circle_get_gateway_balance ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    // ── Spend tools — require human approval before executing ─────────────────
    //
    // In the Vercel AI SDK there is no external hook (no interruptOn, no
    // canUseTool). Human-in-the-loop lives INSIDE the tool's execute function:
    // the agent calls the tool normally, execution pauses on `await ask(...)`,
    // and only proceeds after the human types "y".
    //
    // Errors are also returned rather than thrown — consistent with the rest of
    // the kit — so the model can reason about failures and recover.

    circle_pay_service: tool({
      description:
        'Pay for an x402 service with a Circle USDC payment on Base. The kit reads the ' +
        "service's published payment options and pays under the right scheme automatically: " +
        'vanilla x402, or Circle Gateway when the seller requires it. If the seller requires ' +
        'Gateway and the wallet has no Gateway balance, this fails with an actionable ' +
        'message: call circle_gateway_deposit for the same URL, then retry circle_pay_service. ' +
        'Pass the `method` from circle_inspect_service: a GET service reads data as URL ' +
        'query parameters, a POST/PUT/PATCH service reads it as a JSON body. Sending the wrong ' +
        'one makes the server see no input and still spends USDC, so always copy the inspected method.',
      parameters: z.object({
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
      execute: async ({ url, address, method, data }) => {
        const httpMethod = (method ?? 'GET').toUpperCase();
        log(`circle_pay_service url=${url} from=${address} method=${httpMethod}`);

        // ── Human-in-the-loop ──────────────────────────────────────────────
        // The Vercel AI SDK has no external approval hook: we pause execution
        // here by awaiting user input before any USDC is spent.
        console.log(`\n${yellow('⚠')}  ${bold('approval required:')} circle_pay_service`);
        console.log(colorizeJson({ url, address, method: httpMethod, data }));
        const answer = (await ask(`${bold('Approve? [y/N]')} `)).trim().toLowerCase();
        if (answer !== 'y') {
          log(red('circle_pay_service ✗ rejected by user'));
          return { denied: true, message: 'Payment rejected by user.' };
        }
        console.log(green('✓ approved'));
        // ──────────────────────────────────────────────────────────────────

        // Confirm the seller publishes a Base payment option before paying.
        let accepts;
        try {
          accepts = await getServiceAccepts(url, httpMethod);
        } catch (e) {
          log(`circle_pay_service ✗ could not read seller's payment options: ${(e as Error).message}`);
          return toolError(e);
        }
        if (accepts.options.length === 0) {
          const offered = accepts.unsupportedNetworks.join(', ') || 'none';
          const msg =
            `This service offers no Base payment option, the only chain the kit supports. ` +
            `Seller networks: ${offered}.`;
          log(`circle_pay_service ✗ ${msg}`);
          return { error: msg };
        }

        // Pre-flight: a counterfactual (undeployed) SCA cannot sign an x402 payment.
        try {
          if (!(await isWalletDeployed({ address }))) {
            const msg =
              `Wallet ${address} is not deployed on-chain yet, so it cannot sign x402 ` +
              'payments. Call circle_deploy_wallet with this address first, then retry circle_pay_service.';
            log(`circle_pay_service ✗ wallet not deployed`);
            return { error: msg };
          }
        } catch (e) {
          // Detection is best-effort: a flaky RPC must not block a real payment.
          log(`circle_pay_service: deployment check skipped (${(e as Error).message})`);
        }

        try {
          const result = await payService({ url, address, data, method: httpMethod });
          const tx = (result as { txHash?: string }).txHash
            ? ` txHash=${(result as { txHash?: string }).txHash}`
            : '';
          log(`circle_pay_service ← paid${tx}`);
          return result;
        } catch (e) {
          log(`circle_pay_service ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),

    circle_gateway_deposit: tool({
      description:
        "Fund the wallet's Circle Gateway balance so it can pay a seller that requires " +
        'Gateway (batched) x402 payments. Pass the service URL; the kit confirms the seller ' +
        'requires Gateway, then deposits USDC. Spends USDC (the deposit amount plus fee). ' +
        'After it succeeds, retry circle_pay_service for the same URL. ' +
        'Use deposit_method="eco" (default) for Base→Polygon Gateway: ~30-50 s settlement, ' +
        '$0.03 flat fee. Only use deposit_method="direct" when the source chain is not Base, ' +
        'the seller does not accept Polygon Gateway, or the user explicitly requests it — ' +
        'direct on Base takes 13-19 minutes.',
      parameters: z.object({
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
        deposit_method: z
          .enum(['eco', 'direct'])
          .default('eco')
          .describe(
            '"eco" routes Base→Polygon Gateway (~30-50 s, $0.03 flat fee) — the right ' +
              'default for nearly all cases. "direct" deposits on-chain on the source chain ' +
              '(~13-19 min on Base, ~8 s on Polygon/Avalanche). Only use "direct" when the ' +
              'source is not Base, the seller requires a non-Polygon chain, or explicitly requested.',
          ),
        amount: z
          .number()
          .positive()
          .describe(
            'USDC amount to move into Gateway. Size it to cover the expected paid calls ' +
              'plus the ~$0.03 eco fee; a Gateway minimum deposit may apply.',
          ),
      }),
      execute: async ({ url, address, method, deposit_method, amount }) => {
        const httpMethod = (method ?? 'GET').toUpperCase();
        const depositMethod = deposit_method ?? 'eco';
        log(`circle_gateway_deposit url=${url} address=${address} amount=${amount} deposit_method=${depositMethod}`);

        // ── Human-in-the-loop ──────────────────────────────────────────────
        console.log(`\n${yellow('⚠')}  ${bold('approval required:')} circle_gateway_deposit`);
        console.log(colorizeJson({ url, address, method: httpMethod, deposit_method: depositMethod, amount }));
        const answer = (await ask(`${bold('Approve? [y/N]')} `)).trim().toLowerCase();
        if (answer !== 'y') {
          log(red('circle_gateway_deposit ✗ rejected by user'));
          return { denied: true, message: 'Gateway deposit rejected by user.' };
        }
        console.log(green('✓ approved'));
        // ──────────────────────────────────────────────────────────────────

        try {
          const accepts = await getServiceAccepts(url, httpMethod);
          if (!sellerRequiresGateway(accepts, CHAIN)) {
            const msg =
              `${url} does not require a Base Gateway payment, so a Gateway deposit would not ` +
              'help. Pay it with circle_pay_service directly.';
            log(`circle_gateway_deposit ✗ ${msg}`);
            return { error: msg };
          }
        } catch (e) {
          log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
          return toolError(e);
        }

        try {
          const result = await gatewayDeposit({ address, amount, method: depositMethod });
          log(`circle_gateway_deposit ← ${result.amount} USDC via ${depositMethod} tx=${result.txId ?? 'n/a'}`);
          return result;
        } catch (e) {
          log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
          return toolError(e);
        }
      },
    }),
  };
}

export type CircleTools = ReturnType<typeof buildTools>;
