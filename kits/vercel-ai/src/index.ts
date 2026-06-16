import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import type { CoreMessage } from 'ai';

import { ensureSession } from '@agent-stack-ecosystem-kits/circle-tools';
import { loadConfig, type KitConfig } from './config';
import { runTurn } from './agent';
import { buildTools, type CircleTools } from './tools';
import { withRetry } from './retry';
import { SETUP_SKILL_URL } from './skill';
import { bold, dim, kitLine, red, yellow } from './theme';

function log(line: string): void {
  console.log(kitLine(line));
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
  log('Autonomous Payment Agent demo starting');
  const config = loadConfig();
  log(`chain=${config.chain} provider=${config.provider} model=${config.model}`);
  log(dim('tip: type "exit" at any prompt to quit'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Shared `ask` that routes all prompts through the readline and supports the
  // "exit" escape hatch at any point (auth, approval, follow-up chat).
  const ask = async (question: string): Promise<string> => {
    const answer = await rl.question(question);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      rl.close();
      process.exit(0);
    }
    return answer;
  };

  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    // Check the Circle CLI session before running the agent. Logs in with email
    // + OTP if needed; never auto-accepts Circle Terms of Use.
    await ensureSession({ ask, log, bold });

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
    const { responseMessages } = await runAgentTurn(config, messages, tools);
    messages = [...messages, ...responseMessages];

    // ── REPL ──────────────────────────────────────────────────────────────────
    // After the bootstrap turn the demo drops into an interactive REPL.
    // Each turn keeps full conversation context: messages grows, and the same
    // `tools` object (with the same `ask` closure) is reused.
    log('bootstrap complete — continue the conversation or type "exit" to quit');

    while (true) {
      const input = (await ask(`\n${bold('You:')}\n> `)).trim();
      if (!input || input.toLowerCase() === 'quit') {
        log('done.');
        break;
      }
      messages.push({ role: 'user', content: input });

      const { responseMessages: nextMessages } = await runAgentTurn(config, messages, tools);
      messages = [...messages, ...nextMessages];
    }
  } catch (err: unknown) {
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
    rl.close();
  }
}

main();
