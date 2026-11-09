import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangedFile, Task } from '@ccgs/shared';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunHooks, RunOutcome, Runner } from '../src/tasks/runner';
import { PipelineService, parsePlan, plannerPrompt, readSetup } from '../src/pipelines/pipeline.service';

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
  const p = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => root, templates: () => [] });
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
    const { p, f, q } = setup({ '/create-stories lucky-spin': stories });
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
    const p = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => root, scan: () => gs.get() });
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
    const p2 = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => root2, scan: () => gs2.get() });
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
    const p = new PipelineService({ db, queue: q, skills: () => SKILLS, project: () => tmpProject('modes:\n  rigor: minimal\n'), templates: () => loadTemplates().templates });
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
