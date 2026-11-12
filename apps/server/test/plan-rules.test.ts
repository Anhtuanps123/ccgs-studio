import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PipelineStep, Rigor } from '@ccgs/shared';
import { ART_SKILL, checkPlan, loadTemplates, templatesPrompt } from '../src/pipelines/plan-rules';
import { normalizeStep } from '../src/pipelines/pipeline.service';

const { templates, errors } = loadTemplates();
const KNOWN = new Set(['quick-design', 'design-system', 'ux-design', 'ux-review', 'prototype', 'create-epics', 'create-stories', 'dev-story', 'story-done', 'gate-check', ART_SKILL]);
const mk = (s: any) => normalizeStep(s, KNOWN, false);
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-rules-'));

function run(skills: (string | [string, string])[], o: { type?: string | null; rigor?: Rigor; byUser?: boolean; omitted?: { skill: string; why: string }[]; root?: string; request?: string } = {}) {
  const steps: PipelineStep[] = skills.map(x => mk(Array.isArray(x) ? { skill: x[0], args: x[1] } : { skill: x }));
  return checkPlan({
    steps, type: o.type === undefined ? 'feature-ui' : o.type, slug: 'piggy-bank', omitted: o.omitted ?? [], rigor: o.rigor ?? 'minimal',
    request: o.request ?? 'Piggy bank', templates, root: o.root ?? root(), byUser: o.byUser ?? false, make: s => normalizeStep(s, KNOWN, true),
  });
}
const lv = (r: ReturnType<typeof run>, level: string) => r.issues.filter(i => i.level === level).map(i => i.rule);

describe('plan templates', () => {
  it('all template files load and the prompt lists them for the rigor', () => {
    expect(errors).toEqual([]);
    expect(templates.map(t => t.id).sort()).toEqual(['bugfix', 'content', 'feature-logic', 'feature-ui', 'other', 'tuning']);
    const p = templatesPrompt(templates, 'minimal');
    expect(p).toContain('feature-ui');
    expect(p).toContain('/quick-design');
    expect(templatesPrompt(templates, 'standard')).toContain('/design-system');
  });
});

describe('checkPlan', () => {
  it('feature-ui minimal: inserts art context before the first UI step, no errors', () => {
    const r = run(['quick-design', 'ux-design', 'create-stories']);
    expect(r.steps.map(s => s.skill)).toEqual(['studio:project-conventions', 'quick-design', ART_SKILL, 'ux-design', 'create-stories']);
    expect(r.steps[0]).toMatchObject({ args: null, generated: true });
    expect(r.steps[2]).toMatchObject({ args: 'piggy-bank', generated: true });
    expect(lv(r, 'error')).toEqual([]);
    expect(lv(r, 'info')).toEqual(expect.arrayContaining(['art-context', 'conventions']));
  });
  it('art context sheet already on disk: no insert, missing step is info', () => {
    const d = root();
    fs.mkdirSync(path.join(d, 'design/art-context'), { recursive: true });
    fs.writeFileSync(path.join(d, 'design/art-context/piggy-bank.md'), '#');
    const r = run(['quick-design', 'ux-design', 'create-stories'], { root: d });
    expect(r.steps.some(s => s.skill === ART_SKILL)).toBe(false);
    expect(lv(r, 'error')).toEqual([]);
    const r2 = run(['quick-design', ART_SKILL, 'ux-design', 'create-stories'], { root: d });
    expect(lv(r2, 'warn')).toContain('exists');
  });
  it('wrong order and art after UI are errors', () => {
    const r = run(['create-stories', 'quick-design', 'ux-design', ART_SKILL]);
    expect(lv(r, 'error')).toEqual(expect.arrayContaining(['order', 'art-context']));
  });
  it('missing required step: error, or info with a reason; a user edit only warns', () => {
    expect(lv(run(['ux-design', 'create-stories']), 'error')).toContain('required');
    expect(lv(run(['ux-design', 'create-stories'], { omitted: [{ skill: '/quick-design', why: 'đã có brief' }] }), 'error')).toEqual([]);
    const u = run(['ux-design', 'create-stories'], { byUser: true });
    expect(lv(u, 'error')).toEqual([]);
    expect(lv(u, 'warn')).toContain('required');
    expect(u.steps.some(s => s.skill === ART_SKILL)).toBe(false); // no auto-fix on user edits
  });
  it('standard rigor needs design-system and create-epics; repeatable UX steps may interleave per screen', () => {
    expect(run([ART_SKILL, 'ux-design', 'create-stories'], { rigor: 'standard' }).issues.filter(i => i.rule === 'required').map(i => i.message).join()).toMatch(/design-system.*create-epics/);
    const r = run(['design-system', 'design-review', ART_SKILL, 'ux-design', 'ux-review', 'prototype', 'ux-design', 'ux-review', 'create-epics', 'create-stories'], { rigor: 'full' });
    expect(lv(r, 'error')).toEqual([]);
  });
  it('dev-story gets story-done; dev-story before create-stories is an error; unknown type falls back to other', () => {
    const f = 'production/epics/piggy-bank/story-001-a.md';
    const r = run(['quick-design', 'create-stories', ['dev-story', f]], { type: 'tuning' });
    expect(r.steps.map(s => s.skill)).toEqual(['quick-design', 'create-stories', 'dev-story', 'story-done']);
    expect(lv(run([['dev-story', f], 'quick-design', 'create-stories'], { type: 'tuning' }), 'error')).toContain('stories');
    const o = run(['gate-check'], { type: 'nope' });
    expect(lv(o, 'error')).toContain('type');
    expect(lv(o, 'warn')).toEqual(expect.arrayContaining(['ask-first', 'why']));
    expect(lv(run(['ux-design', 'create-stories'], { type: 'tuning' }), 'warn')).toContain('type');
  });
  it('no templates on disk: the check is off', () => {
    const r = checkPlan({ steps: [mk({ skill: 'dev-story' })], type: null, slug: null, omitted: [], rigor: 'minimal', request: '', templates: [], root: null, byUser: false, make: mk });
    expect(r.issues).toEqual([]);
  });
});
