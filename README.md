# Circle Agent Stack Ecosystem Starter Kits

Open-source example projects integrating the [Circle Agent Stack](https://developers.circle.com/agent-stack) with popular AI agent frameworks. Each kit demonstrates the same **Autonomous Payment Agent** scenario, so developers can directly compare how each framework approaches the same problem.

## Kits

| Kit | Framework | Docs |
| --- | --- | --- |
| [`kits/langchain`](./kits/langchain) | LangChain Deep Agents | https://docs.langchain.com/oss/javascript/deepagents/overview |
| [`kits/claude-agent-sdk`](./kits/claude-agent-sdk) | Claude Agent SDK | https://code.claude.com/docs/en/agent-sdk/overview |
| [`kits/mastra`](./kits/mastra) | Mastra | https://mastra.ai/docs |
| [`kits/openai-agents`](./kits/openai-agents) | OpenAI Agents SDK | https://openai.github.io/openai-agents-js |
| [`kits/vercel-ai`](./kits/vercel-ai) | Vercel AI SDK | https://sdk.vercel.ai/docs |
| [`kits/google-adk`](./kits/google-adk) | Google Agent Development Kit | https://adk.dev/get-started/typescript/ |

## Shared package

- [`packages/circle-tools`](./packages/circle-tools): framework-agnostic wrappers around the Circle CLI (wallets, balances, service discovery, x402 payments).

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
    └── circle-tools/         # shared, framework-agnostic
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

Each kit demonstrates the same flow:

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
