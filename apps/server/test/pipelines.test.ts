import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangedFile, Task } from '@ccgs/shared';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunHooks, RunOutcome, Runner } from '../src/tasks/runner';
import { PipelineService, isCriticPrompt, parsePlan, plannerPrompt, readSetup } from '../src/pipelines/pipeline.service';

const SKILLS = ['quick-design', 'create-stories', 'dev-story', 'story-done', 'balance-check'].map(name => ({ name, description: `mô tả ${name}`, argumentHint: null }));
const KNOWN = new Set(SKILLS.map(s => s.name));

function fakeRunner() {
  const runs = new Map<string, { task: Task; finish: (o: Partial<RunOutcome>) => void }>();
  const runner: Runner = (task: Task, hooks: RunHooks) => {
    let finish!: (o: Partial<RunOutcome>) => void;
    const done = new Promise<RunOutcome>(r => { finish = o => r({ ok: true, sessionId: task.resumeOf ?? 'sess-1', resultText: 'xong', error: null, ...o }); });
    runs.set(task.id, { task, finish });
    hooks.onSession(task.resumeOf ?? 'sess-1');
    return { done, pid: () => null, stop: async () => finish({ ok: false, error: 'stopped' }) };
  };
  return { runner, runs };
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

function tmpProject(yaml: string | null): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-pl-'));
  if (yaml !== null) fs.writeFileSync(path.join(d, 'project.yaml'), yaml);
  return d;
}

function setup(changed: Record<string, ChangedFile[]> = {}, root = tmpProject('project:\n  stage: Production\nmodes:\n  rigor: standard\n')) {
  const f = fakeRunner();
  // Snapshot stub: before = clean, after = the files configured for the running task's prompt (reported as added).
  let lastPrompt = '';
  let calls = 0;
  const db = openDb(':memory:');
  const snapshot = async () => (++calls % 2 ? new Map<string, string>() : new Map((changed[lastPrompt] ?? []).map(c => [c.path, '??|h'] as [string, string])));
  const q = new TaskQueue({ db, runner: (t, h) => { lastPrompt = t.prompt; return f.runner(t, h); }, project: () => 'x', snapshot, sessionExists: () => true });
  const p = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => root, templates: () => [], critic: false });
  return { q, p, f, last: () => lastPrompt };
}

const PLAN = 'Kế hoạch:\n```json\n' + JSON.stringify({
  summary: 'Làm lucky spin',
  steps: [
    { title: 'Thiết kế', skill: '/quick-design', args: 'lucky spin', why: 'spec ngắn' },
    { title: 'Chia việc', skill: 'create-stories', args: 'lucky-spin' },
  ],
}) + '\n```';

describe('pipeline plan parsing', () => {
  it('reads the JSON block, strips "/", flags unknown skills, forces expand on create-stories', () => {
    const r = parsePlan(PLAN, KNOWN);
    expect(r.summary).toBe('Làm lucky spin');
    expect(r.steps.map(s => [s.skill, s.args, s.expand, s.warning])).toEqual([['quick-design', 'lucky spin', null, null], ['create-stories', 'lucky-spin', 'stories', null]]);
    expect(parsePlan('```json\n{"steps":[{"skill":"nope"}]}\n```', KNOWN).steps[0].warning).toMatch(/không có skill/);
    expect(() => parsePlan('không có json', KNOWN)).toThrow(/Không đọc được/);
  });
  it('prompt lists skills and forbids edits', () => {
    const s = plannerPrompt('Lucky Spin', SKILLS);
    expect(s).toContain('/quick-design');
    expect(s).toContain('Do NOT modify');
  });
});

