/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'bun:test';

import { describeApproval, requiresApproval } from './approval';

describe('requiresApproval', () => {
  test('gates a plain spend command', () => {
    expect(
      requiresApproval('circle wallet transfer --to 0xabc --amount 100'),
    ).toBe(true);
    expect(requiresApproval('circle services pay https://seller.example')).toBe(
      true,
    );
  });

  test('does not gate a genuine help invocation of a gated command', () => {
    expect(requiresApproval('circle wallet transfer --help')).toBe(false);
    expect(requiresApproval('circle wallet transfer -h')).toBe(false);
  });

  test('does not gate a price estimate', () => {
    expect(
      requiresApproval('circle services pay https://seller.example --estimate'),
    ).toBe(false);
  });

  // Regression: a `-h`/`--help` carried as an argument value — not the command's
  // own help flag — used to match the loose help check and skip the gate, so a
  // real transfer could run without approval.
  test('gates a spend command carrying -h/--help as an argument value', () => {
    expect(
      requiresApproval(
        'circle wallet transfer --to 0xabc --amount 100 --memo -h',
      ),
    ).toBe(true);
    expect(
      requiresApproval(
        'circle wallet transfer --to 0xabc --amount 100 --note --help',
      ),
    ).toBe(true);
  });
});

describe('describeApproval', () => {
  test('describes a real spend but not a genuine help invocation', () => {
    expect(
      describeApproval('circle wallet transfer --to 0xabc --amount 100'),
    ).not.toBeNull();
    expect(describeApproval('circle wallet transfer --help')).toBeNull();
    // Same regression, at the describe layer.
    expect(
      describeApproval('circle wallet transfer --amount 100 --memo -h'),
    ).not.toBeNull();
  });
});
