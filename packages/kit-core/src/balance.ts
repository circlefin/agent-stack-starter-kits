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
 * The pinned USDC balance readout, shared by every kit.
 *
 * Each kit used to carry its own copy of this, all identical, all awaited at the
 * end of a turn. That await is the reason the "Working…" indicator outlived the
 * agent's reply: reading the balance means shelling out to the Circle CLI, and
 * the input only re-enables on the next `ask()`, so the user watched a spinner
 * for a readout they had not asked to wait for.
 *
 * So there are two ways to refresh, and the distinction is the point:
 *   - `refresh()` — awaited, for startup, where the readout should be on screen
 *     before the first prompt.
 *   - `refreshSoon()` — fire-and-forget, for the end of a turn, so the prompt
 *     comes back immediately and the readout catches up a moment later.
 *
 * The readout is also the one place that decides what a logged-out session
 * shows: a figure and an address left pinned above the input after a logout name
 * an account the user is no longer in, so the line is replaced by a notice that
 * says so and says how to get the readout back.
 */
import {
  formatUsdcBalance,
  sessionStatus,
  walletUsdcBalance,
} from '@agent-stack-starter-kits/circle-tools';

import { isKitLoggedIn, setKitLoggedIn } from './session';

/**
 * The pinned line, mirroring `agent-cli`'s `WalletLine` structurally rather than
 * importing it: this package stays headless (no Ink, no React), so the chat UI
 * satisfies this by shape.
 */
export interface BalanceLine {
  text: string;
  tone: 'balance' | 'notice';
}

/** The slice of the chat UI a readout needs; kits pass their `ChatUi`. */
export interface BalanceTarget {
  setBalance(line: BalanceLine | null): void;
}

/**
 * What the line says once the session is gone.
 *
 * It names the fix, because the kit has no `/login` command to point at: the
 * startup gate is behind us, so logging back in mid-session means asking the
 * agent, which runs the two-step `--init` login and reads the OTP back.
 */
const LOGGED_OUT_NOTICE: BalanceLine = {
  text: 'You are logged out — ask the agent to log you in to see your balance here.',
  tone: 'notice',
};

export interface BalanceReadout {
  /** Update the readout and resolve once it is current. */
  refresh(): Promise<void>;
  /**
   * Start an update and return immediately, so a caller never makes the user
   * wait on it. Concurrent calls collapse: a refresh already in flight is
   * followed by exactly one more, never a queue of them.
   */
  refreshSoon(): void;
}

/**
 * Build a readout bound to a chat UI.
 *
 * `target` is read lazily (via a getter) because the kits create their UI inside
 * `main()`, after this is constructed at module scope — and because the readout
 * must simply do nothing before the UI exists, rather than crash.
 */
export function createBalanceReadout(
  target: () => BalanceTarget | null | undefined,
): BalanceReadout {
  let inFlight: Promise<void> | null = null;
  let repeat = false;

  /**
   * Ask the CLI whether a session is live, and record the answer so the rest of
   * the kit (the approval prompt's login label) agrees with the readout.
   *
   * One `wallet status` spawn, and only on the two paths that already cost more
   * than that or are about to show something wrong. When the check itself fails
   * there is nothing better to go on than what we already believed, so it says
   * so — which keeps a network blip from blanking a good readout.
   */
  const sessionLive = async (): Promise<boolean> => {
    try {
      const { loggedIn } = await sessionStatus();
      setKitLoggedIn(loggedIn);
      return loggedIn;
    } catch {
      return isKitLoggedIn();
    }
  };

  // Best-effort by contract: a balance read must never break the session (no
  // wallet yet, an RPC blip), so a failure leaves the last shown value in place
  // rather than propagating. The exception is a session that has gone: there the
  // last shown value is exactly what must not stay on screen.
  const update = async (): Promise<void> => {
    // The in-process flag only sees logins and logouts the agent typed, so a
    // `false` is confirmed rather than trusted — that also picks up a login done
    // in another terminal, and costs one status call in place of a balance read.
    if (!isKitLoggedIn() && !(await sessionLive())) {
      target()?.setBalance(LOGGED_OUT_NOTICE);
      return;
    }
    try {
      const summary = await walletUsdcBalance();
      // Null, not a notice, when there is simply no wallet yet: that is a
      // first-run state the agent is about to fix, not something to warn about.
      target()?.setBalance(summary ? { text: formatUsdcBalance(summary), tone: 'balance' } : null);
    } catch {
      // A read fails for reasons that mostly have nothing to do with the session
      // — so ask, and replace the line only when the session really is gone (an
      // expiry, or a logout done outside this process).
      if (!(await sessionLive())) target()?.setBalance(LOGGED_OUT_NOTICE);
    }
  };

  const run = (): Promise<void> => {
    if (inFlight) {
      repeat = true;
      return inFlight;
    }
    inFlight = (async () => {
      await update();
      // Collapse everything that arrived mid-flight into one trailing pass, so
      // the readout still ends up current without one refresh per caller.
      while (repeat) {
        repeat = false;
        await update();
      }
      inFlight = null;
    })();
    return inFlight;
  };

  return {
    refresh: run,
    refreshSoon: () => {
      // `update` swallows its own failures, so there is no rejection to handle;
      // `void` documents that the result is deliberately not awaited.
      void run();
    },
  };
}