describe('pipeline /start gate and rigor', () => {
  it('reads project.yaml; refuses to plan until /start has set modes.rigor', () => {
    expect(readSetup(tmpProject(null))).toMatchObject({ started: false, error: 'Không có project.yaml' });
    expect(readSetup(tmpProject('modes:\n  automation: guided\n'))).toMatchObject({ started: false, rigor: null, automation: 'guided' });
    expect(readSetup(tmpProject('project:\n  stage: Concept\nmodes:\n  rigor: full\n'))).toMatchObject({ started: true, rigor: 'full', stage: 'Concept' });
    const { p } = setup({}, tmpProject('modes: {}\n'));
    expect(() => p.create({ request: 'x' })).toThrow(/chưa chạy \/start/);
  });
  it('uses project rigor by default, lets the user override it, and puts the roadmap in the prompt', () => {
    const { p, q } = setup();
    expect(p.create({ request: 'a' }).rigor).toBe('standard');
    const pl = p.create({ request: 'b', rigor: 'minimal' });
    expect(pl.rigor).toBe('minimal');
    expect(q.get(pl.planTaskId!)!.prompt).toMatch(/rigor "minimal"/);
    expect(() => p.create({ request: 'c', rigor: 'x' as any })).toThrow(/rigor/);
    expect(plannerPrompt('r', SKILLS, 'standard')).toContain('/ux-design');
  });
});

describe('pipeline run', () => {
  it('plans, waits for approval, runs steps in one session and expands stories', async () => {
    const stories = [{ path: 'production/epics/lucky-spin/story-001-wheel.md', change: 'A' }, { path: 'production/epics/lucky-spin/story-002-ad.md', change: 'A' }, { path: 'production/epics/lucky-spin/EPIC.md', change: 'M' }] as ChangedFile[];
    const code = (n: string) => [{ path: `Assets/Scripts/${n}.cs`, change: 'A' }] as ChangedFile[];
    const { p, f, q } = setup({
      '/quick-design lucky spin': [{ path: 'design/quick-specs/lucky-spin.md', change: 'A' }], '/create-stories lucky-spin': stories,
      '/dev-story production/epics/lucky-spin/story-001-wheel.md': code('Wheel'), '/dev-story production/epics/lucky-spin/story-002-ad.md': code('Ad'),
    });
    let pl = p.create({ request: 'Tạo Lucky Spin', mode: 'auto', permissionMode: 'acceptEdits' });
    expect(pl.status).toBe('planning');
    await tick();
    f.runs.get(pl.planTaskId!)!.finish({ resultText: PLAN, sessionId: 'sess-1' });
    await tick();
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('review');
    expect(pl.sessionId).toBe('sess-1');
    expect(pl.steps.length).toBe(2);

    pl = p.start(pl.id);
    await tick();
    const s1 = q.get(pl.steps[0].taskId!)!;
    expect(s1).toMatchObject({ prompt: '/quick-design lucky spin', resumeOf: 'sess-1', permissionMode: 'acceptEdits' });
    f.runs.get(s1.id)!.finish({});
    await tick();
    pl = p.get(pl.id)!;
    const s2 = q.get(pl.steps[1].taskId!)!;
    expect(s2.prompt).toBe('/create-stories lucky-spin');
    f.runs.get(s2.id)!.finish({});
    await tick(30);
    pl = p.get(pl.id)!;
    expect(pl.steps.map(s => `${s.skill} ${s.args ?? ''}`.trim())).toEqual([
      'quick-design lucky spin', 'create-stories lucky-spin',
      'dev-story production/epics/lucky-spin/story-001-wheel.md', 'story-done production/epics/lucky-spin/story-001-wheel.md',
      'dev-story production/epics/lucky-spin/story-002-ad.md', 'story-done production/epics/lucky-spin/story-002-ad.md',
    ]);
    // Run the generated steps to the end.
    for (let i = 2; i < 6; i++) {
      await tick();
      pl = p.get(pl.id)!;
      f.runs.get(pl.steps[i].taskId!)!.finish({});
      await tick();
    }
    expect(p.get(pl.id)!.status).toBe('completed');
  });

  it('step mode pauses after each step; a failed step pauses with retry / skip', async () => {
    const { p, f } = setup();
    let pl = p.create({ request: 'x', mode: 'step' });
    await tick();
    f.runs.get(pl.planTaskId!)!.finish({ resultText: PLAN });
    await tick();
    pl = p.start(pl.id);
    await tick();
    f.runs.get(pl.steps[0].taskId!)!.finish({});
    await tick();
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('paused');
    expect(pl.note).toMatch(/Tiếp tục/);
    pl = p.start(pl.id);
    await tick();
    f.runs.get(pl.steps[1].taskId!)!.finish({ ok: false, error: 'boom' });
    await tick();
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('paused');
    expect(pl.steps[1].status).toBe('failed');
    expect(pl.error).toMatch(/boom/);
    p.skip(pl.id, pl.steps[1].id);
    expect(() => p.start(pl.id)).toThrow(/Không còn bước/);
  });

  it('edits only pending steps, rejects starting with an invalid step, cancels', async () => {
    const { p, f, q } = setup();
    let pl = p.create({ request: 'x' });
    await tick();
    f.runs.get(pl.planTaskId!)!.finish({ resultText: PLAN });
    await tick();
    pl = p.updateSteps(pl.id, { steps: [{ title: 'Sai', skill: 'khong-co' }], mode: 'step' });
    expect(pl.mode).toBe('step');
    expect(() => p.start(pl.id)).toThrow(/không có skill/);
    pl = p.updateSteps(pl.id, { steps: [{ title: 'Cân bằng', skill: 'balance-check' }, { title: 'Prompt', prompt: 'làm gì đó' }] });
    pl = p.start(pl.id);
    await tick();
    const tid = pl.steps[0].taskId!;
    pl = await p.cancel(pl.id);
    await tick();
    expect(p.get(pl.id)!.status).toBe('cancelled');
    expect(q.get(tid)!.status).toBe('cancelled');
    expect(p.get(pl.id)!.steps[1].status).toBe('cancelled');
  });

  it('a failed planner reply marks the pipeline failed with the reason', async () => {
    const { p, f } = setup();
    const pl = p.create({ request: 'x' });
    await tick();
    f.runs.get(pl.planTaskId!)!.finish({ resultText: 'không có kế hoạch' });
    await tick();
    expect(p.get(pl.id)).toMatchObject({ status: 'failed' });
    expect(p.get(pl.id)!.error).toMatch(/Không đọc được/);
    expect(() => p.create({ request: ' ' })).toThrow();
  });
});

