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
 * The OpenAI Agents SDK adapter: three tools, no logic.
 *
 * Every body here is one call into `kit-core`, which is the point. What a shell
 * command does, how a truncated result reads, when a spend stops for the user —
 * all of that is identical across the six kits, so it lives in one place and
 * this file is only the shape the Agents SDK wants it in.
 *
 * Approval is external, and this SDK makes that easy: `needsApproval` is a
 * function of the call's own arguments, so it can ask the same question the gate
 * asks — is *this command* one that spends? A true answer interrupts the run,
 * and `index.ts` prompts and resumes. No `ask` is threaded into the tool bodies
 * as a result, which is why `buildTools` takes nothing.
 */
import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  executeGrep,
  executeReadFile,
  executeShell,
  requiresApproval,
  PARAM_DESCRIPTIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  type ToolIo,
} from '@agent-stack-starter-kits/kit-core';
import { toolLine } from './theme';

const io: ToolIo = {
  log: (line) => console.log(toolLine(line)),
  out: (line) => console.log(line),
};

export const shellTool = tool({
  name: TOOL_NAMES.SHELL,
  description: TOOL_DESCRIPTIONS[TOOL_NAMES.SHELL],
  parameters: z.object({
    command: z.string().describe(PARAM_DESCRIPTIONS.command),
  }),
  // The run pauses here only for a command that moves USDC; everything else
  // runs straight through. See kit-core's `approval` for the list.
  needsApproval: async (_context, { command }) => requiresApproval(command),
  execute: ({ command }) => executeShell(command, io),
});

export const readFileTool = tool({
  name: TOOL_NAMES.READ_FILE,
  description: TOOL_DESCRIPTIONS[TOOL_NAMES.READ_FILE],
  parameters: z.object({
    filePath: z.string().describe(PARAM_DESCRIPTIONS.filePath),
    offset: z.number().int().positive().nullable().describe(PARAM_DESCRIPTIONS.offset),
    limit: z.number().int().positive().nullable().describe(PARAM_DESCRIPTIONS.limit),
  }),
  execute: ({ filePath, offset, limit }) =>
    executeReadFile(
      { filePath, offset: offset ?? undefined, limit: limit ?? undefined },
      io,
    ),
});

export const grepTool = tool({
  name: TOOL_NAMES.GREP,
  description: TOOL_DESCRIPTIONS[TOOL_NAMES.GREP],
  parameters: z.object({
    pattern: z.string().describe(PARAM_DESCRIPTIONS.pattern),
    searchPath: z.string().nullable().describe(PARAM_DESCRIPTIONS.searchPath),
    glob: z.string().nullable().describe(PARAM_DESCRIPTIONS.glob),
  }),
  execute: ({ pattern, searchPath, glob }) =>
    executeGrep(
      { pattern, searchPath: searchPath ?? undefined, glob: glob ?? undefined },
      io,
    ),
});

/**
 * The tool set, in the order the agent sees it.
 *
 * Optional arguments are declared `.nullable()` rather than `.optional()`
 * throughout: this SDK generates strict tool schemas, under which every property
 * must appear in `required`, and an omitted-versus-null distinction the model
 * cannot express is nothing the tools need anyway. The bodies map null back to
 * "not supplied".
 */
export const CIRCLE_TOOLS = [shellTool, readFileTool, grepTool];
