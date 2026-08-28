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

import { Agent } from '@mastra/core/agent';
import { buildInstructions } from '@agent-stack-starter-kits/kit-core';

import type { KitConfig } from './config';
import { buildTools, type AskFn } from './tools';

/**
 * Build the Mastra agent.
 *
 * `instructions` is `kit-core`'s prompt: a line of identity, three rules for
 * working a terminal, and an index of the Circle skills installed on this
 * machine. There is no playbook of our own — everything about wallets, x402 and
 * payment comes from those skill documents, which the agent reads with
 * `read_file` when one turns out to be relevant.
 *
 * Mastra takes `instructions` as a function as well as a string, so it could be
 * re-read per turn; it is resolved once here because this kit builds its agent
 * once, and a session that installs skills mid-run is told where to find them
 * (see `kit-core`'s instructions).
 */
export async function buildAgent(config: KitConfig, ask: AskFn): Promise<Agent> {
  return new Agent({
    id: 'circle-payment-agent',
    name: 'Circle Payment Agent',
    instructions: await buildInstructions(),
    model: config.model,
    tools: buildTools(ask),
  });
}
