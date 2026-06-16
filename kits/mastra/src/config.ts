import 'dotenv/config';

export type LLMProvider = 'anthropic' | 'openai';

export interface KitConfig {
  chain: string;
  provider: LLMProvider;
  /** Full Mastra model string, e.g. "anthropic/claude-sonnet-4-6" or "openai/gpt-4.1". */
  model: string;
}

const DEFAULT_ANTHROPIC_MODEL = 'anthropic/claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'openai/gpt-4.1';

/**
 * Load kit configuration from environment variables.
 *
 * Provider selection: whichever API key is set wins. ANTHROPIC_API_KEY is
 * checked first; if absent, OPENAI_API_KEY is used. Set LLM_MODEL to override
 * the default model (include the provider prefix, e.g. "anthropic/claude-opus-4-7").
 */
export function loadConfig(): KitConfig {
  const chain = process.env['CIRCLE_CHAIN'] ?? 'BASE';
  const env = process.env;

  if (env['ANTHROPIC_API_KEY']?.trim()) {
    return {
      chain,
      provider: 'anthropic',
      model: env['LLM_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL,
    };
  }

  if (env['OPENAI_API_KEY']?.trim()) {
    return {
      chain,
      provider: 'openai',
      model: env['LLM_MODEL'] ?? DEFAULT_OPENAI_MODEL,
    };
  }

  throw new Error(
    'No LLM provider key found. Set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY in kits/mastra/.env.',
  );
}
