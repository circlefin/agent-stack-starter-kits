/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { CoreMessage, JSONValue, LanguageModel } from 'ai';
import type { ProviderConfig } from './config';
import type { CircleTools } from './tools';
import { kitLine, streamedBlock, yellow } from './theme';

/**
 * Pick the Vercel AI SDK LanguageModel based on the detected provider, plus any
 * provider-specific options the call needs.
 *
 * The model ID is the raw provider model string — no prefix; the provider comes
 * from which factory is used. Both are built with `create…({ apiKey })` rather
 * than the bare `anthropic()` / `openai()` singletons, which read the key from
 * `process.env` themselves: this kit can run two providers in one process (a
 * primary and its fallback), so each model has to carry the key that belongs to
 * it, and `config.ts` stays the one place a key is resolved.
 */
function pickModel(config: ProviderConfig): {
  model: LanguageModel;
  providerOptions?: Record<string, Record<string, JSONValue>>;
} {
  if (config.provider === 'anthropic') {
    const anthropic = createAnthropic({ apiKey: config.providerApiKey });
    return { model: anthropic(config.model) };
  }
  // `openai()` talks to /v1/chat/completions, which OpenAI's reasoning models
  // (gpt-5.x, o-series) reject when function tools and a non-'none'
  // reasoning_effort are combined: "Function tools with reasoning_effort are
  // not supported ... use /v1/responses or set reasoning_effort to 'none'".
  // This agent is nothing but tool calls, and we want the reasoning, so use the
  // Responses API instead.
  //
  // The Responses model defaults `strictSchemas` to true, which turns on
  // OpenAI's strict tool-calling mode: every property must appear in
  // `required`, with optional ones expressed as nullable instead of omitted.
  // This kit's tool schemas use ordinary zod `.optional()` fields (offset,
  // limit, searchPath, glob), so strict mode rejects them outright before the
  // model ever runs. Turn it off to keep the schemas as declared.
  const openai = createOpenAI({ apiKey: config.providerApiKey });
  return {
    model: openai.responses(config.model),
    providerOptions: { openai: { strictSchemas: false } },
  };
}

/**
 * Run one conversation turn of the Autonomous Payment Agent.
 *
 * `system` is `kit-core`'s prompt: a line of identity, three rules for working a
 * terminal, and an index of the Circle skills installed on this machine. There
 * is no playbook of our own — everything about wallets, x402 and payment comes
 * from those skill documents, which the agent reads with `read_file` when one
 * turns out to be relevant.
 *
 * Uses `generateText` with `maxSteps: 30` so the SDK drives the tool-call loop
 * automatically: model → tool call → tool result → model → … until the model
 * produces a final text response or the step cap is hit.
 *
 * `onStepFinish` fires after each step (including tool execution). We use it to
 * stream intermediate agent text to the terminal so the user can follow the
 * reasoning before the final reply.
 *
 * Returns both the final text and `response.messages` — the full set of
 * assistant and tool-result messages the SDK generated. The caller appends
 * these to the running `messages` array to preserve conversation context for
 * the next turn.
 */
export async function runTurn(
  config: ProviderConfig,
  system: string,
  messages: CoreMessage[],
  tools: CircleTools,
  signal?: AbortSignal,
): Promise<{ text: string; responseMessages: CoreMessage[] }> {
  const { model, providerOptions } = pickModel(config);

  let stepCount = 0;

  const result = await generateText({
    model,
    system,
    tools,
    messages,
    providerOptions,
    maxSteps: 30,
    abortSignal: signal,
    onStepFinish: ({ text, toolCalls, finishReason }) => {
      stepCount++;
      // Prose the model emitted *alongside a tool call* is thinking-aloud, and
      // printing it as it arrives is what keeps a long turn from looking frozen
      // (the tool calls themselves log from inside each tool's execute). Text
      // with no tool call is the turn's answer, and belongs in the reply frame
      // the caller prints — surfacing it here too would print it twice.
      if (text.trim() && toolCalls.length > 0) {
        console.log(streamedBlock(text));
      }
      // Surface a warning when the cap is reached so users understand why the
      // agent stopped mid-task rather than silently abandoning work.
      if (finishReason === 'length' && toolCalls.length > 0) {
        console.log(kitLine(yellow(`step cap reached (${stepCount} steps) — agent may be incomplete`)));
      }
    },
  });

  return {
    text: result.text,
    // Cast: ResponseMessage is a subset of CoreMessage, safe to widen.
    responseMessages: result.response.messages as CoreMessage[],
  };
}
