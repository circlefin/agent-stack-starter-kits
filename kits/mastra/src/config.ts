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
