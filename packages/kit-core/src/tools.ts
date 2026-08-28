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
 * The three tools, and what they do.
 *
 * There used to be sixteen: one per Circle operation, each with a typed schema
 * describing arguments the CLI already describes, each needing the same
 * preflight logic written again in TypeScript. They have been replaced by a
 * shell, because that is what Circle's skills are written for and because the
 * useful surface was never sixteen commands — the agent can now reach `curl`,
 * `jq`, `npm` and everything else the user has installed, and a Circle command
 * released tomorrow works here without a change to this repo.
 *
 * `read_file` and `grep` are not decoration. A marketplace search is thousands
 * of lines of JSON schema, past what any tool result should carry, so the agent
 * redirects it to a file and goes back for the part it needs — the way a person
 * does. Without a reader, "going back" means running the search again, and on a
 * paid call that is a second charge.
 *
 * The bodies live here rather than in each kit so six frameworks cannot drift
 * apart on what a tool does or how its failure reads. A kit's `tools.ts` is now
 * only the adapter between these and its framework's tool API.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseServiceSearch, type AskFn } from '@agent-stack-starter-kits/circle-tools';

import {
  describeApproval,
  isHelpInvocation,
  requiresApproval,
  segmentsOf,
} from './approval';
import { recordServiceSearch } from './commands';
import { setKitLoggedIn } from './session';
import { formatShellResult, runShell } from './shell';
import { bold, dim, green, red, runningLine, toolBlock, yellow, type ToolBlock } from './theme';

/** Tool names, single-sourced so a kit's logs and its schema cannot disagree. */
export const TOOL_NAMES = {
  SHELL: 'shell',
  READ_FILE: 'read_file',
  GREP: 'grep',
} as const;

/**
 * The model-facing description of every tool, single-sourced so the six kits
 * cannot drift apart on wording.
 *
 * These say what each tool does and what its arguments mean — nothing about when
 * to call it, in what order, or what to do afterwards. That belongs to Circle's
 * skills, which are the only thing in these kits that instructs the agent.
 */
export const TOOL_DESCRIPTIONS = {
  [TOOL_NAMES.SHELL]:
    'Run a shell command on the user\'s machine and return everything it prints, stdout and ' +
    'stderr interleaved, followed by its exit status. Runs in the home directory. This is a real ' +
    'shell: pipes, redirection, `&&` and command substitution all work, and every program the ' +
    'user has installed is available, including the `circle` CLI. A non-zero exit is returned as ' +
    'an ordinary result to read, not an error. Commands that move USDC stop for the user to ' +
    'approve before they run.',

  [TOOL_NAMES.READ_FILE]:
    'Read a text file from the machine and return its contents with line numbers. Use it for a ' +
    'skill document, or to open output a previous command redirected to a file. Reads the whole ' +
    'file by default; pass offset and limit to read a slice of a large one.',

  [TOOL_NAMES.GREP]:
    'Search file contents for a regular expression and return the matching lines with their file ' +
    'and line number. Searches a single file, or every text file under a directory. Use it to ' +
    'find the part you need in output too large to read whole.',
} as const;

/** Model-facing descriptions of the tool arguments. */
export const PARAM_DESCRIPTIONS = {
  command:
    'The shell command to run, exactly as it would be typed at a terminal. May contain pipes, ' +
    'redirection and multiple commands joined by `&&` or `;`.',

  filePath: 'Absolute path to the file to read. A path starting with ~ is expanded.',

  offset: 'First line to read, 1-based. Omit to start at the beginning of the file.',

  limit: 'How many lines to read from offset. Omit to read to the end of the file.',

  pattern: 'Regular expression to search for, in JavaScript syntax. Case-insensitive.',

  searchPath:
    'File to search, or directory to search under. Omit to search the home directory. A path ' +
    'starting with ~ is expanded.',

  glob:
    'Only search files whose path matches this glob, e.g. "*.json" or "**/SKILL.md". Omit to ' +
    'search every text file.',
} as const;

