import { InMemoryRunner, isFinalResponse, LogLevel, setLogLevel, type Event } from '@google/adk';
import type { Content } from '@google/genai';
import { createChatUi, type ChatUi } from '@agent-stack-ecosystem-kits/agent-cli';
import {
  ensureSession,
  formatUsdcBalance,
  walletUsdcBalance,
} from '@agent-stack-ecosystem-kits/circle-tools';

import { buildAgent, type ApprovalFn } from './agent';
import { loadConfig } from './config';
import { SETUP_SKILL_URL } from './skill';
import { bold, colorizeJson, dim, green, heading, kitLine, red, yellow } from './theme';

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

  log('Autonomous Payment Agent demo starting');
  const config = loadConfig();
  log(`chain=BASE model=${config.model} auth=GOOGLE_API_KEY`);
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

  // Human-in-the-loop, the ADK-native mirror of LangChain's interruptOn: the
  // agent's beforeToolCallback routes the two USDC-spending tools through this
  // approval prompt; every other tool runs without a pause.
  const approve: ApprovalFn = async (toolName, args) => {
    log(yellow(`approval required for tool: ${bold(toolName)}`));
    out(colorizeJson(args));
    const answer = (await ask(bold('Approve this action? [y/N] '))).trim().toLowerCase();
    const approved = answer === 'y' || answer === 'yes';
    log(approved ? green('approved by user') : red('rejected by user'));
    return approved;
  };

  const agent = buildAgent(config, approve, ask);
  const runner = new InMemoryRunner({ agent, appName: APP_NAME });

  // Brief's AGENT BOOTSTRAP PROMPT, verbatim. setup.md drives the first turn.
  const bootstrapPrompt =
    `Run curl -sL ${SETUP_SKILL_URL}, ` +
    'and use the returned setup instructions to set up my agent wallet.';

  // Inline auth: ensure the Circle CLI has a valid agent session before the
  // agent runs. Logs in with email + OTP if needed; a pending Terms gate is
  // reported as a manual step (the kit never accepts the Terms for the user).
  await ensureSession({ ask, log, bold });
  await refreshBalance();

  // One session for the whole conversation: the InMemorySessionService is the
  // ADK-native checkpointer, so the agent keeps full context across the
  // approval pause and every chat turn.
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });

  log('invoking agent ...');
  // `null` means "no new turn to run" — used for the blank-line re-prompt so we
  // never re-invoke the agent without a fresh user message.
  let input: Content | null = userMessage(bootstrapPrompt);

  while (true) {
    if (input) {
      chat.setStatus('working…');
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: input,
      })) {
        if (event.partial) continue;
        if (event.errorCode) {
          log(red(`model error ${event.errorCode}: ${event.errorMessage ?? '(no message)'}`));
          continue;
        }
        if (!isFinalResponse(event)) continue;
        const text = extractText(event);
        if (!text) continue;
        out(`\n${heading('--- agent reply ---')}\n`);
        out(text);
        out(`\n${heading('-------------------')}`);
      }
      chat.setStatus(null);
      await refreshBalance();
    }

    const next = (await ask('> ')).trim();
    if (next.toLowerCase() === 'quit') {
      log('done.');
      break;
    }
    // A blank line is a stray Enter, not an intent to quit: re-prompt without
    // running a turn. `exit` (handled in `ask`) and `quit` still halt.
    input = next ? userMessage(next) : null;
  }

  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print the
  // failure; otherwise these lines would be swallowed by the Ink frame.
  ui?.close();
  const message = err instanceof Error ? err.message : String(err);
  console.error(kitLine(red(`FATAL: ${message}`)));
  process.exit(1);
});
