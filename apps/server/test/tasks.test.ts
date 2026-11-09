import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Task } from '@ccgs/shared';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunHooks, RunOutcome, Runner } from '../src/tasks/runner';
import { diffSnapshots, parsePorcelainZ, takeSnapshot } from '../src/tasks/git-snapshot';
import { isAlive, killTree } from '../src/tasks/runner';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-task-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Fake runner: each task waits until the test finishes it, or asks the hooks something. */
function fakeRunner() {
  const runs = new Map<string, { hooks: RunHooks; finish: (o: Partial<RunOutcome>) => void; stopped: boolean }>();
  const runner: Runner = (task: Task, hooks) => {
    let finish!: (o: Partial<RunOutcome>) => void;
    const done = new Promise<RunOutcome>(r => { finish = o => r({ ok: true, sessionId: `s-${task.id}`, resultText: 'xong', error: null, ...o }); });
    const rec = { hooks, finish, stopped: false };
    runs.set(task.id, rec);
    hooks.onSession(`s-${task.id}`);
    return { done, pid: () => null, stop: async () => { rec.stopped = true; finish({ ok: false, error: 'error_during_execution' }); } };
  };
  return { runner, runs };
}

const tick = () => new Promise(r => setTimeout(r, 5));

function makeQueue() {
  const f = fakeRunner();
  const q = new TaskQueue({ db: openDb(':memory:'), runner: f.runner, project: () => tmp, snapshot: async () => null });
  return { q, ...f };
}

