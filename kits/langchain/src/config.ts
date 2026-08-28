/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';

/** The LLM providers this kit can drive. */
export type LLMProvider = 'anthropic' | 'openai';

/** The shape every kit's config resolves to: who serves the model, the key that
 * authenticates it, and which model to ask for. */
export interface KitConfig {
  provider: LLMProvider;
  providerApiKey: string;
  model: string;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

/**
 * Resolve the kit's runtime config.
 *
 * Provider selection: whichever API key is set wins. ANTHROPIC_API_KEY is
 * checked first; if absent, OPENAI_API_KEY is used. LLM_MODEL overrides the
 * default model for the selected provider (a raw model ID, no provider prefix).
 * The Circle side authenticates through the CLI, so there is no Circle key here.
 *
 * There is no chain setting. The `circle` CLI settles each payment on a chain
 * the seller and the wallet have in common, so a kit-level chain would only be
 * a label that lies when they disagree.
 */
export function loadConfig(): KitConfig {
  const env = process.env;
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();

  if (anthropicKey) {
    return {
      provider: 'anthropic',
      providerApiKey: anthropicKey,
      model: env.LLM_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    };
  }

  if (openaiKey) {
    return {
      provider: 'openai',
      providerApiKey: openaiKey,
      model: env.LLM_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    };
  }

  throw new Error(
    'No LLM provider key found. Set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY in kits/langchain/.env.',
  );
}
