import { describe, expect, it } from 'vitest';
import type { ChangedFile, PipelineStep } from '@ccgs/shared';
import { checkStep, trailingQuestion, verdictOf } from '../src/pipelines/checkpoint';

const step = (skill: string | null, o: Partial<PipelineStep> = {}): PipelineStep => ({
  id: 's1', status: 'completed', taskId: 't', warning: null, generated: false, title: skill ? `/${skill}` : 'Prompt',
  skill, args: skill ? 'design/ux/popup-piggy.md' : null, prompt: skill ? null : 'làm gì đó', why: null, expand: null, ...o,
});
const files: ChangedFile[] = [{ path: 'design/ux/popup-piggy.md', change: 'M' }];
const run = (s: PipelineStep, text: string, o: { changed?: ChangedFile[] | null; output?: string | null; exists?: boolean; perm?: string } = {}) =>
  checkStep({ step: s, resultText: text, changedFiles: o.changed === undefined ? files : o.changed, permissionMode: o.perm ?? 'default', output: o.output ?? null, outputExists: o.exists ?? false });

describe('verdictOf', () => {
  it('reads the last verdict line, markdown and dev-story story lines; skips option lists', () => {
    expect(verdictOf('blah\n### Verdict: **NEEDS REVISION**\nMore text')).toBe('NEEDS REVISION');
    expect(verdictOf('Verdict: [COMPLETE | COMPLETE WITH NOTES | BLOCKED]\nVerdict: COMPLETE WITH NOTES')).toBe('COMPLETE WITH NOTES');
    expect(verdictOf('Verdict: [COMPLETE | BLOCKED]')).toBeNull();
    expect(verdictOf('Story: production/epics/a/story-001.md — INCOMPLETE — test fails')).toBe('INCOMPLETE');
    expect(verdictOf('Story: production/epics/a/story-001.md — Implemented')).toBe('IMPLEMENTED');
    expect(verdictOf('Recommendation: PIVOT')).toBe('PIVOT');
    expect(verdictOf('the verdict is complete, all good')).toBeNull();
    expect(verdictOf(null)).toBeNull();
  });
  it('finds a trailing question', () => {
    expect(trailingQuestion('Bản nháp ở trên.\n\n**May I write this to design/x.md?**')).toBe('May I write this to design/x.md?');
    expect(trailingQuestion('Xong rồi.')).toBeNull();
  });
});

describe('checkStep', () => {
  it('good verdict continues; review that needs revision gets one fix + re-run, then pauses', () => {
    expect(run(step('ux-review'), 'Verdict: APPROVED').check).toMatchObject({ decision: 'continue', verdict: 'APPROVED' });
    const r = run(step('ux-review'), 'Verdict: NEEDS REVISION');
    expect(r.check.decision).toBe('fix');
    expect(r.fix.map(f => [f.skill, f.args, f.fixOf])).toEqual([[null, null, 's1'], ['ux-review', 'design/ux/popup-piggy.md', 's1']]);
    expect(r.fix[0].prompt).toMatch(/ux-review/);
    const again = run(step('ux-review', { id: 's9', fixOf: 's1' }), 'Verdict: NEEDS REVISION');
    expect(again.check).toMatchObject({ decision: 'pause', replan: true });
    expect(again.fix).toEqual([]);
  });
  it('dev-story INCOMPLETE re-runs once; story-done BLOCKED fixes the story; off-plan verdicts suggest re-planning', () => {
    const f = 'production/epics/p/story-001.md';
    expect(run(step('dev-story', { args: f }), `Story: ${f} — INCOMPLETE — build error`).fix.map(x => x.skill)).toEqual(['dev-story']);
    expect(run(step('story-done', { args: f }), 'Verdict: BLOCKED').fix.map(x => x.skill)).toEqual(['dev-story', 'story-done']);
    expect(run(step('dev-story', { args: f }), `Story: ${f} — BLOCKED — needs ADR`).check).toMatchObject({ decision: 'pause', replan: true });
    expect(run(step('quick-design'), 'Verdict: **REDIRECTED** — use /design-system').check).toMatchObject({ decision: 'pause', replan: true });
    expect(run(step('story-done', { args: f }), 'Verdict: NOT ASSESSED').check).toMatchObject({ decision: 'pause', replan: false });
  });
  it('without a verdict: question, missing output or no file written pauses; plan mode and plain prompts go on', () => {
    expect(run(step('ux-design'), 'Draft above.\nMay I write it?').check).toMatchObject({ decision: 'pause', question: 'May I write it?' });
    expect(run(step('studio:unity-art-context', { args: 'piggy' }), 'done', { output: 'design/art-context/piggy.md', exists: false }).check.decision).toBe('pause');
    expect(run(step('studio:unity-art-context', { args: 'piggy' }), 'done', { output: 'design/art-context/piggy.md', exists: true }).check.decision).toBe('continue');
    expect(run(step('ux-design'), 'xong', { changed: [] }).check.reason).toMatch(/không tạo hoặc sửa file/);
    expect(run(step('ux-design'), 'xong', { changed: [], perm: 'plan' }).check.decision).toBe('continue');
    expect(run(step('ux-design'), 'xong', { changed: null }).check.decision).toBe('continue');
    expect(run(step(null), 'ok').check.decision).toBe('continue');
    expect(run(step('ux-design'), 'Verdict: COMPLETE\nMuốn chạy /ux-review không?').check.decision).toBe('continue');
  });
});
