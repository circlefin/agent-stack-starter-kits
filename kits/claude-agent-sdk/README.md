# Claude Agent SDK × Circle Agent Stack

## What it is

An Autonomous Payment Agent built with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). From a single TypeScript entry point, the agent bootstraps via the Circle Agent Skill, creates an agent wallet on BASE, checks balances, discovers an x402-compatible service on the Circle Agent Marketplace, and pays for it using a USDC nanopayment.

This is the sibling of the [LangChain Deep Agents kit](../langchain): same Autonomous Payment Agent scenario, same shared [`circle-tools`](../../packages/circle-tools) package, so you can compare how each framework approaches the same problem.

## Prerequisites

- [Bun](https://bun.com) 1.2+
- Claude Agent SDK auth: an `ANTHROPIC_API_KEY`. The kit is API-key only, which
  keeps the spawned Claude Code subprocess non-interactive (the subscription /
  OAuth path can hang it on a login prompt). See [Environment](#environment).
- A provisioned agent host: Circle CLI installed, skill installed, and Circle's
  Terms of Use accepted. This is `setup.md` steps 1-2 plus the one-time Terms
  gate, a per-host operation. See [Host setup](#host-setup). **Login is not part
  of host setup** because the demo logs you in with email + OTP on its first run. See
  [Login](#login).

## Quickstart

```bash
git clone <repo-url> && cd agent-stack-ecosystem-kits
bun install
cp kits/claude-agent-sdk/.env.example kits/claude-agent-sdk/.env   # then fill in keys
bun run --cwd kits/claude-agent-sdk demo
```

> Run the demo with `--cwd`, not `bun --filter`. `--filter` wraps output in a
> dashboard that elides lines and interferes with the interactive approval
> prompt; `--cwd` runs the script directly with plain, full output.

> Run [Host setup](#host-setup) once before the first demo. On first run the
> demo logs you in with email + OTP (see [Login](#login)), then pauses for your
> approval before any USDC payment. See [Human-in-the-loop](#human-in-the-loop).

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | API-key auth for the SDK. The kit is API-key only; the run errors at startup if it is unset. Get a key at https://console.anthropic.com/settings/keys. |
| `LLM_MODEL` | no | Overrides the default model (`claude-sonnet-4-6`). |
| `NO_COLOR` | no | Set to disable colored output. Color is auto-disabled when output is piped or redirected. |

The kit pays on Base by default and falls back to Polygon when a service offers no Base payment option. The chain is selected automatically per service, so there is nothing to configure.

## Human-in-the-loop

The agent runs the full tool loop autonomously, with two exceptions: `circle_pay_service` and `circle_gateway_deposit`, the only tools that spend USDC. Both are gated through the SDK's [`canUseTool`](https://code.claude.com/docs/en/agent-sdk/permissions) permission handler, so the agent **pauses before spending** and waits for your decision.

`canUseTool` is the single permission decision point and the SDK-native equivalent of LangChain Deep Agents' `interruptOn`. The handler approves every read-only tool automatically (skill fetch, wallet list/balance, gateway balance, service search/inspect, and `circle_deploy_wallet`, a zero-value, gas-abstracted wallet bootstrap that spends nothing) and, for the two spend tools, prints the pending call and arguments and prompts for `y/N` in the terminal, the way Claude Code prompts before a sensitive action. Approve and it resolves `{ behavior: 'allow' }`; reject and it resolves `{ behavior: 'deny' }` and the agent continues without spending. Run the demo in a real terminal so the prompt is answerable.

### What the demo does

The entry point passes the Circle bootstrap prompt to a Claude Agent SDK `query` and lets [`setup.md`](https://agents.circle.com/skills/setup.md) drive the flow. There is no hand-written system prompt, and built-in tools are switched off (`tools: []`) so the agent's only tools are the Circle ones, an apples-to-apples mirror of the LangChain kit.

0. Before the agent runs, the demo checks the CLI session. If you are not logged in, it runs the email + OTP [login](#login) inline; if the Terms of Use are not accepted, it stops with the one manual step. A valid session is skipped straight through.
1. The agent calls `fetch_setup_skill`, reads the returned 7-step skill, and follows it.
2. Steps 1-2 (CLI install, skill install) and the Terms gate are already satisfied by [Host setup](#host-setup); login is handled in step 0 above, so the agent picks up at wallet provisioning.
3. It lists or creates an agent wallet on BASE, checks the USDC balance, searches the Circle Agent Marketplace, inspects a service, and pays for it with a USDC nanopayment. `fetch_sub_skill` pulls `wallet-fund` / `wallet-pay` guidance when a step needs it.
   - A Circle agent wallet is a Smart Contract Account: its address is counterfactual until the first outbound transaction. It can receive USDC, but cannot sign x402 payments until deployed. If the paying wallet has never sent a transaction, the agent calls `circle_deploy_wallet` first: a one-time, zero-value self-transfer that deploys the account. `circle_pay_service` also pre-checks deployment (via `eth_getCode`) and returns an actionable error if the wallet is not yet deployed.
4. Before `circle_pay_service` runs, the agent pauses for approval. See [Human-in-the-loop](#human-in-the-loop).
5. Every tool call logs to stdout (`[tool] ...`); the agent's reply prints after each turn.
6. The demo then drops into an interactive `You:` prompt. Type follow-ups ("discover services", "pay for the Bitcoin price service") and the agent keeps full context across turns. Empty input or `exit` / `quit` ends the session.

The whole run is one conversation: a single `query` call with a streaming input prompt keeps full agent context across both the approval pause and every chat turn, so there is no thread/session id to manage.

## Skill reference

The agent boots from the official setup skill via this prompt:

> Run `curl -sL https://agents.circle.com/skills/setup.md`, and use the returned setup instructions to set up my agent wallet.

See https://agents.circle.com/skills/setup.md.

### Host setup

Run once per agent host. This is `setup.md` steps 1-2 (CLI install, skill install):

```bash
bun add -g @circle-fin/cli
circle skill install --tool claude-code   # or: cursor | codex | opencode | amp
# Universal fallback (any host):
bunx skills add circlefin/skills -g
```

Login is **not** part of host setup; the demo handles it. See [Login](#login).

### Login

On its first run the demo checks the CLI session (`circle wallet status`) and, if you are not logged in, runs Circle's two-step email + OTP login inline:

1. It prompts for your Circle account email and runs `circle wallet login <email> --init`.
2. It prints the CLI output, which carries an anti-phishing prefix; match it against the code Circle emails you.
3. It prompts for the OTP (the 6 digits alone, or the full `B1X-123456`) and completes the login.

You type your own email and OTP; the kit stores neither. A first-time login also provisions an agent wallet on every supported EVM chain, so no separate `circle wallet create` is needed. A valid existing session is detected and skipped.

**Terms of Use are not handled by the demo.** If the Terms are not yet accepted on this host, login is gated and the kit stops with a manual step: run `circle wallet status` yourself, accept the Terms when prompted, then re-run. Per `setup.md`, an agent must never accept the Terms on a user's behalf, so this kit ships no Terms tool. See [`wallet-login.md`](https://agents.circle.com/skills/wallet-login.md) for the full login flow.

## Architecture

```
┌─────────────────────────────┐
│   Claude Agent SDK query    │
│   (tool-use loop)           │
│   canUseTool: spend tools ──┼──▶ pause ▶ human approve / reject
└──────────────┬──────────────┘
               │ tool calls (in-process MCP server)
               ▼
┌─────────────────────────────┐
│  @.../circle-tools          │
│  (execFileSync → circle)    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Circle Agent Stack         │
│  wallets · services · x402  │
└─────────────────────────────┘
```

The Circle tools are exposed to the agent as an in-process MCP server (`createSdkMcpServer`), so the SDK addresses them as `mcp__circle__<tool>`.

## Links

- Claude Agent SDK: [docs](https://code.claude.com/docs/en/agent-sdk/overview), [TypeScript SDK](https://github.com/anthropics/claude-agent-sdk-typescript), [demos](https://github.com/anthropics/claude-agent-sdk-demos)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [Circle Agent Marketplace](https://agents.circle.com/services)