/** What a tool returns when the user declines the command it was about to run. */
export const REJECTED_MESSAGE =
  'The user declined this command, so it did not run and nothing was spent. Do not retry it as ' +
  'written — ask what they would rather do, or find another way.';

/** The kit-side plumbing a tool body needs. */
export interface ToolIo {
  /** Emit a namespaced `[<kit>-kit]` framework line to the scrollback. */
  log: (line: string) => void;
  /** Emit an already-formatted line (a command, an argument dump) verbatim. */
  out?: (line: string) => void;
  /**
   * Prompt the user, when approval lives *inside* the tool.
   *
   * Frameworks whose tool API can inspect a call's arguments before it runs
   * (Claude Agent SDK's `canUseTool`, OpenAI Agents' `needsApproval`, ADK's
   * `beforeToolCallback`) gate there and leave this unset. The rest pass it, and
   * the gate runs here instead. Either way the decision is the same function —
   * see `./approval`.
   */
  ask?: AskFn;
}

/** Collapse a value to one line and cap its length, for compact log lines. */
export function preview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * How long a tool call may run before it announces itself.
 *
 * Short enough that a human never wonders whether anything is happening, long
 * enough that the great majority of calls — a file read, a `--help`, a status
 * check — finish first and print nothing but their finished block.
 */
export const RUNNING_NOTICE_MS = 1_000;

/**
 * Show an in-flight tool call somewhere that can be un-shown, returning the
 * function that takes it away again. See `setLiveNotices`.
 */
export type LiveNotice = (label: string) => () => void;

let liveNotice: LiveNotice | null = null;

/**
 * Hand `announceRunning` a live region to put in-flight notices in.
 *
 * Process-wide state, like the session flag in `./approval`, and for the same
 * reason: there is one terminal, and the code that announces a call is several
 * frameworks away from the code that owns the screen. A kit installs its chat
 * UI's here once at startup — wrapping it in the kit's own `toolLine` so the
 * notice is colored exactly like the block that will replace it — and every tool
 * in every kit is then announced the same way.
 *
 * Left unset (a kit with no UI, or anything running before one exists) the
 * notice falls back to an ordinary printed line, which is what it always was.
 */
export function setLiveNotices(start: LiveNotice | null): void {
  liveNotice = start;
}

/**
 * Say that a call is still running, if it still is a second from now.
 *
 * Returns the canceller; call it as soon as the tool has a result, whether that
 * result is a success, a failure or a thrown error. Cancelling both stops a
 * notice that has not appeared yet and removes one that has, so the notice is
 * gone by the time the finished block is printed. Exported because the Claude
 * Agent SDK kit's tools are the SDK's own and so cannot go through the bodies
 * below, but should still feel the same to watch.
 */
export function announceRunning(
  emit: (line: string) => void,
  name: string,
  detail: string,
): () => void {
  let clear: (() => void) | null = null;
  const timer = setTimeout(() => {
    if (liveNotice) clear = liveNotice(`${name} ${detail}`);
    else emit(runningLine(name, detail));
  }, RUNNING_NOTICE_MS);
  return () => {
    clearTimeout(timer);
    clear?.();
    clear = null;
  };
}

/** Print a finished tool call as one unsplittable block. */
function emitBlock(io: ToolIo, block: ToolBlock): void {
  const out = io.out ?? ((line: string) => console.log(line));
  out(toolBlock(block));
}

