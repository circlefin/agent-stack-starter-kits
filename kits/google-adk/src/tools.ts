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
 * The Google ADK adapter: three tools, no logic.
 *
 * Every body here is one call into `kit-core`, which is the point. What a shell
 * command does, how a truncated result reads, when a spend stops for the user —
 * all of that is identical across the six kits, so it lives in one place and
 * this file is only the shape ADK wants it in.
 *
 * Approval is external. ADK's `beforeToolCallback` receives the call's arguments
 * as well as its name, so the gate can ask about the command itself rather than
 * about the tool — see `agent.ts`. Nothing here needs `ask` as a result.
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import {
  executeGrep,
  executeReadFile,
  executeShell,
  PARAM_DESCRIPTIONS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  type ToolIo,
} from '@agent-stack-starter-kits/kit-core';
import { toolLine } from './theme';

/** The tool the approval gate applies to; `agent.ts` reads the command off it. */
export const SHELL_TOOL = TOOL_NAMES.SHELL;

const io: ToolIo = {
  log: (line) => console.log(toolLine(line)),
  out: (line) => console.log(line),
};

const shellTool = new FunctionTool({
  name: TOOL_NAMES.SHELL,
  description: TOOL_DESCRIPTIONS[TOOL_NAMES.SHELL],
  parameters: z.object({
    command: z.string().describe(PARAM_DESCRIPTIONS.command),
  }),
  execute: async ({ command }) => executeShell(command, io),
});

const readFileTool = new FunctionTool({
  name: TOOL_NAMES.READ_FILE,
  description: TOOL_DESCRIPTIONS[TOOL_NAMES.READ_FILE],
  parameters: z.object({
    filePath: z.string().describe(PARAM_DESCRIPTIONS.filePath),
    // `.min(1)` rather than `.positive()`: both mean the same for an integer, but
    // zod emits the latter as `exclusiveMinimum`, which Gemini's function-declaration
    // schema rejects outright ("Unknown name \"exclusiveMinimum\"").
    offset: z.number().int().min(1).optional().describe(PARAM_DESCRIPTIONS.offset),
    limit: z.number().int().min(1).optional().describe(PARAM_DESCRIPTIONS.limit),
  }),
  execute: async (args) => executeReadFile(args, io),
});

const grepTool = new FunctionTool({
  name: TOOL_NAMES.GREP,
  description: TOOL_DESCRIPTIONS[TOOL_NAMES.GREP],
  parameters: z.object({
    pattern: z.string().describe(PARAM_DESCRIPTIONS.pattern),
    searchPath: z.string().optional().describe(PARAM_DESCRIPTIONS.searchPath),
    glob: z.string().optional().describe(PARAM_DESCRIPTIONS.glob),
  }),
  execute: async (args) => executeGrep(args, io),
});

/** Build the ADK tool set. */
export function buildTools(): FunctionTool[] {
  return [shellTool, readFileTool, grepTool];
}
