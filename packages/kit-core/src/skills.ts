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
 * Circle's skills, read off the disk they are installed on.
 *
 * The kits ship none of them. They are markdown the agent installs for itself on
 * its first run (`circle skill install`, or the registry's `skills add`
 * fallback), into `~/.agents/skills` — the tool-neutral store that
 * `~/.claude/skills` and its equivalents symlink into. So the same files back
 * this agent, Claude Code, and Codex: install once, and every agent on the
 * machine knows how to work a Circle wallet.
 *
 * What reaches the model is the index, not the documents. Seventeen skills is
 * far more than a system prompt should carry, and most turns need none of them,
 * so each contributes a name, a description and a path — enough to decide *which*
 * one is relevant — and the agent reads the body with `read_file` when it turns
 * out to be. That is progressive disclosure, the same shape Claude Code uses,
 * and it is why the file tools sit next to the shell rather than being an
 * afterthought.
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The skills registry's global install directory, and the tool-specific
 * directory that symlinks into it. Both are read so a user who installed
 * through any supported route is found; `~/.agents/skills` wins a name clash
 * because it is the one Circle's own setup document installs to.
 */
export const SKILLS_DIR = join(homedir(), '.agents', 'skills');
const FALLBACK_SKILLS_DIRS = [join(homedir(), '.claude', 'skills')];

/**
 * Cap on one skill's description in the index.
 *
 * Circle's descriptions are long on purpose — they are written to be matched
 * against a user's phrasing, so they enumerate trigger words — and seventeen of
 * them unabridged is a system prompt in its own right. The cut keeps enough to
 * route on; the document itself is one `read_file` away.
 */
const MAX_DESCRIPTION_CHARS = 320;

export interface InstalledSkill {
  /** The skill's `name` from its frontmatter, falling back to its directory name. */
  name: string;
  /** The skill's `description` from its frontmatter, if it declares one. */
  description: string;
  /** Absolute path to the SKILL.md, which is what the agent reads. */
  path: string;
}

/**
 * Read the value of one frontmatter key.
 *
 * Deliberately not a YAML parser: skill frontmatter is a flat map of two scalar
 * keys, and the failure mode of a partial parser here is a missing description,
 * not a crash. It handles what SKILL.md files actually use — plain scalars,
 * quoted strings with escapes, and `|`/`>` block scalars — and returns null for
 * anything else.
 */
function frontmatterValue(frontmatter: string, key: string): string | null {
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;

  const raw = (lines[start] ?? '').slice(key.length + 1).trim();

  // Block scalar: the value is the indented lines that follow, folded to one
  // line either way, since nothing downstream renders the line breaks.
  if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-') {
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      body.push(line.trim());
    }
    return body.join(' ').trim();
  }

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw || null;
}

/** Pull `name` and `description` out of a SKILL.md's `---` frontmatter block. */
function parseSkill(markdown: string, directory: string, path: string): InstalledSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const frontmatter = match?.[1] ?? '';
  return {
    name: frontmatterValue(frontmatter, 'name') ?? directory,
    description: frontmatterValue(frontmatter, 'description') ?? '',
    path,
  };
}

/** Every SKILL.md directly under one skills directory. Missing directory reads as empty. */
async function readSkillsIn(root: string): Promise<InstalledSkill[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  // A symlinked skill is a normal install (that is how the registry shares one
  // copy between tools), so both directories and links are candidates.
  const candidates = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
  const skills = await Promise.all(
    candidates.map(async (entry) => {
      const path = join(root, entry.name, 'SKILL.md');
      try {
        return parseSkill(await readFile(path, 'utf8'), entry.name, path);
      } catch {
        // A stray file, or a directory left behind by a failed install. Neither
        // is a skill, and neither should read as one.
        return null;
      }
    }),
  );
  return skills.filter((s): s is InstalledSkill => s !== null);
}

/**
 * Every installed skill, in name order.
 *
 * Read fresh each time rather than cached: the agent installs skills *during*
 * its first run, and a cache populated before that would keep reporting an empty
 * machine for the rest of the session.
 */
export async function listSkills(): Promise<InstalledSkill[]> {
  const found = await Promise.all([SKILLS_DIR, ...FALLBACK_SKILLS_DIRS].map(readSkillsIn));
  const byName = new Map<string, InstalledSkill>();
  // First directory wins a name clash, which is `~/.agents/skills`.
  for (const skill of found.flat()) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether any skill is installed.
 *
 * This is what "has setup already run?" reduces to, and it is deliberately a
 * question about the machine rather than about the conversation: the answer has
 * to survive a new session, a cleared history, a second user, and a restart.
 */
export async function hasSkills(): Promise<boolean> {
  return (await listSkills()).length > 0;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * Render the index that goes into the system prompt: one line per skill, each
 * carrying the path to read when it turns out to be the relevant one.
 */
export function formatSkillsIndex(skills: readonly InstalledSkill[]): string {
  return skills
    .map((skill) => {
      const description = skill.description
        ? ` — ${truncate(skill.description, MAX_DESCRIPTION_CHARS)}`
        : '';
      return `- ${skill.name} (${skill.path})${description}`;
    })
    .join('\n');
}
