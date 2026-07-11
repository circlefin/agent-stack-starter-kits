/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RunTurnStepEvent } from "@agent-stack-ecosystem-kits/kit-vercel-ai/agent";

export interface SafeStepTrace {
  runId: string;
  sequence: number;
  recordedAt: string;
  finishReason: string;
  toolCallCount: number;
  textCharacters: number;
}

export function createTraceCollector(
  emit: (line: string) => void,
  capacity = 200,
) {
  const runId = crypto.randomUUID();
  const events: SafeStepTrace[] = [];
  return {
    record(event: RunTurnStepEvent) {
      const trace: SafeStepTrace = {
        runId,
        sequence: event.step,
        recordedAt: new Date().toISOString(),
        finishReason: event.finishReason,
        toolCallCount: event.toolCallCount,
        textCharacters: event.text.length,
      };
      events.push(trace);
      if (events.length > capacity) events.shift();
      emit(
        `trace step=${trace.sequence} finish=${trace.finishReason} ` +
          `tools=${trace.toolCallCount} textChars=${trace.textCharacters}`,
      );
      return trace;
    },
    snapshot(): readonly SafeStepTrace[] {
      return events.map((event) => ({ ...event }));
    },
  };
}