/** Expand a leading `~` and make a path absolute against the home directory. */
function resolvePath(path: string): string {
  const expanded = path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

/**
 * Ask the user to approve a command before it runs.
 *
 * The command is printed verbatim and is the authority; `describeApproval` adds
 * what kind of thing it is, because a user who is not fluent in the CLI still
 * has to be able to judge it. Returns true when approved.
 */
export async function approveCommand(ask: AskFn, command: string, io: ToolIo): Promise<boolean> {
  const out = io.out ?? ((line: string) => console.log(line));
  io.log(yellow('approval required before this runs:'));
  out(`  ${bold(command)}`);
  const reason = describeApproval(command);
  if (reason) out(`  ${dim(reason)}`);
  const answer = (await ask(bold('Approve? [y/N] '))).trim().toLowerCase();
  const approved = answer === 'y' || answer === 'yes';
  io.log(approved ? green('approved by user') : red('rejected by user'));
  return approved;
}

/**
 * Whether `command` invokes `circle services search`.
 *
 * Exported (rather than kept private to `armQuickPickFromSearch` below) so a
 * kit that cannot route through `executeShell` — one whose framework owns the
 * shell tool itself and only sees commands and outputs as separate stream
 * messages — can still recognize the same commands without a second, drifting
 * copy of this pattern.
 */
export function isServiceSearchCommand(command: string): boolean {
  return /\bcircle\s+services\s+search\b/.test(command);
}

/**
 * Keep a numbered service quick-pick pointing at the search that actually ran.
 *
 * `/discover` arms the list itself, but the agent runs its own searches in the
 * shell, and after one of those a bare "2" at the prompt should mean the second
 * result the user just read. Sniffing the output is how that survives the move
 * away from a typed search tool: there is no longer a `circle_search_services`
 * to hook. Silent by contract — output that is not a search payload parses to
 * nothing and leaves the previous list alone.
 */
function armQuickPickFromSearch(command: string, output: string): void {
  if (!isServiceSearchCommand(command)) return;
  const services = parseServiceSearch(output);
  if (services.length > 0) recordServiceSearch(services);
}

/**
 * Keep the approval prompt's account of the session in step with the shell.
 *
 * Sniffing output is how this survives the agent owning the session: the kit
 * logs the user in before the first turn, and from then on the only thing that
 * can log them out or back in is a command the agent typed. A login is only
 * counted when the CLI says it completed — the two-step flow's `--init` half
 * exits 0 having done nothing but send an email.
 *
 * Judged per segment, the way the approval gate is, and with `--help` excluded
 * for the same reason it is excluded there: `circle wallet logout --help` exits
 * 0 and prints the word logout without logging anyone out.
 */
function trackSession(command: string, output: string, exitCode: number | null): void {
  if (exitCode !== 0) return;
  for (const segment of segmentsOf(command)) {
    if (isHelpInvocation(segment)) continue;
    if (segment.startsWith('circle wallet logout')) setKitLoggedIn(false);
    else if (segment.startsWith('circle wallet login') && /\blogged in as\b/i.test(output)) {
      setKitLoggedIn(true);
    }
  }
}

/**
 * Run a shell command, gating it on the user first when this kit's framework
 * cannot gate it earlier.
 */
export async function executeShell(command: string, io: ToolIo): Promise<string> {
  // Nothing is printed up front: the block below carries the command, and a
  // gated command is printed by the approval prompt anyway.
  if (io.ask && requiresApproval(command)) {
    if (!(await approveCommand(io.ask, command, io))) return REJECTED_MESSAGE;
  }

  const detail = preview(command);
  const stopNotice = announceRunning(io.log, TOOL_NAMES.SHELL, detail);

  let result;
  try {
    result = await runShell(command);
  } catch (e) {
    // The shell itself could not be started. Distinct from a command that ran
    // and failed, and worth saying so: retrying will not fix it.
    stopNotice();
    const message = (e as Error).message;
    emitBlock(io, {
      name: TOOL_NAMES.SHELL,
      detail,
      status: `shell could not be started: ${message}`,
      ok: false,
    });
    return `The shell could not be started: ${message}`;
  }
  stopNotice();

  armQuickPickFromSearch(command, result.output);
  trackSession(command, result.output, result.exitCode);

  emitBlock(io, {
    name: TOOL_NAMES.SHELL,
    detail,
    body: result.output,
    status: result.timedOut ? 'timed out' : `exit ${String(result.exitCode)}`,
    ok: !result.timedOut && result.exitCode === 0,
    meta: [`${(result.durationMs / 1000).toFixed(1)}s`, `${result.output.length} chars`],
  });
  return formatShellResult(result);
}

/** Cap on what one file read hands back, for the same reason the shell has one. */
const MAX_READ_CHARS = 30_000;

export interface ReadFileArgs {
  filePath: string;
  offset?: number;
  limit?: number;
}

/**
 * Read a text file, numbered from its real line numbers.
 *
 * Numbering is not cosmetic: it is what lets the agent ask for the next slice of
 * a file it has only partly read, and what makes a `grep` hit and a `read_file`
 * offset refer to the same place.
 */
export async function executeReadFile(args: ReadFileArgs, io: ToolIo): Promise<string> {
  const path = resolvePath(args.filePath);
  const slice = args.offset || args.limit ? ` offset=${args.offset ?? 1} limit=${args.limit ?? '∞'}` : '';
  const detail = `${preview(path)}${slice}`;
  const stopNotice = announceRunning(io.log, TOOL_NAMES.READ_FILE, detail);

  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (e) {
    stopNotice();
    const message = (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? `No such file: ${path}`
      : `Could not read ${path}: ${(e as Error).message}`;
    emitBlock(io, { name: TOOL_NAMES.READ_FILE, detail, status: message, ok: false });
    return message;
  }
  stopNotice();

  const lines = contents.split('\n');
  const from = Math.max(1, args.offset ?? 1);
  const to = args.limit ? from + args.limit - 1 : lines.length;
  const selected = lines.slice(from - 1, to);
  if (selected.length === 0) {
    const message = `${path} has ${lines.length} lines; nothing to read from line ${from}.`;
    emitBlock(io, { name: TOOL_NAMES.READ_FILE, detail, status: message, ok: false });
    return message;
  }

  const width = String(from + selected.length - 1).length;
  let body = selected
    .map((line, i) => `${String(from + i).padStart(width, ' ')}\t${line}`)
    .join('\n');

  let note = '';
  if (body.length > MAX_READ_CHARS) {
    body = body.slice(0, MAX_READ_CHARS);
    note =
      `\n\n[cut at ${MAX_READ_CHARS} characters. Read on with offset and limit, or narrow it ` +
      'down with grep.]';
  } else if (to < lines.length) {
    note = `\n\n[lines ${from}-${to} of ${lines.length}. Continue with offset ${to + 1}.]`;
  }

  // No body: a file read is the one tool whose output is already in a file the
  // user can open, and twelve lines of a skill document tell them nothing.
  emitBlock(io, {
    name: TOOL_NAMES.READ_FILE,
    detail,
    status: `${selected.length} lines`,
    meta: [`${body.length} chars`],
  });
  return body + note;
}

/** Directories never worth walking; everything else, including dotted ones, is. */
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.cache', '.Trash', 'Cache', 'CacheStorage']);
/** Bounds on one search, so a pattern aimed at a home directory still returns. */
const MAX_FILES_SCANNED = 8_000;
const MAX_MATCHES = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WALK_DEPTH = 12;
/** Bounds one `re.test()` call, so a long line cannot turn a vulnerable pattern
 * into a long hang — the risk scales with input length, so this is a cheap,
 * partial mitigation rather than a full regex safety analysis. */
const MAX_LINE_TEST_CHARS = 4_000;
/** Rejects the common shapes of catastrophic backtracking — nested repetition
 * like `(a+)+` or `(a*)*` — outright. Not a complete regex safety analyzer,
 * but a model-supplied pattern that matches this is refused rather than run. */
const CATASTROPHIC_BACKTRACKING = /\([^()]*[+*][^()]*\)[+*]/;

/** Translate a glob into a regular expression over the path, `**` crossing separators. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  // Unanchored on the left so a bare "*.json" matches at any depth, which is
  // what a caller writing that means.
  return new RegExp(`(?:^|/)${source}$`);
}

/** True when the head of a file looks binary, so it is never scanned as text. */
function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes(0);
}

export interface GrepArgs {
  pattern: string;
  searchPath?: string;
  glob?: string;
}

async function* walk(root: string, depth = 0): AsyncGenerator<string> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    // Symlinked directories are not followed: a loop through one turns a search
    // into a hang, and the registry symlinks skills into place.
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(path, depth + 1);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield path;
    }
  }
}

