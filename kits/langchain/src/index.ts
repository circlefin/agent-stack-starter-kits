import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createChatUi, type ChatUi } from '@agent-stack-ecosystem-kits/agent-cli';
import {
  ensureSession,
  formatUsdcBalance,
  walletUsdcBalance,
} from '@agent-stack-ecosystem-kits/circle-tools';

import { buildAgent } from './agent';
import { loadConfig } from './config';
import { SETUP_SKILL_URL } from './skill';
import { bold, colorizeJson, dim, green, heading, kitLine, red, yellow } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[langchain-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (JSON, agent reply) verbatim. */
function out(line: string): void {
  if (ui) ui.log(line);
  else console.log(line);
}

/** Refresh the pinned USDC balance readout. Best-effort: a balance read must
 * never break the session (e.g. before a wallet exists, or on an RPC blip). */
async function refreshBalance(): Promise<void> {
  try {
    const summary = await walletUsdcBalance();
    ui?.setBalance(summary ? formatUsdcBalance(summary) : null);
  } catch {
    // Leave the last shown balance in place.
  }
}

/** A tool call the agent paused on, awaiting human review. Shape is loose
 * because deepagents may nest the tool name/args under `action`. */
interface ActionRequest {
  name?: string;
  args?: Record<string, unknown>;
  action?: { name?: string; args?: Record<string, unknown> };
}

interface InterruptEnvelope {
  value?: { actionRequests?: ActionRequest[] };
}

interface AgentResult {
  messages?: Array<{ content: unknown }>;
  __interrupt__?: InterruptEnvelope[];
}

type Decision = { type: 'approve' } | { type: 'reject' };

type Agent = ReturnType<typeof buildAgent>;
type RunConfig = { configurable: { thread_id: string } };

const EMPTY_RESPONSE_RETRIES = 2;

/**
 * True when the model returned no usable content: null/undefined, a blank
 * string, or an empty content-block array. Under provider degradation the API
 * can answer HTTP 200 with no content blocks (stop_reason set, no text). That is
 * not a thrown error, so the model-level retry in agent.ts (which only fires on
 * 5xx/529/429) never sees it; we catch the empty turn here instead.
 */
function isEmptyContent(content: unknown): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

function finalContentOf(result: AgentResult): unknown {
  const messages = result.messages ?? [];
  return messages[messages.length - 1]?.content;
}

function actionName(req: ActionRequest): string {
  return req.name ?? req.action?.name ?? 'unknown_tool';
}

function actionArgs(req: ActionRequest): Record<string, unknown> {
  return req.args ?? req.action?.args ?? {};
}

/** Prompt the user to approve or reject a single paused tool call. */
async function reviewAction(
  req: ActionRequest,
  ask: (q: string) => Promise<string>,
): Promise<Decision> {
  const name = actionName(req);
  log(yellow(`approval required for tool: ${bold(name)}`));
  out(colorizeJson(actionArgs(req)));

  const answer = (await ask(bold('Approve this action? [y/N] '))).trim().toLowerCase();
  const approved = answer === 'y' || answer === 'yes';
  log(approved ? green('approved by user') : red('rejected by user'));
  return { type: approved ? 'approve' : 'reject' };
}

/**
 * Invoke the agent and drive it to completion for one conversation turn.
 * The agent pauses (interruptOn: circle_pay_service) instead of spending USDC;
 * resume it with one decision per pending action until no interrupt remains.
 * Each resume reuses runConfig so the thread_id stays stable.
 */
async function runTurn(
  agent: Agent,
  input: { messages: HumanMessage[] } | Command,
  runConfig: RunConfig,
  ask: (q: string) => Promise<string>,
): Promise<AgentResult> {
  let attempt = 0;
  while (true) {
    let result = (await agent.invoke(input, runConfig)) as AgentResult;

    while (result.__interrupt__ && result.__interrupt__.length > 0) {
      const requests = result.__interrupt__[0]?.value?.actionRequests ?? [];
      const pending = requests.length > 0 ? requests : [{} as ActionRequest];
      const decisions: Decision[] = [];
      for (const req of pending) {
        decisions.push(await reviewAction(req, ask));
      }
      log('resuming agent ...');
      result = (await agent.invoke(
        new Command({ resume: { decisions } }),
        runConfig,
      )) as AgentResult;
    }

    // An empty final turn is a degraded-provider artifact, not a real reply.
    // Re-run the turn (same input, same thread) to ask the model to regenerate;
    // bounded so a sustained outage still ends instead of looping forever.
    if (!isEmptyContent(finalContentOf(result)) || attempt >= EMPTY_RESPONSE_RETRIES) {
      return result;
    }
    attempt += 1;
    log(yellow(`empty model response; retrying turn (${attempt}/${EMPTY_RESPONSE_RETRIES}) ...`));
  }
}

function printFinal(result: AgentResult): void {
  const content = finalContentOf(result);
  // A string reply is markdown, left as-is; a structured reply is highlighted
  // JSON. An empty turn that survived the retry in runTurn is flagged plainly so
  // a degraded-provider blank never prints as a bare `[]`.
  const finalContent = isEmptyContent(content)
    ? yellow('(empty model response — provider may be degraded; try again in a moment)')
    : typeof content === 'string'
      ? content
      : colorizeJson(content);

  out(`\n${heading('--- agent reply ---')}\n`);
  out(finalContent);
  out(`\n${heading('-------------------')}`);
}

async function main(): Promise<void> {
  // Pin the input to the bottom (Claude Code-style) while logs scroll above.
  // Falls back to plain console + readline when stdout/stdin is not a TTY.
  const chat = createChatUi({ title: heading('Autonomous Payment Agent') });
  ui = chat;

  log('Autonomous Payment Agent demo starting');
  const config = loadConfig();
  log(`chain=BASE provider=${config.provider} model=${config.model}`);
  log(dim('tip: type "exit" at any prompt to quit'));

  // Brief's AGENT BOOTSTRAP PROMPT, verbatim. setup.md drives the first turn.
  const userPrompt =
    `Run curl -sL ${SETUP_SKILL_URL}, ` +
    'and use the returned setup instructions to set up my agent wallet.';

  // The checkpointer-backed agent needs a thread_id. The same config object is
  // reused on every resume AND on every chat turn, so conversation state held
  // by the MemorySaver checkpointer carries across the whole session.
  const runConfig: RunConfig = { configurable: { thread_id: `demo-${Date.now()}` } };

  // Every prompt (chat input, approval [y/N], email/OTP) flows through the same
  // pinned input box the chat UI renders at the bottom of the terminal.
  // `exit` typed at ANY prompt halts the demo immediately, tearing down the UI
  // (which restores the console) before the answer reaches the caller.
  const ask = async (q: string): Promise<string> => {
    const answer = await chat.ask(q);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      chat.close();
      process.exit(0);
    }
    return answer;
  };

  // Inline auth: make sure the CLI has a valid agent session before the agent
  // runs. Logs in with email + OTP if needed; a pending Terms gate is reported
  // as a manual step (the kit never accepts the Terms for the user).
  await ensureSession({ ask, log, bold });
  await refreshBalance();

  // Built after `ask` exists: the agent's circle_login tool prompts for email +
  // OTP through it to recover a logged-out session mid-conversation.
  const agent = buildAgent(config, ask);

  // Interactive chat loop. The first turn runs the bootstrap prompt; after
  // the agent settles, the user drives follow-up turns. Each turn shares the
  // thread_id above, so the agent keeps full context across turns. `exit` or
  // `quit` ends the session; a blank line is ignored and re-prompts.
  log('invoking agent ...');
  // `null` means "no new turn to run" — used for the blank-line re-prompt so we
  // never re-invoke the agent without a fresh user message (that would replay a
  // thread ending on the assistant's reply, which the model rejects as prefill).
  let input: { messages: HumanMessage[] } | null = {
    messages: [new HumanMessage(userPrompt)],
  };

  while (true) {
    if (input) {
      chat.setStatus('working…');
      const result = await runTurn(agent, input, runConfig, ask);
      chat.setStatus(null);
      printFinal(result);
      await refreshBalance();
    }

    const next = (await ask('> ')).trim();
    if (next.toLowerCase() === 'quit') {
      log('done.');
      break;
    }
    // A blank line is a stray Enter, not an intent to quit: re-prompt without
    // running a turn. `exit` (handled in `ask`) and `quit` still halt.
    input = next ? { messages: [new HumanMessage(next)] } : null;
  }

  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print the
  // failure; otherwise these lines would be swallowed by the Ink frame.
  ui?.close();
  const message = err instanceof Error ? err.message : String(err);
  // A 529 means the LLM provider is overloaded after exhausting retries: it is
  // transient and not a kit bug, so say so plainly instead of dumping raw JSON.
  const overloaded = (err as { status?: number })?.status === 529 || message.includes('529');
  if (overloaded) {
    console.error(
      kitLine(red('FATAL: the LLM provider is overloaded (HTTP 529) and retries were exhausted.')),
    );
    console.error(kitLine(yellow('This is transient on the provider side. Re-run in a moment.')));
  } else {
    console.error(kitLine(red(`FATAL: ${message}`)));
  }
  process.exit(1);
});
