import 'dotenv/config';

export interface KitConfig {
  chain: string;
  openaiApiKey: string;
  /** OpenAI model name. Override via LLM_MODEL env var. */
  model: string;
}

const DEFAULT_MODEL = 'gpt-4.1';

/**
 * Load kit configuration from environment variables.
 *
 * This kit uses the OpenAI Agents SDK, which only supports OpenAI-compatible
 * models. Set LLM_MODEL to switch between models (e.g. "gpt-4o", "gpt-4o-mini").
 * For a multi-provider kit, see the langchain or claude-agent-sdk kits instead.
 */
export function loadConfig(): KitConfig {
  const chain = process.env['CIRCLE_CHAIN'] ?? 'BASE';
  const openaiApiKey = process.env['OPENAI_API_KEY']?.trim();

  if (!openaiApiKey) {
    throw new Error(
      'OPENAI_API_KEY is required. Set it in kits/openai-agents/.env.\n' +
        'This kit uses the OpenAI Agents SDK and only supports OpenAI-compatible models.\n' +
        'For Anthropic model support, use the langchain or claude-agent-sdk kit instead.',
    );
  }

  return {
    chain,
    openaiApiKey,
    model: process.env['LLM_MODEL'] ?? DEFAULT_MODEL,
  };
}