/** Search one file, appending `path:line: text` for each hit. */
async function grepFile(path: string, re: RegExp, into: string[]): Promise<void> {
  let buffer: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
    buffer = await readFile(path);
  } catch {
    return;
  }
  if (isBinary(buffer)) return;
  const lines = buffer.toString('utf8').split('\n');
  for (let i = 0; i < lines.length && into.length < MAX_MATCHES; i++) {
    const line = lines[i] ?? '';
    const testLine = line.length > MAX_LINE_TEST_CHARS ? line.slice(0, MAX_LINE_TEST_CHARS) : line;
    if (re.test(testLine)) into.push(`${path}:${i + 1}: ${preview(line, 300)}`);
    // `re` is built without /g, so lastIndex never carries between lines.
  }
}

/** Search file contents for a pattern, over a file or a directory tree. */
export async function executeGrep(args: GrepArgs, io: ToolIo): Promise<string> {
  const root = resolvePath(args.searchPath ?? homedir());
  const detail =
    `${preview(args.pattern, 60)} in ${preview(root)}` + (args.glob ? ` glob=${args.glob}` : '');
  const fail = (message: string): string => {
    emitBlock(io, { name: TOOL_NAMES.GREP, detail, status: message, ok: false });
    return message;
  };

  let re: RegExp;
  try {
    re = new RegExp(args.pattern, 'i');
  } catch (e) {
    return fail(`Not a valid regular expression: ${(e as Error).message}`);
  }
  if (CATASTROPHIC_BACKTRACKING.test(args.pattern)) {
    return fail(
      'Pattern rejected: nested repetition (e.g. "(a+)+") can hang the search on some input. Try a more specific pattern.',
    );
  }

  let info;
  try {
    info = await stat(root);
  } catch {
    return fail(`No such file or directory: ${root}`);
  }

  // Only now, past the checks that fail instantly: a walk of a home directory is
  // the one call here that regularly outlasts the notice.
  const stopNotice = announceRunning(io.log, TOOL_NAMES.GREP, detail);
  const startedAt = Date.now();
  const matches: string[] = [];
  let scanned = 0;
  if (info.isFile()) {
    await grepFile(root, re, matches);
    scanned = 1;
  } else {
    const include = args.glob ? globToRegExp(args.glob) : null;
    // `walked` bounds the cost of walking the tree itself; `scanned` (below,
    // used only for the log line) counts the smaller set that also passed the
    // glob. Capping on `scanned` instead would let a narrow glob over a huge
    // tree walk everything — bounded only by MAX_WALK_DEPTH — before the file
    // cap ever had a chance to apply.
    let walked = 0;
    for await (const path of walk(root)) {
      if (matches.length >= MAX_MATCHES || walked >= MAX_FILES_SCANNED) break;
      walked++;
      // Match the glob against the path relative to the search root, so a
      // pattern is written against what the caller asked about.
      if (include && !include.test(relative(root, path).split(sep).join('/'))) continue;
      scanned++;
      await grepFile(path, re, matches);
    }
  }

  stopNotice();
  emitBlock(io, {
    name: TOOL_NAMES.GREP,
    detail,
    body: matches.join('\n'),
    status: `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${scanned} files`,
    meta: [`${((Date.now() - startedAt) / 1000).toFixed(1)}s`],
  });

  if (matches.length === 0) {
    return `No matches for /${args.pattern}/ under ${root}${args.glob ? ` (glob ${args.glob})` : ''}.`;
  }
  const capped = matches.length >= MAX_MATCHES ? `\n\n[stopped at ${MAX_MATCHES} matches]` : '';
  return matches.join('\n') + capped;
}
