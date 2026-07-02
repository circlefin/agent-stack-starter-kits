import 'dotenv/config';
import type { CoreMessage } from 'ai';

import { createChatUi, type ChatUi } from '@agent-stack-ecosystem-kits/agent-cli';
import {
  ensureSession,
  formatUsdcBalance,
  walletUsdcBalance,
} from '@agent-stack-ecosystem-kits/circle-tools';
import { loadConfig, type KitConfig } from './config';
import { runTurn } from './agent';
import { buildTools, type CircleTools } from './tools';
import { withRetry } from './retry';
import { SETUP_SKILL_URL } from './skill';
import { bold, dim, kitLine, red, yellow } from './theme';

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
  try {
    return await withRetry(() => runTurn(config, messages, tools), config.provider);
  } catch (primaryErr) {
    if (!config.fallback) throw primaryErr;
    log(yellow(`${config.provider} failed — falling back to ${config.fallback.provider} (${config.fallback.model}) …`));
    return await withRetry(
      () => runTurn(config.fallback!, messages, tools),
      config.fallback.provider,
    );
  }
}

async function main(): Promise<void> {
  // Pin the input to the bottom (Claude Code-style) while logs scroll above.
  // Falls back to plain console + readline when stdout/stdin is not a TTY.
  const chat = createChatUi({ title: bold('Autonomous Payment Agent') });
  ui = chat;

  // Shared `ask` that routes every prompt through the pinned input box and
  // supports the "exit" escape hatch at any point (auth, approval, follow-up).
  const ask = async (question: string): Promise<string> => {
    const answer = await chat.ask(question);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      chat.close();
      process.exit(0);
    }
    return answer;
  };

  try {
    log('Autonomous Payment Agent demo starting');
    const config = loadConfig();
    log(`chain=${config.chain} provider=${config.provider} model=${config.model}`);
    log(dim('tip: type "exit" at any prompt to quit'));

    // ── Auth ─────────────────────────────────────────────────────────────────
    // Check the Circle CLI session before running the agent. Logs in with email
    // + OTP if needed; never auto-accepts Circle Terms of Use.
    await ensureSession({ ask, log, bold });
    await refreshBalance();

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    // The first turn is driven by the Circle setup skill, not a system prompt.
    const bootstrapPrompt =
      `Run curl -sL ${SETUP_SKILL_URL}, ` +
      'and use the returned setup instructions to set up my agent wallet.';

    // Conversation history — the running CoreMessage[] that grows each turn.
    // Vercel AI SDK's `generateText` is stateless: we own the history and pass
    // it back on every call. `result.response.messages` gives us all the
    // assistant + tool-result messages the SDK generated so we can append them.
    let messages: CoreMessage[] = [{ role: 'user', content: bootstrapPrompt }];

    // Build the tool set — `ask` is passed in so the two spend tools can pause
    // and prompt for human approval before touching USDC. This is the Vercel AI
    // SDK pattern: approval lives inside the tool, not in an external hook.
    const tools = buildTools(ask);

    log('invoking agent ...');
    chat.setStatus('working…');
    const { responseMessages } = await runAgentTurn(config, messages, tools);
    chat.setStatus(null);
    await refreshBalance();
    messages = [...messages, ...responseMessages];

    // ── REPL ──────────────────────────────────────────────────────────────────
    // After the bootstrap turn the demo drops into an interactive REPL.
    // Each turn keeps full conversation context: messages grows, and the same
    // `tools` object (with the same `ask` closure) is reused.
    log('bootstrap complete — continue the conversation or type "exit" to quit');

    while (true) {
      const input = (await ask('> ')).trim();
      if (input.toLowerCase() === 'quit') {
        log('done.');
        break;
      }
      // A blank line is a stray Enter, not an intent to quit: re-prompt.
      // `exit` (handled in `ask`) and `quit` still halt.
      if (!input) continue;
      messages.push({ role: 'user', content: input });

      chat.setStatus('working…');
      const { responseMessages: nextMessages } = await runAgentTurn(config, messages, tools);
      chat.setStatus(null);
      await refreshBalance();
      messages = [...messages, ...nextMessages];
    }
  } catch (err: unknown) {
    // Tear down the UI first so the console is restored before we print the
    // failure; otherwise these lines would be swallowed by the Ink frame.
    chat.close();
    const message = err instanceof Error ? err.message : String(err);
    const overloaded =
      (err as { status?: number })?.status === 529 || message.includes('529');
    if (overloaded) {
      console.error(
        kitLine(red('FATAL: the LLM provider is overloaded (HTTP 529) and retries were exhausted.')),
      );
      console.error(kitLine(yellow('This is transient on the provider side. Re-run in a moment.')));
    } else {
      console.error(kitLine(red(`FATAL: ${message}`)));
    }
    process.exitCode = 1;
  } finally {
    // Idempotent: a no-op if the catch above (or the exit path) already closed it.
    chat.close();
  }
}

main();
