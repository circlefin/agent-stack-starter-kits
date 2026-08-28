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
 * The Vercel AI SDK adapter: three tools, no logic.
 *
 * Every body here is one call into `kit-core`, which is the point. What a shell
 * command does, how a truncated result reads, when a spend stops for the user —
 * all of that is identical across the six kits, so it lives in one place and
 * this file is only the shape the AI SDK wants it in.
 *
 * Approval is in-tool, which is this SDK's idiom: `generateText` has no external
 * per-call permission hook, so the gate runs inside `executeShell` when `ask` is
 * present. The `kit-core` bodies also never throw for an ordinary failure, which
 * matters more here than elsewhere — a tool that throws inside `generateText`
 * takes the whole call down with it rather than letting the model read the error
 * and recover.
 */
import { tool } from 'ai';
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

/** Build the Vercel AI SDK tool set. */
export function buildTools(ask: AskFn) {
  const io: ToolIo = {
    log: (line) => console.log(toolLine(line)),
    out: (line) => console.log(line),
    ask,
  };

  return {
    [TOOL_NAMES.SHELL]: tool({
      description: TOOL_DESCRIPTIONS[TOOL_NAMES.SHELL],
      parameters: z.object({
        command: z.string().describe(PARAM_DESCRIPTIONS.command),
      }),
      execute: ({ command }) => executeShell(command, io),
    }),

    [TOOL_NAMES.READ_FILE]: tool({
      description: TOOL_DESCRIPTIONS[TOOL_NAMES.READ_FILE],
      parameters: z.object({
        filePath: z.string().describe(PARAM_DESCRIPTIONS.filePath),
        offset: z.number().int().positive().optional().describe(PARAM_DESCRIPTIONS.offset),
        limit: z.number().int().positive().optional().describe(PARAM_DESCRIPTIONS.limit),
      }),
      execute: (args) => executeReadFile(args, io),
    }),

    [TOOL_NAMES.GREP]: tool({
      description: TOOL_DESCRIPTIONS[TOOL_NAMES.GREP],
      parameters: z.object({
        pattern: z.string().describe(PARAM_DESCRIPTIONS.pattern),
        searchPath: z.string().optional().describe(PARAM_DESCRIPTIONS.searchPath),
        glob: z.string().optional().describe(PARAM_DESCRIPTIONS.glob),
      }),
      execute: (args) => executeGrep(args, io),
    }),
  };
}

export type CircleTools = ReturnType<typeof buildTools>;
