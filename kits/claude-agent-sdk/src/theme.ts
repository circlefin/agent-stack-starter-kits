/**
 * Terminal colors for the demo's output, the same idea as code syntax
 * highlighting: distinguish categories by color so a dense run is scannable.
 *
 * Dependency-free ANSI. Colors switch off automatically when stdout is not a
 * TTY (piped/redirected) or when NO_COLOR is set, so logs stay plain text in
 * files and CI. https://no-color.org/
 */

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/**
 * Build a styler from an SGR open code and its specific close code. Specific
 * closes (39 for foreground, 22 for bold/dim, 23 for italic) instead of a full
 * reset let stylers nest without one closing tag cancelling another, e.g.
 * cyan("a" + bold("b") + "c") keeps "c" cyan.
 */
function sgr(open: number, close: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const blue = sgr(34, 39);
export const magenta = sgr(35, 39);
export const cyan = sgr(36, 39);
export const gray = sgr(90, 39);

/**
 * Pretty-print a value as syntax-highlighted JSON: keys, strings, numbers,
 * booleans and null each get their own color. Accepts a value or an
 * already-encoded JSON string; non-JSON strings are returned untouched.
 */
export function colorizeJson(value: unknown, indent = 2): string {
  let json: string;
  if (typeof value === 'string') {
    try {
      json = JSON.stringify(JSON.parse(value), null, indent);
    } catch {
      return value;
    }
  } else {
    json = JSON.stringify(value, null, indent);
  }
  if (json === undefined) return String(value);
  if (!enabled) return json;

  return json.replace(
    /("(?:\\.|[^\\"])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (full, str, colon, bool, nul, num) => {
      if (str !== undefined) return colon !== undefined ? cyan(str) + colon : green(str);
      if (bool !== undefined) return yellow(bool);
      if (nul !== undefined) return gray(nul);
      if (num !== undefined) return magenta(num);
      return full;
    },
  );
}

/**
 * Colorize one `[tool]` log line. The tool name is bold; key=value args have
 * muted keys; a `←` result is dim green; a `✗` error is red, and a JSON blob
 * tacked onto an error (e.g. a service's raw error body) is highlighted as JSON
 * instead of drowned in red.
 */
export function toolLine(line: string): string {
  const prefix = dim(cyan('[tool]'));
  const m = /^(\S+)([\s\S]*)$/.exec(line);
  if (!m) return `${prefix} ${line}`;
  const name = bold(m[1] ?? '');
  const rest = m[2] ?? '';

  const fail = rest.indexOf('✗');
  if (fail >= 0) {
    const before = rest.slice(0, fail);
    const after = rest.slice(fail + 1);
    const jsonAt = after.search(/[{[]/);
    if (jsonAt >= 0) {
      const head = after.slice(0, jsonAt);
      const blob = after.slice(jsonAt).trim();
      try {
        JSON.parse(blob);
        return `${prefix} ${name}${before}${red('✗')}${red(head)}\n${colorizeJson(blob)}`;
      } catch {
        // not a JSON blob, fall through to plain red
      }
    }
    return `${prefix} ${name}${before}${red('✗')}${red(after)}`;
  }

  const hit = rest.indexOf('←');
  if (hit >= 0) {
    const before = rest.slice(0, hit);
    const after = rest.slice(hit + 1);
    return `${prefix} ${name}${before}${green('←')}${dim(after)}`;
  }

  return `${prefix} ${name}${rest.replace(/(\b\w+)=/g, (_w, k) => `${gray(k)}=`)}`;
}

/** Colorize one `[claude-agent-sdk-kit]` framework log line. */
export function kitLine(line: string): string {
  return `${dim(magenta('[claude-agent-sdk-kit]'))} ${line}`;
}

/** A heading rule, e.g. the agent-reply separator. */
export function heading(label: string): string {
  return bold(cyan(label));
}