describe('task queue', () => {
  it('runs one task at a time, second starts only after the first ends', async () => {
    const { q, runs } = makeQueue();
    const a = q.create({ kind: 'prompt', prompt: 'một' });
    const b = q.create({ kind: 'prompt', prompt: 'hai' });
    await tick();
    expect(q.get(a.id)!.status).toBe('running');
    expect(q.get(b.id)!.status).toBe('queued');
    expect(q.get(b.id)!.position).toBe(1);
    expect(runs.has(b.id)).toBe(false);
    runs.get(a.id)!.finish({});
    await tick();
    expect(q.get(a.id)!.status).toBe('completed');
    expect(q.get(a.id)!.resultText).toBe('xong');
    expect(q.get(b.id)!.status).toBe('running');
    expect(new Date(q.get(b.id)!.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(q.get(a.id)!.endedAt!).getTime());
  });

  it('builds the skill prompt and rejects bad input', () => {
    const { q } = makeQueue();
    const t = q.create({ kind: 'skill', skill: '/design-review', args: 'design/gdd/x.md' });
    expect(t.prompt).toBe('/design-review design/gdd/x.md');
    expect(() => q.create({ kind: 'skill', skill: 'a b; rm' })).toThrow();
    expect(() => q.create({ kind: 'prompt', prompt: '  ' })).toThrow();
    expect(() => q.create({ kind: 'prompt', prompt: 'x', permissionMode: 'bypassPermissions' as any })).toThrow();
  });

  it('reorders and cancels queued tasks', async () => {
    const { q } = makeQueue();
    q.create({ kind: 'prompt', prompt: 'chạy' });
    const [b, c, d] = ['b', 'c', 'd'].map(p => q.create({ kind: 'prompt', prompt: p }));
    await tick();
    q.move(d.id, 1);
    expect([b, c, d].map(t => q.get(t.id)!.position)).toEqual([2, 3, 1]);
    await q.cancel(b.id);
    expect(q.get(b.id)!.status).toBe('cancelled');
    expect(q.get(b.id)!.position).toBeNull();
    expect([c, d].map(t => q.get(t.id)!.position)).toEqual([2, 1]);
  });

  it('stopping a running task marks it cancelled and starts the next one', async () => {
    const { q, runs } = makeQueue();
    const a = q.create({ kind: 'prompt', prompt: 'dài' });
    const b = q.create({ kind: 'prompt', prompt: 'sau' });
    await tick();
    await q.cancel(a.id);
    await tick();
    expect(runs.get(a.id)!.stopped).toBe(true);
    expect(q.get(a.id)!.status).toBe('cancelled');
    expect(q.get(a.id)!.error).toBeNull();
    expect(q.get(b.id)!.status).toBe('running');
  });

  it('question: task waits, answer resumes it; permission decisions pass through', async () => {
    const { q, runs } = makeQueue();
    const a = q.create({ kind: 'prompt', prompt: 'hỏi' });
    await tick();
    const hooks = runs.get(a.id)!.hooks;
    const ctl = new AbortController();
    const ans = hooks.ask({ kind: 'question', toolUseId: 't1', agentInvocationId: null, question: { questions: [{ question: 'Màu?', multiSelect: false, options: [{ label: 'Đỏ' }, { label: 'Xanh' }] }] } }, ctl.signal);
    expect(q.get(a.id)!.status).toBe('waiting');
    const [it] = q.interactions();
    expect(() => q.answer(it.id, { answers: {} })).toThrow();
    q.answer(it.id, { answers: { 'Màu?': 'Xanh' } });
    expect(await ans).toEqual({ answers: { 'Màu?': 'Xanh' } });
    expect(q.get(a.id)!.status).toBe('running');

    const perm = hooks.ask({ kind: 'permission', toolUseId: 't2', agentInvocationId: null, permission: { toolName: 'Write', inputSummary: 'x.txt' } }, ctl.signal);
    q.answer(q.interactions()[0].id, { decision: 'deny', message: 'không' });
    expect(await perm).toEqual({ decision: 'deny', message: 'không' });
  });

  it('stopping a waiting task rejects its open question', async () => {
    const { q, runs } = makeQueue();
    const a = q.create({ kind: 'prompt', prompt: 'hỏi' });
    await tick();
    const p = runs.get(a.id)!.hooks.ask({ kind: 'permission', toolUseId: null, agentInvocationId: null, permission: { toolName: 'Bash', inputSummary: 'ls' } }, new AbortController().signal);
    const caught = p.catch(e => e.message);
    await q.cancel(a.id);
    expect(await caught).toBe('Task bị dừng');
    expect(q.interactions()).toEqual([]);
    expect(q.get(a.id)!.status).toBe('cancelled');
  });

  it('marks tasks left running by a previous process as failed on recover', async () => {
    const db = openDb(':memory:');
    const f = fakeRunner();
    const q1 = new TaskQueue({ db, runner: f.runner, project: () => tmp, snapshot: async () => null });
    const a = q1.create({ kind: 'prompt', prompt: 'x' });
    await tick();
    const q2 = new TaskQueue({ db, runner: fakeRunner().runner, project: () => null, snapshot: async () => null });
    q2.recover();
    expect(q2.get(a.id)!.status).toBe('failed');
  });
});

describe('git snapshot', () => {
  const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });

  it('parses porcelain -z including renames', () => {
    expect(parsePorcelainZ(' M a.txt\0R  new.txt\0old.txt\0?? d/e f.txt\0')).toEqual([[' M', 'a.txt'], ['R ', 'new.txt'], ['??', 'd/e f.txt']]);
  });

  it('reports only what changed between snapshots', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    for (const f of ['keep.txt', 'edit.txt', 'del.txt', 'dirty.txt']) fs.writeFileSync(path.join(repo, f), f);
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'user change'); // dirty before the task, untouched by it
    fs.writeFileSync(path.join(repo, 'untracked-before.txt'), 'x');

    const before = (await takeSnapshot(repo))!;
    fs.writeFileSync(path.join(repo, 'edit.txt'), 'changed');
    fs.rmSync(path.join(repo, 'del.txt'));
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'new file.txt'), 'n');
    const after = (await takeSnapshot(repo))!;

    expect(diffSnapshots(before, after)).toEqual([
      { path: 'del.txt', change: 'D' }, { path: 'edit.txt', change: 'M' }, { path: 'sub/new file.txt', change: 'A' },
    ]);
    expect(await takeSnapshot(os.tmpdir())).toBeNull();
  });
});

describe('kill tree', () => {
  it('kills a process and its children', async () => {
    // Parent node spawns a long-lived child and prints its pid.
    const parent = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    const childPid = await new Promise<number>(r => parent.stdout!.once('data', d => r(Number(String(d).trim()))));
    expect(isAlive(childPid)).toBe(true);
    killTree(parent.pid!);
    await new Promise(r => setTimeout(r, 500));
    expect(isAlive(parent.pid!)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
  });
});
