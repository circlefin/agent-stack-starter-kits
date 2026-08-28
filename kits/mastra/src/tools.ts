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
 * The Mastra adapter: three tools, no logic.
 *
 * Every body here is one call into `kit-core`, which is the point. What a shell
 * command does, how a truncated result reads, when a spend stops for the user —
 * all of that is identical across the six kits, so it lives in one place and
 * this file is only the shape Mastra wants it in.
 *
 * Approval is in-tool. Mastra does have a native gate — a `Workspace` with a
 * `LocalSandbox` exposes an `execute_command` tool whose `requireApproval` takes
 * the command and suspends the run — and that is the better fit when a UI is
 * driving, because Studio renders the suspended command and resumes it on a
 * click. This kit drives a terminal loop instead, where a suspend has to be
 * caught and resumed by hand for something the chat prompt can just ask; so the
 * gate runs inside `executeShell` when `ask` is present, as it does in the
 * LangChain and Vercel kits. See the Mastra `circle-payment-agent` template for
 * the Workspace version.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { AskFn as CircleAskFn } from '@agent-stack-starter-kits/circle-tools';
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

/** How the kits prompt a human; shared so prompt options (e.g. the OTP's
 * `echo: false`) survive the trip from a tool down to the chat UI. */
export type AskFn = CircleAskFn;

/** Build the Mastra tool set. */
export function buildTools(ask: AskFn) {
  const io: ToolIo = {
    log: (line) => console.log(toolLine(line)),
    out: (line) => console.log(line),
    ask,
  };

  const shell = createTool({
    id: TOOL_NAMES.SHELL,
    description: TOOL_DESCRIPTIONS[TOOL_NAMES.SHELL],
    inputSchema: z.object({
      command: z.string().describe(PARAM_DESCRIPTIONS.command),
    }),
    execute: ({ command }) => executeShell(command, io),
  });

  const readFile = createTool({
    id: TOOL_NAMES.READ_FILE,
    description: TOOL_DESCRIPTIONS[TOOL_NAMES.READ_FILE],
    inputSchema: z.object({
      filePath: z.string().describe(PARAM_DESCRIPTIONS.filePath),
      offset: z.number().int().positive().optional().describe(PARAM_DESCRIPTIONS.offset),
      limit: z.number().int().positive().optional().describe(PARAM_DESCRIPTIONS.limit),
    }),
    execute: (args) => executeReadFile(args, io),
  });

  const grep = createTool({
    id: TOOL_NAMES.GREP,
    description: TOOL_DESCRIPTIONS[TOOL_NAMES.GREP],
    inputSchema: z.object({
      pattern: z.string().describe(PARAM_DESCRIPTIONS.pattern),
      searchPath: z.string().optional().describe(PARAM_DESCRIPTIONS.searchPath),
      glob: z.string().optional().describe(PARAM_DESCRIPTIONS.glob),
    }),
    execute: (args) => executeGrep(args, io),
  });

  return {
    [TOOL_NAMES.SHELL]: shell,
    [TOOL_NAMES.READ_FILE]: readFile,
    [TOOL_NAMES.GREP]: grep,
  };
}