describe('game scan (Unity MCP)', () => {
  it('runs a read-only scan task, records ok / no-MCP, gates planning and continues /start from its session', async () => {
    const { GameScanService, NO_MCP } = await import('../src/pipelines/game-scan');
    const f = fakeRunner();
    const db = openDb(':memory:');
    const q = new TaskQueue({ db, runner: f.runner, project: () => 'x', snapshot: async () => new Map(), sessionExists: () => true });
    const root = tmpProject('modes:\n  rigor: minimal\n');
    const gs = new GameScanService({ home: tmpProject(null), queue: q, project: () => root });
    const p = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => root, scan: () => gs.get(), critic: false });
    expect(gs.get().status).toBe('none');
    expect(() => p.create({ request: 'x' })).toThrow(/Quét game/);
    let s = gs.start();
    expect(q.get(s.taskId!)!.prompt).toMatch(/READ-ONLY/);
    await tick();
    f.runs.get(s.taskId!)!.finish({ resultText: `${NO_MCP}\nEditor chưa mở` });
    await tick();
    expect(gs.get()).toMatchObject({ status: 'failed', error: expect.stringMatching(/Unity MCP/) });
    expect(() => gs.runStart()).toThrow();
    s = gs.start();
    await tick();
    f.runs.get(s.taskId!)!.finish({ resultText: '## Màn hình UI\n| PopupProfile |', sessionId: 'scan-sess' });
    await tick();
    expect(gs.get()).toMatchObject({ status: 'ok', sessionId: 'scan-sess' });
    const st0 = gs.runStart();
    expect(st0).toMatchObject({ prompt: '/start', resumeOf: 'scan-sess' });
    const pl = p.create({ request: 'y' });
    expect(q.get(pl.planTaskId!)!.prompt).toContain('PopupProfile');
    await tick(); f.runs.get(st0.id)!.finish({}); await tick(); f.runs.get(pl.planTaskId!)!.finish({ resultText: PLAN }); await tick();
    // /start finished in the scan session without saving project.yaml -> still counts as started.
    const root2 = tmpProject('modes: {}');
    const gs2 = new GameScanService({ home: tmpProject(null), queue: q, project: () => root2 });
    const p2 = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => root2, scan: () => gs2.get(), critic: false });
    let s2 = gs2.start(); await tick();
    f.runs.get(s2.taskId!)!.finish({ resultText: 'UI ok', sessionId: 'scan-2' }); await tick();
    expect(p2.setup().started).toBe(false);
    const st = gs2.runStart(); await tick();
    f.runs.get(st.id)!.finish({}); await tick();
    expect(p2.setup()).toMatchObject({ started: true, source: 'session', rigor: 'standard' });
  });
});

