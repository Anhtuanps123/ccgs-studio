// Studio's own skills ship as a local Claude Code plugin (apps/server/plugin), loaded into every task
// session through the Agent SDK `plugins` option. Nothing is written into the CCGS project.
import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter } from './ccgs/parser';

/** apps/server/plugin — same depth from src/ and dist/. */
export const STUDIO_PLUGIN_DIR = path.resolve(__dirname, '..', 'plugin');
export const STUDIO_PLUGIN = 'studio';

export interface StudioSkill { name: string; description: string; argumentHint: string | null }

/** Skills of the Studio plugin, named as Claude Code invokes them: `studio:<skill>`. */
export function studioSkills(dir = STUDIO_PLUGIN_DIR): StudioSkill[] {
  const root = path.join(dir, 'skills');
  if (!fs.existsSync(root)) return [];
  const out: StudioSkill[] = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, d.name, 'SKILL.md');
    if (!d.isDirectory() || !fs.existsSync(f)) continue;
    const { data } = splitFrontmatter(fs.readFileSync(f, 'utf8'));
    const s = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
    out.push({ name: `${STUDIO_PLUGIN}:${s(data.name) ?? d.name}`, description: s(data.description) ?? '', argumentHint: s(data['argument-hint']) });
  }
  return out;
}
