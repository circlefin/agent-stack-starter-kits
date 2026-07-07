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
