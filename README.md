# Circle Agent Stack Starter Kits

Open-source starter kits for developers building agent harneses that need access to wallets and USDC to autonomously pay for x402 and Nanopayment-enabled services via the [Circle Agent Stack](https://developers.circle.com/agent-stack). Each kit wires the Agent Stack — agent wallets, nanopayments, and the [Circle Agent Marketplace](https://agents.circle.com/services) — into a different popular AI agent framework and drops you into an interactive terminal chat with the agent.

<img width="1200" height="600" alt="Claude Agent Terminal" src="demo.gif" />

## Kits

| Kit | Framework | Docs |
| --- | --- | --- |
| [`kits/langchain`](./kits/langchain) | LangChain Deep Agents | https://docs.langchain.com/oss/javascript/deepagents/overview |
| [`kits/claude-agent-sdk`](./kits/claude-agent-sdk) | Claude Agent SDK | https://code.claude.com/docs/en/agent-sdk/overview |
| [`kits/mastra`](./kits/mastra) | Mastra | https://mastra.ai/docs |
| [`kits/openai-agents`](./kits/openai-agents) | OpenAI Agents SDK | https://openai.github.io/openai-agents-js |
| [`kits/vercel-ai`](./kits/vercel-ai) | Vercel AI SDK | https://sdk.vercel.ai/docs |
| [`kits/google-adk`](./kits/google-adk) | Google Agent Development Kit | https://adk.dev/get-started/typescript/ |

## Shared packages

- [`packages/circle-tools`](./packages/circle-tools): framework-agnostic wrappers around the Circle CLI (wallets, balances, service discovery, x402 payments).
- [`packages/agent-cli`](./packages/agent-cli): reusable Ink-based terminal chat UI (scrolling log + pinned bottom input) shared by the kits.

## Repository layout

```
agent-stack-ecosystem-kits/
├── kits/
│   ├── claude-agent-sdk/
│   ├── google-adk/
│   ├── langchain/
│   ├── mastra/
│   ├── openai-agents/
│   └── vercel-ai/
└── packages/
    ├── circle-tools/         # shared, framework-agnostic
    └── agent-cli/            # shared terminal chat UI
```

## Prerequisites

- Node.js 20+
- [Bun](https://bun.com) 1.2+ (workspace manager)
- Circle CLI: `bun add -g @circle-fin/cli`
- Circle Agent Skills (one of):
  - `circle skill install --tool <claude-code|cursor|codex|opencode|amp>`
  - Universal fallback: `bunx skills add circlefin/skills -g`
- A Circle account and API key

## Install

```bash
bun install
```

This installs all workspace dependencies from the repo root. Each kit owns its own `.env.example` (copy to `.env` inside that kit's folder) and exposes a `bun run demo` entrypoint. See its README for details.

## Demo use case

Each kit's `bun run demo` launches an interactive terminal chat (a shared Ink-based UI with a scrolling log and a pinned input showing your live USDC balance) that demonstrates the same flow:

1. Bootstrap with the [Circle Agent Skill](https://agents.circle.com/skills/setup.md) + CLI
   - Install CLI and skill
   - Login
   - Create a wallet
   - Check / fund balance
2. Transact via the agent
   - Find or select a service on the [Circle Agent Marketplace](https://agents.circle.com/services)
   - Pay for it via the agent

See each kit's `README.md` for run instructions.

## Key resources

- [Circle Agent Stack docs](https://developers.circle.com/agent-stack)
- [Circle Skills setup](https://agents.circle.com/skills/setup.md)
- [Circle CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)
- [Agent Wallets quickstart](https://developers.circle.com/agent-stack/agent-wallets/quickstart)
- [Agent Nanopayments quickstart](https://developers.circle.com/agent-stack/agent-nanopayments/quickstart)
- [Circle Agent Marketplace](https://agents.circle.com/services)
- [Circle Developer Discord](https://discord.com/invite/buildoncircle)

## Legal disclaimer

Sample apps provided for demonstration and educational purposes only, intended for Arc testnet use only, and not production-ready. See [Arc.io](https://arc.io) for more.
