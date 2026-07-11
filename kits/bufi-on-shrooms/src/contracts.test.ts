/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildTools } from "@agent-stack-ecosystem-kits/kit-vercel-ai/tools";
import { describe, expect, test } from "bun:test";

import { createTraceCollector } from "./trace";

const expectedTools = [
  "circle_login",
  "circle_logout",
  "fetch_setup_skill",
  "fetch_sub_skill",
  "circle_list_wallets",
  "circle_create_wallet",
  "circle_get_balance",
  "circle_deploy_wallet",
  "circle_wallet_fund",
  "circle_fund_fiat",
  "circle_search_services",
  "circle_inspect_service",
  "fetch_service",
  "call_free_service",
  "circle_get_gateway_balance",
  "circle_pay_service",
  "circle_gateway_deposit",
];

describe("BUFI on Shrooms contracts", () => {
  test("composes the complete Vercel AI Circle roster", () => {
    const tools = buildTools(async () => "n");
    expect(Object.keys(tools)).toEqual(expectedTools);
  });

  test("keeps approval language on both paid tools", () => {
    const tools = buildTools(async () => "n");
    expect(tools.circle_pay_service.description?.toLowerCase()).toContain(
      "approval",
    );
    expect(tools.circle_gateway_deposit.description?.toLowerCase()).toContain(
      "spends usdc",
    );
  });

  test("stores bounded metadata-only step traces", () => {
    const lines: string[] = [];
    const trace = createTraceCollector((line) => lines.push(line), 2);
    trace.record({
      step: 1,
      finishReason: "tool-calls",
      toolCallCount: 1,
      text: "secret one",
    });
    trace.record({
      step: 2,
      finishReason: "tool-calls",
      toolCallCount: 2,
      text: "secret two",
    });
    trace.record({
      step: 3,
      finishReason: "stop",
      toolCallCount: 0,
      text: "secret three",
    });
    const snapshot = trace.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.sequence).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(lines.at(-1)).toContain("tools=0");
  });
});
