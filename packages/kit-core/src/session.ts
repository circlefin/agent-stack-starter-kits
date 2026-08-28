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
 * Whether a Circle session is believed to be live right now, shared by every
 * kit and by everything that renders differently when there is no session.
 *
 * A *hint*, not the authority: it is maintained by watching the commands the
 * agent runs (see `tools.ts`), so it cannot see a login or logout that happened
 * in another terminal. Anything that can afford to ask the CLI should treat a
 * `false` here as a reason to check rather than a verdict — which is what the
 * balance readout does, and why it costs nothing on the common path.
 *
 * It starts true because every kit runs its own login gate before the agent
 * takes a turn, so by the time anything reads this there is a session.
 */
import { invalidateWalletPick } from '@agent-stack-starter-kits/circle-tools';

let kitLoggedIn = true;

/** Whether a Circle session is believed to be live. See the caveat above. */
export function isKitLoggedIn(): boolean {
  return kitLoggedIn;
}

/**
 * Record whether a session is live. Called by the shell when it sees a login or
 * logout land, and by the balance readout when it checks with the CLI.
 *
 * Logging out also drops the cached wallet pick, because the next session may
 * belong to a different account and the pick is an address: `circle-tools`
 * clears it for its own `logout()`, but the agent logs out by typing the
 * command, which never goes through that path.
 */
export function setKitLoggedIn(value: boolean): void {
  if (kitLoggedIn && !value) invalidateWalletPick();
  kitLoggedIn = value;
}
