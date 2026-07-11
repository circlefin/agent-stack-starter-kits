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

import "dotenv/config";

import { createChatUi } from "@agent-stack-ecosystem-kits/agent-cli";
import {
  ensureSession,
  formatUsdcBalance,
  walletUsdcBalance,
} from "@agent-stack-ecosystem-kits/circle-tools";
import { runTurn } from "@agent-stack-ecosystem-kits/kit-vercel-ai/agent";
import { loadConfig } from "@agent-stack-ecosystem-kits/kit-vercel-ai/config";
import { SETUP_SKILL_URL } from "@agent-stack-ecosystem-kits/kit-vercel-ai/skill";
import { buildTools } from "@agent-stack-ecosystem-kits/kit-vercel-ai/tools";
import type { CoreMessage } from "ai";

import { bufiLine, dim, heading, red, toolLine, yellow } from "./theme";
import { createTraceCollector } from "./trace";

async function main(): Promise<void> {
  const workspace = process.env.BUFI_WORKSPACE_NAME ?? "Agentic Workspace";
  const ui = createChatUi({ title: heading(`BUFI on Shrooms — ${workspace}`) });
  const trace = createTraceCollector((event) => ui.log(bufiLine(event)));
  const ask = async (question: string): Promise<string> => {
    const answer = await ui.ask(question);
    if (answer.trim().toLowerCase() === "exit") {
      ui.close();
      process.exit(0);
    }
    return answer;
  };
  const refreshBalance = async () => {
    try {
      const summary = await walletUsdcBalance();
      ui.setBalance(summary ? formatUsdcBalance(summary) : null);
    } catch {
      // A read-only balance refresh never breaks the agent session.
    }
  };

  try {
    const config = loadConfig();
    ui.log(
      bufiLine(
        `workspace=${workspace} provider=${config.provider} model=${config.model}`,
      ),
    );
    ui.log(
      bufiLine(dim("all paid tools retain an in-tool human approval prompt")),
    );
    await ensureSession({
      ask,
      log: (line) => ui.log(bufiLine(line)),
      bold: heading,
    });
    await refreshBalance();

    const tools = buildTools(ask, { log: (line) => ui.log(toolLine(line)) });
    ui.log(
      bufiLine(`circle tool roster ready (${Object.keys(tools).length} tools)`),
    );
    let messages: CoreMessage[] = [
      {
        role: "user",
        content:
          `Fetch ${SETUP_SKILL_URL} with fetch_setup_skill and follow it. ` +
          "Use tools for actions, explain each result, and ask before every paid action.",
      },
    ];

    const run = async () => {
      ui.setStatus("working…");
      const result = await runTurn(config, messages, tools, {
        onStep: (event) => {
          trace.record(event);
        },
      });
      ui.setStatus(null);
      await refreshBalance();
      messages = [...messages, ...result.responseMessages];
    };

    await run();
    ui.log(
      bufiLine(
        'bootstrap complete — continue the workspace session or type "exit"',
      ),
    );
    while (true) {
      const input = (await ask("> ")).trim();
      if (!input) continue;
      if (input.toLowerCase() === "quit") break;
      messages.push({ role: "user", content: input });
      await run();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.log(bufiLine(red(`fatal: ${message}`)));
    ui.log(
      bufiLine(yellow("No paid action runs without a fresh human approval.")),
    );
    process.exitCode = 1;
  } finally {
    ui.close();
  }
}

void main();
