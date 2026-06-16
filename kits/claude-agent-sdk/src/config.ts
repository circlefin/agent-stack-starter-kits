import 'dotenv/config';

export interface KitConfig {
  /** Anthropic API key used to authenticate the Claude Agent SDK. */
  anthropicApiKey: string;
  model: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Resolve the kit's runtime config.
 *
 * Authentication is API-key only, on purpose: a key keeps the spawned Claude
 * Code subprocess fully non-interactive. The subscription/OAuth fallback can
 * leave that subprocess waiting on a login prompt it can never answer (its
 * stdin is an SDK-controlled pipe), which surfaces as an indefinite freeze. A
 * missing or bad key fails loudly here or as a 401 instead. The Circle side
 * authenticates through the CLI, so there is no Circle key here.
 */
export function loadConfig(): KitConfig {
  const env = process.env;
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. This kit authenticates the Claude Agent SDK ' +
        'with an API key only. Add ANTHROPIC_API_KEY to your .env (see .env.example) ' +
        'and re-run. Get a key at https://console.anthropic.com/settings/keys',
    );
  }

  return {
    anthropicApiKey: key,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  };
}
