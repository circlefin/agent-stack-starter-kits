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

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function sgr(open: number, close: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const violet = sgr(35, 39);
export const cyan = sgr(36, 39);
export const gray = sgr(90, 39);

export function bufiLine(line: string): string {
  return `${dim(violet('[bufi-workspace]'))} ${line}`;
}

export function toolLine(line: string): string {
  const prefix = dim(cyan('[tool]'));
  const m = /^(\S+)([\s\S]*)$/.exec(line);
  if (!m) return `${prefix} ${line}`;
  const name = bold(m[1] ?? '');
  const rest = m[2] ?? '';
  const fail = rest.indexOf('x');
  if (fail >= 0) return `${prefix} ${name}${rest.slice(0, fail)}${red('x')}${red(rest.slice(fail + 1))}`;
  const hit = rest.indexOf('<-');
  if (hit >= 0) return `${prefix} ${name}${rest.slice(0, hit)}${green('<-')}${dim(rest.slice(hit + 2))}`;
  return `${prefix} ${name}${rest.replace(/(\b\w+)=/g, (_w, k) => `${gray(k)}=`)}`;
}

export function heading(label: string): string {
  return bold(violet(label));
}