describe('pipeline plan standard', () => {
  it('stores type/slug/issues, blocks start on a template error, lets the user decide after editing', async () => {
    const { loadTemplates } = await import('../src/pipelines/plan-rules');
    const f = fakeRunner();
    const db = openDb(':memory:');
    const q = new TaskQueue({ db, runner: f.runner, project: () => 'x', snapshot: async () => new Map(), sessionExists: () => true });
    const p = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => tmpProject('modes:\n  rigor: minimal\n'), templates: () => loadTemplates().templates, critic: false });
    let pl = p.create({ request: 'Chỉnh thưởng' });
    expect(q.get(pl.planTaskId!)!.prompt).toContain('"type": "<template id>"');
    await tick();
    const reply = '```json\n' + JSON.stringify({ summary: 's', type: 'tuning', slug: 'Lucky Spin', steps: [{ title: 'Chia việc', skill: 'create-stories', args: 'lucky-spin' }] }) + '\n```';
    f.runs.get(pl.planTaskId!)!.finish({ resultText: reply });
    await tick();
    pl = p.get(pl.id)!;
    expect(pl).toMatchObject({ status: 'review', planType: 'tuning', planTypeTitle: 'Chỉnh số, cân bằng', slug: 'lucky-spin' });
    expect(pl.issues!.some(i => i.level === 'error' && i.rule === 'required')).toBe(true);
    expect(() => p.start(pl.id)).toThrow(/chưa đạt chuẩn.*quick-design/);
    pl = p.updateSteps(pl.id, { steps: pl.steps.map(s => ({ ...s })) });
    expect(pl.edited).toBe(true);
    expect(pl.issues!.some(i => i.level === 'error')).toBe(false);
    expect(p.start(pl.id).status).toBe('running');
  });
});

