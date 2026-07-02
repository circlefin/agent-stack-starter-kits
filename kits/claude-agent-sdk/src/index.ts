import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createChatUi, type ChatUi } from '@agent-stack-ecosystem-kits/agent-cli';
import {
  ensureSession,
  formatUsdcBalance,
  walletUsdcBalance,
} from '@agent-stack-ecosystem-kits/circle-tools';

import { buildQueryOptions } from './agent';
import { loadConfig } from './config';
import { SETUP_SKILL_URL } from './skill';
import { bold, colorizeJson, dim, green, heading, kitLine, red, yellow } from './theme';
import { SPEND_TOOLS } from './tools';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[claude-agent-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (JSON, agent prose) verbatim. */
function out(line: string): void {
  if (ui) ui.log(line);
  else console.log(line);
}

/** Refresh the pinned USDC balance readout. Best-effort: a balance read must
 * never break the session (e.g. before a wallet exists, or on an RPC blip). */
async function refreshBalance(): Promise<void> {
  try {
    const summary = await walletUsdcBalance();
    ui?.setBalance(summary ? formatUsdcBalance(summary) : null);
  } catch {
    // Leave the last shown balance in place.
  }
}

/** True when an error string is an Anthropic "Overloaded" (HTTP 529). The
 * underlying Claude Code subprocess retries 529 itself (those retries surface
 * via the wired stderr); this only classifies the message once retries are
 * exhausted so it reads as a transient provider hiccup, not a kit bug. */
function isOverloaded(text: string): boolean {
  return text.includes('529') || /overloaded/i.test(text);
}

/** Wrap a turn of user text as the streaming-input message the SDK expects. */
function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/**
 * Print the agent's text for one assistant message. Tool calls log themselves
 * from inside the tool handlers (`[tool] ...`), so only the model's prose is
 * printed here, under a per-turn heading.
 */
function printAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): void {
  const content = msg.message.content;
  const blocks = Array.isArray(content) ? content : [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) {
      out(`\n${heading('--- agent ---')}\n`);
      out(block.text.trimEnd());
    }
  }
}

/** Print a one-line turn summary (duration + cost), or the error on failure. */
function printResult(msg: Extract<SDKMessage, { type: 'result' }>): void {
  const secs = (msg.duration_ms / 1000).toFixed(1);
  if (msg.subtype === 'success') {
    log(dim(`turn complete (${secs}s, $${msg.total_cost_usd.toFixed(4)})`));
  } else {
    log(red(`turn ended: ${msg.subtype} (${secs}s)`));
    if (msg.errors.some(isOverloaded)) {
      log(yellow('The LLM provider is overloaded (HTTP 529). This is transient; try again in a moment.'));
    }
    for (const e of msg.errors) out(red(e));
  }
}

