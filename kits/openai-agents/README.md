# OpenAI Agents SDK × Circle Agent Stack

An agent built with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/agents/) that owns a USDC wallet and pays for services on the [Circle Agent Marketplace](https://agents.circle.com/services) on your behalf. It has a shell rather than a wallet API, and learns what to do with it from [Circle's skills](https://github.com/circlefin/skills) — which it installs itself, on its first run, straight from Circle's [setup document](https://agents.circle.com/skills/setup.md).

## Prerequisites

- [Bun](https://bun.com) 1.2+
- Circle CLI: `bun add -g @circle-fin/cli`
- A Circle account and an `OPENAI_API_KEY` (this SDK supports OpenAI models only)

## Run

```bash
cd kits/openai-agents
bun install
cp .env.example .env   # add your API key
bun run demo
```

## How it works

There is no wrapper layer here: no typed tool per Circle command, and nothing in the prompt about how wallets, sellers or payments work.

- **A shell, not an SDK surface.** The agent gets three tools — `shell`, `read_file` and `grep` — and runs `circle` in the first of them, next to `curl`, `jq` and everything else you have installed. A Circle command released tomorrow works here with no change to this repo.
- **Skills off disk.** On a machine with none, the first turn is Circle's own bootstrap line: the agent fetches [setup.md](https://agents.circle.com/skills/setup.md) and installs the skills into `~/.agents/skills`, the tool-neutral store `~/.claude/skills` and its equivalents symlink into — so they are shared with every other agent on your machine. The system prompt carries their names and descriptions; the agent reads the body of the one that fits, with `read_file`, when it fits.
- **A gate on the command, not the tool.** Sixteen tools meant two of them moved USDC, so those two were what paused. One shell means the question is *which command*, so [`packages/kit-core/src/approval.ts`](../../packages/kit-core/src/approval.ts) matches the command string — every segment of it, so a pipe or a `$(…)` cannot slip one past. That file is short, and it is the thing to edit. It is not a sandbox: it will not stop the agent deleting a file or installing a package. The ceiling no instruction can argue past is `circle wallet limit set`, which confirms by one-time code and so is yours to run.
- **Reads of what the shell writes.** A marketplace search is thousands of lines of JSON schema, more than a tool result should carry, so the agent redirects it to a file and goes back for the part it needs. Without a reader, going back means running the search again — and on a paid call, that is a second charge.

`needsApproval` on the shell tool is a function of the call's own arguments, so it asks whether *this command* spends. A true answer interrupts the run, and the entry point prompts and resumes from the interruption.

## First run

- **Login.** The demo checks your Circle session and, if needed, logs you in with your email and a one-time code. You type both; the kit stores neither.
- **Terms of Use.** If your account has not accepted Circle's Terms, the demo stops and asks you to run `circle wallet status` once and accept them yourself — an agent must never accept them for you.
- **Approval.** Before any command that moves USDC — `services pay`, `wallet transfer`, `gateway deposit`, `wallet sign`, a change to your spending caps — the exact command is printed and waits for `y/N`. Nothing is spent unless you approve. Everything else runs unprompted.
- Type `exit` or `quit` to end the session.

## Try it

Once the wallet is set up, ask for what you want in plain language:

- `check my flight WN2417 using FlightAware`
- `what services are available for weather data?`
- `top up my wallet with testnet USDC`

## Quick commands

A few common lookups skip the model round-trip and call the `circle` CLI directly:

| Command | Does |
| --- | --- |
| `/help` | list the commands below |
| `/wallets` | list agent wallet addresses |
| `/balance` | per-wallet USDC balances |
| `/gateway` | Circle Gateway balance for the primary wallet |
| `/discover <keyword>` | search the marketplace |

`/discover` prints a numbered list; reply with just a number (e.g. `1`) to hand that service to the agent instead of retyping its name or URL. A `circle services search` the agent runs in its own shell is numbered the same way. A number only counts as a pick until the next turn reaches the agent, so a numeric answer to a question the agent asked ("how much USDC?") is never mistaken for a service. Picks still go through the agent as a normal turn — and the same approval gate if one leads to a payment — the number is just a shortcut for the reference, not a bypass.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | The run errors at startup if unset. For Anthropic models, use the `langchain`, `vercel-ai` or `claude-agent-sdk` kit instead. |
| `LLM_MODEL` | no | Overrides the default model (`gpt-5.6-sol`). |
| `NO_COLOR` | no | Disables colored output. Color is off automatically when output is piped. |
| `NODE_OPTIONS` | no | Set to `--use-system-ca` if your corporate network inspects TLS traffic, so the `circle` CLI trusts your organisation's certificate authority. |

There is no chain to configure. The `circle` CLI settles each payment on a chain the seller and your wallet have in common, and the agent reads Circle's skills for how to choose between them.

## Links

- OpenAI Agents SDK: [docs](https://openai.github.io/openai-agents-js/guides/agents/), [GitHub](https://github.com/openai/openai-agents-js)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [Circle Agent Marketplace](https://agents.circle.com/services)
- [Circle CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)
- [Circle Developer Discord](https://discord.com/invite/buildoncircle)