describe('pipeline critic loop (P2)', () => {
  const crit = (o: unknown) => 'Nhận xét:\n```json\n' + JSON.stringify(o) + '\n```';
  const BAD = crit({ ok: false, issues: [{ level: 'error', message: 'Thiếu bước ux cho popup', stepTitle: 'Thiết kế' }, { level: 'warn', message: 'args mơ hồ', stepTitle: null }] });
  const GOOD = crit({ ok: true, issues: [] });
  function mk() {
    const f = fakeRunner();
    const db = openDb(':memory:');
    const q = new TaskQueue({ db, runner: f.runner, project: () => 'x', snapshot: async () => new Map(), sessionExists: () => true });
    const p = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => tmpProject('modes:\n  rigor: minimal\n'), templates: () => [] });
    const finish = async (id: string, o: Partial<RunOutcome>) => { await tick(); f.runs.get(id)!.finish(o); await tick(); };
    return { p, q, finish };
  }

  it('critic errors send the plan back to the planner session; a clean critique goes to review', async () => {
    const { p, q, finish } = mk();
    let pl = p.create({ request: 'Lucky spin' });
    const plan1 = pl.planTaskId!;
    await finish(plan1, { resultText: PLAN, sessionId: 'plan-sess' });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('critiquing');
    const c1 = q.get(pl.critiqueTaskId!)!;
    expect(c1.prompt).toMatch(/producer/);
    expect(c1.prompt).toMatch(/Do NOT spawn subagents/);
    expect(c1.prompt).not.toMatch(/subagent_type/);
    expect(isCriticPrompt(c1.prompt)).toBe(true);
    expect(isCriticPrompt(q.get(plan1)!.prompt)).toBe(false);
    expect(c1.prompt).toContain('"skill": "quick-design"');
    expect(c1.resumeOf).toBeNull();
    await finish(c1.id, { resultText: BAD, sessionId: 'crit-sess' });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('planning');
    expect(pl.critiques![0]).toMatchObject({ round: 1, planTaskId: plan1, ok: false, revised: true });
    const r1 = q.get(pl.planTaskId!)!;
    expect(r1).toMatchObject({ resumeOf: 'plan-sess' });
    expect(r1.prompt).toContain('Thiếu bước ux cho popup');
    expect(r1.prompt).not.toContain('args mơ hồ');
    await finish(r1.id, { resultText: PLAN });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('critiquing');
    await finish(pl.critiqueTaskId!, { resultText: GOOD });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('review');
    expect(pl.critiques!.map(c => [c.round, c.ok, c.revised])).toEqual([[1, false, true], [2, true, false]]);
    expect(p.start(pl.id).status).toBe('running');
  });

  it('stops after MAX_REVISIONS; critic opinions never block the run', async () => {
    const { p, finish } = mk();
    let pl = p.create({ request: 'x' });
    await finish(pl.planTaskId!, { resultText: PLAN });
    for (let i = 0; i < 3; i++) {
      pl = p.get(pl.id)!;
      await finish(pl.critiqueTaskId!, { resultText: BAD });
      pl = p.get(pl.id)!;
      if (pl.status === 'planning') await finish(pl.planTaskId!, { resultText: PLAN });
    }
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('review');
    expect(pl.critiques!.length).toBe(3);
    expect(pl.critiques!.filter(c => c.revised).length).toBe(2);
    expect(pl.note).toMatch(/Phản biện vẫn còn 1/);
    expect(p.start(pl.id).status).toBe('running');
  });

  it('unreadable critique or a failed revision falls back to review with the last plan; skip works', async () => {
    const { p, q, finish } = mk();
    let pl = p.create({ request: 'x' });
    await finish(pl.planTaskId!, { resultText: PLAN });
    await finish(p.get(pl.id)!.critiqueTaskId!, { resultText: 'không có json' });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('review');
    expect(pl.critiques![0].error).toMatch(/Không đọc được/);

    let b = p.create({ request: 'y' });
    await finish(b.planTaskId!, { resultText: PLAN });
    await finish(p.get(b.id)!.critiqueTaskId!, { resultText: BAD });
    await finish(p.get(b.id)!.planTaskId!, { resultText: 'hỏng' });
    b = p.get(b.id)!;
    expect(b.status).toBe('review');
    expect(b.steps.length).toBe(2);
    expect(b.note).toMatch(/không sửa được/);

    let c = p.create({ request: 'z' });
    await finish(c.planTaskId!, { resultText: PLAN });
    const ct = p.get(c.id)!.critiqueTaskId!;
    c = await p.skipCritique(c.id);
    await tick();
    expect(c.status).toBe('review');
    expect(q.get(ct)!.status).toBe('cancelled');
    expect(p.get(c.id)!.status).toBe('review');
    await expect(p.skipCritique(c.id)).rejects.toThrow(/phản biện/);

    const off = p.create({ request: 'w', critic: false });
    await finish(off.planTaskId!, { resultText: PLAN });
    expect(p.get(off.id)!.status).toBe('review');
  });

  it('"Sửa theo phản biện": warnings + user edits + note go to the planner session, then a new critique; not counted as auto revision', async () => {
    const { p, q, finish } = mk();
    const WARN = crit({ ok: true, issues: [{ level: 'warn', message: 'Engine vẫn ghi Godot', stepTitle: null }, { level: 'warn', message: 'Đóng story 003 trước story 004', stepTitle: 'Chia việc' }] });
    let pl = p.create({ request: 'Piggy bank' });
    await finish(pl.planTaskId!, { resultText: PLAN, sessionId: 'plan-sess' });
    await finish(p.get(pl.id)!.critiqueTaskId!, { resultText: WARN });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('review');
    expect(pl.critiques![0].revised).toBe(false);
    expect(pl.note).toMatch(/2 cảnh báo/);

    // The user edits a step first; the revision must see that edit.
    p.updateSteps(pl.id, { steps: [...pl.steps.map(s => ({ ...s })), { title: 'Cấu hình engine', skill: 'quick-design', args: 'unity' }] });
    pl = p.revise(pl.id, 'Nút dùng chữ Claim');
    expect(pl.status).toBe('planning');
    expect(pl.critiques![0]).toMatchObject({ revised: true, revisedBy: 'user' });
    const r = q.get(pl.planTaskId!)!;
    expect(r.resumeOf).toBe('plan-sess');
    expect(r.prompt).toContain('Engine vẫn ghi Godot');
    expect(r.prompt).toContain('Đóng story 003 trước story 004');
    expect(r.prompt).toContain('Nút dùng chữ Claim');
    expect(r.prompt).toContain('Cấu hình engine');
    expect(r.prompt).toContain('CẦN QUYẾT');

    await finish(r.id, { resultText: PLAN });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('critiquing');
    // Errors in the new round still get the full automatic budget.
    const BAD = crit({ ok: false, issues: [{ level: 'error', message: 'thiếu bước', stepTitle: null }] });
    await finish(pl.critiqueTaskId!, { resultText: BAD });
    expect(p.get(pl.id)!.status).toBe('planning');
    expect(p.get(pl.id)!.critiques![1].revisedBy).toBe('auto');

    await expect(async () => p.revise(pl.id)).rejects.toThrow(/chờ duyệt/);
  });

  it('revise refuses without anything to fix, and after a step has run', async () => {
    const { p, finish } = mk();
    let pl = p.create({ request: 'x', critic: false });
    await finish(pl.planTaskId!, { resultText: PLAN });
    pl = p.get(pl.id)!;
    expect(() => p.revise(pl.id)).toThrow(/Không có ý kiến/);
    expect(p.revise(pl.id, 'thêm bước balance-check').status).toBe('planning');
    await finish(p.get(pl.id)!.planTaskId!, { resultText: PLAN });
    pl = p.start(pl.id);
    await finish(pl.steps[0].taskId!, { resultText: 'xong' });
    // Once a step has run, re-plan is the tool for the remaining steps, not revise.
    expect(() => p.revise(pl.id, 'x')).toThrow();
  });
});

