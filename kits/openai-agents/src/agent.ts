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

import { Agent } from '@openai/agents';
import type { KitConfig } from './config';
import {
  fetchSetupSkillTool,
  fetchSubSkillTool,
  circleCreateWallet,
  circleListWallets,
  circleGetBalance,
  circleWalletFund,
  fetchServiceTool,
  circleDeployWallet,
  fundFiatTool,
  circleGetGatewayBalance,
  circleSearchServices,
  circleInspectService,
  circlePayService,
  circleGatewayDeposit,
  callFreeService,
  buildAuthTools,
} from './tools';

export function buildAgent(config: KitConfig, ask: (q: string) => Promise<string>): Agent {
  const { loginTool, logoutTool } = buildAuthTools(ask);
  return new Agent({
    name: 'Circle Payment Agent',
    instructions: [
      'You are an onboarding agent for the Circle Agent Stack.',
      'YOU MUST USE YOUR TOOLS to perform every action — never just describe steps.',
      'Follow this sequence:',
      '1. Call fetch_setup_skill to read the Circle setup instructions.',
      '2. Call circle_list_wallets. If no wallet exists, call circle_create_wallet then call circle_deploy_wallet on the new address.',
      '3. Call circle_get_balance on the wallet address.',
      '4. If USDC balance is zero: call fetch_sub_skill with name="wallet-fund" and explain to the developer how to fund their wallet (include the address and chain). Do NOT stop here — continue regardless.',
      '5. Call fetch_sub_skill with name="discover-services", then call circle_search_services with keyword "crypto" to discover available services.',
      '6. For each result, call fetch_service to probe it. If paymentRequired=false, show the data as the answer. If paymentRequired=true, call circle_inspect_service to get pricing and schema.',
      '7. If the wallet has sufficient USDC and the service is paid: call fetch_sub_skill with name="wallet-pay", ensure the wallet is deployed (call circle_deploy_wallet if needed), then call circle_pay_service with the method copied from circle_inspect_service. If the payment fails because Gateway balance is required, call circle_gateway_deposit for the same URL, then retry circle_pay_service.',
      'After each tool call, briefly explain what happened and what it means for the developer.',
    ].join(' '),
    model: config.model,
    tools: [
      loginTool,
      logoutTool,
      fetchSetupSkillTool,
      fetchSubSkillTool,
      circleCreateWallet,
      circleListWallets,
      circleGetBalance,
      circleWalletFund,
      fetchServiceTool,
      circleDeployWallet,
      fundFiatTool,
      circleGetGatewayBalance,
      circleSearchServices,
      circleInspectService,
      circlePayService,
      circleGatewayDeposit,
      callFreeService,
    ],
  });
}
