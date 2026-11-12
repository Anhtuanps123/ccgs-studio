import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PipelineStep, Rigor } from '@ccgs/shared';
import { ART_SKILL, checkPlan, loadTemplates } from '../src/pipelines/plan-rules';
import { normalizeStep } from '../src/pipelines/pipeline.service';
import {
  activeOpenItems, COMPARE_SKILL, CONVENTIONS_SKILL, openItemsPrompt, openQuestions, projectState, ruleChecklist, storyGate, storySteps,
} from '../src/pipelines/studio-rules';

const { templates } = loadTemplates();
const ALL = new Set(['quick-design', 'design-system', 'ux-design', 'ux-review', 'prototype', 'create-epics', 'create-stories', 'dev-story', 'story-done',
  'story-readiness', 'propagate-design-change', 'bug-report', 'code-review', 'team-qa', 'smoke-check', ART_SKILL, CONVENTIONS_SKILL, COMPARE_SKILL]);
const root = (files: Record<string, string> = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-srules-'));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
  return d;
};
type S = string | { skill?: string | null; args?: string; prompt?: string };
function run(steps: S[], o: { type?: string; rigor?: Rigor; byUser?: boolean; root?: string; request?: string; known?: Set<string>; slug?: string } = {}) {
  const known = o.known ?? ALL;
  const ps: PipelineStep[] = steps.map(x => normalizeStep(typeof x === 'string' ? { skill: x } : x, known, false));
  return checkPlan({
    steps: ps, type: o.type ?? 'feature-ui', slug: o.slug ?? 'piggy-bank', omitted: [], rigor: o.rigor ?? 'minimal', request: o.request ?? 'Piggy bank',
    templates, root: o.root ?? root(), byUser: o.byUser ?? false, known, make: s => normalizeStep(s, known, true),
  });
}
const rules = (r: ReturnType<typeof run>, level: string) => r.issues.filter(i => i.level === level).map(i => i.rule);

const ACTIVE = `<!-- STATUS -->
Epic:
<!-- /STATUS -->

<!-- CHECKPOINT -->
**Updated:** 2026-11-12
**Next step:** /story-done production/epics/piggy-bank/story-004-home-piggy-button.md
**Blocked on:** nothing
**Open questions:** none
<!-- /CHECKPOINT -->

- Task: /design-system piggy-bank
- Status: Complete — GDD updated; chưa chạy /design-review
- Open: MAX_POINT=200 cần xác nhận; chống chỉnh đồng hồ máy
- Open: MAX_POINT=200 cần xác nhận; chống chỉnh đồng hồ máy
`;

describe('active.md (rule 9)', () => {
  it('takes the checkpoint next step, "Open:" lines and unreviewed docs; skips none/nothing and duplicates', () => {
    const items = activeOpenItems(ACTIVE);
    expect(items).toEqual([
      { kind: 'checkpoint', text: 'Next step: /story-done production/epics/piggy-bank/story-004-home-piggy-button.md' },
      { kind: 'unreviewed', text: '/design-system piggy-bank — Status: Complete — GDD updated; chưa chạy /design-review' },
      { kind: 'open', text: '/design-system piggy-bank — MAX_POINT=200 cần xác nhận; chống chỉnh đồng hồ máy' },
    ]);
    expect(openItemsPrompt(items)).toContain('MAX_POINT=200');
    expect(openItemsPrompt([])).toBe('');
  });
});

