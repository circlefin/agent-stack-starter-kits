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

/** The LLM providers this kit can drive. Single-provider, hence one member. */
export type LLMProvider = 'openai';

/** The shape every kit's config resolves to: who serves the model, the key that
 * authenticates it, and which model to ask for. */
export interface KitConfig {
  provider: LLMProvider;
  providerApiKey: string;
  /** OpenAI model name. Override via LLM_MODEL env var. */
  model: string;
}

const DEFAULT_MODEL = 'gpt-5.6-sol';

/**
 * Resolve the kit's runtime config.
 *
 * This kit uses the OpenAI Agents SDK, which only supports OpenAI-compatible
 * models. LLM_MODEL overrides the default model (e.g. "gpt-5.4"). For a
 * multi-provider kit, see the langchain or vercel-ai kits instead. The Circle
 * side authenticates through the CLI, so there is no Circle key here.
 *
 * There is no chain setting. The `circle` CLI settles each payment on a chain
 * the seller and the wallet have in common, so a kit-level chain would only be
 * a label that lies when they disagree.
 */
export function loadConfig(): KitConfig {
  const env = process.env;
  const key = env.OPENAI_API_KEY?.trim();

  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is not set. This kit uses the OpenAI Agents SDK, which only ' +
        'supports OpenAI-compatible models. Add OPENAI_API_KEY to your .env (see ' +
        '.env.example) and re-run. For Anthropic model support, use the langchain ' +
        'or claude-agent-sdk kit instead.',
    );
  }

  return {
    provider: 'openai',
    providerApiKey: key,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  };
}
