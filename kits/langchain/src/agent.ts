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

import { homedir } from 'node:os';

import { ChatAnthropic } from '@langchain/anthropic';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { createDeepAgent, FilesystemBackend } from 'deepagents';
import { createMiddleware } from 'langchain';
import { announceRunning, preview } from '@agent-stack-starter-kits/kit-core';

import type { KitConfig } from './config';
import { kitLine, toolBlock, toolLine, yellow } from './theme';
import { buildTools, type AskFn } from './tools';

const MAX_RETRIES = 4;

interface RetryableError {
  status?: number;
}

/**
 * Bounded, visible retry. The provider can answer HTTP 529 ("Overloaded") or
 * 5xx; LangChain retries those with exponential backoff, but silently, so a long
 * backoff looks like a freeze. This logs each retry (counting attempts itself,
 * since LangChain does not pass p-retry's attemptNumber through) and keeps the
 * fail-fast on real client errors (bad key 401, bad request 400) by rethrowing
 * them, which aborts the retry loop instead of hammering the API.
 */
function makeOnFailedAttempt() {
  let attempt = 0;
  return (error: RetryableError): void => {
    const status = error.status;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
      throw error;
    }
    attempt += 1;
    const reason = status === 529 ? 'overloaded' : status ? `HTTP ${status}` : 'unreachable';
    const last = attempt > MAX_RETRIES;
    const tail = last ? 'giving up' : `retrying (${attempt}/${MAX_RETRIES}) ...`;
    console.log(kitLine(yellow(`model ${reason} on attempt ${attempt}; ${tail}`)));
  };
}

/** Deep Agents' built-in filesystem tools, which this kit uses in place of its own. */
const FILE_TOOL_NAMES = new Set(['ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep']);

const HOME = homedir();

/** `/` is what `ls`, `glob` and `grep` pass when the model omits a path; read it
 * as "wherever the agent is", which is home. Any other path is used as given. */
function fromHome(path?: string | null): string {
  return !path || path === '/' ? HOME : path;
}

/**
 * The real filesystem, searched from the home directory.
 *
 * `FilesystemBackend` resolves an absolute path as itself, which is what the
 * skills index needs — its entries are absolute paths under `~`. But the
 * built-in tools default their path argument to `/`, and absolute means absolute
 * there too: an unqualified `grep` would walk the entire machine, come back with
 * a permission error out of `/root` or `/proc`, and take a long time doing it.
 * Redirecting that default to home bounds the search where the shell already
 * works, and matches what `kit-core`'s own grep documents.
 *
 * One ripgrep default survives: an unqualified search skips dotted directories,
 * so a home-wide `grep` does not see `~/.agents/skills`. Handing it that path
 * explicitly does, which is what the skills index leads the agent to do.
 */
class HomeBackend extends FilesystemBackend {
  constructor() {
    super({ rootDir: HOME });
  }

  override ls(dirPath: string) {
    return super.ls(fromHome(dirPath));
  }

  override glob(pattern: string, searchPath?: string) {
    return super.glob(pattern, fromHome(searchPath));
  }

  override grep(pattern: string, dirPath?: string, glob?: string | null) {
    return super.grep(pattern, fromHome(dirPath), glob);
  }
}

/** Render a tool call's arguments as one compact line: paths and patterns bare,
 * everything else as `key=value`. */
function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) =>
      key === 'file_path' || key === 'path' || key === 'pattern'
        ? String(value)
        : `${key}=${String(value)}`,
    )
    .join(' ');
}

/** The built-ins whose output is worth showing; a file read opens a file the user already has. */
const BODY_TOOLS = new Set(['ls', 'glob', 'grep']);

/** Pull the text out of whatever a tool handler returned, defensively. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'string' ? part : String((part as { text?: string }).text ?? ''),
    )
    .join('\n');
}

/**
 * Print each built-in file tool call in the scrollback, as one finished block.
 *
 * `kit-core`'s tools print themselves, so the shell needs nothing here; Deep
 * Agents' built-ins do not, and a turn that silently reads four skill documents
 * looks like a freeze. The middleware still never touches the result — it awaits
 * it, prints it, and hands it back exactly as it came.
 */
