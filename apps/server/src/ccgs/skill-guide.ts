import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../store/db';
import type { SkillDetail, SkillExplain, SkillFacts, SkillGuide, Task, WorkflowPhase } from '@ccgs/shared';
import { ENDED_STATUSES, type TaskQueue } from '../tasks/task-queue';

/** Giải thích skill (api-contract §16). */
export class BadGuide extends Error {}

/** Identifies the SKILL.md text an explanation was written from. */
export const skillHash = (s: Pick<SkillDetail, 'description' | 'argumentHint' | 'body'>) =>
  crypto.createHash('sha256').update(`${s.description}\n${s.argumentHint ?? ''}\n${s.body}`).digest('hex');

const STEP_HEAD = /^(phase|step|stage|bước|giai đoạn)\b/i;
const cmdName = (c: string | null) => (c ? c.trim().split(/\s+/)[0] : null);

/** What Studio reads from SKILL.md and the workflow catalog, without Claude. */
export function skillFacts(s: Pick<SkillDetail, 'name' | 'body'>, skillNames: string[], workflows: WorkflowPhase[]): SkillFacts {
  const heads: { level: number; text: string }[] = [];
  let fence: string | null = null;
  for (const line of s.body.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) heads.push({ level: h[1].length, text: h[2].replace(/\*\*/g, '') });
  }
  const steps = heads.filter(h => STEP_HEAD.test(h.text)).map(h => h.text);
  const phases = steps.length ? steps : heads.filter(h => h.level === 2).map(h => h.text);

  const me = `/${s.name}`;
  const label = (x: { title: string; command: string | null } | undefined) => (x ? cmdName(x.command) ?? x.title : null);
  const workflow: SkillFacts['workflow'] = [];
  for (const p of workflows) {
    p.steps.forEach((st, i) => {
      if (cmdName(st.command) !== me) return;
      workflow.push({ phase: p.label, step: st.title, required: st.required, prev: label(p.steps[i - 1]), next: label(p.steps[i + 1]) });
    });
  }

  const known = new Set(skillNames);
  const mentions: string[] = [];
  for (const m of s.body.matchAll(/(^|[^\w/.-])\/([a-z][a-z0-9-]*)/g)) {
    const n = m[2];
    if (n !== s.name && known.has(n) && !mentions.includes(n)) mentions.push(n);
  }
  return { workflow, phases, mentions };
}

const KEYS: (keyof SkillExplain)[] = ['purpose', 'whenToUse', 'needs', 'steps', 'outputs', 'writes', 'limits', 'next'];

/** Longest SKILL.md text put in the prompt; the rest is cut with a note. */
export const EXPLAIN_MAX_CHARS = 120_000;

/**
 * The task that writes the explanation. The SKILL.md text is in the prompt, so Claude needs no tool: a Read could be
 * cut short by a plugin (context-mode) and turn into permission prompts.
 */
export function explainPrompt(s: Pick<SkillDetail, 'name'>, file: string, text: string): string {
  const cut = text.length > EXPLAIN_MAX_CHARS;
  return [
    `Giải thích skill /${s.name} cho người dùng Studio (chỉ đọc, không sửa gì).`,
    '',
    `The full text of ${file} is between the <skill_md> tags below${cut ? ` (cut after ${EXPLAIN_MAX_CHARS} characters)` : ''}.`,
    'Do not use any tool: do not read other files, do not run the skill, do not edit or create files, do not ask questions.',
    'Write for a game developer who has not read the file and wants to know what the skill does before running it.',
    'Use only what the file says. If the file does not say something, write "SKILL.md không nói rõ". Do not guess.',
    'Write in Vietnamese; keep commands, file paths and verdict words (PASS, FAIL…) as they are.',
    'Be brief: every line at most 15 words; leave out details the reader does not need before running the skill.',
    '',
    'Answer with ONLY this short markdown, no JSON, no text before or after, these headings in this order:',
    '**Mục đích:** 1-2 sentences on the same line: what the skill is for',
    '**Khi dùng:** at most 3 "- " lines',
    '**Cần có:** at most 3 "- " lines: files, earlier skills, arguments needed first',
    '**Các bước:** at most 5 "1. " lines, in order',
    '**Kết quả:** at most 3 "- " lines: what you get, including files it writes',
    '**Lưu ý:** at most 3 "- " lines: what it does NOT do, important cautions',
    '**Tiếp theo:** at most 3 "- " lines: skills or actions to run afterwards',
    'Leave out a heading only when the file says nothing for it.',
    '',
    '<skill_md>',
    cut ? text.slice(0, EXPLAIN_MAX_CHARS) : text,
    '</skill_md>',
    '',
    'Now write the short markdown.',
  ].join('\n');
}

