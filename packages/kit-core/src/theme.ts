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
 * Terminal colors for the demos' output, the same idea as code syntax
 * highlighting: distinguish categories by color so a dense run is scannable.
 *
 * Dependency-free ANSI. Colors switch off automatically when stdout is not a
 * TTY (piped/redirected) or when NO_COLOR is set, so logs stay plain text in
 * files and CI. https://no-color.org/
 */

const enabled = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];

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

/**
 * Bounds on what a tool block *shows*.
 *
 * Deliberately unrelated to `MAX_SHELL_OUTPUT_CHARS` in `./shell`, which bounds
 * what the *model* reads (30k). A transcript a person is watching wants far
 * less: one `circle services search` at the model's budget would bury the rest
 * of the run. What is cut here is still in the tool result the agent got.
 */
export const TOOL_BLOCK_MAX_LINES = 12;
export const TOOL_BLOCK_MAX_CHARS = 1_500;
export const TOOL_BLOCK_MAX_LINE_CHARS = 200;

/** One finished tool call, as the transcript shows it. */
export interface ToolBlock {
  /** Tool name, e.g. `shell`. */
  name: string;
  /** What it was called on: the command, the path, the pattern. */
  detail?: string;
  /** What it printed. Omit for tools whose output is not worth showing. */
  body?: string;
  /** How it ended, e.g. `exit 0`, `252 lines`, an error message. */
  status: string;
  /** False paints the status red. Defaults to true. */
  ok?: boolean;
  /** Footer facts after the status, e.g. `1.8s`, `952 chars`. */
  meta?: string[];
}

/** Cut one line to width without collapsing its indentation, unlike `preview`. */
function cutLine(line: string): string {
  return line.length > TOOL_BLOCK_MAX_LINE_CHARS
    ? `${line.slice(0, TOOL_BLOCK_MAX_LINE_CHARS)}…`
    : line;
}

/** The body lines a block shows, and how many it dropped. */
function bodyLines(body: string): { shown: string[]; hidden: number } {
  const text = body.trimEnd();
  if (!text) return { shown: [], hidden: 0 };

  // JSON is what most of these commands print, and it is unreadable as one long
  // line, so it is re-indented and highlighted before being measured.
  let rendered = text;
  try {
    JSON.parse(text);
    rendered = colorizeJson(text);
  } catch {
    // not JSON; show it as it came
  }

  const lines = rendered.split('\n');
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (shown.length >= TOOL_BLOCK_MAX_LINES || chars >= TOOL_BLOCK_MAX_CHARS) break;
    const cut = cutLine(line);
    shown.push(cut);
    chars += cut.length + 1;
  }
  return { shown, hidden: lines.length - shown.length };
}

/**
 * Render a finished tool call as one block: header, output, status footer.
 *
 * ```
 * [tool] shell circle wallet balance --address 0xc3f4… --chain BASE
 * │ { "balance": "12.40", "token": "USDC" }
 * └ exit 0 · 1.8s · 39 chars
 * ```
 *
 * It is one string on purpose. Agents call tools in parallel, so a command line
 * printed when a call starts and a result line printed when it ends have every
 * other in-flight call landing between them — which is how a transcript ends up
 * with five commands followed by five exit codes and no way to pair them. A
 * block is emitted once, complete, and cannot be split; concurrency then only
 * decides the order blocks arrive in, which is the order they finished.
 */
export function toolBlock(block: ToolBlock): string {
  const head = toolLine(`${block.name}${block.detail ? ` ${block.detail}` : ''}`);
  const gutter = dim('│');
  const lines = [head];

  if (block.body) {
    const { shown, hidden } = bodyLines(block.body);
    for (const line of shown) lines.push(`${gutter} ${line}`);
    if (hidden > 0) {
      lines.push(`${gutter} ${dim(`… ${hidden} more line${hidden === 1 ? '' : 's'}`)}`);
    }
  }

  const status = block.ok === false ? red(block.status) : green(block.status);
  const meta = block.meta?.length ? dim(` · ${block.meta.join(' · ')}`) : '';
  lines.push(`${dim('└')} ${status}${meta}`);
  return lines.join('\n');
}

/**
 * The line a tool call prints when it is *still running*.
 *
 * With blocks printed on completion, nothing marks the start of a call, and a
 * three-minute `circle services pay` would look like a hang. This is what the
 * timer in `./tools` emits for calls slow enough to be worth announcing.
 *
 * The fixed form, for output that cannot be taken back: a pipe, a file, a kit
 * with no UI. A kit with a live region gets the animated, self-erasing version
 * instead — see `setLiveNotices` in `./tools`.
 */
export function runningLine(name: string, detail: string): string {
  return `${name} ${detail} ${dim('(running…)')}`;
}

/**
 * Build the `[<label>-kit]` framework-line colorizer for one kit. Each kit calls
 * this once with its own label; the formatting is identical everywhere else, so
 * only the tag differs between kits.
 */
export function makeKitLine(label: string): (line: string) => string {
  const tag = dim(magenta(`[${label}]`));
  return (line) => `${tag} ${line}`;
}

/** A heading rule, e.g. the agent-reply separator. */
export function heading(label: string): string {
  return bold(cyan(label));
}

/**
 * The frame a finished turn's answer prints in, shared so the six kits end a
 * turn identically no matter which framework produced the text. Pass the
 * model's reply; LaTeX cleanup and the empty-reply placeholder are applied here
 * so no caller has to remember either.
 *
 * Prose a kit prints *while* a turn is still running is a different thing and
 * is not framed this way — see `streamedBlock`.
 */
export function replyBlock(text: string | null | undefined): string {
  const body = humanizeLatexSymbols((text ?? '').trim()) || '(no output)';
  return `\n${heading('--- agent reply ---')}\n\n${body}\n\n${heading('-------------------')}`;
}

/**
 * The frame for prose the model emits mid-turn, in the kits whose frameworks
 * stream it (the Claude Agent SDK's message stream, the Vercel AI SDK's
 * `onStepFinish`). Deliberately unclosed and labelled differently from
 * `replyBlock`: it marks thinking-aloud between tool calls, not the answer.
 */
export function streamedBlock(text: string): string {
  return `\n${heading('--- agent ---')}\n\n${humanizeLatexSymbols(text.trimEnd())}`;
}

/**
 * Common LaTeX math snippets a chat model reaches for assuming a renderer that
 * understands them (arrows, multiplication, ...), swapped for their Unicode
 * equivalent. The terminal prints raw text with no LaTeX or markdown renderer,
 * so `$\rightarrow$` would otherwise show up literally instead of as `→`.
 * Deliberately not a LaTeX parser — display cleanup for the handful of symbols
 * models reach for most often, not general math rendering.
 */
const LATEX_SYMBOLS: Record<string, string> = {
  rightarrow: '→',
  Rightarrow: '⇒',
  leftarrow: '←',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  times: '×',
  div: '÷',
  pm: '±',
  cdot: '·',
  approx: '≈',
  neq: '≠',
  leq: '≤',
  geq: '≥',
  infty: '∞',
};

const LATEX_SYMBOL_PATTERN = new RegExp(
  `\\$?\\\\(${Object.keys(LATEX_SYMBOLS).join('|')})\\$?`,
  'g',
);

/** Replace the LaTeX snippets above with their Unicode equivalent. */
export function humanizeLatexSymbols(text: string): string {
  return text.replace(LATEX_SYMBOL_PATTERN, (match, name: string) => LATEX_SYMBOLS[name] ?? match);
}
