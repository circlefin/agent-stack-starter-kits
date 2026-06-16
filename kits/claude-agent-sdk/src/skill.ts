export const SKILLS_BASE_URL = 'https://agents.circle.com/skills';
export const SETUP_SKILL_URL = `${SKILLS_BASE_URL}/setup.md`;

export const SUB_SKILLS = {
  'wallet-login': `${SKILLS_BASE_URL}/wallet-login.md`,
  'wallet-fund': `${SKILLS_BASE_URL}/wallet-fund.md`,
  'wallet-pay': `${SKILLS_BASE_URL}/wallet-pay.md`,
  'discover-services': `${SKILLS_BASE_URL}/discover-services.md`,
} as const satisfies Record<string, string>;

export type SubSkillName = keyof typeof SUB_SKILLS;

export const SUB_SKILL_NAMES = Object.keys(SUB_SKILLS) as SubSkillName[];

async function fetchMarkdown(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${res.status} ${res.statusText}. ` +
        'Check connectivity or visit the URL in a browser to confirm it is reachable.',
    );
  }
  return res.text();
}

export function fetchSetupSkill(): Promise<string> {
  return fetchMarkdown(SETUP_SKILL_URL);
}

export function fetchSubSkill(name: SubSkillName): Promise<string> {
  const url = SUB_SKILLS[name];
  return fetchMarkdown(url);
}
