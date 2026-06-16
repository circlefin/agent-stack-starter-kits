import 'dotenv/config';

export interface KitConfig {
  /** Google AI Studio API key used to authenticate Gemini through @google/genai. */
  googleApiKey: string;
  model: string;
}

const DEFAULT_MODEL = 'gemini-3-flash-preview';

/**
 * Resolve the kit's runtime config.
 *
 * Authentication is API-key only against Google AI Studio: @google/genai reads
 * several env-var aliases for the key (GOOGLE_API_KEY, GEMINI_API_KEY, etc.),
 * so the kit fixes on GOOGLE_API_KEY (the variable named in the ADK quickstart)
 * and forwards it explicitly to the Gemini constructor. The Circle side
 * authenticates through the CLI, so there is no Circle key here.
 */
export function loadConfig(): KitConfig {
  const env = process.env;
  const key = env.GOOGLE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'GOOGLE_API_KEY is not set. This kit authenticates Gemini with a Google AI ' +
        'Studio API key. Add GOOGLE_API_KEY to your .env (see .env.example) and ' +
        're-run. Get a key at https://aistudio.google.com/apikey',
    );
  }

  return {
    googleApiKey: key,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  };
}