const fileToolLogging = createMiddleware({
  name: 'FileToolLogging',
  wrapToolCall: async (request, handler) => {
    const { name, args } = request.toolCall;
    if (!FILE_TOOL_NAMES.has(name)) return handler(request);

    const detail = preview(describeArgs(args));
    const emit = (line: string): void => console.log(toolLine(line));
    const stopNotice = announceRunning(emit, name, detail);
    const startedAt = Date.now();

    let result;
    try {
      result = await handler(request);
    } catch (e) {
      stopNotice();
      console.log(toolBlock({ name, detail, status: (e as Error).message, ok: false }));
      throw e;
    }
    stopNotice();

    const text = resultText(result);
    const showBody = BODY_TOOLS.has(name);
    console.log(
      toolBlock({
        name,
        detail,
        body: showBody ? text : undefined,
        status: showBody ? 'ok' : `${text ? text.split('\n').length : 0} lines`,
        meta: [`${((Date.now() - startedAt) / 1000).toFixed(1)}s`, `${text.length} chars`],
      }),
    );
    return result;
  },
});

/**
 * Build the Deep Agents agent.
 *
 * `systemPrompt` is `kit-core`'s: a line of identity, three rules for working a
 * terminal, and an index of the Circle skills installed on this machine. There
 * is no playbook of our own — everything about wallets, x402 and payment comes
 * from those skill documents, which the agent reads with `read_file` when one
 * turns out to be relevant.
 *
 * That `read_file` is Deep Agents' own, not `kit-core`'s: the framework ships a
 * filesystem toolset (`ls`, `read_file`, `write_file`, `edit_file`, `glob`,
 * `grep`) and rejects custom tools that shadow those names. By default it backs
 * them with `StateBackend`, a virtual filesystem living in agent state, which
 * would leave the agent reading an empty disk — the skills it needs are real
 * files under the home directory. The `HomeBackend` above is what makes the
 * built-ins read the actual machine, from the same directory the shell tool runs
 * in.
 *
 * That index is built by `kit-core` rather than by Deep Agents'
 * `createSkillsMiddleware`, which implements the same progressive-disclosure
 * pattern natively over a filesystem backend. Reading it ourselves is what keeps
 * this kit's behaviour identical to the other five, and so keeps the six
 * comparable; reach for the middleware if you are building on this kit alone.
 *
 * `interruptOn` is likewise absent, and its absence is the interesting part. It
 * pauses on a tool *name*, which was the right shape when two of sixteen tools
 * moved USDC. With one shell tool the question is about the command, not the
 * tool, so the gate moved inside `executeShell` — see `kit-core`'s `approval`.
 * The checkpointer stays: it is what carries conversation state across turns.
 */
export function buildAgent(config: KitConfig, ask: AskFn, instructions: string) {
  const tools = buildTools(ask);
  // maxRetries bounds the backoff so a sustained outage fails with a clear error
  // instead of hanging; onFailedAttempt makes each retry visible.
  const retry = { maxRetries: MAX_RETRIES, onFailedAttempt: makeOnFailedAttempt() };
  const model =
    config.provider === 'anthropic'
      ? new ChatAnthropic({ model: config.model, apiKey: config.providerApiKey, ...retry })
      : // ChatOpenAI still calls /v1/chat/completions by default, and OpenAI's
        // reasoning models apply a non-zero reasoning_effort there server-side,
        // which that endpoint refuses to combine with function tools: "Function
        // tools with reasoning_effort are not supported ... use /v1/responses or
        // set reasoning_effort to 'none'". An agent needs both, so route to the
        // Responses API rather than trading the reasoning away.
        new ChatOpenAI({
          model: config.model,
          apiKey: config.providerApiKey,
          useResponsesApi: true,
          ...retry,
        });

  return createDeepAgent({
    model,
    tools,
    systemPrompt: instructions,
    backend: new HomeBackend(),
    middleware: [fileToolLogging],
    checkpointer: new MemorySaver(),
  });
}