describe('pipeline checkpoints and re-plan (P3)', () => {
  const PLAN3 = '```json\n' + JSON.stringify({ summary: 's', steps: [
    { title: 'UX', skill: 'ux-design', args: 'popup-piggy' }, { title: 'Review UX', skill: 'ux-review', args: 'design/ux/popup-piggy.md' }, { title: 'Chia việc', skill: 'create-stories', args: 'piggy' },
  ] }) + '\n```';
  function mk() {
    const f = fakeRunner();
    const db = openDb(':memory:');
    let last = '';
    let n = 0;
    const changed: Record<string, ChangedFile[]> = { '/ux-design popup-piggy': [{ path: 'design/ux/popup-piggy.md', change: 'A' }] };
    const snapshot = async () => (++n % 2 ? new Map<string, string>() : new Map((changed[last] ?? []).map(c => [c.path, '??|h'] as [string, string])));
    const q = new TaskQueue({ db, runner: (t, h) => { last = t.prompt; return f.runner(t, h); }, project: () => 'x', snapshot, sessionExists: () => true });
    const skills = [...SKILLS, ...['ux-design', 'ux-review'].map(name => ({ name, description: name, argumentHint: null }))];
    const p = new PipelineService({ db, queue: q, skills: () => skills, project: () => tmpProject('modes:\n  rigor: minimal\n'), templates: () => [], critic: false });
    const finish = async (id: string, o: Partial<RunOutcome>) => { await tick(); f.runs.get(id)!.finish(o); await tick(); };
    const running = (id: string) => p.get(id)!.steps.find(s => s.status === 'running')!;
    return { p, q, finish, running };
  }

  it('a review that needs revision gets a fix and a re-run; a second failure pauses; re-plan replaces only pending steps', async () => {
    const { p, q, finish, running } = mk();
    let pl = p.create({ request: 'Piggy bank' });
    await finish(pl.planTaskId!, { resultText: PLAN3, sessionId: 'work-sess' });
    p.start(pl.id);
    await finish(running(pl.id).taskId!, { resultText: 'Verdict: **COMPLETE**' });
    await finish(running(pl.id).taskId!, { resultText: '### Verdict: NEEDS REVISION' });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('running');
    expect(pl.steps.map(s => s.skill ?? 'prompt')).toEqual(['ux-design', 'ux-review', 'prompt', 'ux-review', 'create-stories']);
    expect(pl.steps[1].check).toMatchObject({ decision: 'fix', verdict: 'NEEDS REVISION' });
    expect(q.get(pl.steps[2].taskId!)!).toMatchObject({ resumeOf: 'work-sess' });
    await finish(running(pl.id).taskId!, { resultText: 'Đã sửa.' }); // fix prompt (no skill: no file rule)
    await finish(running(pl.id).taskId!, { resultText: 'Verdict: NEEDS REVISION' });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('paused');
    expect(pl.checkpoint).toMatchObject({ stepId: pl.steps[3].id, replan: true });
    expect(pl.note).toMatch(/lập lại kế hoạch/);

    pl = p.replan(pl.id, 'Bỏ review, chia việc luôn');
    expect(pl).toMatchObject({ status: 'planning', replanning: true, replans: 1 });
    const rp = q.get(pl.planTaskId!)!;
    expect(rp).toMatchObject({ resumeOf: 'work-sess' });
    expect(rp.prompt).toMatch(/REMAINING/);
    expect(rp.prompt).toContain('Bỏ review, chia việc luôn');
    expect(rp.prompt).toContain('verdict NEEDS REVISION');
    await finish(rp.id, { resultText: '```json\n{"summary":"mới","steps":[{"title":"Chia việc","skill":"create-stories","args":"piggy"}]}\n```' });
    pl = p.get(pl.id)!;
    expect(pl).toMatchObject({ status: 'review', replanning: false, summary: 'mới' });
    expect(pl.steps.map(s => `${s.skill ?? 'prompt'}:${s.status}`)).toEqual(['ux-design:completed', 'ux-review:completed', 'prompt:completed', 'ux-review:completed', 'create-stories:pending']);
    expect(p.start(pl.id).checkpoint).toBeNull();
  });

  it('a step that ends with a question pauses; the answer runs next in the same session', async () => {
    const { p, q, finish, running } = mk();
    let pl = p.create({ request: 'x' });
    await finish(pl.planTaskId!, { resultText: PLAN3, sessionId: 'work-sess' });
    p.start(pl.id);
    await finish(running(pl.id).taskId!, { resultText: 'Bản nháp ở trên.\nMay I write this to design/ux/popup-piggy.md?' });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('paused');
    expect(pl.checkpoint!.question).toMatch(/May I write/);
    expect(() => p.replan(pl.id, null)).not.toThrow();
    pl = p.get(pl.id)!;
    await finish(pl.planTaskId!, { resultText: 'hỏng' }); // failed re-plan keeps the steps
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('review');
    expect(pl.steps.length).toBe(3);
    expect(pl.note).toMatch(/không lập lại/);
    pl = p.answer(pl.id, 'Yes');
    expect(pl.status).toBe('running');
    const a = pl.steps[1];
    expect(a).toMatchObject({ title: 'Trả lời Claude', prompt: 'Yes', status: 'running', fixOf: pl.steps[0].id });
    expect(q.get(a.taskId!)!).toMatchObject({ prompt: 'Yes', resumeOf: 'work-sess' });
    expect(() => p.answer(pl.id, ' ')).toThrow(/trống/);
  });

  it('a writer step that changed no file pauses', async () => {
    const { p, finish, running } = mk();
    let pl = p.create({ request: 'x' });
    await finish(pl.planTaskId!, { resultText: '```json\n{"steps":[{"title":"UX","skill":"ux-design","args":"khac"},{"title":"Chia","skill":"create-stories","args":"a"}]}\n```' });
    p.start(pl.id);
    await finish(running(pl.id).taskId!, { resultText: 'xong' });
    pl = p.get(pl.id)!;
    expect(pl.status).toBe('paused');
    expect(pl.checkpoint!.reason).toMatch(/không tạo hoặc sửa file/);
    expect(p.start(pl.id).status).toBe('running');
  });
});
