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

import { homedir } from 'node:os';

import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import { buildInstructions } from '@agent-stack-starter-kits/kit-core';

import type { KitConfig } from './config';
import { dim, red } from './theme';

/**
 * The tool this kit gates on. The SDK's own Bash tool, not one of ours: this is
 * the kit where the shell was already in the box, so the sensible thing is to
 * use it rather than ship a second one alongside.
 */
export const SHELL_TOOL = 'Bash';

/**
 * What the agent may use.
 *
 * Four of the other five kits build a shell, a file reader and a grep out of
 * `kit-core` because their frameworks have none — the LangChain kit is the
 * exception, using Deep Agents' built-in file tools next to a `kit-core` shell.
 * This one does not have to build anything: Bash, Read,
 * Grep and Glob are the SDK's built-ins, they behave the way Claude Code's do,
 * and using them is most of the reason to reach for this SDK. The list is still
 * closed — nothing here writes, edits or deletes through a tool, because the
 * shell does all of that under the gate below.
 */
const TOOLS = [SHELL_TOOL, 'Read', 'Grep', 'Glob'];

/**
 * Everything except the shell runs unprompted; `canUseTool` never sees these.
 * Derived from `TOOLS` rather than listed again, so a tool added to one list
 * cannot silently miss the other.
 */
const AUTO_ALLOWED = TOOLS.filter((tool) => tool !== SHELL_TOOL);

/**
 * Build the Claude Agent SDK `query` options.
 *
 * There is no tool layer here and no playbook. The system prompt is `kit-core`'s:
 * a line of identity, three rules for working a terminal, and an index of the
 * Circle skills installed on this machine. Everything about wallets, x402 and
 * payment comes from those skill documents, which the agent reads with the same
 * Read tool it reads anything else with.
 *
 * `settingSources: []` keeps the run isolated from the host's own Claude Code
 * configuration: no `~/.claude` settings, no project CLAUDE.md, no inherited
 * permission rules. What a user has installed for their editor should not
 * quietly change what this demo does. The Circle skills still arrive, because
 * `kit-core` reads them off disk itself rather than through the SDK's own skill
 * discovery — which is what keeps this kit's behaviour identical to the other
 * five, and what makes the six comparable at all.
 *
 * The `stderr` callback is wired so the spawned Claude Code subprocess is never
 * silent: by default the SDK discards its stderr, so a startup failure (auth,
 * CLI extraction) looks like an indefinite freeze.
 */
export async function buildQueryOptions(
  config: KitConfig,
  canUseTool: CanUseTool,
): Promise<Options> {
  return {
    model: config.model,
    systemPrompt: await buildInstructions(),
    tools: TOOLS,
    allowedTools: AUTO_ALLOWED,
    // Where the user's own terminal would be, and where a global skill install
    // expects to land.
    cwd: homedir(),
    canUseTool,
    permissionMode: 'default',
    settingSources: [],
    stderr: (data: string) => {
      const text = data.trimEnd();
      if (text) console.error(red('[claude-code stderr]'), dim(text));
    },
  };
}
