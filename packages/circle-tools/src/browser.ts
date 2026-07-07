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

import { execFile } from 'node:child_process';

/**
 * Best-effort open of a URL in the user's default browser, picking the platform
 * launcher (`open` / `start` / `xdg-open`). Local-run convenience only: on a
 * headless or remote host there is no desktop to open, so this silently no-ops
 * and the caller still has the URL to hand the user.
 *
 * Uses `execFile` (no shell), so a URL with shell metacharacters cannot be
 * interpreted as a command.
 */
export function openInBrowser(url: string): void {
  // Swallow launch errors: the URL the caller already holds is the fallback,
  // so a missing desktop / launcher must never break the surrounding flow.
  const ignore = (): void => {};
  switch (process.platform) {
    case 'darwin':
      execFile('open', [url], ignore);
      break;
    case 'win32':
      // `start` is a cmd builtin, so go via `cmd /c`. The empty "" is start's
      // title argument (otherwise a URL containing spaces is read as the window
      // title). cmd treats & as a command separator, so escape it or a Transak
      // URL's query string (?apiKey=…&sessionId=…) gets truncated.
      execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], ignore);
      break;
    default:
      execFile('xdg-open', [url], ignore); // Linux, BSD, other X/Wayland desktops
      break;
  }
}