describe('open questions (rule 3)', () => {
  it('reads bullets under an Open Questions heading, bold lines and TBD markers; ignores resolved, none and code blocks', () => {
    const doc = `# Story
## Acceptance Criteria
- Nút Claim hiện khi đủ điểm
- Giá trị TBD sau playtest
## Open Questions
- Nhãn nút "Break!" hay "Claim"?
- ~~Có cần âm thanh?~~
- [x] Đã chốt: dùng UTC
## Notes
\`\`\`
CẦN QUYẾT trong code mẫu
\`\`\`
**Open questions:** none
`;
    expect(openQuestions(doc)).toEqual(['Giá trị TBD sau playtest', 'Nhãn nút "Break!" hay "Claim"?']);
    expect(openQuestions('## Open Questions\n- None\n')).toEqual([]);
    expect(openQuestions('**Câu hỏi mở:** MAX_POINT là 200 hay 300?')).toEqual(['MAX_POINT là 200 hay 300?']);
  });
  it('storyGate reads the story, its GDD and UX specs of the slug', () => {
    const d = root({
      'production/epics/piggy-bank/story-003-popup.md': '# Story\n## Open Questions\n- Nhãn nút?\n',
      'design/gdd/piggy-bank.md': '# GDD\nMAX_POINT: CẦN QUYẾT\n',
      'design/ux/popup-piggy-bank.md': '# UX\nKhông có gì treo\n',
      'design/ux/lucky-spin.md': '# UX\nTBD\n',
    });
    const g = storyGate(d, 'production/epics/piggy-bank/story-003-popup.md', null);
    expect(g.files).toEqual(['production/epics/piggy-bank/story-003-popup.md', 'design/gdd/piggy-bank.md']);
    expect(g.items).toEqual(['story-003-popup.md: Nhãn nút?', 'piggy-bank.md: MAX_POINT: CẦN QUYẾT']);
    expect(storyGate(d, 'production/epics/piggy-bank/story-404.md', 'piggy-bank').files).toEqual(['design/gdd/piggy-bank.md']);
  });
});

describe('plan rules 1, 4, 5, 8', () => {
  it('rule 1: minimal with 3+ epics warns', () => {
    const d = root({ 'production/epics/a/EPIC.md': '', 'production/epics/b/EPIC.md': '', 'production/epics/c/EPIC.md': '', 'design/conventions.md': '' });
    expect(rules(run(['quick-design', 'create-stories'], { type: 'feature-logic', root: d }), 'warn')).toContain('rigor');
    expect(rules(run(['quick-design', 'create-stories'], { type: 'feature-logic', root: d, rigor: 'standard' }), 'warn')).not.toContain('rigor');
    expect(projectState(d, 'minimal')).toMatchObject({ epics: 3, gdds: 0, conventions: { exists: true }, openItems: [], openSource: null });
  });
  it('rule 4: redesigning a feature that has stories adds a story update step (and propagate for a GDD); user edit only warns', () => {
    const d = root({ 'production/epics/piggy-bank/story-001-rules.md': '# s', 'design/conventions.md': '' });
    const r = run(['quick-design', 'create-stories'], { type: 'feature-logic', root: d });
    expect(r.steps.map(s => s.skill ?? 'prompt')).toEqual(['quick-design', 'prompt', 'create-stories']);
    expect(r.steps[1].prompt).toContain('production/epics/piggy-bank/story-001-rules.md');
    expect(rules(r, 'info')).toContain('propagate');
    const std = run(['design-system', 'create-epics', 'create-stories'], { type: 'feature-logic', root: d, rigor: 'standard' });
    expect(std.steps.map(s => s.skill ?? 'prompt')).toEqual(['design-system', 'propagate-design-change', 'prompt', 'create-epics', 'create-stories']);
    expect(std.steps[1].args).toBe('design/gdd/piggy-bank.md');
    expect(rules(std, 'error')).toEqual([]);
    expect(rules(run(['quick-design', 'create-stories'], { type: 'feature-logic', root: d, byUser: true }), 'warn')).toContain('propagate');
    // No stories yet: nothing to propagate.
    expect(run(['quick-design', 'create-stories'], { type: 'feature-logic' }).steps).toHaveLength(2);
  });
  it('rule 5: a bugfix plan without a fixing step is an error; evaluators only on a fix request warn', () => {
    expect(rules(run(['bug-report', 'code-review'], { type: 'bugfix', request: 'Sửa lỗi điểm' }), 'error')).toContain('fix-step');
    expect(rules(run(['bug-report', { prompt: 'Sửa PiggyBank.Claim' }], { type: 'bugfix', request: 'Sửa lỗi điểm' }), 'error')).not.toContain('fix-step');
    expect(rules(run(['team-qa'], { type: 'other', request: 'Fix bug popup' }), 'warn')).toContain('fix-step');
  });
  it('rule 8: a UI bugfix gets studio:ui-compare after the last fix step; user edit or unknown skill only warns', () => {
    const r = run(['bug-report', { prompt: 'Sửa popup' }, 'code-review'], { type: 'bugfix', request: 'Sửa lỗi nút close popup bị lệch' });
    expect(r.steps.map(s => s.skill ?? 'prompt')).toEqual(['bug-report', 'prompt', COMPARE_SKILL, 'code-review']);
    expect(rules(r, 'error')).toEqual([]);
    expect(rules(run(['bug-report', { prompt: 'Sửa popup' }], { type: 'bugfix', request: 'Sửa popup lệch', byUser: true }), 'warn')).toContain('ui-compare');
    const known = new Set([...ALL].filter(s => s !== COMPARE_SKILL));
    expect(rules(run(['bug-report', { prompt: 'Sửa popup' }], { type: 'bugfix', request: 'Sửa popup lệch', known }), 'warn')).toContain('ui-compare');
    expect(run(['bug-report', { prompt: 'Sửa công thức điểm' }], { type: 'bugfix', request: 'Sửa lỗi cộng điểm' }).steps).toHaveLength(2);
  });
  it('rule 7: conventions on disk = no insert; unknown skill = no insert', () => {
    const d = root({ 'design/conventions.md': '# x' });
    expect(run(['quick-design', 'ux-design', 'create-stories'], { root: d }).steps.map(s => s.skill)).not.toContain(CONVENTIONS_SKILL);
    const known = new Set([...ALL].filter(s => s !== CONVENTIONS_SKILL));
    expect(run(['quick-design', 'ux-design', 'create-stories'], { known }).steps.map(s => s.skill)).not.toContain(CONVENTIONS_SKILL);
  });
});

