import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { createChatUi, type ChatUi } from '@agent-stack-ecosystem-kits/agent-cli';
import {
  ensureSession,
  formatUsdcBalance,
  walletUsdcBalance,
} from '@agent-stack-ecosystem-kits/circle-tools';
import { onboardingWorkflow } from './workflow';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { withRetry } from './retry';
import { bold, kitLine } from './theme';

const INITIAL_PROMPT =
  'Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[mastra-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (agent output) verbatim. */
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
  log(`chain=${config.chain} provider=${config.provider} model=${config.model}`);

  await ensureSession({ ask, log, bold });
  await refreshBalance();

  chat.setStatus('working…');
  const run = await onboardingWorkflow.createRun();
  let result = await run.start({ inputData: {} });

  while (result.status === 'suspended') {
    const suspendedEntry = Object.entries(result.steps).find(([, s]) => s.status === 'suspended');
    if (!suspendedEntry) break;
    const [stepId, stepResult] = suspendedEntry;
    const payload = (stepResult as any).suspendPayload as { prompt: string } | undefined;
    if (!payload?.prompt) break;
    chat.setStatus(null);
    const value = await ask(`\n${payload.prompt}\n> `);
    chat.setStatus('working…');
    result = await run.resume({ step: stepId, resumeData: { value } });
  }
  chat.setStatus(null);

  if (result.status !== 'success') {
    out(`[mastra-kit] workflow ended with status: ${result.status}`);
    chat.close();
    return;
  }

  const summary: string =
    (result as any).result?.summary ??
    (result as any).steps?.agent?.output?.summary ??
    '(no output)';
  out(summary);
  await refreshBalance();

  log('continue the conversation — type "exit" to quit');
  const agent = buildAgent(config, ask);
  const messages: Array<{ role: 'user'; content: string } | { role: 'assistant'; content: string }> = [
    { role: 'user', content: INITIAL_PROMPT },
    { role: 'assistant', content: summary },
  ];

  while (true) {
    const input = await ask('> ');
    if (input.toLowerCase() === 'exit') break;
    // A blank line is a stray Enter, not an intent to quit: re-prompt.
    if (!input) continue;
    messages.push({ role: 'user', content: input });
    chat.setStatus('working…');
    const response = await withRetry(() => agent.generate(messages, { maxSteps: 30 }), 'agent');
    chat.setStatus(null);
    await refreshBalance();
    const text = response.text ?? '(no output)';
    out('\n' + text + '\n');
    messages.push({ role: 'assistant', content: text });
  }

  log('onboarding complete');
  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print.
  ui?.close();
  console.error('[mastra-kit] fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
