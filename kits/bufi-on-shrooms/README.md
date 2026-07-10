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

The demo is safe by default. It reads Circle wallet state and service discovery metadata. Any future USDC-spending tool must keep human approval inside the tool execution boundary, following the existing `kits/vercel-ai` pattern.

## Why this exists

BUFI's product surface is a browser and mobile agent workspace, but the public contribution should remain useful to Circle developers without BUFI infrastructure. This kit shows the reusable boundary:

1. Circle wallet and x402 tools stay framework-agnostic.
2. The terminal console is a developer surface, similar to Stripe CLI, not a raw log stream.
3. Agent workspace traces and workflow state should be readable as first-class events.
4. Branding is theme-level only; it does not leak private APIs or tenant assumptions.

## Upstream PR boundary

Safe upstream candidates:

- A branded-kit example that composes `circle-tools` and `agent-cli`.
- Better Vercel AI SDK docs around tool-contained approvals.
- A theme hook for console labels and JSON highlighting.

BUFI-private follow-up outside this repo:

- Desk-v1 workflow graph, trace drawer, and approval queue.
- BUFI wallet provisioning policy.
- Tenant-specific knowledge graph, ERP, and MCP integrations.
