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
