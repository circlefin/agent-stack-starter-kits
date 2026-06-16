import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';

import type { KitConfig } from './config';
import { dim, red } from './theme';
import { buildCircleServer, MCP_SERVER_NAME } from './tools';

/**
 * Build the Claude Agent SDK `query` options for the Autonomous Payment Agent.
 *
 * The agent's only tools are the in-process Circle MCP server (skill fetch +
 * wallet/service/x402 wrappers); built-in tools are switched off (`tools: []`)
 * so the run is a clean, apples-to-apples mirror of the LangChain kit. There is
 * no hand-written system prompt: the bootstrap prompt plus setup.md drive the
 * flow.
 *
 * Human-in-the-loop is `canUseTool`, the SDK-native equivalent of LangChain
 * Deep Agents' `interruptOn`. It is the single permission decision point: the
 * entry point's handler approves read-only tools automatically and pauses for a
 * y/N on the two USDC-spending tools. `settingSources: []` isolates the run
 * from any filesystem settings (no ~/.claude or project config bleed-through).
 *
 * The `stderr` callback is wired so the spawned Claude Code subprocess is never
 * silent: by default the SDK discards its stderr, so a startup failure (auth,
 * CLI extraction) looks like an indefinite freeze. Surfacing it turns any such
 * failure into a visible diagnostic instead.
 */
export function buildQueryOptions(
  config: KitConfig,
  canUseTool: CanUseTool,
  ask: (q: string) => Promise<string>,
): Options {
  return {
    model: config.model,
    mcpServers: { [MCP_SERVER_NAME]: buildCircleServer(ask) },
    tools: [],
    canUseTool,
    permissionMode: 'default',
    settingSources: [],
    stderr: (data: string) => {
      const text = data.trimEnd();
      if (text) console.error(red('[claude-code stderr]'), dim(text));
    },
  };
}
