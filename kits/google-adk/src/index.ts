import { createInterface } from 'node:readline/promises';

import { InMemoryRunner, isFinalResponse, LogLevel, setLogLevel, type Event } from '@google/adk';
import type { Content } from '@google/genai';
import { ensureSession } from '@agent-stack-ecosystem-kits/circle-tools';

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

function log(line: string): void {
  console.log(kitLine(line));
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
  log('Autonomous Payment Agent demo starting');
  const config = loadConfig();
  log(`chain=BASE model=${config.model} auth=GOOGLE_API_KEY`);
  log(dim('tip: type "exit" at any prompt to quit'));

  // Open readline only for the duration of a single question. Keeping it open
  // across the whole session would leave it attached to the TTY in terminal
  // mode while the agent streams, where any keystroke (or a stdout write racing
  // its line-refresh) repaints its prompt mid-output. Open/close per prompt so
  // readline never owns the TTY during streaming.
  // `exit` typed at ANY prompt (chat input or an approval [y/N]) halts the demo
  // immediately, before the answer reaches the caller.
  const ask = async (q: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(q);
      if (answer.trim().toLowerCase() === 'exit') {
        log('exit, halting.');
        process.exit(0);
      }
      return answer;
    } finally {
      rl.close();
    }
  };

  // Human-in-the-loop, the ADK-native mirror of LangChain's interruptOn: the
  // agent's beforeToolCallback routes the two USDC-spending tools through this
  // approval prompt; every other tool runs without a pause.
  const approve: ApprovalFn = async (toolName, args) => {
    log(yellow(`approval required for tool: ${bold(toolName)}`));
    console.log(colorizeJson(args));
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
        console.log(`\n${heading('--- agent reply ---')}\n`);
        console.log(text);
        console.log(`\n${heading('-------------------')}`);
      }
    }

    const next = (await ask(`\n${bold('You:')}\n> `)).trim();
    if (next.toLowerCase() === 'quit') {
      log('done.');
      break;
    }
    // A blank line is a stray Enter, not an intent to quit: re-prompt without
    // running a turn. `exit` (handled in `ask`) and `quit` still halt.
    input = next ? userMessage(next) : null;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(kitLine(red(`FATAL: ${message}`)));
  process.exit(1);
});
