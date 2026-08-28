# Circle Agent Stack Starter Kits

Open-source starter kits for developers building agent harnesses that need access to wallets and USDC to autonomously pay for x402 and Nanopayment-enabled services via the [Circle Agent Stack](https://developers.circle.com/agent-stack). Each kit wires the Agent Stack — agent wallets, nanopayments, and the [Circle Agent Marketplace](https://agents.circle.com/services) — into a different popular AI agent framework and drops you into an interactive terminal chat with the agent.

<img width="1200" height="600" alt="Claude Agent Terminal" src="demo.gif" />

## The shape of these kits

Every kit gives its agent a **shell** and lets **Circle's own skills** tell it what to do with it. There is no typed tool per Circle command, and nothing in any prompt about how wallets, sellers or payments work.

- **A shell, not an SDK surface.** Three tools: a shell, a file reader and a grep. The agent runs `circle` in the first of them, next to `curl`, `jq`, `npm` and everything else you have installed. A Circle command released tomorrow works here with no change to this repo — and the agent can reach for a tool nobody anticipated when the obvious path fails. Four kits build all three out of `kit-core`; the Claude Agent SDK kit uses the SDK's `Bash`, `Read`, `Grep` and `Glob`, and the LangChain kit uses Deep Agents' file tools next to a `kit-core` shell, because those frameworks ship their own and Deep Agents refuses a custom tool that shadows one.
- **Skills off disk, installed by the agent.** These kits ship no agent instructions. On a machine with no skills the first turn is Circle's own bootstrap line: the agent fetches [setup.md](https://agents.circle.com/skills/setup.md) and installs the skills into `~/.agents/skills`, the tool-neutral store that `~/.claude/skills` and its equivalents symlink into — so they are shared with every other agent on your machine, and a change Circle publishes changes every kit with no release here. The system prompt carries only their names, descriptions and paths; the agent reads the body of the one that fits, when it fits.
- **A gate on the command, not the tool.** Before any command that moves USDC — `services pay`, `wallet transfer`, `bridge transfer`, `gateway deposit`, `wallet sign`, or a change to your spending caps — the exact command is printed and waits for `y/N`. The list is [`packages/kit-core/src/approval.ts`](./packages/kit-core/src/approval.ts), it is short, and it is the thing to edit. Everything else runs unprompted, which is worth knowing before you extend it: this is not a sandbox, and it will not stop the agent deleting a file or installing a package.
- **What actually stops it.** Set per-transaction, daily, weekly and monthly caps on the wallet itself with `circle wallet limit set`, and they hold no matter what the agent is persuaded to do. That one confirms by one-time code, so it is yours to run. Keep the wallet funded with what you would not mind losing.
- **Almost no prompt.** A line of identity, three rules for working a terminal — read the error before re-running; large output goes to a file, not a second run; a list is not its first entry — and the skills index. The kind of thing an editor supplies for free and a bare agent has to be given.

The six differ only where their frameworks genuinely do: where the approval gate can live, and what the framework already brings.

## Kits

| Kit | Framework | Where approval lives | Docs |
| --- | --- | --- | --- |
| [`kits/langchain`](./kits/langchain) | LangChain Deep Agents | in the tool (`interruptOn` is per-tool, not per-command) — and the file tools are Deep Agents' own | https://docs.langchain.com/oss/javascript/deepagents/overview |
| [`kits/claude-agent-sdk`](./kits/claude-agent-sdk) | Claude Agent SDK | `canUseTool` — and the shell is the SDK's own `Bash` | https://code.claude.com/docs/en/agent-sdk/overview |
| [`kits/mastra`](./kits/mastra) | Mastra | in the tool (`Workspace` suspend suits a UI, not a terminal loop) | https://mastra.ai/docs |
| [`kits/openai-agents`](./kits/openai-agents) | OpenAI Agents SDK | `needsApproval`, a function of the command | https://openai.github.io/openai-agents-js |
| [`kits/vercel-ai`](./kits/vercel-ai) | Vercel AI SDK | in the tool (`generateText` has no permission hook) | https://sdk.vercel.ai/docs |
| [`kits/google-adk`](./kits/google-adk) | Google Agent Development Kit | `beforeToolCallback`, which sees the arguments | https://adk.dev/get-started/typescript/ |

## Shared packages

Everything a kit does not have to write for itself lives in one of three workspace packages, so the kits differ only where their frameworks genuinely differ:

- [`packages/kit-core`](./packages/kit-core): what the agent is given — the three tool bodies and their descriptions, the shell, the approval gate, on-disk skill discovery, the instructions — and the chrome around it that should not differ between kits: the slash-command router, the pinned balance readout, the terminal theme, and the fatal-error report.
- [`packages/circle-tools`](./packages/circle-tools): Circle CLI wrappers for the kit's own chrome — session and login, wallet and Gateway balance reads, marketplace search. Not for the agent; it runs the CLI itself.
- [`packages/agent-cli`](./packages/agent-cli): reusable Ink-based terminal chat UI (scrolling log + pinned bottom input) and the retry/timeout wrapper shared by the kits.

## Repository layout

```
agent-stack-starter-kits/
├── kits/
│   ├── claude-agent-sdk/
│   ├── google-adk/
│   ├── langchain/
│   ├── mastra/
│   ├── openai-agents/
│   └── vercel-ai/
└── packages/
    ├── circle-tools/         # Circle CLI wrappers for the terminal UI
    ├── kit-core/             # shell + file tools, approval, skills, instructions, theme
    └── agent-cli/            # shared terminal chat UI + retry
```

Each kit is deliberately thin: a `config.ts`, an `agent.ts` wiring its framework's agent to the shared instructions and approval hook, a `tools.ts` that is a schema and a one-line call into `kit-core` per tool, a `theme.ts` that only names the kit's log tag, and an `index.ts` driving the chat loop. Three kits depart from that list, each in one file and only where the framework earns it: the Claude Agent SDK kit has no `tools.ts`, because its tools are the SDK's own; the Mastra kit adds a `workflow.ts`, because its opening turn runs as a Mastra workflow; and the Vercel kit adds a `retry.ts`, because it is the one kit that falls back to a second provider mid-turn.

## Prerequisites

- Node.js 22.15+
- [Bun](https://bun.com) 1.2+ (workspace manager)
- Circle CLI: `bun add -g @circle-fin/cli`
- A Circle account, and an API key for whichever model provider the kit uses

On a corporate network that inspects TLS traffic, see the corporate-network block at the bottom of any kit's `.env.example`: one setting there is usually the difference between the agent working and every `circle` command reporting `fetch failed`.

Circle's skills are **not** a prerequisite — the agent installs them on its first run. If you would rather do it yourself, or already have them for your editor, either of these works and both are idempotent:

```bash
circle skill install --tool <claude-code|cursor|codex|opencode|amp>
bunx skills add circlefin/skills -g     # universal fallback
```

## Install

```bash
bun install
```

This installs all workspace dependencies from the repo root. Each kit owns its own `.env.example` (copy to `.env` inside that kit's folder) and exposes a `bun run demo` entrypoint. See its README for details.

## Demo use case

Each kit's `bun run demo` launches an interactive terminal chat (a shared Ink-based UI with a scrolling log and a pinned input showing your live USDC balance) that demonstrates the same flow:

1. Bootstrap, driven by the [Circle Agent Skills](https://agents.circle.com/skills/setup.md) the agent installs
   - Install the skills
   - Check the session (the kit logs you in with email + OTP before the agent starts)
   - Create a wallet
   - Check / fund the balance
2. Transact via the agent
   - Find or select a service on the [Circle Agent Marketplace](https://agents.circle.com/services)
   - Pay for it, once you approve the command

Quick commands (`/help`, `/wallets`, `/balance`, `/gateway`, `/discover <keyword>`) answer from the CLI without spending a model turn. `/discover` prints a numbered list, and a bare number at the next prompt hands that service to the agent — a search the agent ran in its own shell is numbered the same way.

See each kit's `README.md` for run instructions.

## Key resources

- [Circle Agent Stack docs](https://developers.circle.com/agent-stack)
- [Circle Skills setup](https://agents.circle.com/skills/setup.md) and [source](https://github.com/circlefin/skills)
- [Circle CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)
- [Agent Wallets quickstart](https://developers.circle.com/agent-stack/agent-wallets/quickstart)
- [Agent Nanopayments quickstart](https://developers.circle.com/agent-stack/agent-nanopayments/quickstart)
- [Circle Agent Marketplace](https://agents.circle.com/services)
- [Circle Developer Discord](https://discord.com/invite/buildoncircle)

## Legal disclaimer

Sample apps provided for demonstration and educational purposes only, intended for Arc testnet use only, and not production-ready. See [Arc.io](https://arc.io) for more.
