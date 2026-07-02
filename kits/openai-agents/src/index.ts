import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { run, user } from '@openai/agents';
import type { Agent, RunResult } from '@openai/agents';
import { ensureSession } from '@agent-stack-ecosystem-kits/circle-tools';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { withRetry } from './retry';
import { bold, kitLine } from './theme';

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
  log(`chain=${config.chain} model=${config.model}`);

  await ensureSession({ ask, log, bold });

  const agent = buildAgent(config, ask);
  const prompt = 'Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.';
  log(`prompt: ${prompt}`);
  log('running agent...');

  let result = await withRetry(() => run(agent, prompt), 'agent');
  result = await resolveInterruptions(result, agent);
  console.log(result.finalOutput ?? '(no output)');

  log('continue the conversation — type "exit" to quit');
  while (true) {
    const input = await ask(`\n${bold('You:')}\n> `);
    if (input.toLowerCase() === 'exit') break;
    // A blank line is a stray Enter, not an intent to quit: re-prompt.
    if (!input) continue;
    result = await withRetry(() => run(agent, [...result.history, user(input)]), 'agent');
    result = await resolveInterruptions(result, agent);
    console.log('\n' + (result.finalOutput ?? '(no output)') + '\n');
  }

  log('onboarding complete');
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

      console.log(`\n[approval required] ${toolName}`);
      console.log(JSON.stringify(toolArgs, null, 2));

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
  console.error('[openai-agents-kit] fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
