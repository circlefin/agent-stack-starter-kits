import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { run, user } from '@openai/agents';
import type { Agent, RunResult } from '@openai/agents';
import { createChatUi, type ChatUi } from '@agent-stack-ecosystem-kits/agent-cli';
import {
  ensureSession,
  formatUsdcBalance,
  walletUsdcBalance,
} from '@agent-stack-ecosystem-kits/circle-tools';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { withRetry } from './retry';
import { bold, kitLine } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[openai-agents-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (JSON, agent output) verbatim. */
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

async function ask(question: string): Promise<string> {
  if (ui) return (await ui.ask(question)).trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  // Pin the input to the bottom (Claude Code-style) while logs scroll above.
  // Falls back to plain console + readline when stdout/stdin is not a TTY.
  const chat = createChatUi({ title: bold('Circle Agent Stack onboarding') });
  ui = chat;

  log('starting Circle Agent Stack onboarding demo');
  const config = loadConfig();
  log(`chain=${config.chain} model=${config.model}`);

  await ensureSession({ ask, log, bold });
  await refreshBalance();

  const agent = buildAgent(config, ask);
  const prompt = 'Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.';
  log(`prompt: ${prompt}`);
  log('running agent...');

  chat.setStatus('working…');
  let result = await withRetry(() => run(agent, prompt), 'agent');
  result = await resolveInterruptions(result, agent);
  chat.setStatus(null);
  await refreshBalance();
  out(result.finalOutput ?? '(no output)');

  log('continue the conversation — type "exit" to quit');
  while (true) {
    const input = await ask('> ');
    if (input.toLowerCase() === 'exit') break;
    // A blank line is a stray Enter, not an intent to quit: re-prompt.
    if (!input) continue;
    chat.setStatus('working…');
    result = await withRetry(() => run(agent, [...result.history, user(input)]), 'agent');
    result = await resolveInterruptions(result, agent);
    chat.setStatus(null);
    await refreshBalance();
    out('\n' + (result.finalOutput ?? '(no output)') + '\n');
  }

  log('onboarding complete');
  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

async function resolveInterruptions(
  result: RunResult<any, any>,
  agent: Agent<any, any>,
): Promise<RunResult<any, any>> {
  while (result.interruptions && result.interruptions.length > 0) {
    for (const interruption of result.interruptions) {
      const rawItem = interruption.rawItem as { name?: string; arguments?: string };
      const toolName = rawItem?.name ?? 'unknown';
      const toolArgs = (() => { try { return JSON.parse(rawItem?.arguments ?? '{}'); } catch { return {}; } })();

      out(`\n[approval required] ${toolName}`);
      out(JSON.stringify(toolArgs, null, 2));

      const answer = await ask(`\nAllow ${toolName}? [yes/no]\n> `);
      if (answer.toLowerCase() === 'yes') {
        result.state.approve(interruption);
      } else {
        result.state.reject(interruption, { message: 'User declined.' });
      }
    }
    result = await withRetry(() => run(agent, result.state), 'agent');
  }
  return result;
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print.
  ui?.close();
  console.error('[openai-agents-kit] fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
