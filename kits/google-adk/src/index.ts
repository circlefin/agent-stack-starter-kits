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

import { InMemoryRunner, isFinalResponse, LogLevel, setLogLevel, type Event } from '@google/adk';
import type { Content } from '@google/genai';
import { createChatUi, type ChatUi } from '@agent-stack-starter-kits/agent-cli';
import { ensureSession, type AskFn } from '@agent-stack-starter-kits/circle-tools';

import {
  approveCommand,
  buildInitialPrompt,
  createBalanceReadout,
  createCommandRouter,
  isProviderOverloaded,
  reportFatal,
  setLiveNotices,
} from '@agent-stack-starter-kits/kit-core';
import { buildAgent, type ApprovalFn } from './agent';
import { loadConfig } from './config';
import { bold, heading, kitLine, red, replyBlock, toolLine, yellow } from './theme';

const APP_NAME = 'circle-payment-agent';
const USER_ID = 'demo-user';

// ADK's built-in winston logger defaults to INFO and prints every model request
// and session event to stdout, which drowns the kit's own [adk-kit]/[tool] lines.
// Clamp to WARN so framework errors still surface but the chat output stays clean.
setLogLevel(LogLevel.WARN);

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[adk-kit]` framework line to the scrollback. */
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
 * Pull the agent's prose out of an event: text parts only, with any reasoning
 * "thought" parts dropped so the final reply prints clean.
 */
function extractText(event: Event): string {
  const parts = event.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join('')
    .trimEnd();
}

function userMessage(text: string): Content {
  return { role: 'user', parts: [{ text }] };
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
  // (which restores the console) before the answer reaches the caller.
  const ask: AskFn = async (q, options) => {
    const answer = await chat.ask(q, options);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      chat.close();
      process.exit(0);
    }
    return answer;
  };

  // Human-in-the-loop. The agent's beforeToolCallback routes any shell command
  // that moves USDC through this prompt; every other command runs without a
  // pause. What is shown and approved is the command itself, because the command
  // is what runs.
  const approve: ApprovalFn = (command) => approveCommand(ask, command, { log, out });

  const agent = await buildAgent(config, approve);
  const runner = new InMemoryRunner({ agent, appName: APP_NAME });

  // Inline auth: ensure the Circle CLI has a valid agent session before the
  // agent runs. Logs in with email + OTP if needed; a pending Terms gate is
  // reported as a manual step (the kit never accepts the Terms for the user).
  await ensureSession({ ask, log, bold });
  await balance.refresh();

  // One session for the whole conversation: the InMemorySessionService is the
  // ADK-native checkpointer, so the agent keeps full context across the
  // approval pause and every chat turn.
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });

  // Handles "/balance", "/discover <keyword>", etc. (direct circle-tools calls,
  // no model turn spent) and bare-number replies to a prior "/discover" list.
  const commands = createCommandRouter({ log, out, refreshBalance: balance.refresh });

  log('invoking agent ...');
  // `null` means "no new turn to run" — used for the blank-line re-prompt so we
  // never re-invoke the agent without a fresh user message.
  // On a machine with no skills this is Circle's own bootstrap line, so the
  // first turn installs them; otherwise it is a status check.
  let input: Content | null = userMessage(await buildInitialPrompt());

  while (true) {
    if (input) {
      chat.setStatus('working…');
      // NOTE: unlike the discrete-invoke kits (openai/mastra/vercel/langchain),
      // this kit does NOT wrap turns in the shared `withRetry` + per-attempt
      // timeout. `runAsync` yields a single streaming turn over a persistent ADK
      // session; racing a timeout against the stream would truncate a
      // legitimately long turn. If a stall guard is needed, drive the iterator
      // manually and race each `.next()` against a timeout, calling the
      // iterator's `return?.()` to clean up on timeout.
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: input,
      })) {
        if (event.partial) continue;
        if (event.errorCode) {
          // A 529 that reaches here means the provider is overloaded and any
          // retries the SDK does internally ran out — transient on the
          // provider's side, not a kit bug, same as the Claude SDK kit's
          // equivalent check on `msg.errors`.
          if (isProviderOverloaded(event.errorMessage ?? event.errorCode)) {
            log(yellow('The LLM provider is overloaded. This is transient; try again in a moment.'));
          }
          log(red(`model error ${event.errorCode}: ${event.errorMessage ?? '(no message)'}`));
          continue;
        }
        if (!isFinalResponse(event)) continue;
        const text = extractText(event);
        if (!text) continue;
        out(replyBlock(text));
      }
      chat.setStatus(null);
      balance.refreshSoon();
    }

    const next = (
      await ask('> ', { placeholder: 'type "/help" for quick commands or "exit" to quit' })
    ).trim();
    if (next.toLowerCase() === 'quit') {
      log('done.');
      break;
    }
    // A blank line is a stray Enter, not an intent to quit: re-prompt without
    // running a turn. `exit` (handled in `ask`) and `quit` still halt.
    if (!next) {
      input = null;
      continue;
    }
    // "/command" and a bare number picking a prior "/discover" result are
    // handled locally; everything else goes to the agent as a normal turn.
    const outcome = await commands.run(next);
    input = outcome.handled ? (outcome.forward ? userMessage(outcome.forward) : null) : userMessage(next);
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
