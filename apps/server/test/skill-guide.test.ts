import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillDetail, Task, WorkflowPhase } from '@ccgs/shared';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { RunHooks, RunOutcome, Runner } from '../src/tasks/runner';
import { BadGuide, EXPLAIN_MAX_CHARS, SkillGuideService, explainPrompt, parseExplain, skillFacts } from '../src/ccgs/skill-guide';

const BODY = [
  '# Estimate', '', '## Phase 1: Understand the Task', 'Run `/story-readiness` first.', '',
  '```markdown', '## Phase 9: inside a template', '/not-a-heading', '```', '',
  '### Phase 2: Scan Affected Code', 'See production/qa and docs/x. Then /code-review.', '',
  '## Guidelines', 'Next: /sprint-plan or /estimate again.',
].join('\n');

const skill = (name: string, body = BODY): SkillDetail => ({
  name, dir: `.claude/skills/${name}`, origin: 'ccgs', linkTarget: null, hasSkillMd: true, description: `${name} desc`,
  argumentHint: null, model: null, allowedTools: [], userInvocable: true, relatedAgents: [], parseError: null,
  body, file: `.claude/skills/${name}/SKILL.md`,
});
const WF: WorkflowPhase[] = [{ id: 'production', label: 'Production', steps: [
  { id: 'a', title: 'Ready', command: '/story-readiness', required: true, repeatable: true },
  { id: 'b', title: 'Estimate', command: '/estimate [task]', required: false, repeatable: true },
  { id: 'c', title: 'Review', command: null, required: false, repeatable: false },
] }];
const NAMES = ['estimate', 'story-readiness', 'code-review', 'sprint-plan', 'qa'];

const GOOD = {
  purpose: 'Ước lượng công sức.', whenToUse: ['Trước sprint'], needs: ['Mô tả task'], steps: ['Đọc task', 'Quét code'],
  outputs: ['Bảng ước lượng'], writes: 'Không ghi file', limits: ['Không sửa code'], next: ['/sprint-plan'],
};
const answer = (o: unknown) => `Đây là giải thích.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe('skill guide facts (api-contract §16)', () => {
  it('reads step headings outside code fences, the workflow position and other skills named', () => {
    const f = skillFacts(skill('estimate'), NAMES, WF);
    expect(f.phases).toEqual(['Phase 1: Understand the Task', 'Phase 2: Scan Affected Code']);
    expect(f.workflow).toEqual([{ phase: 'Production', step: 'Estimate', required: false, prev: '/story-readiness', next: 'Review' }]);
    expect(f.mentions).toEqual(['story-readiness', 'code-review', 'sprint-plan']); // not itself, not production/qa
  });
  it('falls back to every ## heading when there are no step headings', () => {
    expect(skillFacts(skill('x', '## Overview\n## Output\n### Detail'), [], []).phases).toEqual(['Overview', 'Output']);
  });
});

describe('parseExplain', () => {
  it('takes the last json block and keeps only strings', () => {
    const e = parseExplain(`\`\`\`json\n{"purpose":"cũ"}\n\`\`\`\n${answer({ ...GOOD, steps: ['a', 3, ''], whenToUse: 'một dòng' })}`);
    expect(e.purpose).toBe('Ước lượng công sức.');
    expect(e.steps).toEqual(['a']);
    expect(e.whenToUse).toEqual(['một dòng']);
  });
  it('reads the short markdown answer; extra lines are cut', () => {
    const md = [
      '**Mục đích:** Ước lượng công sức', 'cho một task.', '', '**Khi dùng:**', '- Trước sprint', '',
      '**Các bước:**', ...Array.from({ length: 8 }, (_, i) => `${i + 1}. Bước **${i + 1}**`), '',
      '## Kết quả', '- Bảng ước lượng', '**Lưu ý:** Không sửa code', '**Tiếp theo:**', '- /sprint-plan',
    ].join('\n');
    const e = parseExplain(md);
    expect(e.purpose).toBe('Ước lượng công sức cho một task.');
    expect(e.whenToUse).toEqual(['Trước sprint']);
    expect(e.needs).toEqual([]);
    expect(e.steps).toHaveLength(6);
    expect(e.steps[0]).toBe('Bước 1');
    expect(e.outputs).toEqual(['Bảng ước lượng']);
    expect(e.limits).toEqual(['Không sửa code']);
    expect(e.next).toEqual(['/sprint-plan']);
    expect(e.writes).toBe('');
    expect(() => parseExplain('**Khi dùng:**\n- x')).toThrow(/Mục đích/);
  });
  it('refuses an answer without usable JSON', () => {
    expect(() => parseExplain('không có gì')).toThrow(BadGuide);
    expect(() => parseExplain('```json\n{oops}\n```')).toThrow(/JSON không hợp lệ/);
    expect(() => parseExplain(answer({ ...GOOD, purpose: '' }))).toThrow(/purpose/);
  });
  it('the prompt carries the SKILL.md text, forbids tools and edits, and cuts a huge file', () => {
    const p = explainPrompt({ name: 'estimate' }, '.claude/skills/estimate/SKILL.md', 'NỘI DUNG SKILL');
    expect(p).toContain('<skill_md>\nNỘI DUNG SKILL\n</skill_md>');
    expect(p).toMatch(/Do not use any tool/);
    expect(p).toMatch(/do not edit or create files/);
    expect(p).toMatch(/ONLY this short markdown, no JSON/);
    expect(p).toMatch(/**Mục đích:**/);
    expect(p).toMatch(/at most 15 words/);
    expect(parseExplain(answer({ ...GOOD, steps: Array.from({ length: 10 }, (_, i) => `b${i}`) })).steps).toHaveLength(6);
    const big = explainPrompt({ name: 'x' }, 'f', 'a'.repeat(EXPLAIN_MAX_CHARS + 50));
    expect(big).toMatch(/cut after/);
    expect(big.length).toBeLessThan(EXPLAIN_MAX_CHARS + 5000);
  });
});

