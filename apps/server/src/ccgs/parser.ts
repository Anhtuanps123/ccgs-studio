// Pure, read-only parsers for a CCGS .claude/ folder. No caching, no watching.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  AgentDefinition, AgentDetail, Skill, SkillDetail, Rule, HookEntry, Template, WorkflowPhase, WorkflowStep,
} from '@ccgs/shared';

export const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');

export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string; error: string | null } {
  const t = text.replace(/^﻿/, '');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: t, error: null };
  try {
    const data = YAML.parse(m[1]);
    return { data: data && typeof data === 'object' ? data : {}, body: t.slice(m[0].length), error: null };
  } catch (e) {
    return { data: {}, body: t.slice(m[0].length), error: (e as Error).message.split('\n')[0] };
  }
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** Agent name -> tier label, read from the tables in .claude/docs/agent-roster.md. */
export function parseRoster(root: string): Map<string, { tier: string; order: number }> {
  const map = new Map<string, { tier: string; order: number }>();
  let order = -1;
  const f = path.join(root, '.claude', 'docs', 'agent-roster.md');
  if (!fs.existsSync(f)) return map;
  let heading: string | null = null;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const h = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (h) { heading = h[1].replace(/\s*--\s*/, ': '); order++; continue; }
    const row = line.match(/^\|\s*`([a-z0-9-]+)`\s*\|/);
    if (row && heading && !map.has(row[1])) map.set(row[1], { tier: heading, order });
  }
  return map;
}

export function parseAgentFile(root: string, file: string, roster: ReturnType<typeof parseRoster>): AgentDetail {
  const { data, body, error } = splitFrontmatter(fs.readFileSync(file, 'utf8'));
  const name = str(data.name) ?? path.basename(file, '.md');
  const maxTurns = Number(data.maxTurns);
  return {
    name,
    file: rel(root, file),
    description: str(data.description) ?? '',
    model: str(data.model),
    tools: list(data.tools),
    disallowedTools: list(data.disallowedTools),
    maxTurns: Number.isFinite(maxTurns) ? maxTurns : null,
    tier: roster.get(name)?.tier ?? null,
    tierOrder: roster.get(name)?.order ?? null,
    frontmatter: data,
    parseError: error,
    body,
  };
}

export function loadAgents(root: string): AgentDetail[] {
  const dir = path.join(root, '.claude', 'agents');
  if (!fs.existsSync(dir)) return [];
  const roster = parseRoster(root);
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    .map(f => parseAgentFile(root, path.join(dir, f), roster));
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function loadSkills(root: string, agentNames: string[]): SkillDetail[] {
  const dir = path.join(root, '.claude', 'skills');
  if (!fs.existsSync(dir)) return [];
  const out: SkillDetail[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (!isDir(full)) continue; // follows symlinks/junctions
    const link = d.isSymbolicLink() ? fs.readlinkSync(full) : null;
    const skillMd = path.join(full, 'SKILL.md');
    const has = fs.existsSync(skillMd);
    const { data, body, error } = has ? splitFrontmatter(fs.readFileSync(skillMd, 'utf8')) : { data: {}, body: '', error: null };
    const spawns = new Set([...body.matchAll(/subagent_type:\s*["'`]?([a-z0-9-]+)/g)].map(m => m[1]));
    const related: Skill['relatedAgents'] = [];
    for (const a of agentNames) {
      if (spawns.has(a)) related.push({ name: a, via: 'subagent_type' });
      else if (body.includes('`' + a + '`')) related.push({ name: a, via: 'mention' });
    }
    const isCcgs = fs.existsSync(path.join(full, 'CONTRACT.md')) || data['user-invocable'] !== undefined;
    const ui = data['user-invocable'];
    out.push({
      name: str(data.name) ?? d.name,
      dir: rel(root, full),
      origin: link ? 'symlink' : isCcgs ? 'ccgs' : 'local',
      linkTarget: link,
      hasSkillMd: has,
      description: str(data.description) ?? '',
      argumentHint: str(data['argument-hint']),
      model: str(data.model),
      allowedTools: list(data['allowed-tools']),
      userInvocable: typeof ui === 'boolean' ? ui : ui === undefined ? null : String(ui) === 'true',
      relatedAgents: related,
      parseError: error,
      body,
      file: has ? rel(root, skillMd) : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadRules(root: string): Rule[] {
  const dir = path.join(root, '.claude', 'rules');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => {
    const { data, body } = splitFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { file: f, paths: list(data.paths), body };
  });
}

export const STUDIO_HOOK_MARKER = 'ccgs-studio-hook';

function hooksFromSettings(root: string, fileRel: string, defaultOwner: HookEntry['owner']): HookEntry[] {
  const f = path.join(root, fileRel);
  if (!fs.existsSync(f)) return [];
  let json: any;
  try { json = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
  const out: HookEntry[] = [];
  for (const [event, groups] of Object.entries<any>(json?.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g?.hooks ?? []) {
        const command = String(h.command ?? '');
        out.push({
          owner: command.includes(STUDIO_HOOK_MARKER) ? 'studio' : defaultOwner,
          file: fileRel, event, matcher: String(g.matcher ?? ''), command,
          ...(h.timeout !== undefined ? { timeout: Number(h.timeout) } : {}),
        });
      }
    }
  }
  return out;
}

export function loadHooks(root: string): HookEntry[] {
  return [
    ...hooksFromSettings(root, '.claude/settings.json', 'ccgs'),
    ...hooksFromSettings(root, '.claude/settings.local.json', 'user'),
  ];
}

export function loadTemplates(root: string): Template[] {
  const dir = path.join(root, '.claude', 'docs', 'templates');
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter(f => /\.(md|ya?ml|json)$/i.test(f))
    .map(f => ({ path: rel(root, path.join(dir, f)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function loadWorkflows(root: string): WorkflowPhase[] {
  const f = path.join(root, '.claude', 'docs', 'workflow-catalog.yaml');
  if (!fs.existsSync(f)) return [];
  let doc: any;
  try { doc = YAML.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
  const toSteps = (steps: any[]): WorkflowStep[] => (steps ?? []).map((s: any) => ({
    id: String(s.id), title: String(s.name ?? s.id), command: str(s.command),
    required: s.required === true, repeatable: s.repeatable === true,
  }));
  const out: WorkflowPhase[] = [];
  for (const [id, p] of Object.entries<any>(doc?.paths ?? {})) out.push({ id: `path:${id}`, label: String(p?.label ?? id), steps: toSteps(p?.steps) });
  for (const [id, p] of Object.entries<any>(doc?.phases ?? {})) out.push({ id, label: String(p?.label ?? id), steps: toSteps(p?.steps) });
  return out;
}

export function checkProject(root: string) {
  const exists = isDir(root);
  const checks = [
    { label: 'Thư mục tồn tại', ok: exists },
    { label: 'Có thư mục .claude/', ok: exists && isDir(path.join(root, '.claude')) },
    { label: 'Có .claude/agents/', ok: exists && isDir(path.join(root, '.claude', 'agents')) },
    { label: 'Có .claude/skills/', ok: exists && isDir(path.join(root, '.claude', 'skills')) },
    { label: 'Có CLAUDE.md hoặc project.yaml', ok: exists && (fs.existsSync(path.join(root, 'CLAUDE.md')) || fs.existsSync(path.join(root, 'project.yaml'))) },
    { label: 'Là git repository', ok: exists && fs.existsSync(path.join(root, '.git')) },
  ];
  return { valid: checks.slice(0, 4).every(c => c.ok), checks };
}
