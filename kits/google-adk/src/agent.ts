import { LlmAgent, Gemini, type SingleBeforeToolCallback } from '@google/adk';

import type { KitConfig } from './config';
import { buildTools, SPEND_TOOLS } from './tools';

/**
 * Signature the entry point uses to drive an approval prompt for a single
 * pending tool call. Resolves true to allow, false to deny.
 */
export type ApprovalFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<boolean>;

const SPEND_TOOL_SET = new Set<string>(SPEND_TOOLS);

/**
 * Build the ADK LlmAgent for the Autonomous Payment Agent demo.
 *
 * Human-in-the-loop is wired through `beforeToolCallback`: read-only tools run
 * without a pause, and the two USDC-spending tools route to `approve()`. When
 * the callback returns `undefined` the framework runs the tool normally; when
 * it returns a record (here `{error: ...}`) that record is used as the tool
 * result and the actual tool is skipped, the ADK-native equivalent of
 * LangChain's `interruptOn` and Claude Agent SDK's `canUseTool`.
 *
 * The Gemini model is constructed with the API key explicitly to avoid relying
 * on @google/genai's env-var probing (it accepts several aliases). There is no
 * hand-written system prompt: the bootstrap prompt plus setup.md drive the
 * flow.
 */
export function buildAgent(
  config: KitConfig,
  approve: ApprovalFn,
  ask: (q: string) => Promise<string>,
): LlmAgent {
  const tools = buildTools(ask);

  const beforeToolCallback: SingleBeforeToolCallback = async ({ tool, args }) => {
    if (!SPEND_TOOL_SET.has(tool.name)) return undefined;
    const approved = await approve(tool.name, args);
    if (approved) return undefined;
    return { error: 'User rejected this action.' };
  };

  const model = new Gemini({ model: config.model, apiKey: config.googleApiKey });

  return new LlmAgent({
    name: 'circle_payment_agent',
    description: 'Autonomous Payment Agent that pays for x402 services on Circle Agent Marketplace.',
    model,
    tools,
    beforeToolCallback,
  });
}
