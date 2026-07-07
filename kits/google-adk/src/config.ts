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
