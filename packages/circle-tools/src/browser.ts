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
