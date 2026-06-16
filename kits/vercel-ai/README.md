# Vercel AI SDK Kit — Circle Agent Stack

Autonomous Payment Agent built with the **[Vercel AI SDK](https://github.com/vercel/ai)** and Circle Agent Stack.

Part of the [agent-stack-ecosystem-kits](../../README.md) monorepo — the same demo scenario
across five frameworks so you can compare them directly.

| Kit | Framework |
|-----|-----------|
| `kits/langchain` | LangChain Deep Agents |
| `kits/claude-agent-sdk` | Claude Agent SDK |
| `kits/mastra` | Mastra |
| `kits/openai-agents` | OpenAI Agents SDK |
| **`kits/vercel-ai`** ← this kit | **Vercel AI SDK** |

---

## What the agent does

One command, one conversation:

```bash
bun run --cwd kits/vercel-ai demo
```

**Automated (no human input)**
1. Fetch the Circle Agent setup skill from `agents.circle.com/skills/setup.md`
2. Follow the skill: list or create a USDC wallet on Base
3. Check the wallet's USDC balance
4. Search the Circle Agent Marketplace for a service
5. Inspect the service (price, schema, method)
6. ⏸ **Pause — human approves the payment** (in the tool execute function)
7. Pay for the service with a USDC nanopayment via x402

**Interactive**
After the first payment the demo drops into a `You: >` REPL.
Full agent context is kept across every turn — the message history is passed
back to `generateText` on each call; no session ID to manage.

---

## Quick start

```bash
# One-time host setup
bun add -g @circle-fin/cli
circle skill install --tool claude-code   # optional if only using this kit

# First run
cp kits/vercel-ai/.env.example kits/vercel-ai/.env
# edit .env → set ANTHROPIC_API_KEY or OPENAI_API_KEY

bun install
bun run --cwd kits/vercel-ai demo
```

---

## Architecture

```
┌──────────────────────────────────────────┐
│  src/index.ts  (entry point)             │
│  ┌─────────────────────────────────────┐ │
│  │  buildTools(ask)                    │ │
│  │  ┌───────────────────────────────┐  │ │
│  │  │  circle_pay_service.execute   │  │ │
│  │  │  → await ask("Approve?")  ←  │  │ │  ← human-in-the-loop
│  │  └───────────────────────────────┘  │ │
│  └───────────────┬─────────────────────┘ │
│                  │                        │
│  src/agent.ts  runTurn()                 │
│  generateText({ maxSteps: 30, tools })   │
│  onStepFinish → log intermediate text   │
└──────────────────────────────────────────┘
                   │ tool calls
                   ▼
┌──────────────────────────────────────────┐
│  packages/circle-tools  (shared pkg)     │
│  wallet · balance · services · x402      │
└──────────────────────────────────────────┘
```

---

## Key design decisions

### `tool()` with `parameters` — the Vercel AI SDK primitive

Every Circle operation is a Vercel AI SDK `tool()` with a Zod `parameters` schema
and an `execute` function. This is different from Mastra's `createTool()`,
LangChain's `DynamicStructuredTool`, and the Claude Agent SDK's MCP server:

```typescript
// kits/vercel-ai/src/tools.ts
import { tool } from 'ai';
import { z } from 'zod';

circle_inspect_service: tool({
  description: 'Inspect an x402 service...',
  parameters: z.object({
    url: z.string().describe('The service URL to inspect'),
  }),
  execute: async ({ url }) => {
    return await inspectService({ url });
  },
}),
```

### Human-in-the-loop — inside `execute`

The Vercel AI SDK has no external approval hook. Instead, the two USDC-spending
tools (`circle_pay_service`, `circle_gateway_deposit`) pause execution by
`await`-ing the readline `ask` function before touching USDC:

```typescript
// ── Human-in-the-loop ──────────────────────────────────────────────
// No interruptOn (LangChain), no canUseTool (Claude SDK), no state.approve
// (OpenAI Agents). The tool pauses here; generateText waits for the result.
console.log('⚠  approval required: circle_pay_service');
console.log(colorizeJson({ url, address, method, data }));
const answer = (await ask('Approve? [y/N] ')).trim().toLowerCase();
if (answer !== 'y') {
  return { denied: true, message: 'Payment rejected by user.' };
}
// ───────────────────────────────────────────────────────────────────
```

Because `generateText` `await`s each tool's `execute` result before continuing,
the entire generation suspends at this point — no polling, no external state.

### `generateText` with `maxSteps` — the agent loop

The SDK drives the tool-call loop automatically:
model → tool call → tool result → model → … until the model returns no more
tool calls or the step cap is reached. We own the message history and pass it
back on each `generateText` call for multi-turn support:

```typescript
// kits/vercel-ai/src/agent.ts
const result = await generateText({
  model,
  tools,
  messages,          // full conversation history
  maxSteps: 30,
  onStepFinish: ({ text }) => {
    if (text.trim()) console.log(heading('--- agent ---') + '\n' + text);
  },
});

// Append everything the model generated (assistant + tool results) for next turn
return {
  text: result.text,
  responseMessages: result.response.messages as CoreMessage[],
};
```

### Provider-agnostic model selection

`ANTHROPIC_API_KEY` → `anthropic('claude-sonnet-4-6')` via `@ai-sdk/anthropic`
`OPENAI_API_KEY` → `openai('gpt-4.1')` via `@ai-sdk/openai`

Both use the same `generateText` call; only the `LanguageModel` object changes.

### Conversation history — caller-owned

Unlike LangGraph's MemorySaver or the Claude Agent SDK's session, the Vercel AI
SDK is stateless — `generateText` takes messages in, returns messages out. The
caller (index.ts) owns the history:

```typescript
// index.ts — turn 1
let messages: CoreMessage[] = [{ role: 'user', content: bootstrapPrompt }];
const { responseMessages } = await runTurn(config, messages, tools);
messages = [...messages, ...responseMessages];

// turn 2 (user follow-up)
messages.push({ role: 'user', content: userInput });
const { responseMessages: next } = await runTurn(config, messages, tools);
messages = [...messages, ...next];
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | one of the two | — | Anthropic API key (preferred) |
| `OPENAI_API_KEY` | one of the two | — | OpenAI API key |
| `LLM_MODEL` | no | see below | Raw model ID, no provider prefix |
| `CIRCLE_CHAIN` | no | `BASE` | Chain for wallet operations |

Default models: `claude-sonnet-4-6` (Anthropic), `gpt-4.1` (OpenAI).

---

## Links

- Vercel AI SDK: https://sdk.vercel.ai
- Circle Agent Stack: https://developers.circle.com/agent-stack
- Circle Agent Marketplace: https://agents.circle.com/services
