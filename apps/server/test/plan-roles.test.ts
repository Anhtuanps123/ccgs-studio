import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PipelineStep } from '@ccgs/shared';
import { ART_SKILL, activeRoles, checkPlan, fillRoles, loadRoles, loadTemplates, roleOfSkill, rolesPrompt } from '../src/pipelines/plan-rules';
import { normalizeStep, plannerPrompt, criticPrompt } from '../src/pipelines/pipeline.service';

const { templates } = loadTemplates();
const { roles, errors } = loadRoles();
const KNOWN = new Set(['quick-design', 'design-system', 'ux-design', 'ux-review', 'prototype', 'create-epics', 'create-stories', 'dev-story', 'story-done', 'qa-plan', ART_SKILL]);
const mk = (s: any) => normalizeStep(s, KNOWN, false);

function run(skills: (string | Record<string, any>)[], chosen: string[] | null, byUser = false) {
  const steps: PipelineStep[] = skills.map(x => mk(typeof x === 'string' ? { skill: x } : x));
  return checkPlan({
    steps, type: 'feature-ui', slug: 'piggy-bank', omitted: [], rigor: 'minimal', request: 'Piggy bank', templates,
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-roles-')), byUser, make: s => normalizeStep(s, KNOWN, true), roles, chosen,
  });
}
const rules = (r: ReturnType<typeof run>, level: string) => r.issues.filter(i => i.level === level).map(i => i.rule);

describe('plan roles', () => {
  it('plan-roles.yaml loads; every template skill has exactly one role', () => {
    expect(errors).toEqual([]);
    expect(roles.map(r => r.id)).toEqual(['design', 'uiux', 'art', 'dev', 'qa']);
    for (const t of templates) for (const s of t.steps) expect(roles.filter(r => r.skills.includes(s.skill)).length, s.skill).toBe(1);
    expect(roleOfSkill('dev-story', roles)).toBe('dev');
    expect(roleOfSkill(ART_SKILL, roles)).toBe('art');
    expect(roleOfSkill('nope', roles)).toBeNull();
  });
  it('broken or missing file: no roles, no crash', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-roles-'));
    expect(loadRoles(path.join(d, 'none.yaml'))).toEqual({ roles: [], errors: [] });
    fs.writeFileSync(path.join(d, 'r.yaml'), 'roles:\n  - id: Bad Id\n  - id: ok\n    skills: [/x]\n');
    const r = loadRoles(path.join(d, 'r.yaml'));
    expect(r.roles).toEqual([{ id: 'ok', title: 'ok', hint: '', skills: ['x'] }]);
    expect(r.errors).toHaveLength(1);
  });
  it('activeRoles: nothing or every role chosen = no filter; unknown ids dropped', () => {
    expect(activeRoles(null, roles)).toBeNull();
    expect(activeRoles([], roles)).toBeNull();
    expect(activeRoles(roles.map(r => r.id), roles)).toBeNull();
    expect(activeRoles(['dev', 'zzz'], roles)).toEqual(['dev']);
  });
  it('fillRoles keeps a known role, replaces an unknown one with the skill role', () => {
    const s = fillRoles([{ skill: 'qa-plan', role: null }, { skill: null, role: 'design' }, { skill: 'ux-design', role: 'zzz' }, { skill: null, role: null }], roles);
    expect(s.map(x => x.role)).toEqual(['qa', 'design', 'uiux', null]);
  });
  it('every role chosen: same result as before, steps get roles', () => {
    const r = run(['quick-design', 'ux-design', 'create-stories'], roles.map(x => x.id));
    expect(r.steps.map(s => s.skill)).toEqual(['quick-design', ART_SKILL, 'ux-design', 'create-stories']);
    expect(r.steps.map(s => s.role)).toEqual(['design', 'art', 'uiux', 'dev']);
    expect(rules(r, 'error')).toEqual([]);
  });
  it('only Developer: design/UI/art steps are not required nor auto-added', () => {
    const r = run(['create-stories'], ['dev']);
    expect(r.steps.map(s => s.skill)).toEqual(['create-stories']);
    expect(rules(r, 'error')).toEqual([]);
    expect(r.issues.filter(i => i.rule === 'role' && i.level === 'info').map(i => i.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('/quick-design'), expect.stringContaining('/ux-design'), expect.stringContaining('Designer'),
    ]));
  });
  it('a step of a role the user did not choose is a warning (planner and user edit alike)', () => {
    for (const byUser of [false, true]) {
      const r = run(['create-stories', 'qa-plan'], ['dev'], byUser);
      expect(r.issues.find(i => i.rule === 'role' && i.level === 'warn')?.message).toContain('Tester');
    }
  });
  it('a missing step of a chosen role is still an error', () => {
    expect(rules(run(['ux-design'], ['dev', 'uiux', 'art']), 'error')).toContain('required');
  });
  it('prompts: planner lists roles and the choice; critic knows other roles are left out', () => {
    const all = rolesPrompt(roles, null);
    expect(all).toContain('uiux (UI/UX)');
    expect(all).toContain('every role');
    const only = plannerPrompt('Lucky spin', [], 'minimal', null, null, templates, null, roles, ['dev', 'qa']);
    expect(only).toContain('ONLY these roles for this plan: Developer, Tester');
    expect(only).toContain('"role": "<role id>"');
    expect(plannerPrompt('x', [], 'minimal', null, null, templates, null)).not.toContain('"role"');
    const p: any = { request: 'x', rigor: 'minimal', planType: 'feature-ui', steps: [mk({ skill: 'create-stories', role: 'dev' })], issues: [], roles: ['dev'] };
    const c = criticPrompt(p, 1, templates, roles);
    expect(c).toContain('only the roles Developer');
    expect(c).toContain('do not report it as missing');
    expect(c).toContain('"role": "dev"');
    expect(criticPrompt({ ...p, roles: null }, 1, templates, roles)).not.toContain('only the roles');
  });
});
