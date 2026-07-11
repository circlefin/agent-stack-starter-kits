# BUFI on Shrooms Kit - Circle Agent Stack

This kit is an upstreamable reference for a BUFI-style agent workspace built on the public Circle Agent Stack primitives.

It deliberately stays generic:

- `packages/circle-tools` owns Circle CLI wrappers for wallets, balances, service discovery, and x402 payments.
- `packages/agent-cli` owns the reusable pinned-input terminal UI.
- This kit owns the workspace framing, branded console output, and the shape of a developer-facing operation surface.
- It does not call BUFI private APIs, ship customer data, or store secrets.

## Run

```bash
bun install
cp kits/bufi-on-shrooms/.env.example kits/bufi-on-shrooms/.env
bun run --cwd kits/bufi-on-shrooms demo
```

The kit composes the complete Vercel AI Circle roster: authentication, setup/sub-skills, wallet create/list/balance/deploy/fund, fiat funding links, service search/inspect/fetch, custom free-service calls, Gateway balance/deposit, and x402 payment. The two paid tools retain the Vercel kit's in-tool human approval boundary; declining returns a denial result before any payment or deposit call.

The terminal emits bounded metadata-only step traces (sequence, finish reason, tool-call count, and text length). It deliberately does not copy prompts, model text, credentials, or tool payloads into the trace buffer. A browser product can replace this emitter with its own durable trace sink.

## Why this exists

BUFI's product surface is a browser and mobile agent workspace, but the public contribution should remain useful to Circle developers without BUFI infrastructure. This kit shows the reusable boundary:

1. Circle wallet and x402 tools stay framework-agnostic.
2. The terminal console is a developer surface, similar to Stripe CLI, not a raw log stream.
3. Agent workspace traces and workflow state are readable as first-class, redacted events.
4. Branding is theme-level only; it does not leak private APIs or tenant assumptions.

## Upstream PR boundary

Safe upstream candidates:

- A branded-kit example that composes `circle-tools` and `agent-cli`.
- Vercel AI SDK exports for composing its complete tool roster in other kits.
- A consumer logger hook for branded consoles.
- Framework-neutral step hooks for trace surfaces.
- A missing `call_free_service` parity tool for GET-query and POST-body free endpoints.

BUFI-private follow-up outside this repo:

- Desk-v1 workflow graph, trace drawer, and approval queue.
- BUFI wallet provisioning policy.
- Tenant-specific knowledge graph, ERP, and MCP integrations.
