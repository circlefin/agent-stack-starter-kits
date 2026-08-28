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

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { requireSession } from '@agent-stack-starter-kits/circle-tools';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { withRetry } from '@agent-stack-starter-kits/agent-cli';
import { buildInitialPrompt } from '@agent-stack-starter-kits/kit-core';

/**
 * Gate the workflow on a valid Circle agent session.
 *
 * The interactive email + OTP login itself lives in `ensureSession`, which
 * `index.ts` runs before the workflow starts. This step only re-verifies the
 * session, so the login flow (and its hardening: JSON status parsing, single-use
 * request IDs, keyring diagnostics) has exactly one implementation across kits.
 *
 * It deliberately does not prompt via `suspend()`. Two reasons: the session is
 * already guaranteed by the time the run starts, and `suspend()` in @mastra/core
 * v1 does not return the resumed value — it marks the step suspended and
 * resolves `undefined`, expecting the step to return immediately and re-execute
 * from the top with `resumeData` populated on resume.
 */
const authStep = createStep({
  id: 'auth',
  inputSchema: z.object({}),
  outputSchema: z.object({ authenticated: z.literal(true) }),
  execute: async () => {
    await requireSession();
    return { authenticated: true as const };
  },
});

const agentStep = createStep({
  id: 'agent',
  inputSchema: z.object({ authenticated: z.literal(true) }),
  outputSchema: z.object({ summary: z.string(), prompt: z.string() }),
  execute: async () => {
    const config = loadConfig();
    // Nothing in this step should reach the approval gate: the session is
    // already valid, and setup and status checks spend nothing. A prompt here
    // would mean the agent tried to move USDC during what is supposed to be a
    // read-only opening turn, and failing loudly is the right answer to that.
    const noInteractiveAsk = async (): Promise<string> => {
      throw new Error('No interactive terminal available in this workflow step.');
    };
    const agent = await buildAgent(config, noInteractiveAsk);
    const prompt = await buildInitialPrompt();
    const result = await withRetry(
      (signal) => agent.generate(prompt, { maxSteps: 30, abortSignal: signal }),
      { label: 'agent' },
    );
    // `prompt` is returned alongside the summary so `index.ts` can replay the
    // exact turn this step sent as the first chat-history message, rather than
    // recomputing it — `buildInitialPrompt()` reads skills off disk fresh each
    // call, and this step's own run may have just installed them, so a second
    // call after this step returns can produce a different prompt than the one
    // `summary` is actually a reply to.
    return { summary: result.text ?? '(no output)', prompt };
  },
});

export const onboardingWorkflow = createWorkflow({
  id: 'circle-onboarding',
  inputSchema: z.object({}),
  outputSchema: z.object({ summary: z.string(), prompt: z.string() }),
})
  .then(authStep)
  .then(agentStep)
  .commit();
