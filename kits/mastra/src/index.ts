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

import 'dotenv/config';
import type { AIV5ResponseMessage } from '@mastra/core/agent/message-list';
import { createChatUi, withRetry, type ChatUi } from '@agent-stack-starter-kits/agent-cli';
import { ensureSession, type AskFn } from '@agent-stack-starter-kits/circle-tools';

import {
  buildInitialPrompt,
  createBalanceReadout,
  createCommandRouter,
  reportFatal,
  setLiveNotices,
} from '@agent-stack-starter-kits/kit-core';
import { onboardingWorkflow } from './workflow';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { bold, heading, kitLine, red, replyBlock, toolLine } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[mastra-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (JSON, agent reply) verbatim. */
function out(line: string): void {
  if (ui) ui.log(line);
  else console.log(line);
}

// The pinned USDC readout, shared by every kit (see kit-core/balance). `ui` is
// passed as a getter because it only exists once main() creates the chat UI.
const balance = createBalanceReadout(() => ui);

/**
 * One entry of the conversation this kit owns and re-sends every turn: a typed
 * user line, or one of the assistant / tool messages a turn produced.
 */
type ChatMessage = { role: 'user'; content: string } | AIV5ResponseMessage;

async function main(): Promise<void> {
  // Pin the input to the bottom (Claude Code-style) while logs scroll above.
  // Falls back to plain console + readline when stdout/stdin is not a TTY.
  const chat = createChatUi({ title: heading('Autonomous Payment Agent') });
  ui = chat;
  // In-flight tool calls draw in the live region at the bottom of the frame
  // rather than in the scrollback, so each one erases itself the moment its
  // finished block prints (see kit-core's `setLiveNotices`).
  setLiveNotices((label) => chat.startRunning(toolLine(label)));

  log('Autonomous Payment Agent demo starting');
  const config = loadConfig();
  log(`provider=${config.provider} model=${config.model}`);

  // Every prompt (chat input, approval [y/N], email/OTP) flows through the same
  // pinned input box the chat UI renders at the bottom of the terminal.
  // `exit` typed at ANY prompt halts the demo immediately, tearing down the UI
  // (which restores the console) before the answer reaches the caller. Options
  // (e.g. the OTP prompt's `echo: false`) pass straight through to the UI.
  const ask: AskFn = async (question, options) => {
    const answer = await chat.ask(question, options);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      chat.close();
      process.exit(0);
    }
    return answer;
  };

  // Inline auth: ensure the Circle CLI has a valid agent session before the
  // agent runs. Logs in with email + OTP if needed; a pending Terms gate is
  // reported as a manual step (the kit never accepts the Terms for the user).
  await ensureSession({ ask, log, bold });
  await balance.refresh();

  // The opening turn runs as a Mastra workflow rather than a bare agent call —
  // the one place this kit differs in shape from the other five, and the reason
  // is that workflows are Mastra's own answer to a multi-step run with a
  // human in it. `workflow.ts` re-verifies the session, then takes the turn.
  log('invoking agent ...');
  chat.setStatus('working…');
  const run = await onboardingWorkflow.createRun();
  let result = await run.start({ inputData: {} });

  // Generic resume driver: no shipped step suspends (login is handled up front
  // by `ensureSession`), but any human-in-the-loop step added to the workflow
  // gets prompted through the chat UI without touching this file. A suspending
  // step must `suspend(...)` and then return immediately — on resume Mastra
  // re-executes it from the top with `resumeData` set.
  while (result.status === 'suspended') {
    const suspendedEntry = Object.entries(result.steps).find(([, s]) => s.status === 'suspended');
    if (!suspendedEntry) break;
    const [stepId, stepResult] = suspendedEntry;
    const payload = (stepResult as any).suspendPayload as { prompt: string } | undefined;
    if (!payload?.prompt) break;
    chat.setStatus(null);
    const value = await ask(`\n${payload.prompt}\n> `);
    chat.setStatus('working…');
    result = await run.resume({ step: stepId, resumeData: { value } });
  }
  chat.setStatus(null);

  if (result.status !== 'success') {
    log(red(`workflow ended with status: ${result.status}`));
    chat.close();
    return;
  }

  const summary: string =
    (result as any).result?.summary ??
    (result as any).steps?.agent?.output?.summary ??
    '(no output)';
  // The exact prompt the workflow sent, not a fresh call to buildInitialPrompt():
  // skills are read off disk on every call, and the workflow's own run may have
  // just installed them, so recomputing here can silently swap the bootstrap
  // prompt for the returning-session one — leaving `summary` as the reply to a
  // question that was never actually asked in this history.
  const initialPrompt: string =
    (result as any).result?.prompt ?? (result as any).steps?.agent?.output?.prompt ?? (await buildInitialPrompt());
  out(replyBlock(summary));
  balance.refreshSoon();

  const agent = await buildAgent(config, ask);
  // The workflow above already ran the opening turn; replaying it here as the
  // first user message is what carries that turn into the chat's history. Only
  // its text is available (the step returns a summary), which is the one place
  // history is lossy — the opening turn is read-only setup, so nothing later in
  // the conversation depends on the detail of what it ran.
  const messages: ChatMessage[] = [
    { role: 'user', content: initialPrompt },
    { role: 'assistant', content: summary },
  ];

  // Handles "/balance", "/discover <keyword>", etc. (direct circle-tools calls,
  // no model turn spent) and bare-number replies to a prior "/discover" list.
  const commands = createCommandRouter({ log, out, refreshBalance: balance.refresh });

  // Interactive chat loop. `messages` grows each turn, so the agent keeps full
  // context across turns. `exit` (handled in `ask`) or `quit` ends the session;
  // a blank line is ignored and re-prompts.
  while (true) {
    const next = (
      await ask('> ', { placeholder: 'type "/help" for quick commands or "exit" to quit' })
    ).trim();
    if (next.toLowerCase() === 'quit') {
      log('done.');
      break;
    }
    // A blank line is a stray Enter, not an intent to quit: re-prompt without
    // running a turn. `exit` (handled in `ask`) and `quit` still halt.
    if (!next) continue;
    // "/command" and a bare number picking a prior "/discover" result are
    // handled locally; everything else goes to the agent as a normal turn.
    const outcome = await commands.run(next);
    if (outcome.handled && !outcome.forward) continue;
    messages.push({ role: 'user', content: outcome.forward ?? next });

    chat.setStatus('working…');
    const response = await withRetry(
      (signal) => agent.generate(messages, { maxSteps: 30, abortSignal: signal }),
      { label: 'agent', log },
    );
    chat.setStatus(null);
    const text = response.text ?? '';
    out(replyBlock(text));
    balance.refreshSoon();
    // Everything the turn produced, not just its closing text: `generate` is
    // stateless (no memory is configured), so this array is the whole context
    // the next turn gets. Appending only `text` would drop every tool call and
    // tool result, and a turn that ends mid-procedure — "I sent the code, tell
    // me what it says" — would come back next turn with no record of what it
    // ran, and start the procedure again from the top.
    const turnMessages = response.response?.messages;
    messages.push(
      ...(turnMessages && turnMessages.length > 0
        ? turnMessages
        : // A degraded turn can answer with no response messages at all. Keep
          // the text so the reply the user just read is still in the history.
          [{ role: 'assistant' as const, content: text }]),
    );
  }

  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print the
  // failure; otherwise these lines would be swallowed by the Ink frame.
  ui?.close();
  reportFatal(err, kitLine);
  process.exit(1);
});
