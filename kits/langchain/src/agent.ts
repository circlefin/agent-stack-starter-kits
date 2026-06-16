import { ChatAnthropic } from '@langchain/anthropic';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { createDeepAgent } from 'deepagents';

import type { KitConfig } from './config';
import { kitLine, yellow } from './theme';
import { buildTools } from './tools';

const MAX_RETRIES = 4;

interface RetryableError {
  status?: number;
}

/**
 * Bounded, visible retry. The provider can answer HTTP 529 ("Overloaded") or
 * 5xx; LangChain retries those with exponential backoff, but silently, so a long
 * backoff looks like a freeze. This logs each retry (counting attempts itself,
 * since LangChain does not pass p-retry's attemptNumber through) and keeps the
 * fail-fast on real client errors (bad key 401, bad request 400) by rethrowing
 * them, which aborts the retry loop instead of hammering the API.
 */
function makeOnFailedAttempt() {
  let attempt = 0;
  return (error: RetryableError): void => {
    const status = error.status;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
      throw error;
    }
    attempt += 1;
    const reason = status === 529 ? 'overloaded' : status ? `HTTP ${status}` : 'unreachable';
    const last = attempt > MAX_RETRIES;
    const tail = last ? 'giving up' : `retrying (${attempt}/${MAX_RETRIES}) ...`;
    console.log(kitLine(yellow(`model ${reason} on attempt ${attempt}; ${tail}`)));
  };
}

/**
 * Tools the agent must NOT run without human approval. circle_pay_service and
 * circle_gateway_deposit are the two tools that move USDC, so both are gated
 * here. Read-only tools (skill fetch, wallet list/balance, gateway balance,
 * service search/inspect) and circle_deploy_wallet (a zero-value, gas-abstracted
 * SCA bootstrap that spends nothing) are intentionally absent, so the agent runs
 * them without a pause. Keyed by tool name, matching `interruptOn` below.
 */
const INTERRUPT_TOOLS = ['circle_pay_service', 'circle_gateway_deposit'] as const;

export function buildAgent(config: KitConfig, ask: (q: string) => Promise<string>) {
  const tools = buildTools(ask);
  // maxRetries bounds the backoff so a sustained outage fails with a clear error
  // instead of hanging; onFailedAttempt makes each retry visible.
  const retry = { maxRetries: MAX_RETRIES, onFailedAttempt: makeOnFailedAttempt() };
  const model =
    config.provider === 'anthropic'
      ? new ChatAnthropic({ model: config.model, apiKey: config.providerApiKey, ...retry })
      : new ChatOpenAI({ model: config.model, apiKey: config.providerApiKey, ...retry });

  return createDeepAgent({
    model,
    tools,
    // Human-in-the-loop: pause before circle_pay_service instead of spending USDC.
    // interruptOn is per-tool (granular) rather than interrupting every tool
    // call. A checkpointer is required to persist agent state across the
    // pause/resume cycle; src/index.ts drives the resume loop.
    interruptOn: Object.fromEntries(INTERRUPT_TOOLS.map((name) => [name, true])),
    checkpointer: new MemorySaver(),
  });
}
