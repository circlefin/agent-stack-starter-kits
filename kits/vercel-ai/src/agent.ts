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
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { CoreMessage, LanguageModel } from 'ai';
import type { KitConfig, ProviderConfig } from './config';
import type { CircleTools } from './tools';
import { heading, kitLine, yellow } from './theme';

/**
 * Pick the Vercel AI SDK LanguageModel based on the detected provider.
 *
 * The model ID is the raw provider model string — no prefix. The SDK selects
 * the provider from the imported factory (`anthropic()` / `openai()`).
 */
function pickModel(config: ProviderConfig): LanguageModel {
  if (config.provider === 'anthropic') {
    return anthropic(config.model);
  }
  return openai(config.model);
}

/**
 * Run one conversation turn of the Autonomous Payment Agent.
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
  messages: CoreMessage[],
  tools: CircleTools,
): Promise<{ text: string; responseMessages: CoreMessage[] }> {
  const model = pickModel(config);

  let stepCount = 0;

  const result = await generateText({
    model,
    tools,
    messages,
    maxSteps: 30,
    onStepFinish: ({ text, toolCalls, finishReason }) => {
      stepCount++;
      // Print any prose the model emitted in this step. Tool calls are logged
      // inside each tool's execute function, so we only need to surface text.
      if (text.trim()) {
        console.log(`\n${heading('--- agent ---')}\n${text}`);
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
