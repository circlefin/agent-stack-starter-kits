import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { runCircle } from '@agent-stack-ecosystem-kits/circle-tools';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { withRetry } from './retry';

const PROMPT =
  'Run curl -sL https://agents.circle.com/skills/setup.md, and use the returned setup instructions to set up my agent wallet.';

const authStep = createStep({
  id: 'auth',
  inputSchema: z.object({}),
  outputSchema: z.object({ authenticated: z.literal(true) }),
  suspendSchema: z.object({
    type: z.enum(['terms', 'email', 'otp']),
    prompt: z.string(),
  }),
  resumeSchema: z.object({ value: z.string() }),
  execute: async ({ suspend, resumeData }) => {
    // Check wallet status
    let status: string;
    try {
      status = runCircle(['wallet', 'status']);
    } catch (err) {
      status = err instanceof Error ? err.message : String(err);
    }

    // Handle terms acceptance
    if (status.includes('Terms acceptance is required')) {
      const termsResume = await suspend({
        type: 'terms',
        prompt:
          'Please review and accept the Circle Terms of Use (https://agents.circle.com/terms-of-use) and Privacy Policy (https://www.circle.com/legal/privacy-policy). Type "yes" to accept.',
      });
      const termsAnswer = (termsResume as { value: string } | undefined)?.value ?? '';
      if (termsAnswer.toLowerCase() !== 'yes') {
        throw new Error('Terms of Use must be accepted to continue.');
      }
      runCircle(['terms', 'accept']);

      // Re-check status after accepting terms
      try {
        status = runCircle(['wallet', 'status']);
      } catch (err) {
        status = err instanceof Error ? err.message : String(err);
      }
    }

    // Handle authentication
    if (status.includes('Not logged in') || status.includes('AUTH_REQUIRED')) {
      const emailResume = await suspend({
        type: 'email',
        prompt: 'Please enter your email address to log in to Circle:',
      });
      const email = ((emailResume as { value: string } | undefined)?.value ?? '').trim();

      const loginInitOutput = runCircle(['wallet', 'login', email, '--init']);
      const requestIdMatch = loginInitOutput.match(/--request\s+([a-f0-9-]+)/);
      const requestId = requestIdMatch?.[1] ?? '';

      const otpResume = await suspend({
        type: 'otp',
        prompt: 'Please enter the OTP code sent to your email:',
      });
      const otp = ((otpResume as { value: string } | undefined)?.value ?? '').trim();

      runCircle(['wallet', 'login', '--request', requestId, '--otp', otp]);
    }

    return { authenticated: true as const };
  },
});

const agentStep = createStep({
  id: 'agent',
  inputSchema: z.object({ authenticated: z.literal(true) }),
  outputSchema: z.object({ summary: z.string() }),
  execute: async () => {
    const config = loadConfig();
    const noInteractiveAsk = async (): Promise<string> => {
      throw new Error('No interactive terminal available in this workflow step.');
    };
    const agent = buildAgent(config, noInteractiveAsk);
    const result = await withRetry(() => agent.generate(PROMPT, { maxSteps: 30 }), 'agent');
    return { summary: result.text ?? '(no output)' };
  },
});

export const onboardingWorkflow = createWorkflow({
  id: 'circle-onboarding',
  inputSchema: z.object({}),
  outputSchema: z.object({ summary: z.string() }),
})
  .then(authStep)
  .then(agentStep)
  .commit();
