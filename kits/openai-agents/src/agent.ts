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

import { Agent, setDefaultOpenAIKey } from '@openai/agents';
import { buildInstructions } from '@agent-stack-starter-kits/kit-core';

import type { KitConfig } from './config';
import { CIRCLE_TOOLS } from './tools';

/**
 * Build the OpenAI Agents SDK agent.
 *
 * `instructions` is `kit-core`'s prompt: a line of identity, three rules for
 * working a terminal, and an index of the Circle skills installed on this
 * machine. There is no playbook of our own — everything about wallets, x402 and
 * payment comes from those skill documents, which the agent reads with
 * `read_file` when one turns out to be relevant.
 *
 * It is passed as a function rather than a resolved string: `buildInstructions`
 * reads the skills index off disk on every call, because the agent's own first
 * turn can install skills that had not been on the machine when this agent was
 * built. The SDK re-invokes the function on every run, so the index the model
 * sees stays current across a session instead of freezing at construction time.
 *
 * Human-in-the-loop lives on the tools rather than here: `needsApproval` on the
 * shell tool asks whether *this command* spends, and a true answer interrupts
 * the run for `index.ts` to resolve.
 *
 * The key is handed to the SDK explicitly rather than left to its own read of
 * `process.env`, so the one place a key is resolved is `config.ts` — the same
 * arrangement as the other kits.
 */
export async function buildAgent(config: KitConfig): Promise<Agent> {
  setDefaultOpenAIKey(config.providerApiKey);

  return new Agent({
    name: 'Circle Payment Agent',
    model: config.model,
    instructions: () => buildInstructions(),
    tools: CIRCLE_TOOLS,
  });
}
