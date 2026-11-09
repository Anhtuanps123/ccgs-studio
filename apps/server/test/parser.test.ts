import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitFrontmatter, loadAgents, loadSkills, loadRules, loadHooks, loadWorkflows, checkProject } from '../src/ccgs/parser';
import { kindsForPath } from '../src/ccgs/adapter.service';
import { isAllowedOrigin, isLoopbackHost } from '../src/security/origin';

let root: string;
const w = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-fixture-'));
  w('.claude/agents/producer.md', '---\nname: producer\ndescription: "Sprint planning"\ntools: Read, Write, Agent\nmodel: opus\nmaxTurns: 30\n---\nBody');
  w('.claude/agents/broken.md', '---\nname: [unclosed\n---\nBody');
  w('.claude/docs/agent-roster.md', '## Tier 1 -- Leadership Agents\n| Agent | Domain |\n|--|--|\n| `producer` | prod |\n');
  w('.claude/skills/sprint-plan/SKILL.md', '---\nname: sprint-plan\ndescription: Plan\nargument-hint: "[weeks]"\nuser-invocable: true\nmodel: sonnet\n---\nSpawn subagent_type: producer');
  w('.claude/skills/no-md/references/x.md', 'x');
  w('.claude/rules/gameplay.md', '---\npaths:\n  - "Assets/**/*.cs"\n---\nRule');
  w('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'bash stop.sh', timeout: 5 }] }] } }));
  w('.claude/settings.local.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node x/ccgs-studio-hook.mjs' }] }] } }));
  w('.claude/docs/workflow-catalog.yaml', 'paths:\n  minimal:\n    label: Minimal\n    steps:\n      - id: a\n        name: A\n        command: /start\n        required: true\nphases:\n  concept:\n    label: Concept\n    steps: []\n');
  w('CLAUDE.md', '#');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('parser', () => {
  it('splits frontmatter and reports YAML errors without throwing', () => {
    expect(splitFrontmatter('---\na: 1\n---\nb').data).toEqual({ a: 1 });
    expect(splitFrontmatter('no fm').body).toBe('no fm');
    expect(splitFrontmatter('---\na: [x\n---\n').error).toBeTruthy();
  });

  it('loads agents with tier from roster and keeps broken files listed', () => {
    const a = loadAgents(root);
    expect(a.map(x => x.name)).toEqual(['broken', 'producer']);
    const p = a.find(x => x.name === 'producer')!;
    expect(p).toMatchObject({ model: 'opus', maxTurns: 30, tools: ['Read', 'Write', 'Agent'], tier: 'Tier 1: Leadership Agents', tierOrder: 0 });
    expect(a.find(x => x.name === 'broken')!.parseError).toBeTruthy();
  });

  it('loads skills, flags folders without SKILL.md, finds related agents', () => {
    const s = loadSkills(root, ['producer']);
    const sp = s.find(x => x.name === 'sprint-plan')!;
    expect(sp).toMatchObject({ argumentHint: '[weeks]', userInvocable: true, origin: 'ccgs', hasSkillMd: true });
    expect(sp.relatedAgents).toEqual([{ name: 'producer', via: 'subagent_type' }]);
    expect(s.find(x => x.name === 'no-md')!.hasSkillMd).toBe(false);
  });

  it('loads rules, hooks (owner split), workflows, project checks', () => {
    expect(loadRules(root)[0].paths).toEqual(['Assets/**/*.cs']);
    const h = loadHooks(root);
    expect(h.map(x => x.owner)).toEqual(['ccgs', 'studio']);
    expect(loadWorkflows(root).map(x => x.id)).toEqual(['path:minimal', 'concept']);
    expect(checkProject(root).valid).toBe(true);
    expect(checkProject(path.join(root, 'nope')).valid).toBe(false);
  });

  it('maps changed paths to config kinds', () => {
    expect(kindsForPath('agents/x.md')).toEqual(['agents', 'skills']);
    expect(kindsForPath(path.join('skills', 'a', 'SKILL.md'))).toEqual(['skills']);
    expect(kindsForPath('settings.local.json')).toEqual(['hooks']);
    expect(kindsForPath('agent-memory/x.md')).toEqual([]);
  });
});

describe('origin guard', () => {
  it('accepts loopback only', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4310')).toBe(true);
    expect(isAllowedOrigin('http://evil.com')).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1:4310')).toBe(true);
    expect(isLoopbackHost('evil.com:4310')).toBe(false);
  });
});

// Integration against the real CCGS project, when present.
const REAL = 'D:/Meodoku';
describe.runIf(fs.existsSync(path.join(REAL, '.claude')))('real CCGS project', () => {
  it('matches Phase 0 inventory counts', () => {
    const agents = loadAgents(REAL);
    const skills = loadSkills(REAL, agents.map(a => a.name));
    expect(agents.length).toBe(fs.readdirSync(path.join(REAL, '.claude/agents')).filter(f => f.endsWith('.md')).length);
    expect(skills.filter(s => s.hasSkillMd).length).toBe(109);
    expect(skills.filter(s => s.origin === 'symlink').length).toBe(34);
    expect(agents.filter(a => a.tier).length).toBeGreaterThan(40);
    expect(loadHooks(REAL).filter(h => h.owner === 'ccgs').length).toBe(15);
    expect(loadWorkflows(REAL).length).toBeGreaterThan(5);
  });
});
