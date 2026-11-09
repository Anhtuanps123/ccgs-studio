// Phase 0 spike: inventory a CCGS .claude/ folder. Read-only.
// Usage: node spikes/inventory.mjs <projectRoot> [upstreamSkillsDir]
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const upstream = process.argv[3];
const C = path.join(root, '.claude');

function fm(file) {
  const t = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { _noFrontmatter: true };
  const o = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) { key = kv[1]; o[key] = kv[2].replace(/^["']|["']$/g, ''); }
    else if (key && /^\s+-\s+/.test(line)) {
      o[key] = (Array.isArray(o[key]) ? o[key] : []).concat(line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, ''));
    }
  }
  return o;
}
const keyCount = (arr) => arr.reduce((a, o) => { for (const k of Object.keys(o)) a[k] = (a[k] || 0) + 1; return a; }, {});

const agents = fs.readdirSync(path.join(C, 'agents')).filter(f => f.endsWith('.md'))
  .map(f => ({ file: f, ...fm(path.join(C, 'agents', f)) }));
const skillDirs = fs.readdirSync(path.join(C, 'skills'), { withFileTypes: true }).filter(d => d.isDirectory() || (d.isSymbolicLink() && fs.statSync(path.join(C, 'skills', d.name)).isDirectory())).map(d => Object.assign(d, { link: d.isSymbolicLink() ? fs.readlinkSync(path.join(C, 'skills', d.name)) : null }));
const up = upstream ? new Set(fs.readdirSync(upstream)) : null;
const skills = skillDirs.map(d => {
  const p = path.join(C, 'skills', d.name, 'SKILL.md');
  const has = fs.existsSync(p);
  const meta = has ? fm(p) : {};
  const body = has ? fs.readFileSync(p, 'utf8') : '';
  const spawns = [...new Set([...body.matchAll(/subagent_type:\s*["'`]?([a-z0-9-]+)/g)].map(m => m[1]))];
  const mentions = agents.map(a => a.name).filter(n => body.includes('`' + n + '`') || body.includes(n + ' agent'));
  return { dir: d.name, hasSkillMd: has, origin: d.link ? 'symlink:' + d.link : up ? (up.has(d.name) ? 'ccgs' : 'non-ccgs') : '?', spawns, mentions: mentions.length, ...meta };
});
const rules = fs.readdirSync(path.join(C, 'rules')).filter(f => f.endsWith('.md'))
  .map(f => ({ file: f, ...fm(path.join(C, 'rules', f)) }));
const settings = JSON.parse(fs.readFileSync(path.join(C, 'settings.json'), 'utf8'));
const hooks = Object.entries(settings.hooks || {}).flatMap(([ev, groups]) =>
  groups.flatMap(g => (g.hooks || []).map(h => ({ event: ev, matcher: g.matcher ?? '', command: h.command, timeout: h.timeout }))));
const templates = fs.readdirSync(path.join(C, 'docs', 'templates'), { recursive: true }).filter(f => /\.(md|yaml|json)$/.test(f));

const out = {
  counts: {
    agents: agents.length, skills: skills.length,
    skillsCcgs: skills.filter(s => s.origin === 'ccgs').length,
    skillsNonCcgs: skills.filter(s => s.origin === 'non-ccgs').length, skillsSymlinked: skills.filter(s => s.origin.startsWith('symlink')).length, skillsNoSkillMd: skills.filter(s => !s.hasSkillMd).map(s => s.dir),
    rules: rules.length, hookEntries: hooks.length, hookEvents: Object.keys(settings.hooks || {}).length,
    templates: templates.length,
  },
  agentFrontmatterKeys: keyCount(agents),
  agentModels: agents.reduce((a, x) => (a[x.model] = (a[x.model] || 0) + 1, a), {}),
  agentsWithAgentTool: agents.filter(a => /\b(Agent|Task)\b/.test(a.tools || '')).map(a => a.name),
  skillFrontmatterKeys: keyCount(skills.map(({ dir, hasSkillMd, origin, spawns, mentions, ...m }) => m)),
  skillsWithContextFork: skills.filter(s => s.context).map(s => `${s.dir}:${s.context}${s.agent ? '/' + s.agent : ''}`),
  skillsSpawningAgents: skills.filter(s => s.spawns.length).length,
  nonCcgsSkills: skills.filter(s => s.origin === 'non-ccgs').map(s => s.dir),
  hooks,
  rules: rules.map(r => ({ file: r.file, paths: r.paths })),
  agents: agents.map(a => ({ name: a.name, model: a.model, tools: a.tools, maxTurns: a.maxTurns })),
  skills: skills.map(s => ({ dir: s.dir, origin: s.origin, model: s.model, args: s['argument-hint'], userInvocable: s['user-invocable'], spawns: s.spawns })),
};
console.log(JSON.stringify(out, null, 1));