async function main(): Promise<void> {
  // Pin the input to the bottom (Claude Code-style) while logs scroll above.
  // Falls back to plain console + readline when stdout/stdin is not a TTY.
  const chat = createChatUi({ title: heading('Autonomous Payment Agent') });
  ui = chat;

  log('Autonomous Payment Agent demo starting');
  const config = loadConfig();
  log(`chain=BASE model=${config.model} auth=ANTHROPIC_API_KEY`);
  log(dim('tip: type "exit" at any prompt to quit'));

  // Every prompt (chat input, approval [y/N], email/OTP) flows through the same
  // pinned input box the chat UI renders at the bottom of the terminal.
  // `exit` typed at ANY prompt halts the demo immediately, tearing down the UI
  // (which restores the console) before the answer reaches the caller.
  const ask = async (q: string): Promise<string> => {
    const answer = await chat.ask(q);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      chat.close();
      process.exit(0);
    }
    return answer;
  };

  // Human-in-the-loop, the SDK-native mirror of LangChain's interruptOn: the
  // permission handler approves every read-only tool and pauses for a y/N on the
  // two USDC-spending tools before they run.
  const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
    if (!SPEND_TOOLS.includes(toolName as (typeof SPEND_TOOLS)[number])) {
      return { behavior: 'allow', updatedInput: input };
    }
    log(yellow(`approval required for tool: ${bold(toolName)}`));
    out(colorizeJson(input));
    const answer = (await ask(bold('Approve this action? [y/N] '))).trim().toLowerCase();
    const approved = answer === 'y' || answer === 'yes';
    if (approved) {
      log(green('approved by user'));
      return { behavior: 'allow', updatedInput: input };
    }
    log(red('rejected by user'));
    return { behavior: 'deny', message: 'User rejected this action.' };
  };

  // Streaming input: the bootstrap prompt drives turn one; thereafter the result
  // handler feeds follow-ups through `pushInput`. Buffering decouples the SDK
  // pulling the next input from when the user actually answers, so the prompt
  // order never races the SDK's read of the stream.
  const buffered: Array<SDKUserMessage | null> = [];
  let waiter: ((m: SDKUserMessage | null) => void) | null = null;
  function pushInput(m: SDKUserMessage | null): void {
    if (waiter) {
      waiter(m);
      waiter = null;
    } else {
      buffered.push(m);
    }
  }
  function nextInput(): Promise<SDKUserMessage | null> {
    if (buffered.length > 0) return Promise.resolve(buffered.shift() ?? null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  // Brief's AGENT BOOTSTRAP PROMPT, verbatim. setup.md drives the first turn.
  const bootstrapPrompt =
    `Run curl -sL ${SETUP_SKILL_URL}, ` +
    'and use the returned setup instructions to set up my agent wallet.';

  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(bootstrapPrompt);
    while (true) {
      const next = await nextInput();
      if (next === null) return;
      yield next;
    }
  }

  // Inline auth: ensure the Circle CLI has a valid agent session before the
  // agent runs. Logs in with email + OTP if needed; a pending Terms gate is
  // reported as a manual step (the kit never accepts the Terms for the user).
  await ensureSession({ ask, log, bold });
  await refreshBalance();

  log('invoking agent ...');
  chat.setStatus('working…');
  const session = query({
    prompt: inputStream(),
    options: buildQueryOptions(config, canUseTool, ask),
  });

  // One `query` call is the whole conversation: the SDK keeps full context
  // across turns natively, so there is no thread_id to carry. We print as
  // messages stream and, on each turn's `result`, prompt for the next turn.
  for await (const msg of session) {
    if (msg.type === 'assistant') {
      printAssistant(msg);
    } else if (msg.type === 'result') {
      printResult(msg);
      chat.setStatus(null);
      await refreshBalance();
      // A blank line is a stray Enter, not an intent to quit: re-prompt without
      // feeding the input stream. `exit` (handled in `ask`) and `quit` still halt.
      let next = (await ask('> ')).trim();
      while (!next) {
        next = (await ask('> ')).trim();
      }
      if (next.toLowerCase() === 'quit') {
        log('done.');
        pushInput(null);
      } else {
        chat.setStatus('working…');
        pushInput(userMessage(next));
      }
    }
  }

  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print the
  // failure; otherwise these lines would be swallowed by the Ink frame.
  ui?.close();
  const message = err instanceof Error ? err.message : String(err);
  // A 529 means the LLM provider is overloaded after retries were exhausted: it
  // is transient and not a kit bug, so say so plainly instead of dumping raw JSON.
  const overloaded = (err as { status?: number })?.status === 529 || isOverloaded(message);
  if (overloaded) {
    console.error(
      kitLine(red('FATAL: the LLM provider is overloaded (HTTP 529) and retries were exhausted.')),
    );
    console.error(kitLine(yellow('This is transient on the provider side. Re-run in a moment.')));
  } else {
    console.error(kitLine(red(`FATAL: ${message}`)));
  }
  process.exit(1);
});
