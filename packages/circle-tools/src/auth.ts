import { CircleCliError, runCircle } from './cli';

/**
 * Framework-agnostic Circle CLI session handling: status checks, the two-step
 * email + OTP login, and logout. Shared by every kit so the login flow (and its
 * fixes) live in one place instead of being copy-pasted per kit.
 *
 * The kit owns ONE auth step itself, email + OTP login, because the human types
 * their own email and OTP and nothing is stored by the kit. It never touches the
 * Terms of Use: per setup.md an agent must not accept the Terms on a user's
 * behalf, so a pending-Terms host is reported as an actionable manual step
 * instead of being auto-accepted.
 */

export const TERMS_MESSAGE =
  'Circle Terms of Use are not accepted on this host. Per setup.md, an agent must ' +
  'never accept the Terms on your behalf, so this kit will not do it for you. Run:\n\n' +
  '  circle wallet status\n\n' +
  'yourself, review and accept the Terms of Use when prompted, then re-run the demo.';

/** Terminal I/O the login flow drives. `ask` prompts the human (and is expected
 * to handle "exit"); `log` writes a namespaced status line; `bold` styles a
 * prompt label and defaults to identity for non-TTY callers. */
export interface InteractiveIo {
  ask: (q: string) => Promise<string>;
  log: (line: string) => void;
  bold?: (s: string) => string;
}

export interface SessionResult {
  /** `already-valid` when a session existed; `logged-in` after a fresh login. */
  status: 'already-valid' | 'logged-in';
}

/** Flatten a CLI error into the full text the CLI emitted, for substring checks. */
function rawText(e: unknown): string {
  if (e instanceof CircleCliError) {
    return [e.message, e.stdout, e.stderr].filter(Boolean).join('\n');
  }
  return e instanceof Error ? e.message : String(e);
}

/** `circle wallet status` exits non-zero when logged out; capture either way. */
function statusText(): string {
  try {
    return runCircle(['wallet', 'status']);
  } catch (e) {
    return rawText(e);
  }
}

/** An active session prints "Status:   VALID". */
function isLoggedIn(status: string): boolean {
  return /status:\s*valid/i.test(status);
}

/** Detect a pending Terms-of-Use gate in any CLI output. */
function termsPending(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('terms') && (lower.includes('accept') || lower.includes('required'));
}

/**
 * Pull the login request ID out of `circle wallet login <email> --init` output.
 * Prefers a JSON field; falls back to the `--request <id>` example line the CLI
 * prints, then to a bare UUID.
 */
function parseRequestId(out: string): string | undefined {
  const trimmed = out.trim();
  try {
    const env = JSON.parse(trimmed) as Record<string, unknown> & { data?: Record<string, unknown> };
    const data = (env.data ?? env) as Record<string, unknown>;
    const id = data.requestId ?? data.request_id ?? data.id;
    if (typeof id === 'string' && id) return id;
  } catch {
    // not JSON, so fall through to text extraction
  }
  return (
    trimmed.match(/--request\s+([0-9a-f-]{8,})/i)?.[1] ??
    trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
  );
}

/** Snapshot of the current CLI session, for callers that want to branch on it. */
export function sessionStatus(): { loggedIn: boolean; termsPending: boolean; raw: string } {
  const raw = statusText();
  return { loggedIn: isLoggedIn(raw), termsPending: termsPending(raw), raw };
}

/**
 * Run the two-step email + OTP login interactively, re-prompting on bad input
 * instead of crashing, with no attempt cap. The user always exits by typing
 * "exit" at any prompt (the `ask` wrapper intercepts it). Only a Terms gate or
 * an empty entry ends it with a thrown error the caller can surface.
 *
 * Each loop is one full attempt: a fresh `--init` (which emails a new code) plus
 * one OTP submission. A Circle login request is SINGLE-USE: one wrong code burns
 * the request ID, after which even the correct code returns "Invalid or expired
 * request ID". So a rejected OTP cannot be retried against the same request; it
 * must re-init for a new code. A mistyped email (CLI 400) likewise loops back.
 */
