// Phase 4/5 features: one block per feature code.
import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import type { Task } from '@ccgs/shared';
import { parseTranscript, readTranscript } from '../src/monitor/transcript';
import { unifiedDiff } from '../src/monitor/diff';
import { configureRedaction, redactString, REDACTED } from '../src/monitor/redact';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings/settings.service';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunHooks, RunOutcome, Runner } from '../src/tasks/runner';
import { baseRef, gitInfo, takeSnapshot, diffSnapshots, taskDiffs } from '../src/tasks/git-snapshot';
import { encodeTraces, sessionSpans } from '../src/phoenix/otlp';

process.env.CCGS_STUDIO_DB = ':memory:';
const { MonitorService } = await import('../src/monitor/monitor.service');
const settingsStub = { dir: os.tmpdir() } as any;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-p4-'));
afterAll(() => { configureRedaction({ patterns: [], maxPayloadKB: 8 }); fs.rmSync(tmp, { recursive: true, force: true }); });

// Transcript lines shaped like the real ones (Phase 0 §5): one API message split in several lines repeating usage.
const usage = (i: number, o: number, cc = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });
const line = (o: object) => JSON.stringify(o);
const MAIN = [
  line({ type: 'user', timestamp: '2026-11-09T10:00:00Z', message: { role: 'user', content: 'Làm việc X' } }),
  line({ type: 'assistant', timestamp: '2026-11-09T10:00:01Z', requestId: 'r1', message: { id: 'msg_1', model: 'claude-haiku-5-5', content: [{ type: 'thinking', thinking: '' }], usage: usage(10, 5, 100, 1000) } }),
  line({ type: 'assistant', timestamp: '2026-11-09T10:00:01Z', requestId: 'r1', message: { id: 'msg_1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'qa-tester' } }], usage: usage(10, 5, 100, 1000) } }),
  line({ type: 'user', timestamp: '2026-11-09T10:00:05Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'xong' }] }] } }),
  line({ type: 'assistant', timestamp: '2026-11-09T10:00:06Z', message: { id: 'msg_2', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Hoàn tất' }], usage: usage(3, 7, 0, 2000) } }),
  line({ type: 'assistant', isSidechain: true, message: { id: 'msg_side', content: [], usage: usage(999, 999) } }),
  '{not json', line({ type: 'summary', summary: 'x' }),
].join('\n');
const SUB = [
  line({ type: 'user', message: { role: 'user', content: 'Viết test' } }),
  line({ type: 'assistant', message: { id: 'msg_a', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], usage: usage(20, 30, 40, 50) } }),
].join('\n');

describe('M-PF-02 transcript tokens', () => {
  it('counts each message.id once, skips sidechain lines in the main file and odd lines', () => {
    const t = parseTranscript(MAIN, { sidechain: false });
    expect(t.usage).toEqual({ input: 13, output: 12, cacheCreation: 100, cacheRead: 3000, messages: 2 });
    expect(t.models).toEqual(['claude-haiku-5-5']);
    expect(t.items.map(i => i.kind)).toEqual(['user', 'tool_use', 'tool_result', 'assistant']);
  });

  it('session usage = main transcript + each subagent transcript (found next to the session)', () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    const main = path.join(tmp, `${sid}.jsonl`);
    fs.writeFileSync(main, MAIN);
    fs.mkdirSync(path.join(tmp, sid, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(tmp, sid, 'subagents', 'agent-abc.jsonl'), SUB);
    const svc = new MonitorService(settingsStub);
    const send = (p: object, t: string) => svc.ingest({ v: 1, receivedAt: t, taskId: null, origin: 'local-settings', payload: { session_id: sid, cwd: tmp, transcript_path: main, ...p } });
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'Làm việc X' }, '2026-11-09T10:00:00Z');
    send({ hook_event_name: 'SubagentStart', agent_id: 'abc', agent_type: 'qa-tester' }, '2026-11-09T10:00:02Z');
    send({ hook_event_name: 'SubagentStop', agent_id: 'abc', agent_type: 'qa-tester' }, '2026-11-09T10:00:04Z');
    const u = svc.usage(sid)!;
    expect(u.total).toEqual({ input: 33, output: 42, cacheCreation: 140, cacheRead: 3050, messages: 3 });
    expect(u.byAgent.find(a => a.agentType === 'qa-tester')!.usage!.output).toBe(30);
    expect(u.missing).toEqual([]);
    // M-AM-04: the subagent's own conversation.
    const tr = svc.transcript(sid, 'abc')!;
    expect(tr.items.map(i => i.kind)).toEqual(['user', 'assistant']);
    // Cache follows file changes.
    fs.appendFileSync(path.join(tmp, sid, 'subagents', 'agent-abc.jsonl'), '\n' + line({ type: 'assistant', message: { id: 'msg_b', content: [], usage: usage(1, 1) } }));
    expect(readTranscript(path.join(tmp, sid, 'subagents', 'agent-abc.jsonl'))!.usage.messages).toBe(2);
  });
});

describe('M-TS-02 / M-TS-03 tool detail and file activity, M-LG-03 log time filter', () => {
  const svc = new MonitorService(settingsStub);
  const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
  let t = Date.parse('2026-11-09T11:00:00Z');
  const send = (p: object) => svc.ingest({ v: 1, receivedAt: new Date((t += 1000)).toISOString(), taskId: null, origin: 'local-settings', payload: { session_id: sid, cwd: 'D:\\proj', transcript_path: 'x', ...p } });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' } });
  send({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' }, tool_response: { stdout: 'a\nb', stderr: '', interrupted: false } });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'false' } });
  send({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'false' }, error: 'Exit code 2\nboom' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'D:\\proj\\src\\a.ts', old_string: 'x = 1', new_string: 'x = 2' } });
  send({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'D:\\proj\\src\\a.ts', old_string: 'x = 1', new_string: 'x = 2' },
    tool_response: { structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-x = 1', '+x = 2'] }] } });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'D:\\proj\\new.md', content: 'một\nhai' } });
  send({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'D:\\proj\\new.md', content: 'một\nhai' }, tool_response: { type: 'create' } });
  send({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'D:\\proj\\README.md' }, tool_response: { file: { numLines: 3 } } });

  it('Bash: exit code from the error, inferred 0 on success, output kept', () => {
    const ok = svc.toolcallDetail('b1')!.bash!;
    expect(ok).toMatchObject({ command: 'ls', exitCode: 0, exitCodeSource: 'inferred', output: 'a\nb' });
    expect(svc.toolcallDetail('b2')!.bash).toMatchObject({ exitCode: 2, exitCodeSource: 'error' });
  });
  it('Edit uses the structured patch; Write create shows added lines', () => {
    const e = svc.toolcallDetail('e1')!.file!;
    expect(e.path).toBe('src/a.ts');
    expect(e.diff!.filter(d => d.op !== 'hunk')).toEqual([{ op: 'del', line: 'x = 1' }, { op: 'add', line: 'x = 2' }]);
    const w = svc.toolcallDetail('w1')!.file!;
    expect(w.op).toBe('create');
    expect(w.diff).toEqual([{ op: 'add', line: 'một' }, { op: 'add', line: 'hai' }]);
  });
  it('lists file activity with operation and relative path', () => {
    expect(svc.files(sid).map(f => `${f.op} ${f.path}`)).toEqual(['edit src/a.ts', 'create new.md', 'read README.md']);
  });
  it('filters logs by time range and session', () => {
    const all = svc.logs({ session: sid }).items;
    expect(all.length).toBe(1); // the Bash failure warning
    expect(svc.logs({ session: sid, from: '2026-11-09T11:00:05Z' }).items.length).toBe(0);
    expect(svc.logs({ session: sid, to: '2026-11-09T11:00:05Z' }).items.length).toBe(1);
  });
});

describe('T-AG-04 / M-PF-01 stats, S-04 purge, P1 spool', () => {
  it('aggregates agent invocations and finished tasks', () => {
    const svc = new MonitorService(settingsStub);
    const sid = 'bbbbbbbb-0000-0000-0000-000000000001';
    let t = Date.parse('2026-11-09T12:00:00Z');
    const send = (p: object) => svc.ingest({ v: 1, receivedAt: new Date((t += 2000)).toISOString(), taskId: null, origin: 'local-settings', payload: { session_id: sid, ...p } });
    send({ hook_event_name: 'SubagentStart', agent_id: 'x1', agent_type: 'qa-tester' });
    send({ hook_event_name: 'SubagentStop', agent_id: 'x1', agent_type: 'qa-tester' });
    send({ hook_event_name: 'SubagentStart', agent_id: 'x2', agent_type: 'qa-tester' });
    send({ hook_event_name: 'SessionEnd' });
    expect(svc.agentStats()).toEqual([{ agentType: 'qa-tester', calls: 2, completed: 1, failed: 0, unknown: 1, avgDurationMs: 2000, lastAt: '2026-11-09T12:00:06.000Z' }]);
    const ins = svc.db.$client.prepare(`INSERT INTO tasks (id, kind, prompt, permission_mode, status, created_at, started_at, ended_at, cost_usd) VALUES (?, 'prompt', 'p', 'default', ?, 'x', ?, ?, ?)`);
    ins.run('t1', 'completed', '2026-11-09T12:00:00Z', '2026-11-09T12:00:10Z', 0.01);
    ins.run('t2', 'completed', '2026-11-09T12:00:00Z', '2026-11-09T12:00:20Z', 0.02);
    ins.run('t3', 'failed', null, null, null);
    ins.run('t4', 'queued', null, null, null);
    const st = svc.taskStats();
    expect(st).toMatchObject({ total: 3, completed: 2, failed: 1, cancelled: 0, avgDurationMs: 15000 });
    expect(st.totalCostUsd).toBeCloseTo(0.03);
  });

  it('purges sessions idle for more than N days with their rows', () => {
    const svc = new MonitorService(settingsStub);
    const old = svc.ingest({ v: 1, receivedAt: '2026-10-01T00:00:00Z', taskId: null, origin: 'local-settings', payload: { session_id: 'old', hook_event_name: 'SessionStart' } });
    svc.ingest({ v: 1, receivedAt: '2026-11-09T00:00:00Z', taskId: null, origin: 'local-settings', payload: { session_id: 'new', hook_event_name: 'SessionStart' } });
    expect(old).not.toBeNull();
    const r = svc.purge(30, Date.parse('2026-11-09T12:00:00Z'));
    expect(r.sessions).toBe(1);
    expect(svc.getSession('old')).toBeNull();
    expect(svc.getSession('new')).not.toBeNull();
    expect(svc.events('old')).toEqual([]);
  });

  it('loads events from the spool once and deletes it', () => {
    const svc = new MonitorService(settingsStub);
    const f = path.join(tmp, 'spool.jsonl');
    const body = (n: number) => JSON.stringify({ v: 1, receivedAt: `2026-11-09T13:00:0${n}Z`, taskId: null, origin: 'local-settings', payload: { session_id: 'sp', hook_event_name: 'UserPromptSubmit', prompt: `p${n}` } });
    fs.writeFileSync(f, [body(1), 'garbage', body(2)].join('\n') + '\n');
    expect(svc.ingestSpool(f)).toBe(2);
    expect(fs.existsSync(f)).toBe(false);
    expect(svc.ingestSpool(f)).toBe(0);
    expect(svc.events('sp').length).toBe(2);
  });
});

describe('P1 hook spool (backend down)', () => {
  it('writes the event to spool.jsonl, exits 0 and fast', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    fs.copyFileSync(path.resolve(__dirname, '../hook/ccgs-studio-hook.mjs'), path.join(home, 'ccgs-studio-hook.mjs'));
    fs.writeFileSync(path.join(home, 'hook.json'), JSON.stringify({ token: 't', port: 1 })); // nothing listens on port 1
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(home, 'ccgs-studio-hook.mjs'), 'local'], { input: JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }), env: { ...process.env, CCGS_STUDIO_TASK_ID: '' } });
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.stdout.toString()).toBe('');
    const lines = fs.readFileSync(path.join(home, 'spool.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]).payload.hook_event_name).toBe('Stop');
  });
});

describe('S-03 / S-04 / S-05 settings', () => {
  it('validates and merges partial updates', () => {
    const d = DEFAULT_SETTINGS();
    const s = mergeSettings(d, { taskDefaults: { model: 'haiku', maxRuntimeMin: '30' }, retention: { days: 14 }, redactPatterns: ['MY-[0-9]{4}', ' '] });
    expect(s.taskDefaults).toEqual({ model: 'haiku', permissionMode: 'default', maxRuntimeMin: 30, compactAfter: true });
    expect(s.retention).toEqual({ days: 14, maxPayloadKB: 8 });
    expect(s.redactPatterns).toEqual(['MY-[0-9]{4}']);
    expect(() => mergeSettings(d, { redactPatterns: ['(['] })).toThrow(/Regex/);
    expect(() => mergeSettings(d, { redactPatterns: ['a*'] })).toThrow(/rỗng/);
    expect(() => mergeSettings(d, { taskDefaults: { permissionMode: 'bypassPermissions' } })).toThrow();
    expect(() => mergeSettings(d, { retention: { maxPayloadKB: 0 } })).toThrow();
    expect(() => mergeSettings(d, { phoenix: { endpoint: 'file:///x' } })).toThrow();
    expect(mergeSettings(d, { autoAllow: ['Bash', ' Bash ', 'mcp__UnityMCP__read_console', '*'] }).autoAllow).toEqual(['Bash', 'mcp__UnityMCP__read_console', '*']);
    expect(() => mergeSettings(d, { autoAllow: ['Bash(rm -rf)'] })).toThrow(/công cụ/);
  });
  it('applies user redaction patterns and the payload cap', () => {
    configureRedaction({ patterns: ['MY-[0-9]{4}'], maxPayloadKB: 1 });
    expect(redactString('mã MY-1234 ở đây')).toBe(`mã ${REDACTED} ở đây`);
    expect(redactString('a'.repeat(5000)).length).toBeLessThan(1100);
    configureRedaction({ patterns: [], maxPayloadKB: 8 });
    expect(redactString('MY-1234')).toBe('MY-1234');
  });
});

// ---------- tasks ----------
function fakeRunner() {
  const runs = new Map<string, { task: Task; finish: (o: Partial<RunOutcome>) => void; stopped: boolean }>();
  const runner: Runner = (task: Task, hooks: RunHooks) => {
    let finish!: (o: Partial<RunOutcome>) => void;
    const done = new Promise<RunOutcome>(r => { finish = o => r({ ok: true, sessionId: `s-${task.id}`, resultText: 'xong', error: null, ...o }); });
    const rec = { task, finish, stopped: false };
    runs.set(task.id, rec);
    hooks.onSession(`s-${task.id}`);
    return { done, pid: () => null, stop: async () => { rec.stopped = true; finish({ ok: false, error: 'error_during_execution' }); } };
  };
  return { runner, runs };
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

describe('S-03 task defaults, T-TC-07 resume, M-PF-03 cost', () => {
  it('fills unset model / permission from defaults, keeps explicit values', () => {
    const q = new TaskQueue({ db: openDb(':memory:'), runner: fakeRunner().runner, project: () => null, snapshot: async () => null,
      defaults: () => ({ model: 'haiku', permissionMode: 'acceptEdits', maxRuntimeMin: null, compactAfter: false }) });
    expect(q.create({ kind: 'prompt', prompt: 'a' })).toMatchObject({ model: 'haiku', permissionMode: 'acceptEdits' });
    expect(q.create({ kind: 'prompt', prompt: 'b', model: 'opus', permissionMode: 'plan' })).toMatchObject({ model: 'opus', permissionMode: 'plan' });
    expect(q.create({ kind: 'prompt', prompt: 'c', model: null })).toMatchObject({ model: null });
  });

  it('resumes a finished task in its session and stores the cost', async () => {
    const f = fakeRunner();
    const q = new TaskQueue({ db: openDb(':memory:'), runner: f.runner, project: () => tmp, snapshot: async () => null, sessionExists: id => id.startsWith('s-') || id === 'abcdef12' });
    const a = q.create({ kind: 'prompt', prompt: 'đầu', model: 'haiku' });
    await tick();
    expect(() => q.resume(a.id, 'tiếp')).toThrow(/đã kết thúc/);
    f.runs.get(a.id)!.finish({ costUsd: 0.0123 });
    await tick();
    expect(q.get(a.id)!.costUsd).toBe(0.0123);
    const b = q.resume(a.id, 'tiếp tục');
    expect(b).toMatchObject({ resumeOf: `s-${a.id}`, prompt: 'tiếp tục', model: 'haiku' });
    await tick();
    expect(f.runs.get(b.id)!.task.resumeOf).toBe(`s-${a.id}`);
    expect(() => q.create({ kind: 'prompt', prompt: 'x', resumeOf: 'không hợp lệ!' })).toThrow();
    expect(() => q.create({ kind: 'prompt', prompt: 'x', resumeOf: '99999999' })).toThrow(/Không có session/);
  });

  it('stops a task that runs past the max runtime and marks it failed', async () => {
    const f = fakeRunner();
    const q = new TaskQueue({ db: openDb(':memory:'), runner: f.runner, project: () => tmp, snapshot: async () => null,
      defaults: () => ({ model: null, permissionMode: 'default', maxRuntimeMin: 0.001, compactAfter: false }) }); // 60 ms
    const a = q.create({ kind: 'prompt', prompt: 'dài' });
    await tick(200);
    expect(f.runs.get(a.id)!.stopped).toBe(true);
    expect(q.get(a.id)).toMatchObject({ status: 'failed' });
    expect(q.get(a.id)!.error).toMatch(/thời gian chạy tối đa/);
  });

  it('T-TC-08: searches prompt / result and filters by skill (T-SK-04)', async () => {
    const f = fakeRunner();
    const q = new TaskQueue({ db: openDb(':memory:'), runner: f.runner, project: () => null, snapshot: async () => null });
    q.create({ kind: 'skill', skill: 'design-review', args: 'gdd/a.md' });
    q.create({ kind: 'prompt', prompt: 'Viết test inventory' });
    expect(q.list({ q: 'INVENTORY' }).length).toBe(1);
    expect(q.list({ skill: '/design-review' }).map(t => t.prompt)).toEqual(['/design-review gdd/a.md']);
    expect(q.busy()).toBe(true); // T-PJ-03 guard input
  });
});

describe('T-TC-06 task diff, T-PJ-02 git info', () => {
  const g = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  it('diffs against the work tree as it was before the task, without touching refs or the stash', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    g(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'một\nhai\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    g(repo, 'add', '.');
    g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'một\nhai (người dùng)\n'); // user's own edit before the task

    const before = (await takeSnapshot(repo))!;
    const base = await baseRef(repo);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(g(repo, 'stash', 'list').stdout).toBe('');
    // the "task"
    fs.writeFileSync(path.join(repo, 'a.txt'), 'một\nhai (người dùng)\nba (task)\n');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'mới\n');
    fs.rmSync(path.join(repo, 'b.txt'));
    const after = (await takeSnapshot(repo))!;
    const d = await taskDiffs(repo, base, diffSnapshots(before, after), before);
    const by = Object.fromEntries(d.map(x => [x.path, x]));
    expect(by['a.txt'].diff).toContain('+ba (task)');
    expect(by['a.txt'].diff).not.toContain('+hai (người dùng)'); // the user's earlier edit is not attributed to the task
    expect(by['c.txt'].diff).toContain('+mới');
    expect(by['b.txt'].diff).toContain('-b');

    const info = await gitInfo(repo);
    expect(info).toMatchObject({ isRepo: true, branch: 'main', truncated: false });
    expect(info.files.map(f => f.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect((await gitInfo(os.tmpdir())).isRepo).toBe(false);
  });
});

describe('diff util', () => {
  it('keeps context around changes and folds the rest', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l10', 'L10');
    const d = unifiedDiff(a, b, 1);
    expect(d).toEqual([
      { op: 'hunk', line: '… 9 dòng không đổi' }, { op: 'ctx', line: 'l9' }, { op: 'del', line: 'l10' }, { op: 'add', line: 'L10' },
      { op: 'ctx', line: 'l11' }, { op: 'hunk', line: '… 8 dòng không đổi' },
    ]);
  });
});

// Minimal protobuf reader to check the OTLP encoding round-trips.
function readPb(buf: Buffer): [number, number, any][] {
  const out: [number, number, any][] = [];
  let i = 0;
  const varint = () => { let r = 0n, s = 0n; for (;;) { const b = buf[i++]; r |= BigInt(b & 127) << s; s += 7n; if (b < 128) return r; } };
  while (i < buf.length) {
    const tag = Number(varint()); const f = tag >> 3, w = tag & 7;
    if (w === 0) out.push([f, w, varint()]);
    else if (w === 1) { out.push([f, w, buf.readBigUInt64LE(i)]); i += 8; }
    else if (w === 2) { const n = Number(varint()); out.push([f, w, buf.subarray(i, i + n)]); i += n; }
    else throw new Error('wire ' + w);
  }
  return out;
}

describe('M-PF-05 Phoenix (OTLP)', () => {
  it('builds session → agent → tool spans and encodes valid protobuf', () => {
    const s = { id: 'sess-1', taskId: 't', external: false, cwd: null, transcriptPath: null, claudeVersion: null, startedAt: '2026-11-09T10:00:00Z', endedAt: '2026-11-09T10:01:00Z', endReason: null, lastEventAt: '2026-11-09T10:01:00Z', firstPrompt: 'hi' };
    const invs: any[] = [
      { id: 'main:sess-1', sessionId: 'sess-1', parentInvocationId: null, agentType: 'main', status: 'completed', startedAt: '2026-11-09T10:00:00Z', endedAt: '2026-11-09T10:00:59Z', prompt: 'hi', output: 'ok' },
      { id: 'a1', sessionId: 'sess-1', parentInvocationId: 'main:sess-1', agentType: 'qa-tester', status: 'completed', startedAt: '2026-11-09T10:00:10Z', endedAt: '2026-11-09T10:00:20Z', prompt: null, output: null },
      { id: 'a2', sessionId: 'sess-1', parentInvocationId: null, agentType: 'x', status: 'unknown', startedAt: null, endedAt: null },
    ];
    const calls: any[] = [{ id: 'c1', invocationId: 'a1', toolName: 'Bash', inputSummary: 'ls', outputSummary: 'a', status: 'completed', startedAt: '2026-11-09T10:00:11Z', endedAt: '2026-11-09T10:00:12Z', error: null }];
    const usage: any = { byAgent: [{ invocationId: 'a1', usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, messages: 1 }, models: ['m'] }] };
    const spans = sessionSpans(s, invs, calls, usage);
    expect(spans.map(x => x.name)).toEqual(['session sess-1', 'main session', 'qa-tester', 'Bash']); // a2 has no start: skipped
    expect(spans[2].parentSpanId!.equals(spans[1].spanId)).toBe(true);
    expect(spans[3].parentSpanId!.equals(spans[2].spanId)).toBe(true);
    expect(spans[2].attrs['llm.token_count.completion']).toBe(2);
    expect(spans[3].endNs - spans[3].startNs).toBe(1_000_000_000n);

    const top = readPb(encodeTraces(spans, 'Meodoku'));
    expect(top.map(x => x[0])).toEqual([1]); // resource_spans
    const rs = readPb(top[0][2]);
    const scope = readPb(rs.find(x => x[0] === 2)![2]);
    const pbSpans = scope.filter(x => x[0] === 2).map(x => readPb(x[2]));
    expect(pbSpans.length).toBe(4);
    expect(pbSpans[3].find(x => x[0] === 5)![2].toString()).toBe('Bash');
    expect(pbSpans[3].find(x => x[0] === 1)![2].length).toBe(16);
  });
});
