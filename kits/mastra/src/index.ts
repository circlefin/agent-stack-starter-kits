import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { ensureSession } from '@agent-stack-ecosystem-kits/circle-tools';
import { onboardingWorkflow } from './workflow';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { withRetry } from './retry';
import { bold, kitLine } from './theme';

const INITIAL_PROMPT =
  'Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.';

function log(line: string): void {
  console.log(kitLine(line));
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function main(): Promise<void> {
  log('starting Circle Agent Stack onboarding demo');
  const config = loadConfig();
  log(`chain=${config.chain} provider=${config.provider} model=${config.model}`);

  await ensureSession({ ask, log, bold });

  const run = await onboardingWorkflow.createRun();
  let result = await run.start({ inputData: {} });

  while (result.status === 'suspended') {
    const suspendedEntry = Object.entries(result.steps).find(([, s]) => s.status === 'suspended');
    if (!suspendedEntry) break;
    const [stepId, stepResult] = suspendedEntry;
    const payload = (stepResult as any).suspendPayload as { prompt: string } | undefined;
    if (!payload?.prompt) break;
    const value = await ask(`\n${payload.prompt}\n> `);
    result = await run.resume({ step: stepId, resumeData: { value } });
  }

  if (result.status !== 'success') {
    console.error(`[mastra-kit] workflow ended with status: ${result.status}`);
    return;
  }

  const summary: string =
    (result as any).result?.summary ??
    (result as any).steps?.agent?.output?.summary ??
    '(no output)';
  console.log(summary);

  log('continue the conversation — type "exit" to quit');
  const agent = buildAgent(config, ask);
  const messages: Array<{ role: 'user'; content: string } | { role: 'assistant'; content: string }> = [
    { role: 'user', content: INITIAL_PROMPT },
    { role: 'assistant', content: summary },
  ];

  while (true) {
    const input = await ask(`\n${bold('You:')}\n> `);
    if (input.toLowerCase() === 'exit') break;
    // A blank line is a stray Enter, not an intent to quit: re-prompt.
    if (!input) continue;
    messages.push({ role: 'user', content: input });
    const response = await withRetry(() => agent.generate(messages, { maxSteps: 30 }), 'agent');
    const text = response.text ?? '(no output)';
    console.log('\n' + text + '\n');
    messages.push({ role: 'assistant', content: text });
  }

  log('onboarding complete');
}

main().catch((err: unknown) => {
  console.error('[mastra-kit] fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