async function runEmailOtpLogin(io: Required<InteractiveIo>): Promise<void> {
  const { ask, log, bold } = io;
  for (;;) {
    const email = (await ask(`${bold('Circle account email:')}\n> `)).trim();
    if (!email) throw new Error('No email entered, cannot log in.');

    let initOut: string;
    try {
      initOut = runCircle(['wallet', 'login', email, '--type', 'agent', '--init']);
    } catch (e) {
      const text = rawText(e);
      if (termsPending(text)) throw new Error(TERMS_MESSAGE);
      log(`login init failed: ${text}`);
      log('check the address and re-enter it; type "exit" to quit');
      continue;
    }

    // Show the CLI's own output so the user can match the anti-phishing prefix
    // it prints against the code in the OTP email before entering it.
    console.log(initOut.trim());

    const requestId = parseRequestId(initOut);
    if (!requestId) {
      log('could not read a login request ID from the CLI output; requesting a new code');
      continue;
    }

    const otp = (
      await ask(`${bold('OTP from the email (6 digits, or full e.g. B1X-123456):')}\n> `)
    ).trim();
    if (!otp) throw new Error('No OTP entered, cannot complete login.');

    let otpOut = '';
    try {
      otpOut = runCircle(['wallet', 'login', '--request', requestId, '--otp', otp]);
    } catch (e) {
      const text = rawText(e);
      if (termsPending(text)) throw new Error(TERMS_MESSAGE);
      log(`OTP rejected: ${text}`);
      // The request is now spent regardless of why it failed, so request a fresh
      // code rather than retrying this dead request with the same (or correct) OTP.
      log('a Circle login code can only be tried once, so a new code is being sent; type "exit" to quit');
      continue;
    }
    // Surface any stdout from the OTP command — it may contain a Terms-of-Use
    // prompt that exited 0 without storing a session when stdin was not a TTY.
    if (otpOut.trim()) console.log(otpOut.trim());
    if (termsPending(otpOut)) throw new Error(TERMS_MESSAGE);

    // The Circle backend may take a moment to activate the session after the OTP
    // command exits. Retry the status check up to 3 times with a 1-second delay
    // so transient timing issues or brief network blips don't surface as a fatal error.
    let lastStatus = '';
    let sessionOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      lastStatus = statusText();
      if (isLoggedIn(lastStatus)) { sessionOk = true; break; }
    }
    if (!sessionOk) {
      // On Linux the Circle CLI stores credentials via secret-tool (libsecret).
      // If secret-tool is missing the session is lost on every login, leaving
      // only the previous EXPIRED entry. Fix: sudo apt-get install libsecret-tools
      const hint = process.platform === 'linux'
        ? ' On Linux, install libsecret-tools (sudo apt-get install libsecret-tools) and ensure a keyring daemon (gnome-keyring-daemon) is running.'
        : '';
      throw new Error(
        `Login completed but no valid session was produced (status: ${lastStatus.trim()}).${hint} Re-run the demo.`,
      );
    }
    log('logged in, Circle session valid');
    return;
  }
}

/** Fill in optional I/O fields with safe defaults (identity `bold`). */
function withDefaults(io: InteractiveIo): Required<InteractiveIo> {
  return { ask: io.ask, log: io.log, bold: io.bold ?? ((s) => s) };
}

/**
 * Ensure the Circle CLI has a valid agent session.
 *
 * - Already logged in -> returns `{ status: 'already-valid' }` immediately.
 * - Terms not accepted -> throws TERMS_MESSAGE (never auto-accepts).
 * - Logged out -> runs the two-step email OTP login inline, prompting via `ask`,
 *   re-prompting on bad input, and returns `{ status: 'logged-in' }`.
 *
 * Used both as the demo's startup gate and by the in-agent login tool, so a
 * mid-session call short-circuits when the user already logged in elsewhere.
 */
export async function ensureSession(io: InteractiveIo): Promise<SessionResult> {
  const ready = withDefaults(io);
  const status = statusText();
  if (isLoggedIn(status)) {
    ready.log('Circle session valid, skipping login');
    return { status: 'already-valid' };
  }
  if (termsPending(status)) {
    throw new Error(TERMS_MESSAGE);
  }

  ready.log('no active Circle session, starting email OTP login');
  await runEmailOtpLogin(ready);
  return { status: 'logged-in' };
}

/**
 * Clear the stored agent credentials (`circle wallet logout`). Idempotent from
 * the caller's view: when there is no active session the CLI reports it and this
 * returns without error so a logout tool never crashes the demo.
 */
export function logout(log?: (line: string) => void): void {
  if (!sessionStatus().loggedIn) {
    log?.('no active Circle session, nothing to log out of');
    return;
  }
  runCircle(['wallet', 'logout', '--type', 'agent']);
  log?.('logged out, Circle session cleared');
}
