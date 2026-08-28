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
import { run, user } from '@openai/agents';
import type { Agent, RunResult } from '@openai/agents';
import { createChatUi, withRetry, type ChatUi } from '@agent-stack-starter-kits/agent-cli';
import { ensureSession, type AskFn } from '@agent-stack-starter-kits/circle-tools';

import {
  approveCommand,
  buildInitialPrompt,
  createBalanceReadout,
  createCommandRouter,
  reportFatal,
  setLiveNotices,
  REJECTED_MESSAGE,
} from '@agent-stack-starter-kits/kit-core';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { bold, heading, kitLine, replyBlock, toolLine } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[openai-kit]` framework line to the scrollback. */
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
 * Resolve every tool call the run paused on, then carry the run forward.
 *
 * Only the shell tool ever pauses, and only for a command that moves USDC —
 * `needsApproval` in `tools.ts` asks that question of the command itself. The
 * command is what gets shown and approved, because the command is what runs.
 */
async function resolveInterruptions(
  result: RunResult<any, any>,
  agent: Agent<any, any>,
  ask: AskFn,
): Promise<RunResult<any, any>> {
  while (result.interruptions && result.interruptions.length > 0) {
    for (const interruption of result.interruptions) {
      const rawItem = interruption.rawItem as { name?: string; arguments?: string };
      const args = (() => {
        try {
          return JSON.parse(rawItem?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const command = String(args.command ?? rawItem?.name ?? 'unknown command');

      if (await approveCommand(ask, command, { log, out })) {
        result.state.approve(interruption);
      } else {
        result.state.reject(interruption, { message: REJECTED_MESSAGE });
      }
    }
    result = await withRetry((signal) => run(agent, result.state, { signal }), { label: 'agent', log });
  }
  return result;
}

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

  const agent = await buildAgent(config);

  // On a machine with no skills this is Circle's own bootstrap line, so the
  // first turn installs them; otherwise it is a status check.
  const initialPrompt = await buildInitialPrompt();

  // Handles "/balance", "/discover <keyword>", etc. (direct circle-tools calls,
  // no model turn spent) and bare-number replies to a prior "/discover" list.
  const commands = createCommandRouter({ log, out, refreshBalance: balance.refresh });

  log('invoking agent ...');
  chat.setStatus('working…');
  let result = await withRetry((signal) => run(agent, initialPrompt, { signal }), {
    label: 'agent',
    log,
  });
  result = await resolveInterruptions(result, agent, ask);
  chat.setStatus(null);
  out(replyBlock(result.finalOutput));
  balance.refreshSoon();

  // Interactive chat loop. The first turn ran the initial prompt above; from
  // here the user drives follow-ups. Each turn replays `result.history`, so the
  // agent keeps full context across turns. `exit` (handled in `ask`) or `quit`
  // ends the session; a blank line is ignored and re-prompts.
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
    const turnInput = outcome.forward ?? next;

    chat.setStatus('working…');
    result = await withRetry((signal) => run(agent, [...result.history, user(turnInput)], { signal }), {
      label: 'agent',
      log,
    });
    result = await resolveInterruptions(result, agent, ask);
    chat.setStatus(null);
    out(replyBlock(result.finalOutput));
    balance.refreshSoon();
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
