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

/**
 * The LangChain adapter: one tool, no logic.
 *
 * The body here is one call into `kit-core`, which is the point. What a shell
 * command does, how a truncated result reads, when a spend stops for the user —
 * all of that is identical across the six kits, so it lives in one place and
 * this file is only the shape LangChain wants it in.
 *
 * Only the shell, because Deep Agents already ships `read_file`, `grep`, `ls`
 * and `glob` as built-ins and refuses to start when a custom tool takes one of
 * those names. Registering `kit-core`'s versions here is therefore not an
 * option, and would not be the right call anyway: the framework's own file
 * tools are most of the reason to reach for it. `agent.ts` points them at the
 * real disk. This is the same trade the Claude Agent SDK kit makes with Read
 * and Grep; the other four kits build all three out of `kit-core` because their
 * frameworks have none.
 *
 * Approval is in-tool. Deep Agents' `interruptOn` pauses on a tool *name*, and
 * the thing worth pausing on here is a command, so the gate runs inside
 * `executeShell` instead — it fires when `ask` is present, which is why `ask` is
 * threaded through.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AskFn as CircleAskFn } from '@agent-stack-starter-kits/circle-tools';
import {
  executeShell,
  PARAM_DESCRIPTIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  type ToolIo,
} from '@agent-stack-starter-kits/kit-core';
import { toolLine } from './theme';

/** How the kits prompt a human; shared so prompt options (e.g. the OTP's
 * `echo: false`) survive the trip from a tool down to the chat UI. */
export type AskFn = CircleAskFn;

/** Build the LangChain tool set. */
export function buildTools(ask: AskFn) {
  const io: ToolIo = {
    log: (line) => console.log(toolLine(line)),
    out: (line) => console.log(line),
    ask,
  };

  const shell = tool(({ command }) => executeShell(command, io), {
    name: TOOL_NAMES.SHELL,
    description: TOOL_DESCRIPTIONS[TOOL_NAMES.SHELL],
    schema: z.object({
      command: z.string().describe(PARAM_DESCRIPTIONS.command),
    }),
  });

  return [shell];
}
