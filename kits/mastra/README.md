# Mastra × Circle Agent Stack

## What it is

An Autonomous Payment Agent built with [Mastra](https://mastra.ai). From a single TypeScript entry point, the agent bootstraps via the Circle Agent Skill, creates an agent wallet on BASE, checks balances, discovers an x402-compatible service on the Circle Agent Marketplace, and pays for it using a USDC nanopayment.

## Prerequisites

- Node.js 20+
- Circle CLI: `npm install -g @circle-fin/cli`
- Circle Agent Skill installed for your agent host (see [Skill install](#skill-install))
- A Circle API key and an `OPENAI_API_KEY`

## Quickstart

```bash
git clone <repo-url> && cd circle-agent-stack-examples
bun install
cp kits/mastra/.env.example kits/mastra/.env   # then fill in keys
bun --filter @agent-stack-ecosystem-kits/kit-mastra demo
```

## Skill reference

The agent boots from the official setup skill:

> Run `curl -sL https://agents.circle.com/skills/setup.md`, and use the returned setup instructions to set up my agent wallet.

See https://agents.circle.com/skills/setup.md.

### Skill install

```bash
npm install -g @circle-fin/cli
circle login
circle skill install --tool claude-code   # or: cursor | codex | opencode | amp

# Universal fallback (any host):
npx skills add circlefin/skills -g
```

## Architecture

```
┌─────────────────────────────┐
│   Mastra Agent              │
│   (tool-calling loop)       │
└──────────────┬──────────────┘
               │ tool calls
               ▼
┌─────────────────────────────┐
│  @.../circle-tools          │
│  (execSync → circle CLI)    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  Circle Agent Stack         │
│  wallets · services · x402  │
└─────────────────────────────┘
```

## Links

- Mastra: [docs](https://mastra.ai/docs/agents/overview), [GitHub](https://github.com/mastra-ai/mastra)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [Circle Agent Marketplace](https://agents.circle.com/services)
- [Circle CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)
- [Circle Developer Discord](https://discord.com/invite/buildoncircle)
