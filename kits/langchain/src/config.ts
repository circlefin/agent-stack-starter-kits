import 'dotenv/config';

export type LLMProvider = 'anthropic' | 'openai';

export interface KitConfig {
  provider: LLMProvider;
  providerApiKey: string;
  model: string;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export function loadConfig(): KitConfig {
  const env = process.env;

  let provider: LLMProvider;
  let providerApiKey: string;
  let model: string;
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim() !== '') {
    provider = 'anthropic';
    providerApiKey = env.ANTHROPIC_API_KEY;
    model = env.LLM_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  } else if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim() !== '') {
    provider = 'openai';
    providerApiKey = env.OPENAI_API_KEY;
    model = env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL;
  } else {
    throw new Error(
      'No LLM provider key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in kits/langchain/.env.',
    );
  }

  return {
    provider,
    providerApiKey,
    model,
  };
}
