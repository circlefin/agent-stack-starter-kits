# LangChain Deep Agents × Circle Agent Stack

## What it is

An Autonomous Payment Agent built with [LangChain Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview). From a single TypeScript entry point, the agent bootstraps via the Circle Agent Skill, creates an agent wallet on BASE, checks balances, discovers an x402-compatible service on the Circle Agent Marketplace, and pays for it using a USDC nanopayment.

## Prerequisites

- [Bun](https://bun.com) 1.2+
- An LLM provider API key (Anthropic or OpenAI)
- A provisioned agent host: Circle CLI installed, skill installed, and Circle's
  Terms of Use accepted. This is `setup.md` steps 1-2 plus the one-time Terms
  gate, a per-host operation. See [Host setup](#host-setup). **Login is not part
  of host setup** because the demo logs you in with email + OTP on its first run. See
  [Login](#login).

## Quickstart

```bash
git clone <repo-url> && cd agent-stack-ecosystem-kits
bun install
cp kits/langchain/.env.example kits/langchain/.env   # then fill in keys
bun run --cwd kits/langchain demo
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
| `ANTHROPIC_API_KEY` *or* `OPENAI_API_KEY` | one of | Provider auto-selected from whichever key is set. Anthropic wins if both are set. |
| `LLM_MODEL` | no | Overrides the default model (`claude-sonnet-4-6` / `gpt-4o-mini`). |
| `NO_COLOR` | no | Set to disable colored output. Color is auto-disabled when output is piped or redirected. |

The kit pays on Base by default and falls back to Polygon when a service offers no Base payment option. The chain is selected automatically per service, so there is nothing to configure.

## Human-in-the-loop

The agent runs the full tool loop autonomously, with two exceptions: `circle_pay_service` and `circle_gateway_deposit`, the only tools that spend USDC. Both are wired with Deep Agents' [`interruptOn`](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop), so the agent **pauses before spending** and waits for your decision. Read-only tools (skill fetch, wallet list/balance, gateway balance, service search/inspect) and `circle_deploy_wallet` (a zero-value, gas-abstracted wallet bootstrap that spends nothing) never pause.

`interruptOn` is per-tool by design. The blunter LangGraph-level `interruptBefore: ["<node>"]` would pause before *every* tool call, including read-only ones; `interruptOn: { circle_pay_service: true, circle_gateway_deposit: true }` pauses only on the spends. A [`MemorySaver`](https://docs.langchain.com/oss/javascript/langchain/agents) checkpointer persists agent state across the pause.

When the agent pauses, the entry point reads `result.__interrupt__`, prints the pending tool call and arguments, and prompts for `y/N` approval in the terminal, the way Claude Code prompts before a sensitive action. It then resumes the agent with `new Command({ resume: { decisions } })` carrying an `approve` or `reject` per pending action. Run the demo in a real terminal so the prompt is answerable.

### What the demo does

The entry point passes the Circle bootstrap prompt to a LangChain Deep Agent and lets [`setup.md`](https://agents.circle.com/skills/setup.md) drive the flow. There is no hand-written system prompt.

0. Before the agent runs, the demo checks the CLI session. If you are not logged in, it runs the email + OTP [login](#login) inline; if the Terms of Use are not accepted, it stops with the one manual step. A valid session is skipped straight through.
1. The agent calls `fetch_setup_skill`, reads the returned 7-step skill, and follows it.
2. Steps 1-2 (CLI install, skill install) and the Terms gate are already satisfied by [Host setup](#host-setup); login is handled in step 0 above, so the agent picks up at wallet provisioning.
3. It lists or creates an agent wallet on BASE, checks the USDC balance, searches the Circle Agent Marketplace, inspects a service, and pays for it with a USDC nanopayment. `fetch_sub_skill` pulls `wallet-fund` / `wallet-pay` guidance when a step needs it.
   - A Circle agent wallet is a Smart Contract Account: its address is counterfactual until the first outbound transaction. It can receive USDC, but cannot sign x402 payments until deployed. If the paying wallet has never sent a transaction, the agent calls `circle_deploy_wallet` first: a one-time, zero-value self-transfer that deploys the account. `circle_pay_service` also pre-checks deployment (via `eth_getCode`) and returns an actionable error if the wallet is not yet deployed.
4. Before `circle_pay_service` runs, the agent pauses for approval. See [Human-in-the-loop](#human-in-the-loop).
5. Every tool call logs to stdout (`[tool] ...`); the agent's reply prints after each turn.
6. The demo then drops into an interactive `you>` prompt. Type follow-ups ("discover services", "pay for the Bitcoin price service") and the agent keeps full context across turns. Empty input or `exit` / `quit` ends the session.

The whole run is one conversation: a [`MemorySaver`](https://docs.langchain.com/oss/javascript/langchain/agents) checkpointer with a stable `thread_id` persists agent state across both the approval pause and every chat turn.

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
│   LangChain Deep Agent      │
│   (planner + sub-agents)    │
│   interruptOn: spend tools ─┼──▶ pause ▶ human approve / reject
└──────────────┬──────────────┘
               │ tool calls
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

## Links

- LangChain Deep Agents: [docs](https://docs.langchain.com/oss/javascript/deepagents/overview), [GitHub](https://github.com/langchain-ai/deepagentsjs)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [Circle Agent Marketplace](https://agents.circle.com/services)