function setup() {
  const runs = new Map<string, (o: Partial<RunOutcome>) => void>();
  const runner: Runner = (task: Task, hooks: RunHooks) => {
    let finish!: (o: Partial<RunOutcome>) => void;
    const done = new Promise<RunOutcome>(r => { finish = o => r({ ok: true, sessionId: `s-${task.id}`, resultText: null, error: null, ...o }); });
    runs.set(task.id, finish);
    hooks.onSession(`s-${task.id}`);
    return { done, pid: () => null, stop: async () => finish({ ok: false, error: 'stopped' }) };
  };
  const db = openDb(':memory:');
  const queue = new TaskQueue({ db, runner, project: () => 'x', snapshot: async () => null, sessionExists: () => true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-guide-'));
  fs.mkdirSync(path.join(root, '.claude/skills/estimate'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/skills/estimate/SKILL.md'), `---\nname: estimate\n---\n${BODY}`);
  const skills = [skill('estimate'), { ...skill('broken'), hasSkillMd: false, file: null }, skill('gone')];
  const svc = new SkillGuideService({ db, queue, skills: () => skills, workflows: () => WF, root: () => root });
  return { svc, queue, runs, skills, db };
}
const tick = () => new Promise(r => setTimeout(r, 5));

describe('SkillGuideService', () => {
  it('queues one explanation task per SKILL.md and stores the parsed answer', async () => {
    const s = setup();
    expect(s.svc.get('estimate')).toMatchObject({ explain: null, taskId: null, stale: false });
    const g = s.svc.explain('estimate')!;
    expect(g.taskId).toBeTruthy();
    const t = s.queue.get(g.taskId!)!;
    expect(t).toMatchObject({ kind: 'prompt', model: 'sonnet' });
    expect(t.prompt).toContain('.claude/skills/estimate/SKILL.md');
    expect(t.prompt).toContain('## Phase 2: Scan Affected Code'); // the file text, read from disk
    expect(s.svc.explain('estimate')!.taskId).toBe(g.taskId); // already running: no second task
    await tick();
    s.runs.get(g.taskId!)!({ resultText: answer(GOOD) });
    await tick();
    const done = s.svc.get('estimate')!;
    expect(done).toMatchObject({ explain: GOOD, stale: false, taskId: null, error: null });
    expect(done.explainedAt).toBeTruthy();
  });

  it('keeps the old explanation marked stale when SKILL.md changes, and records a failed run', async () => {
    const s = setup();
    const g = s.svc.explain('estimate')!;
    await tick();
    s.runs.get(g.taskId!)!({ resultText: answer(GOOD) });
    await tick();
    s.skills[0] = { ...s.skills[0], body: BODY + '\n## Phase 3: New' };
    expect(s.svc.get('estimate')).toMatchObject({ explain: GOOD, stale: true });
    const again = s.svc.explain('estimate')!;
    await tick();
    s.runs.get(again.taskId!)!({ resultText: 'Tôi quên JSON' });
    await tick();
    const after = s.svc.get('estimate')!;
    expect(after).toMatchObject({ explain: GOOD, stale: true, taskId: null });
    expect(after.error).toMatch(/Không đọc được kết quả/);
  });

  it('errors: unknown skill, no SKILL.md, failed task; a deleted pending task clears the wait', async () => {
    const s = setup();
    expect(() => s.svc.get('nope')).toThrow(/Không có skill/);
    expect(() => s.svc.explain('broken')).toThrow(/không có SKILL.md/);
    expect(() => s.svc.explain('gone')).toThrow(/Không đọc được SKILL.md/);
    const g = s.svc.explain('estimate')!;
    await tick();
    s.runs.get(g.taskId!)!({ ok: false, error: 'usage limit' });
    await tick();
    expect(s.svc.get('estimate')!.error).toMatch(/usage limit/);
    const q = s.queue.create({ kind: 'prompt', prompt: 'giữ hàng đợi bận' });
    const waiting = s.svc.explain('estimate')!; // queued behind q
    s.db.$client.prepare('UPDATE skill_guides SET task_id = ? WHERE hash = ?').run(waiting.taskId, waiting.hash);
    await s.queue.cancel(waiting.taskId!);
    await tick();
    expect(s.svc.get('estimate')).toMatchObject({ taskId: null, error: 'Task giải thích đã bị huỷ' });
    s.runs.get(q.id)?.({});
  });
});
