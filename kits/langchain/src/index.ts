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

import { HumanMessage } from '@langchain/core/messages';
import { createChatUi, withRetry, type ChatUi } from '@agent-stack-starter-kits/agent-cli';
import { ensureSession, type AskFn } from '@agent-stack-starter-kits/circle-tools';

import {
  buildInitialPrompt,
  buildInstructions,
  createBalanceReadout,
  createCommandRouter,
  reportFatal,
  setLiveNotices,
} from '@agent-stack-starter-kits/kit-core';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { bold, colorizeJson, heading, kitLine, replyBlock, toolLine, yellow } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[langchain-kit]` framework line to the scrollback. */
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

interface AgentResult {
  messages?: Array<{ content: unknown }>;
}

type Agent = ReturnType<typeof buildAgent>;
type RunConfig = { configurable: { thread_id: string }; signal?: AbortSignal };

const EMPTY_RESPONSE_RETRIES = 2;

/**
 * True when the model returned no usable content: null/undefined, a blank
 * string, or an empty content-block array. Under provider degradation the API
 * can answer HTTP 200 with no content blocks (stop_reason set, no text). That is
 * not a thrown error, so the model-level retry in agent.ts (which only fires on
 * 5xx/529/429) never sees it; we catch the empty turn here instead.
 */
function isEmptyContent(content: unknown): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    // Blocks that are all text but carry none of it are the same blank turn,
    // which is the shape a degraded reply takes over the Responses API.
    return textContentOf(content)?.trim() === '';
  }
  return false;
}

function finalContentOf(result: AgentResult): unknown {
  const messages = result.messages ?? [];
  return messages[messages.length - 1]?.content;
}

/**
 * The reply as markdown, when the content is text.
 *
 * Anthropic hands back a plain string for a text-only reply; OpenAI through the
 * Responses API always hands back content blocks, so the same answer arrives as
 * `[{ type: "text", text: "..." }]`. Both are markdown the user should read as
 * markdown — this flattens the block form to it and returns null for anything
 * genuinely structured, which printFinal then shows as JSON.
 */
function textContentOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const blocks = content as Array<{ type?: string; text?: unknown }>;
  if (!blocks.every((block) => block.type === 'text' && typeof block.text === 'string')) return null;
  return blocks.map((block) => block.text as string).join('');
}

/**
 * Invoke the agent and drive it to completion for one conversation turn.
 *
 * There is no interrupt loop here any more. Deep Agents' `interruptOn` pauses on
 * a tool name, and with a single shell tool the question worth pausing on is
 * which *command* is about to run — so the gate moved inside the tool (see
 * kit-core's `approval`), where it prompts through the same chat UI and returns
 * a normal tool result either way. Each turn reuses `runConfig` so the thread_id
 * stays stable and the checkpointer keeps the conversation.
 */
async function runTurn(
  agent: Agent,
  input: { messages: HumanMessage[] },
  runConfig: RunConfig,
): Promise<AgentResult> {
  let attempt = 0;
  while (true) {
    const result = (await withRetry(
      (signal) => agent.invoke(input, { ...runConfig, signal }),
      { label: 'agent', log },
    )) as AgentResult;

    // An empty final turn is a degraded-provider artifact, not a real reply.
    // Re-run the turn (same input, same thread) to ask the model to regenerate;
    // bounded so a sustained outage still ends instead of looping forever.
    if (!isEmptyContent(finalContentOf(result)) || attempt >= EMPTY_RESPONSE_RETRIES) {
      return result;
    }
    attempt += 1;
    log(yellow(`empty model response; retrying turn (${attempt}/${EMPTY_RESPONSE_RETRIES}) ...`));
  }
}

function printFinal(result: AgentResult): void {
  const content = finalContentOf(result);
  const text = textContentOf(content);
  // A text reply is markdown, left as-is; a structured reply is highlighted
  // JSON. An empty turn that survived the retry in runTurn is flagged plainly so
  // a degraded-provider blank never prints as a bare `[]`.
  const finalContent = isEmptyContent(content)
    ? yellow('(empty model response — provider may be degraded; try again in a moment)')
    : (text ?? colorizeJson(content));

  out(replyBlock(finalContent));
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

  // The checkpointer-backed agent needs a thread_id. The same config object is
  // reused on every chat turn, so conversation state held by the MemorySaver
  // checkpointer carries across the whole session.
  const runConfig: RunConfig = { configurable: { thread_id: `demo-${Date.now()}` } };

  // Every prompt (chat input, approval [y/N], email/OTP) flows through the same
  // pinned input box the chat UI renders at the bottom of the terminal.
  // `exit` typed at ANY prompt halts the demo immediately, tearing down the UI
  // (which restores the console) before the answer reaches the caller. Options
  // (e.g. the OTP prompt's `echo: false`) pass straight through to the UI.
  const ask: AskFn = async (q, options) => {
    const answer = await chat.ask(q, options);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      chat.close();
      process.exit(0);
    }
    return answer;
  };

  // Inline auth: make sure the CLI has a valid agent session before the agent
  // runs. Logs in with email + OTP if needed; a pending Terms gate is reported
  // as a manual step (the kit never accepts the Terms for the user).
  await ensureSession({ ask, log, bold });
  await balance.refresh();

  // The system prompt: identity, three rules for a terminal, and whatever Circle
  // skills are installed. Built once, here, because the agent is built once.
  const instructions = await buildInstructions();
  // On a machine with no skills this is Circle's own bootstrap line, so the
  // first turn installs them; otherwise it is a status check.
  const initialPrompt = await buildInitialPrompt();

  // Built after `ask` exists: the shell tool prompts through it before running
  // anything that spends.
  const agent = buildAgent(config, ask, instructions);

  // Handles "/balance", "/discover <keyword>", etc. (direct circle-tools calls,
  // no model turn spent) and bare-number replies to a prior "/discover" list.
  const commands = createCommandRouter({ log, out, refreshBalance: balance.refresh });

  // Interactive chat loop. The first turn runs the initial prompt; after the
  // agent settles, the user drives follow-up turns. Each turn shares the
  // thread_id above, so the agent keeps full context across turns. `exit` or
  // `quit` ends the session; a blank line is ignored and re-prompts.
  log('invoking agent ...');
  // `null` means "no new turn to run" — used for the blank-line re-prompt so we
  // never re-invoke the agent without a fresh user message (that would replay a
  // thread ending on the assistant's reply, which the model rejects as prefill).
  let input: { messages: HumanMessage[] } | null = {
    messages: [new HumanMessage(initialPrompt)],
  };

  while (true) {
    if (input) {
      chat.setStatus('working…');
      const result = await runTurn(agent, input, runConfig);
      chat.setStatus(null);
      printFinal(result);
      balance.refreshSoon();
    }

    const next = (await ask('> ', { placeholder: 'type "/help" for quick commands or "exit" to quit' })).trim();
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
    input = outcome.handled
      ? outcome.forward
        ? { messages: [new HumanMessage(outcome.forward)] }
        : null
      : { messages: [new HumanMessage(next)] };
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
