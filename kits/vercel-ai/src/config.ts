import 'dotenv/config';

export type LLMProvider = 'anthropic' | 'openai';

export interface ProviderConfig {
  provider: LLMProvider;
  model: string;
}

export interface KitConfig extends ProviderConfig {
  chain: string;
  /**
   * If both ANTHROPIC_API_KEY and OPENAI_API_KEY are set, this is populated
   * with the secondary provider so the kit can fall back automatically when
   * the primary hits a quota limit or auth failure.
   */
  fallback?: ProviderConfig;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1';

/**
 * Load kit configuration from environment variables.
 *
 * Provider selection: ANTHROPIC_API_KEY is checked first; if absent,
 * OPENAI_API_KEY is used. When BOTH keys are present the secondary becomes an
 * automatic fallback — if the primary provider returns a quota or auth error
 * the kit retries the same turn with the fallback model.
 *
 * LLM_MODEL overrides the primary model only (no provider prefix needed,
 * e.g. "claude-opus-4-7" or "gpt-4o-mini").
 */
export function loadConfig(): KitConfig {
  const chain = process.env['CIRCLE_CHAIN'] ?? 'BASE';
  const env = process.env;
  const anthropicKey = env['ANTHROPIC_API_KEY']?.trim();
  const openaiKey = env['OPENAI_API_KEY']?.trim();

  if (anthropicKey) {
    return {
      chain,
      provider: 'anthropic',
      model: env['LLM_MODEL'] ?? DEFAULT_ANTHROPIC_MODEL,
      fallback: openaiKey
        ? { provider: 'openai', model: DEFAULT_OPENAI_MODEL }
        : undefined,
    };
  }

  if (openaiKey) {
    return {
      chain,
      provider: 'openai',
      model: env['LLM_MODEL'] ?? DEFAULT_OPENAI_MODEL,
    };
  }

  throw new Error(
    'No LLM provider key found. Set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY in kits/vercel-ai/.env.',
  );
}
