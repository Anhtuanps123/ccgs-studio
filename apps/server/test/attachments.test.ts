import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, type Task } from '@ccgs/shared';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunOutcome, Runner } from '../src/tasks/runner';
import { AttachmentStore, attachmentDirs, safeName, withAttachments } from '../src/tasks/attachments';
import { PipelineService } from '../src/pipelines/pipeline.service';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-att-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

function fakeRunner() {
  const runs = new Map<string, { task: Task; finish: (o: Partial<RunOutcome>) => void }>();
  const runner: Runner = (task, hooks) => {
    let finish!: (o: Partial<RunOutcome>) => void;
    const done = new Promise<RunOutcome>(r => { finish = o => r({ ok: true, sessionId: task.resumeOf ?? 'sess-1', resultText: 'xong', error: null, ...o }); });
    runs.set(task.id, { task, finish });
    hooks.onSession(task.resumeOf ?? 'sess-1');
    return { done, pid: () => null, stop: async () => finish({ ok: false, error: 'stopped' }) };
  };
  return { runner, runs };
}

describe('attachment store', () => {
  const store = new AttachmentStore(path.join(tmp, 'store'));

  it('saves a file under its own folder and reads it back by id', () => {
    const a = store.save('mockup UI.png', b64(PNG));
    expect(a).toMatchObject({ name: 'mockup UI.png', size: PNG.length, mime: 'image/png' });
    expect(fs.readFileSync(a.path)).toEqual(PNG);
    expect(path.dirname(path.dirname(a.path))).toBe(path.join(tmp, 'store'));
    expect(store.get(a.id)).toEqual(a);
    expect(store.resolve([a.id, a.id])).toEqual([a]);
  });

  it('strips folders and bad characters from the name', () => {
    expect(safeName('..\\..\\Windows\\evil.png')).toBe('evil.png');
    expect(safeName('../a/b:c?.md')).toBe('b_c_.md');
    expect(safeName('.hidden.txt')).toBe('hidden.txt');
    expect(safeName('x'.repeat(300) + '.pdf')).toMatch(/^x{116}\.pdf$/);
  });

  it('refuses unknown types, empty and oversized files, bad or missing ids, too many files', () => {
    expect(() => store.save('run.exe', b64('MZ'))).toThrow(/Không nhận/);
    expect(() => store.save('a.svg', b64('<svg/>'))).toThrow(/Không nhận/);
    expect(() => store.save('a.png', '')).toThrow(/rỗng/);
    expect(() => store.save('a.png', b64(Buffer.alloc(ATTACH_MAX_BYTES + 1)))).toThrow(/tối đa/);
    expect(store.get('../../etc')).toBeNull();
    expect(() => store.resolve(['00000000-0000-4000-8000-000000000000'])).toThrow(/Không tìm thấy/);
    expect(() => store.resolve('x')).toThrow(/danh sách/);
    const ids = Array.from({ length: ATTACH_MAX_FILES + 1 }, (_, i) => store.save(`f${i}.txt`, b64('x')).id);
    expect(() => store.resolve(ids)).toThrow(/Tối đa/);
  });

  it('appends the paths to the prompt and lists the folders to open', () => {
    const a = store.save('spec.md', b64('# Spec'));
    expect(withAttachments('Làm theo spec', [])).toBe('Làm theo spec');
    const s = withAttachments('Làm theo spec', [a]);
    expect(s.startsWith('Làm theo spec\n\nAttached files')).toBe(true);
    expect(s).toContain(a.path);
    expect(s).toContain('Read tool');
    expect(attachmentDirs([a, a])).toEqual([path.dirname(a.path)]);
  });
});

describe('attachments on tasks and plans', () => {
  const store = new AttachmentStore(path.join(tmp, 'q'));

  it('keeps the files on the task (also after a reload), not in its prompt; resume can attach more', async () => {
    const f = fakeRunner();
    const db = openDb(':memory:');
    const q = new TaskQueue({ db, runner: f.runner, project: () => tmp, snapshot: async () => null, sessionExists: () => true, attachments: store });
    const a = store.save('shot.png', b64(PNG));
    const t = q.create({ kind: 'skill', skill: 'quick-design', args: 'lucky spin', attachments: [a.id] });
    expect(t.prompt).toBe('/quick-design lucky spin');
    expect(t.attachments).toEqual([a]);
    await tick();
    expect(f.runs.get(t.id)!.task.attachments).toEqual([a]);
    expect(new TaskQueue({ db, runner: f.runner, project: () => null, snapshot: async () => null }).get(t.id)!.attachments).toEqual([a]);
    expect(q.create({ kind: 'prompt', prompt: 'x', attachments: [] }).attachments).toBeNull();
    expect(() => q.create({ kind: 'prompt', prompt: 'x', attachments: ['nope'] })).toThrow(/Không tìm thấy/);
    f.runs.get(t.id)!.finish({});
    await tick();
    const b = store.save('log.txt', b64('lỗi'));
    expect(q.resume(t.id, 'sửa tiếp', [b.id]).attachments).toEqual([b]);
  });

  it('gives the request files to the planner and to every step', async () => {
    const f = fakeRunner();
    const db = openDb(':memory:');
    const q = new TaskQueue({ db, runner: f.runner, project: () => 'x', snapshot: async () => null, sessionExists: () => true, attachments: store });
    const root = fs.mkdtempSync(path.join(tmp, 'pl-'));
    fs.writeFileSync(path.join(root, 'project.yaml'), 'modes:\n  rigor: minimal\n');
    const skills = [{ name: 'quick-design', description: 'd', argumentHint: null }];
    const p = new PipelineService({ db, queue: q, skills: () => skills, project: () => root, templates: () => [], critic: false, attachments: store });
    const a = store.save('ui.png', b64(PNG));
    expect(() => p.create({ request: 'x', attachments: ['nope'] })).toThrow(/Không tìm thấy/);
    let pl = p.create({ request: 'Làm màn này', attachments: [a.id] });
    expect(pl.attachments).toEqual([a]);
    expect(q.get(pl.planTaskId!)!.attachments).toEqual([a]);
    await tick();
    f.runs.get(pl.planTaskId!)!.finish({ resultText: '```json\n{"steps":[{"title":"Thiết kế","skill":"quick-design","args":"x"}]}\n```' });
    await tick();
    pl = p.start(pl.id);
    expect(q.get(pl.steps[0].taskId!)!.attachments).toEqual([a]);
    expect(p.create({ request: 'không tệp' }).attachments).toBeUndefined();
  });
});
