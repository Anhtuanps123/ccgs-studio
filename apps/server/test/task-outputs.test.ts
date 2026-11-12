import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChangedFile, Task } from '@ccgs/shared';
import { BadOutput, listOutputs, markdownToCsv, markdownToXlsx, outputKind, parseMarkdown, resolveOutput, resolveStudioOutput, studioOutputDir, studioOutputs, withOutput } from '../src/tasks/outputs';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunHooks, RunOutcome, Runner } from '../src/tasks/runner';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-out-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (root: string, rel: string, body: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

const GDD = `# Piggy Bank

## Summary
Heo đất tích **điểm** mỗi lần thắng.

## Tuning Knobs
| Knob | Default | Range |
|---|---|---|
| MAX_POINT | 200 | 100–500 |
| CLAIMS_PER_DAY | 2 | 1, 2, 3 |

\`\`\`
| not | a table |
|---|---|
\`\`\`

## Acceptance Criteria
| ID | Criterion | Test |
|----|-----------|------|
| AC-1 | Đầy 200 điểm thì nút Claim sáng, "Break!" | Manual |
`;

describe('task outputs (Đầu ra)', () => {
  it('sorts files into kinds', () => {
    expect(outputKind('prototypes/a/index.HTML')).toBe('web');
    expect(outputKind('design/gdd/piggy-bank.md')).toBe('doc');
    expect(outputKind('production/qa/evidence/a.png')).toBe('image');
    expect(outputKind('data/rewards.csv')).toBe('data');
    expect(outputKind('Assets/Scripts/Piggy.cs')).toBe('other');
  });

  it('reads a GDD: title, sections, tables under their heading, fenced code left alone', () => {
    const d = parseMarkdown(GDD);
    expect(d.title).toBe('Piggy Bank');
    expect(d.sections.map(s => s.heading)).toEqual(['Piggy Bank', 'Summary', 'Tuning Knobs', 'Acceptance Criteria']);
    expect(d.tables).toHaveLength(2);
    expect(d.tables[0]).toEqual({ section: 'Tuning Knobs', header: ['Knob', 'Default', 'Range'], rows: [['MAX_POINT', '200', '100–500'], ['CLAIMS_PER_DAY', '2', '1, 2, 3']] });
    expect(d.tables[1].section).toBe('Acceptance Criteria');
    expect(d.sections.find(s => s.heading === 'Summary')!.lines).toEqual(['Heo đất tích **điểm** mỗi lần thắng.']);
  });

  it('CSV: tables only, BOM for Excel, quoted cells; several tables each under its heading', () => {
    const one = markdownToCsv('# X\n| a | b |\n|---|---|\n| 1 | x, "y" |\n');
    expect(one.startsWith('\uFEFF')).toBe(true);
    expect(one.slice(1).split('\r\n')).toEqual(['a,b', '1,"x, ""y"""', '']);
    const many = markdownToCsv(GDD).slice(1).split('\r\n');
    expect(many[0]).toBe('Tuning Knobs');
    expect(many).toContain('Acceptance Criteria');
    expect(many).toContain('AC-1,"Đầy 200 điểm thì nút Claim sáng, ""Break!""",Manual');
    const same = markdownToCsv('## A\n| k | v |\n|---|---|\n| x | 1 |\n## B\n| k | v |\n|---|---|\n| y | 2 |\n').slice(1).split('\r\n');
    expect(same).toEqual(['Mục,k,v', 'A,x,1', 'B,y,2', '']);
    expect(() => markdownToCsv('# Không có bảng\nchữ thôi')).toThrow(BadOutput);
  });

  it('Excel: a "Nội dung" sheet with every section and the tables in place, then one sheet per table', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await markdownToXlsx(GDD, 'piggy-bank') as any);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Nội dung', 'Tuning Knobs', 'Acceptance Criteria']);
    const all: string[] = [];
    wb.getWorksheet('Nội dung')!.eachRow(r => all.push((r.values as any[]).slice(1).join(' | ')));
    expect(all[0]).toBe('Piggy Bank');
    expect(all).toContain('Summary');
    expect(all).toContain('Heo đất tích điểm mỗi lần thắng.');
    expect(all).toContain('Knob | Default | Range');
    expect(all).toContain('MAX_POINT | 200 | 100–500');
    const knobs = wb.getWorksheet('Tuning Knobs')!;
    expect(knobs.getRow(1).getCell(1).value).toBe('Knob');
    expect(knobs.getRow(3).getCell(1).value).toBe('CLAIMS_PER_DAY');
    expect(knobs.autoFilter).toBeTruthy();
  });

  it('opens only files the task changed (or next to a changed HTML page), inside the project', () => {
    const root = path.join(tmp, 'r1');
    put(root, 'prototypes/piggy/index.html', '<script src="app.js"></script>');
    put(root, 'prototypes/piggy/app.js', '1');
    put(root, 'design/gdd/piggy-bank.md', GDD);
    put(root, 'secret.txt', 'no');
    const files: ChangedFile[] = [{ path: 'prototypes/piggy/index.html', change: 'A' }, { path: 'design/gdd/piggy-bank.md', change: 'M' }, { path: 'old.md', change: 'D' }];
    expect(resolveOutput(root, files, 'design/gdd/piggy-bank.md')).toBe(path.join(root, 'design', 'gdd', 'piggy-bank.md'));
    expect(resolveOutput(root, files, 'prototypes/piggy/app.js')).toBe(path.join(root, 'prototypes', 'piggy', 'app.js'));
    for (const bad of ['secret.txt', '../secret.txt', 'prototypes/piggy/../../secret.txt', 'old.md', '', 'C:/Windows/win.ini', '/etc/passwd'])
      expect(() => resolveOutput(root, files, bad), bad).toThrow(BadOutput);
    fs.rmSync(path.join(root, 'design/gdd/piggy-bank.md'));
    expect(() => resolveOutput(root, files, 'design/gdd/piggy-bank.md')).toThrow(/không còn/);
  });

  it('lists outputs relative to the git root; prototypes get the /preview URL of the project', () => {
    const root = path.join(tmp, 'r2'), project = path.join(root, 'game');
    put(project, 'prototypes/spin/index.html', '<p>x</p>');
    put(project, 'design/gdd/lucky-spin.md', GDD);
    const list = listOutputs(root, project, [
      { path: 'game/prototypes/spin/index.html', change: 'A' }, { path: 'game/design/gdd/lucky-spin.md', change: 'A' },
      { path: 'game/gone.png', change: 'M' }, { path: 'game/x.cs', change: 'D' },
    ]);
    expect(list.map(o => [o.path, o.kind, o.exists, o.preview, o.tables])).toEqual([
      ['game/prototypes/spin/index.html', 'web', true, '/preview/spin/index.html', null],
      ['game/design/gdd/lucky-spin.md', 'doc', true, null, 2],
      ['game/gone.png', 'image', false, null, null],
    ]);
  });

  it('output asked for: the prompt says where and how; Excel is built from the tables Claude writes when listed', async () => {
    const dir = path.join(tmp, 'home', 'outputs', 't1');
    expect(withOutput('/prototype piggy', null, dir)).toBe('/prototype piggy');
    const web = withOutput('/prototype piggy', 'web', dir);
    expect(web.startsWith('/prototype piggy\n\n')).toBe(true);
    expect(web).toContain(path.join(dir, 'index.html'));
    expect(web).toContain('not type="module"');
    expect(withOutput('x', 'xlsx', dir)).toContain(path.join(dir, 'output.md'));
    expect(withOutput('x', 'csv', dir)).toContain('rewards.csv');
    expect(await studioOutputs(dir, 'xlsx')).toEqual([]); // folder not made yet
    put(dir, 'output.md', GDD);
    put(dir, 'page/index.html', '<p>x</p>');
    const list = await studioOutputs(dir, 'xlsx');
    expect(list.map(o => [o.path, o.kind, o.tables])).toEqual([
      ['~studio/output.md', 'doc', 2], ['~studio/output.xlsx', 'other', null], ['~studio/page/index.html', 'web', null]]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fs.readFileSync(path.join(dir, 'output.xlsx')) as any);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Nội dung', 'Tuning Knobs', 'Acceptance Criteria']);
    expect((await studioOutputs(dir, 'csv')).length).toBe(3); // no rebuild for other formats
    expect(resolveStudioOutput(dir, '~studio/page/index.html')).toBe(path.join(dir, 'page', 'index.html'));
    for (const bad of ['~studio/../t2/x.md', '~studio/', '~studio/nope.md']) expect(() => resolveStudioOutput(dir, bad), bad).toThrow(BadOutput);
  });

  it('a task keeps the output format it was created with; its output folder goes when the task is deleted', async () => {
    const home = path.join(tmp, 'home2');
    const runs = new Map<string, () => void>();
    const runner: Runner = (task: Task, hooks: RunHooks) => {
      let finish!: () => void;
      const done = new Promise<RunOutcome>(r => { finish = () => r({ ok: true, sessionId: `s-${task.id}`, resultText: 'xong', error: null }); });
      runs.set(task.id, finish); hooks.onSession(`s-${task.id}`);
      return { done, pid: () => null, stop: async () => finish() };
    };
    const q = new TaskQueue({ db: openDb(':memory:'), runner, project: () => 'x', snapshot: async () => null, sessionExists: () => true, outputsDir: id => studioOutputDir(home, id) });
    expect(() => q.create({ kind: 'prompt', prompt: 'a', output: 'pdf' as any })).toThrow(/web, xlsx hoặc csv/);
    const t = q.create({ kind: 'skill', skill: 'prototype', args: 'piggy', output: 'web' });
    expect(q.get(t.id)!.output).toBe('web');
    expect(q.create({ kind: 'prompt', prompt: 'b', output: null }).output).toBeNull();
    await new Promise(r => setTimeout(r, 5));
    put(q.outputDir(t.id)!, 'index.html', '<p>x</p>');
    runs.get(t.id)!();
    await new Promise(r => setTimeout(r, 5));
    const again = q.resume(t.id, 'thêm nút Claim', undefined, 'xlsx');
    expect(again.output).toBe('xlsx');
    expect(q.remove(t.id).deleted).toEqual([t.id]);
    expect(fs.existsSync(studioOutputDir(home, t.id))).toBe(false);
  });
});
