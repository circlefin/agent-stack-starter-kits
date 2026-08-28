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
export type LLMProvider = 'anthropic';

/** The shape every kit's config resolves to: who serves the model, the key that
 * authenticates it, and which model to ask for. */
export interface KitConfig {
  provider: LLMProvider;
  providerApiKey: string;
  model: string;
}

const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Resolve the kit's runtime config.
 *
 * Authentication is API-key only, on purpose: a key keeps the spawned Claude
 * Code subprocess fully non-interactive. The subscription/OAuth fallback can
 * leave that subprocess waiting on a login prompt it can never answer (its
 * stdin is an SDK-controlled pipe), which surfaces as an indefinite freeze. A
 * missing or bad key fails loudly here or as a 401 instead. The Circle side
 * authenticates through the CLI, so there is no Circle key here.
 *
 * There is no chain setting. The `circle` CLI settles each payment on a chain
 * the seller and the wallet have in common, so a kit-level chain would only be
 * a label that lies when they disagree.
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
    provider: 'anthropic',
    providerApiKey: key,
    model: env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  };
}
