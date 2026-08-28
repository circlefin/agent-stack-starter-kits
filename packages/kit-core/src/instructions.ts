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

/**
 * Everything the kits tell the agent, which is deliberately almost nothing.
 *
 * There is no playbook here: not a word about how wallets work, what x402 is,
 * which chain to settle on, or when to check a balance. All of that is Circle's
 * to say, and it says it in the skills the agent installs — publishing a change
 * to those documents changes every kit's behaviour without a release, which is
 * the point of reading them off disk rather than baking them in.
 *
 * What is left is the part no skill can supply: a line of identity, and how to
 * hold a terminal. An editor hands a model a page of the latter for free; a bare
 * agent has to be given it, and without it re-runs a malformed command against
 * an error that already named the missing flag.
 */
import { formatSkillsIndex, listSkills, SKILLS_DIR } from './skills';

export const SETUP_SKILL_URL = 'https://agents.circle.com/skills/setup.md';

/**
 * The one prompt the kits put in front of the agent when the machine has no
 * skills yet, quoted from the marketplace's own setup copy. Everything the agent
 * does from there is driven by the markdown this fetches.
 */
export const BOOTSTRAP_PROMPT =
  `Run curl -sL ${SETUP_SKILL_URL}, ` +
  'and use the returned setup instructions to set up my agent wallet.';

/** The first turn once the skills are installed and the wallet is set up. */
const RETURNING_PROMPT =
  'Check the state of my Circle agent wallet — the session, my wallets and their USDC ' +
  'balance — and tell me briefly where I stand and what I can do from here.';

const IDENTITY =
  "You manage the user's Circle USDC wallet by running the `circle` CLI in your shell, and your " +
  'skills tell you how.';

/**
 * How to work a terminal, and nothing about Circle.
 *
 * Each of these is a failure seen in practice rather than a general principle:
 * a model that retries a rejected flag verbatim, one that re-runs a paid call to
 * re-read output it already had, and one that treats the first search hit as the
 * only one.
 */
const OPERATING_RULES = [
  'Read the error before running a command again. The same command failing the same way twice means the command has to change, not repeat — when a flag is rejected, ask the command for its `--help` and fix it.',
  'Large output belongs in a file, not in a second run. Redirect it, then open the part you need with the file tools. Never re-run a command to see output you already fetched — least of all one that costs money.',
  'A list is not its first entry. When a command returns several candidates, look at each before drawing a conclusion about any of them.',
];

const SKILLS_PREAMBLE =
  'These skills are installed on this machine. Each line gives a name, the file that holds it, ' +
  'and what it covers. The description is only a routing hint: when one matches what is being ' +
  'asked, read its file before acting, because the file is where the actual instructions are.';

const NO_SKILLS_PREAMBLE =
  'No skills are installed on this machine yet, so you do not yet know how to do any of this. ' +
  `Install them first: run \`curl -sL ${SETUP_SKILL_URL}\` and follow the setup instructions it ` +
  'returns. They are written for a terminal, which is what you have.\n\n' +
  `Installing puts them under ${SKILLS_DIR}, one directory per skill, each holding a SKILL.md. ` +
  'List that directory once the install finishes and read the SKILL.md that matches what is ' +
  'being asked — this prompt was built before they existed, so it will not list them for you ' +
  'until the next session.';

/**
 * Build the system prompt for a turn.
 *
 * Called per turn rather than once at startup, because the skills section has to
 * be able to change from "none installed" to a full index *within a session* —
 * that transition is the agent's own first run.
 */
export async function buildInstructions(): Promise<string> {
  const skills = await listSkills();
  const rules = OPERATING_RULES.map((rule) => `- ${rule}`).join('\n');
  const section =
    skills.length > 0
      ? `${SKILLS_PREAMBLE}\n\n${formatSkillsIndex(skills)}`
      : NO_SKILLS_PREAMBLE;
  return `${IDENTITY}\n\n${rules}\n\n## Skills\n\n${section}`;
}

/**
 * The message that opens the conversation.
 *
 * On a machine with no skills this is the bootstrap, so the first turn installs
 * them; afterwards it is a status check, so the first turn is worth watching
 * rather than a no-op re-run of a setup that is already done.
 */
export async function buildInitialPrompt(): Promise<string> {
  return (await listSkills()).length > 0 ? RETURNING_PROMPT : BOOTSTRAP_PROMPT;
}