describe('story steps and checklist', () => {
  it('readiness at standard/full, UI compare on UI plans, filtered by known skills and roles', () => {
    const f = 'production/epics/x/story-001-a.md';
    expect(storySteps(f, { rigor: 'minimal', ui: false, known: ALL }).map(s => s.skill)).toEqual(['dev-story', 'story-done']);
    expect(storySteps(f, { rigor: 'standard', ui: true, known: ALL }).map(s => s.skill)).toEqual(['story-readiness', 'dev-story', COMPARE_SKILL, 'story-done']);
    expect(storySteps(f, { rigor: 'full', ui: true, known: ALL, allow: s => s !== COMPARE_SKILL }).map(s => s.skill)).toEqual(['story-readiness', 'dev-story', 'story-done']);
    expect(storySteps(f, { rigor: 'full', ui: true, known: new Set(['dev-story', 'story-done']) }).map(s => s.skill)).toEqual(['dev-story', 'story-done']);
  });
  it('one line per rule 1..9', () => {
    const d = root({ 'production/session-state/active.md': ACTIVE });
    const r = run(['quick-design', 'ux-design', 'create-stories'], { root: d });
    const c = ruleChecklist({ steps: r.steps, issues: r.issues, ui: true, request: 'Piggy bank', type: 'feature-ui', slug: 'piggy-bank', root: d, rigor: 'minimal' });
    expect(c.map(x => x.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Object.fromEntries(c.map(x => [x.rule, x.state]))).toEqual({ 1: 'ok', 2: 'ok', 3: 'todo', 4: 'na', 5: 'na', 6: 'ok', 7: 'todo', 8: 'todo', 9: 'warn' });
  });
});
