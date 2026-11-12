import { describe, expect, it } from 'vitest';
import type { Task } from '@ccgs/shared';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunHooks, RunOutcome, Runner } from '../src/tasks/runner';

/** Fake runner: a resumed task keeps its session id, a new one gets s-<id>. */
function setup() {
  const runs = new Map<string, (o: Partial<RunOutcome>) => void>();
  const runner: Runner = (task: Task, hooks: RunHooks) => {
    let finish!: (o: Partial<RunOutcome>) => void;
    const sid = task.resumeOf ?? `s-${task.id}`;
    const done = new Promise<RunOutcome>(r => { finish = o => r({ ok: true, sessionId: sid, resultText: 'xong', error: null, ...o }); });
    runs.set(task.id, finish);
    hooks.onSession(sid);
    return { done, pid: () => null, stop: async () => finish({ ok: false, error: 'stopped' }) };
  };
  const q = new TaskQueue({ db: openDb(':memory:'), runner, project: () => 'x', snapshot: async () => null, sessionExists: () => true });
  const removed: string[][] = [];
  q.bus.on('removed', ids => removed.push(ids));
  return { q, runs, removed };
}
const tick = () => new Promise(r => setTimeout(r, 5));
async function finished(s: ReturnType<typeof setup>, prompt: string, o: Partial<RunOutcome> = {}) {
  const t = s.q.create({ kind: 'prompt', prompt });
  await tick();
  s.runs.get(t.id)!(o);
  await tick();
  return s.q.get(t.id)!;
}

describe('task history delete (api-contract §13)', () => {
  it('deletes one ended task; refuses a queued/running one and a task an unfinished plan keeps', async () => {
    const s = setup();
    const a = await finished(s, 'một');
    const running = s.q.create({ kind: 'prompt', prompt: 'đang chạy' });
    const queued = s.q.create({ kind: 'prompt', prompt: 'đang chờ' });
    await tick();
    expect(() => s.q.remove(running.id)).toThrow(/chưa kết thúc/);
    expect(() => s.q.remove(queued.id)).toThrow(/chưa kết thúc/);
    expect(() => s.q.remove('nope')).toThrow(/Không có task/);
    s.q.setKeep(() => new Map([[a.id, 'thuộc chuỗi kế hoạch "x" chưa kết thúc (paused)']]));
    expect(() => s.q.remove(a.id)).toThrow(/chuỗi kế hoạch/);
    s.q.setKeep(() => new Map());
    expect(s.q.remove(a.id)).toEqual({ deleted: [a.id], kept: [] });
    expect(s.q.get(a.id)).toBeNull();
    expect(s.removed).toEqual([[a.id]]);
  });

  it('clear deletes ended tasks matching the filter, keeps plan tasks and unfinished ones', async () => {
    const s = setup();
    const ok1 = await finished(s, 'sửa popup');
    const ok2 = await finished(s, 'làm lucky spin');
    const bad = await finished(s, 'lỗi', { ok: false, error: 'boom' });
    const plan = await finished(s, 'kế hoạch');
    s.q.setKeep(() => new Map([[plan.id, 'thuộc chuỗi kế hoạch']]));
    expect(bad.status).toBe('failed');
    // Search filter, like the history list.
    expect(s.q.clear({ q: 'popup' }).deleted).toEqual([ok1.id]);
    // Status filter.
    expect(s.q.clear({ status: 'failed' }).deleted).toEqual([bad.id]);
    expect(() => s.q.clear({ status: 'running' })).toThrow(/đã kết thúc/);
    expect(() => s.q.clear({ before: 'hôm qua' })).toThrow(/ISO/);
    // before: nothing ended before a past instant.
    expect(s.q.clear({ before: '2000-01-01T00:00:00Z' }).deleted).toEqual([]);
    const all = s.q.clear();
    expect(all.deleted).toEqual([ok2.id]);
    expect(all.kept).toEqual([{ id: plan.id, reason: 'thuộc chuỗi kế hoạch' }]);
    expect(s.q.list().map(t => t.id)).toEqual([plan.id]);
  });

  it('after deleting a session\'s tasks, resuming it still splits cost from the last total', async () => {
    const s = setup();
    const a = await finished(s, 'bước 1', { costUsd: 0.7, contextTokens: 60_000 });
    expect(a).toMatchObject({ sessionCostUsd: 0.7, costUsd: 0.7 });
    s.q.remove(a.id);
    const b = s.q.create({ kind: 'prompt', prompt: 'bước 2', resumeOf: a.sessionId! });
    await tick();
    s.runs.get(b.id)!({ costUsd: 1.0 }); // the SDK reports the running total of the session
    await tick();
    expect(s.q.get(b.id)).toMatchObject({ sessionCostUsd: 1.0, costUsd: expect.closeTo(0.3) });
  });
});
