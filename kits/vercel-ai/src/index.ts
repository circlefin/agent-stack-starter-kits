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
import type { CoreMessage } from 'ai';

import {
  createChatUi,
  withRetry,
  isRetryableError,
  type ChatUi,
} from '@agent-stack-starter-kits/agent-cli';
import { ensureSession, type AskFn } from '@agent-stack-starter-kits/circle-tools';
import { loadConfig, type KitConfig } from './config';
import { runTurn } from './agent';
import { buildTools, type CircleTools } from './tools';
import { isQuotaExhausted } from './retry';
import {
  buildInitialPrompt,
  buildInstructions,
  createBalanceReadout,
  createCommandRouter,
  reportFatal,
  setLiveNotices,
} from '@agent-stack-starter-kits/kit-core';
import { bold, heading, kitLine, replyBlock, toolLine, yellow } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helper below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[vercel-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (JSON, listings) verbatim. */
function out(line: string): void {
  if (ui) ui.log(line);
  else console.log(line);
}

// The pinned USDC readout, shared by every kit (see kit-core/balance). `ui` is
// passed as a getter because it only exists once main() creates the chat UI.
const balance = createBalanceReadout(() => ui);

/**
 * Run one conversation turn, falling back to the secondary provider if the
 * primary hits a quota or auth error.
 *
 * When both ANTHROPIC_API_KEY and OPENAI_API_KEY are set, `config.fallback` is
 * populated and this function will silently retry the exact same turn with the
 * fallback model after a primary failure. The message history is unchanged, so
 * the fallback model picks up mid-conversation seamlessly.
 */
async function runAgentTurn(
  config: KitConfig,
  messages: CoreMessage[],
  tools: CircleTools,
): Promise<{ text: string; responseMessages: CoreMessage[] }> {
  // Rebuilt every turn rather than once for the whole session: it reads the
  // skills index off disk, and the agent's own opening turn can install skills
  // that were not present when the session began. `generateText` is stateless
  // and takes the system prompt fresh on each call, so there is no reason to
  // freeze this at session start.
  const system = await buildInstructions();
  // Fast-fail quota-exhausted 429s so the fallback fires immediately; retry
  // every other transient error (and stalls) per the shared default.
  const shouldRetry = (error: unknown): boolean =>
    isRetryableError(error) && !isQuotaExhausted(error);
  try {
    return await withRetry((signal) => runTurn(config, system, messages, tools, signal), {
      label: config.provider,
      log,
      shouldRetry,
    });
  } catch (primaryErr) {
    if (!config.fallback) throw primaryErr;
    log(yellow(`${config.provider} failed — falling back to ${config.fallback.provider} (${config.fallback.model}) …`));
    return await withRetry((signal) => runTurn(config.fallback!, system, messages, tools, signal), {
      label: config.fallback.provider,
      log,
      shouldRetry,
    });
  }
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

  // Conversation history — the running CoreMessage[] that grows each turn. The
  // Vercel AI SDK's `generateText` is stateless: we own the history and pass it
  // back on every call. `result.response.messages` gives us all the assistant +
  // tool-result messages the SDK generated so we can append them.
  //
  // On a machine with no skills the first message is Circle's own bootstrap
  // line, so the first turn installs them; otherwise it is a status check.
  let messages: CoreMessage[] = [{ role: 'user', content: await buildInitialPrompt() }];

  // Built after `ask` exists: the shell tool prompts through it before running
  // anything that spends. This is the Vercel AI SDK pattern — approval lives
  // inside the tool, because `generateText` has no external permission hook.
  const tools = buildTools(ask);

  // Handles "/balance", "/discover <keyword>", etc. (direct circle-tools calls,
  // no model turn spent) and bare-number replies to a prior "/discover" list.
  const commands = createCommandRouter({ log, out, refreshBalance: balance.refresh });

  // Interactive chat loop. The first turn runs the initial prompt; after the
  // agent settles, the user drives follow-up turns. `messages` grows each turn,
  // so the agent keeps full context. `exit` (handled in `ask`) or `quit` ends
  // the session; a blank line is ignored and re-prompts.
  log('invoking agent ...');
  chat.setStatus('working…');
  const first = await runAgentTurn(config, messages, tools);
  chat.setStatus(null);
  out(replyBlock(first.text));
  balance.refreshSoon();
  messages = [...messages, ...first.responseMessages];

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
    const turn = await runAgentTurn(config, messages, tools);
    chat.setStatus(null);
    out(replyBlock(turn.text));
    balance.refreshSoon();
    messages = [...messages, ...turn.responseMessages];
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
