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

import { LlmAgent, Gemini, type SingleBeforeToolCallback } from '@google/adk';
import {
  buildInstructions,
  requiresApproval,
  REJECTED_MESSAGE,
} from '@agent-stack-starter-kits/kit-core';

import type { KitConfig } from './config';
import { buildTools, SHELL_TOOL } from './tools';

/**
 * Signature the entry point uses to drive an approval prompt for a single
 * pending command. Resolves true to allow, false to deny.
 */
export type ApprovalFn = (command: string) => Promise<boolean>;

/**
 * Build the ADK LlmAgent.
 *
 * `instruction` is `kit-core`'s prompt: a line of identity, three rules for
 * working a terminal, and an index of the Circle skills installed on this
 * machine. There is no playbook of our own — everything about wallets, x402 and
 * payment comes from those skill documents, which the agent reads with
 * `read_file` when one turns out to be relevant.
 *
 * Human-in-the-loop is wired through `beforeToolCallback`, which sees the call's
 * arguments as well as its name — and arguments are what the gate needs now,
 * because with a shell the thing worth stopping is a command, not a tool.
 * Returning `undefined` runs the tool normally; returning a record uses that
 * record as the tool result and skips the call, which is how a declined command
 * reports back without anything having run.
 *
 * The Gemini model is constructed with the API key explicitly to avoid relying
 * on @google/genai's env-var probing (it accepts several aliases).
 */
export async function buildAgent(
  config: KitConfig,
  approve: ApprovalFn,
): Promise<LlmAgent> {
  const beforeToolCallback: SingleBeforeToolCallback = async ({ tool, args }) => {
    if (tool.name !== SHELL_TOOL) return undefined;
    const command = String((args as { command?: unknown }).command ?? '');
    if (!requiresApproval(command)) return undefined;
    if (await approve(command)) return undefined;
    return { error: REJECTED_MESSAGE };
  };

  const model = new Gemini({ model: config.model, apiKey: config.providerApiKey });

  return new LlmAgent({
    name: 'circle_payment_agent',
    description: 'Autonomous Payment Agent that pays for x402 services on Circle Agent Marketplace.',
    instruction: await buildInstructions(),
    model,
    tools: buildTools(),
    beforeToolCallback,
  });
}
