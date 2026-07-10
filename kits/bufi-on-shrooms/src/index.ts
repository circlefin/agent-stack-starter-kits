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

import 'dotenv/config';

import { createChatUi } from '@agent-stack-ecosystem-kits/agent-cli';
import { searchServices, walletUsdcBalance, formatUsdcBalance } from '@agent-stack-ecosystem-kits/circle-tools';
import { bufiLine, heading, toolLine, yellow } from './theme';

async function main(): Promise<void> {
  const workspace = process.env.BUFI_WORKSPACE_NAME ?? 'Agentic Workspace';
  const ui = createChatUi({ title: heading(`BUFI on Shrooms - ${workspace}`) });
  try {
    ui.log(bufiLine('starting public Circle Agent Stack workspace demo'));
    ui.log(bufiLine('private BUFI APIs are intentionally out of scope'));

    try {
      const balance = await walletUsdcBalance();
      ui.setBalance(balance ? formatUsdcBalance(balance) : null);
      ui.log(toolLine(`walletUsdcBalance <- ${balance ? balance.address : 'no wallet'}`));
    } catch (error) {
      ui.log(toolLine(`walletUsdcBalance x ${(error as Error).message}`));
    }

    try {
      const services = (await searchServices({ keyword: 'weather' })).slice(0, 3);
      ui.log(toolLine(`searchServices <- ${services.length} services`));
      for (const service of services) {
        ui.log(bufiLine(`${service.name}: ${service.url}`));
      }
    } catch (error) {
      ui.log(toolLine(`searchServices x ${(error as Error).message}`));
    }

    ui.log(bufiLine(yellow('demo complete; add Vercel AI tools only behind explicit approval for spends')));
  } finally {
    ui.close();
  }
}

void main();