const MAX_ITEMS = 6;
const str = (v: unknown, max = 800) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.map(x => str(x, 400)).filter(Boolean).slice(0, MAX_ITEMS) : typeof v === 'string' && v.trim() ? [str(v, 400)] : []);

const SECTIONS: [RegExp, keyof SkillExplain][] = [
  [/^mục đích$/, 'purpose'], [/^khi (nào )?dùng$/, 'whenToUse'], [/^cần có$/, 'needs'], [/^các bước$/, 'steps'],
  [/^kết quả$/, 'outputs'], [/^lưu ý$/, 'limits'], [/^tiếp theo$/, 'next'],
];
const HEAD = /^\s*(?:#{1,6}\s*)?\*\*([^*:]+?)\s*:?\s*\*\*\s*:?\s*(.*)$|^\s*#{1,6}\s*([^:]+?)\s*:?\s*$/;

/** Reads the short markdown answer (Mục đích / Khi dùng / …). */
function parseMarkdownExplain(text: string): SkillExplain | null {
  const out: SkillExplain = { purpose: '', whenToUse: [], needs: [], steps: [], outputs: [], writes: '', limits: [], next: [] };
  let cur: keyof SkillExplain | null = null, found = 0;
  for (const line of text.split(/\r?\n/)) {
    const h = HEAD.exec(line);
    const key = h && SECTIONS.find(([re]) => re.test((h[1] ?? h[3]).trim().toLowerCase()))?.[1];
    let rest = line;
    if (key) { cur = key; found++; rest = h![2] ?? ''; }
    const item = rest.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim();
    if (!cur || !item) continue;
    if (cur === 'purpose') out.purpose = str(`${out.purpose} ${item}`);
    else { const xs = out[cur] as string[]; if (xs.length < MAX_ITEMS) xs.push(str(item, 400)); }
  }
  return found ? out : null;
}

/**
 * Reads the task's answer: the short markdown, or the last ```json block of answers written before 2026-11-12.
 * Throws BadGuide with a readable reason.
 */
export function parseExplain(text: string | null): SkillExplain {
  const blocks = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : null;
  if (!raw) {
    const md = parseMarkdownExplain(text ?? '');
    if (!md) throw new BadGuide('Câu trả lời không có mục "Mục đích", "Các bước"…');
    if (!md.purpose) throw new BadGuide('Thiếu "Mục đích"');
    return md;
  }
  let o: any;
  try { o = JSON.parse(raw); } catch (e) { throw new BadGuide(`JSON không hợp lệ: ${(e as Error).message}`); }
  if (!o || typeof o !== 'object') throw new BadGuide('JSON không phải object');
  const out: SkillExplain = {
    purpose: str(o.purpose), whenToUse: strs(o.whenToUse), needs: strs(o.needs), steps: strs(o.steps),
    outputs: strs(o.outputs), writes: str(o.writes, 600), limits: strs(o.limits), next: strs(o.next),
  };
  if (!out.purpose) throw new BadGuide('Thiếu "purpose"');
  const missing = KEYS.filter(k => !(k in o));
  if (missing.length > 3) throw new BadGuide(`Thiếu các mục: ${missing.join(', ')}`);
  return out;
}

type Row = { hash: string; name: string; explain: string | null; task_id: string | null; error: string | null; created_at: string };
const ended = (t: Task | null) => !!t && (ENDED_STATUSES as readonly string[]).includes(t.status);

export class SkillGuideService {
  constructor(private readonly d: {
    db: Db; queue: TaskQueue;
    skills: () => SkillDetail[] | null; workflows: () => WorkflowPhase[]; root: () => string | null;
    model?: string;
  }) {
    d.queue.bus.on('task', t => this.onTask(t));
    d.queue.bus.on('removed', ids => {
      const st = d.db.$client.prepare('UPDATE skill_guides SET task_id = NULL WHERE task_id = ?');
      for (const id of ids) st.run(id);
    });
    // Studio restarted while an explanation ran: settle what already ended, drop what no longer exists.
    for (const r of d.db.$client.prepare('SELECT * FROM skill_guides WHERE task_id IS NOT NULL').all() as Row[]) {
      const t = d.queue.get(r.task_id!);
      if (!t) d.db.$client.prepare('UPDATE skill_guides SET task_id = NULL WHERE hash = ?').run(r.hash);
      else this.onTask(t);
    }
  }

  private get sql() { return this.d.db.$client; }
  private row(hash: string) { return (this.sql.prepare('SELECT * FROM skill_guides WHERE hash = ?').get(hash) as Row | undefined) ?? null; }

  private onTask(t: Task) {
    if (!ended(t)) return;
    const r = this.sql.prepare('SELECT * FROM skill_guides WHERE task_id = ?').get(t.id) as Row | undefined;
    if (!r) return;
    const now = new Date().toISOString();
    if (t.status !== 'completed') {
      const why = t.status === 'cancelled' ? 'Task giải thích đã bị huỷ' : `Task giải thích lỗi: ${t.error ?? 'không rõ lý do'}`;
      this.sql.prepare('UPDATE skill_guides SET task_id = NULL, error = ? WHERE hash = ?').run(why, r.hash);
      return;
    }
    try {
      const e = parseExplain(t.resultText);
      this.sql.prepare('UPDATE skill_guides SET task_id = NULL, error = NULL, explain = ?, created_at = ? WHERE hash = ?').run(JSON.stringify(e), now, r.hash);
    } catch (e) {
      this.sql.prepare('UPDATE skill_guides SET task_id = NULL, error = ? WHERE hash = ?').run(`Không đọc được kết quả: ${(e as Error).message}`, r.hash);
    }
  }

  private skill(name: string) {
    const all = this.d.skills();
    if (!all) return null;
    const s = all.find(x => x.name === name);
    if (!s) throw new BadGuide(`Không có skill ${name}`);
    return { s, all };
  }

  /** null when no project is open. */
  get(name: string): SkillGuide | null {
    const k = this.skill(name);
    if (!k) return null;
    const { s, all } = k;
    const hash = skillHash(s);
    const facts = skillFacts(s, all.map(x => x.name), this.d.workflows());
    const r = this.row(hash);
    let src = r?.explain ? r : null;
    if (!src) src = (this.sql.prepare('SELECT * FROM skill_guides WHERE name = ? AND explain IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(s.name) as Row | undefined) ?? null;
    const t = r?.task_id ? this.d.queue.get(r.task_id) : null;
    return {
      name: s.name, hash, facts,
      explain: src?.explain ? (JSON.parse(src.explain) as SkillExplain) : null,
      explainedAt: src?.explain ? src.created_at : null,
      stale: !!src && src.hash !== hash,
      taskId: t?.id ?? null, taskStatus: t?.status ?? null, error: r?.error ?? null,
    };
  }

  /** Queues the explanation task (or returns the one already running for this SKILL.md). */
  explain(name: string): SkillGuide | null {
    const k = this.skill(name);
    if (!k) return null;
    const { s } = k;
    const root = this.d.root();
    if (!s.hasSkillMd || !s.file || !root) throw new BadGuide('Skill này không có SKILL.md');
    const hash = skillHash(s);
    const r = this.row(hash);
    const cur = r?.task_id ? this.d.queue.get(r.task_id) : null;
    if (cur && !ended(cur)) return this.get(name);
    const abs = path.resolve(root, s.file);
    let text: string;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { throw new BadGuide(`Không đọc được SKILL.md: ${(e as Error).message}`); }
    const t = this.d.queue.create({ kind: 'prompt', prompt: explainPrompt(s, s.file, text), model: this.d.model ?? 'sonnet', permissionMode: 'default' });
    this.sql.prepare(`INSERT INTO skill_guides (hash, name, task_id, error, created_at) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(hash) DO UPDATE SET task_id = excluded.task_id, error = NULL`).run(hash, s.name, t.id, new Date().toISOString());
    return this.get(name);
  }
}
