// Feature pipelines: one request -> a plan (written by Claude, read-only) -> the user edits and approves ->
// Studio runs each step as a task in the same session, one after another.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { NewPipeline, Pipeline, PipelineMode, PipelineSetup, PipelineStep, PlanStep, Rigor, Task } from '@ccgs/shared';
import type { Db } from '../store/db';
import { BadTask, TaskQueue } from '../tasks/task-queue';
import { checkPlan, loadTemplates, slugOf, templatesPrompt, type PlanTemplate } from './plan-rules';

export interface SkillInfo { name: string; description: string; argumentHint: string | null }
export interface PipelineDeps { db: Db; queue: TaskQueue; skills: () => SkillInfo[]; project?: () => string | null; scan?: () => { status: string; summary: string | null; startDoneAt?: string | null }; templates?: () => PlanTemplate[] }

export const RIGORS: Rigor[] = ['minimal', 'standard', 'full'];

/** Reads what /start wrote to project.yaml (modes.rigor, modes.automation, project.stage). Read-only. */
export function readSetup(root: string | null): PipelineSetup {
  const none = (error: string | null): PipelineSetup => ({ started: false, rigor: null, stage: null, automation: null, error });
  if (!root) return none('Chưa chọn project');
  const f = path.join(root, 'project.yaml');
  if (!fs.existsSync(f)) return none('Không có project.yaml');
  let y: any;
  try { y = YAML.parse(fs.readFileSync(f, 'utf8')) ?? {}; } catch (e) { return none(`Không đọc được project.yaml: ${(e as Error).message}`); }
  const rigor = RIGORS.includes(y?.modes?.rigor) ? (y.modes.rigor as Rigor) : null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { started: !!rigor, rigor, stage: str(y?.project?.stage), automation: str(y?.modes?.automation), error: null, source: rigor ? 'project.yaml' : null };
}

// The CCGS roadmap per rigor, condensed from .claude/skills/start/SKILL.md (Phase 6) and .claude/docs/effects-map.md.
const ROADMAP: Record<Rigor, string> = {
  minimal: `rigor = minimal: no GDDs; design/game-brief.md is the design record; coarse stories; tests optional (UI/visual stories still need a retained screenshot). Path to code: /brainstorm (brief) -> /create-stories (from the brief, no epics or sprint plan needed) -> /dev-story. For a small feature prefer /quick-design -> /create-stories -> per-story /dev-story. Add /ux-design only when the feature adds a new screen or popup.`,
  standard: `rigor = standard: GDDs with 5 required sections (+ Formulas for numeric rules); critical ADRs only; balanced stories; standard QA evidence. Order: Systems Design (/design-system per system, /review-all-gdds) -> Architecture (/architecture-decision for critical decisions) -> Pre-Production (/ux-design for every new screen, HUD or popup, then /create-epics -> /create-stories) -> Production (/dev-story per story). Use /quick-design only for a tuning tweak or minor mechanic; a new system gets /design-system.`,
  full: `rigor = full: everything in standard, plus all 8 GDD sections, an ADR for every decision, fine-grained stories, full QA evidence and director reviews. Add /design-review after each GDD, /ux-review after each /ux-design, and /architecture-review after ADRs; consider /vertical-slice and /playtest-report before Production.`,
};

export class BadPipeline extends Error {}

const STORY_RE = /^production\/epics\/[^/]+\/story-\d+[^/]*\.md$/;
const SKILL_RE = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$/i; // plugin skills: plugin:skill
const MAX_STEPS = 40;
const ENDED: Task['status'][] = ['completed', 'failed', 'cancelled'];
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function plannerPrompt(request: string, skills: SkillInfo[], rigor?: Rigor | null, setup?: PipelineSetup | null, gameScan?: string | null, templates: PlanTemplate[] = []): string {
  const list = skills.map(s => `- /${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ''}: ${cut(s.description.replace(/\s+/g, ' '), 160)}`).join('\n');
  return `You are planning work for CCGS Studio. Do NOT modify any file and do not run commands that change anything; only read (Read, Glob, Grep) to understand the project.

The user's request:
"""
${request}
"""

Turn it into an ordered list of steps that the studio will run one after another in the same Claude session. Prefer the project's skills (slash commands) below; use a plain prompt step only when no skill fits. Follow this project's own workflow (see .claude/docs/workflow-catalog.yaml) and look at what already exists (design/, production/, the code) so you do not plan work that is done. Keep it as short as the request allows.

Project setup (from /start, project.yaml): stage ${setup?.stage ?? 'Unknown'}, rigor in project.yaml ${setup?.rigor ?? 'Unknown'}.
The user chose rigor "${rigor ?? 'minimal'}" for this plan. Follow it:
${ROADMAP[rigor ?? 'minimal']}
Skip steps whose output already exists on disk. Do not plan /start, /settings or /gate-check unless the request asks for them.
If the plan contains a /ux-design step, you MUST ask the user (AskUserQuestion, in Vietnamese) before replying, for each such screen: "Có cần /prototype (bản HTML chạy được để xem trước UI/UX) cho màn này không?". Only when the user answers yes, add a /prototype step for that screen right after its /ux-design step (and its /ux-review, if any). Never add /prototype for a screen without that yes.
Art consistency: before the first /ux-design, /prototype or /dev-story step of a feature that touches UI (screens, popups, HUD, buttons), add one step with skill "studio:unity-art-context" and args "<feature-slug> <screen names>", unless design/art-context/<feature-slug>.md already exists. It reads the game's real sprites, colours and fonts through Unity MCP so later steps reuse them; read that file yourself if it exists.
${templates.length ? `
Plan templates (the studio standard). Pick exactly ONE template id as "type" and follow its order for rigor "${rigor ?? 'minimal'}". Every non-optional step of the template must be in the plan, unless its output already exists or you list it in "omitted" with a reason. Optional steps only when needed (prototype only after the user's yes). A step outside the template needs a "why". The studio checks the plan against the template in code; a missing step or a wrong order blocks the run.
${templatesPrompt(templates, rigor ?? 'minimal')}
"slug": the feature id in kebab-case (for example piggy-bank); it fills {slug} in the template.
` : ''}
${gameScan ? `What the game already has (scanned from the Unity Editor through Unity MCP; build on it, do not redo existing screens):
"""
${cut(gameScan, 6000)}
"""

` : ''}If a step creates stories (for example /create-stories), set "expand": "stories" on it: the studio will then add /dev-story and /story-done steps for each story file it creates, so do not list those per-story steps yourself.

Available skills:
${list}

Reply with a short explanation in Vietnamese, then exactly one JSON block in this shape:
\`\`\`json
{"summary": "<1-2 câu tiếng Việt>",${templates.length ? ' "type": "<template id>", "slug": "<feature-slug>", "omitted": [{"skill": "<skill>", "why": "<tiếng Việt>"}],' : ''} "steps": [
  {"title": "<tiếng Việt, ngắn>", "skill": "<skill name without slash, or null>", "args": "<arguments or null>", "prompt": "<only when skill is null>", "why": "<tiếng Việt, ngắn>", "expand": null}
]}
\`\`\``;
}

/** Extracts the plan from the planner's reply. Throws BadPipeline with a readable reason. */
export interface ParsedPlan { summary: string | null; steps: PipelineStep[]; type: string | null; slug: string | null; omitted: { skill: string; why: string }[] }
export function parsePlan(text: string, known: Set<string>): ParsedPlan {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  let j: any = null;
  for (const c of candidates) { try { j = JSON.parse(c); if (j && Array.isArray(j.steps)) break; } catch { j = null; } }
  if (!j || !Array.isArray(j.steps)) throw new BadPipeline('Không đọc được kế hoạch (thiếu khối JSON có "steps").');
  if (!j.steps.length) throw new BadPipeline('Kế hoạch không có bước nào.');
  const steps = j.steps.slice(0, MAX_STEPS).map((s: any) => normalizeStep(s, known, false));
  const omitted = Array.isArray(j.omitted) ? j.omitted.filter((o: any) => typeof o?.skill === 'string' && typeof o?.why === 'string' && o.why.trim())
    .map((o: any) => ({ skill: o.skill.trim().replace(/^\//, ''), why: o.why.trim() })) : [];
  return { summary: typeof j.summary === 'string' ? j.summary : null, steps, type: typeof j.type === 'string' && j.type.trim() ? j.type.trim() : null, slug: slugOf(j.slug), omitted };
}

export function normalizeStep(s: any, known: Set<string>, generated: boolean, keep?: Partial<PipelineStep>): PipelineStep {
  const skill = typeof s?.skill === 'string' && s.skill.trim() ? s.skill.trim().replace(/^\//, '') : null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let warning: string | null = null;
  if (skill && !SKILL_RE.test(skill)) warning = 'Tên skill không hợp lệ';
  else if (skill && !known.has(skill)) warning = `Project không có skill /${skill}`;
  else if (!skill && !str(s?.prompt)) warning = 'Bước không có skill cũng không có prompt';
  return {
    id: keep?.id ?? randomUUID(), status: keep?.status ?? 'pending', taskId: keep?.taskId ?? null, generated: keep?.generated ?? generated,
    title: str(s?.title) ?? (skill ? `/${skill}` : 'Bước'), skill, args: skill ? str(s?.args) : null, prompt: skill ? null : str(s?.prompt),
    why: str(s?.why), expand: s?.expand === 'stories' || skill === 'create-stories' ? 'stories' : null, warning,
  };
}

/** Story files a step created or changed, from the task's changed-file list. */
export function storiesFrom(t: Task): string[] {
  return (t.changedFiles ?? []).filter(f => f.change !== 'D' && STORY_RE.test(f.path)).map(f => f.path).sort();
}

export class PipelineService {
  readonly bus = new EventEmitter<{ pipeline: [Pipeline]; log: ['info' | 'warn' | 'error', string] }>();

  constructor(private readonly d: PipelineDeps) {
    d.db.$client.exec('CREATE TABLE IF NOT EXISTS pipelines (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)');
    d.queue.bus.on('task', t => { if (ENDED.includes(t.status)) this.onTaskEnded(t); });
  }

  private known() { return new Set(this.d.skills().map(s => s.name)); }
  private templates(): PlanTemplate[] {
    if (this.d.templates) return this.d.templates();
    const r = loadTemplates();
    for (const e of r.errors) this.bus.emit('log', 'warn', `Mẫu kế hoạch lỗi: ${e}`);
    return r.templates;
  }

  /** Runs the plan check and stores steps + issues on the pipeline. */
  private check(p: Pipeline, byUser: boolean, omitted = p.omitted ?? []) {
    const known = this.known();
    const r = checkPlan({
      steps: p.steps, type: p.planType ?? null, slug: p.slug ?? null, omitted, rigor: (p.rigor ?? 'minimal') as Rigor, request: p.request,
      templates: this.templates(), root: this.d.project ? this.d.project() : null, byUser,
      make: s => normalizeStep(s, known, true),
    });
    p.steps = r.steps; p.issues = r.issues; p.omitted = omitted; p.planTypeTitle = r.template?.title ?? null;
  }

  get(id: string): Pipeline | null {
    const r = this.d.db.$client.prepare('SELECT data FROM pipelines WHERE id = ?').get(id) as any;
    return r ? JSON.parse(r.data) : null;
  }
  list(limit = 50): Pipeline[] {
    return (this.d.db.$client.prepare('SELECT data FROM pipelines ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(r => JSON.parse(r.data));
  }
  private save(p: Pipeline): Pipeline {
    this.d.db.$client.prepare('INSERT INTO pipelines (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(p.id, p.createdAt, JSON.stringify(p));
    this.bus.emit('pipeline', p);
    return p;
  }
  private must(id: string): Pipeline {
    const p = this.get(id);
    if (!p) throw new BadPipeline('Không có chuỗi này');
    return p;
  }

  /** project.yaml first; otherwise a /start that completed in Studio counts (rigor defaults to standard, overridable per plan). */
  setup(): PipelineSetup {
    const y = readSetup(this.d.project ? this.d.project() : null);
    if (y.started) return y;
    const done = this.d.scan?.().startDoneAt;
    return done ? { ...y, started: true, rigor: y.rigor ?? 'standard', source: 'session', startedAt: done, error: null } : y;
  }

  create(input: NewPipeline): Pipeline {
    const request = String(input?.request ?? '').trim();
    if (!request) throw new BadPipeline('Yêu cầu trống');
    const mode: PipelineMode = input.mode === 'step' ? 'step' : 'auto';
    const permissionMode = input.permissionMode ?? 'default';
    if (!['default', 'acceptEdits', 'plan'].includes(permissionMode)) throw new BadPipeline('permissionMode không hợp lệ');
    const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
    const setup = this.setup();
    if (!setup.started) throw new BadPipeline(`Project chưa chạy /start (project.yaml chưa có modes.rigor)${setup.error ? `: ${setup.error}` : ''}. Chạy /start trước rồi lập kế hoạch.`);
    const scan = this.d.scan?.();
    if (scan && scan.status !== 'ok') throw new BadPipeline('Chưa quét game qua Unity MCP. Vào Tổng quan, bấm "Quét game" (cần mở Unity Editor) rồi lập kế hoạch.');
    const rigor = (input.rigor ?? setup.rigor) as Rigor;
    if (!RIGORS.includes(rigor)) throw new BadPipeline('rigor phải là minimal, standard hoặc full');
    const plan = this.d.queue.create({ kind: 'prompt', prompt: plannerPrompt(request, this.d.skills(), rigor, setup, scan?.summary, this.templates()), permissionMode: 'default', ...(model ? { model } : {}) });
    return this.save({
      id: randomUUID(), request, summary: null, mode, permissionMode, model, rigor, status: 'planning', planTaskId: plan.id, sessionId: null,
      steps: [], createdAt: new Date().toISOString(), endedAt: null, error: null, note: null,
    });
  }

  /** Edit the plan: steps already run are kept as they are, the rest is replaced. */
  updateSteps(id: string, body: { steps?: unknown[]; mode?: PipelineMode; permissionMode?: Pipeline['permissionMode'] }): Pipeline {
    const p = this.must(id);
    if (!['review', 'paused', 'failed'].includes(p.status)) throw new BadPipeline('Chỉ sửa được kế hoạch khi chuỗi đang chờ duyệt hoặc tạm dừng');
    const done = p.steps.filter(s => s.status !== 'pending');
    if (Array.isArray(body.steps)) {
      if (body.steps.length > MAX_STEPS) throw new BadPipeline(`Tối đa ${MAX_STEPS} bước`);
      const known = this.known();
      const prev = new Map(p.steps.map(s => [s.id, s]));
      const pending = body.steps.map((s: any) => {
        const old = s?.id ? prev.get(s.id) : undefined;
        return normalizeStep(s, known, old?.generated ?? false, old && old.status === 'pending' ? { id: old.id } : undefined);
      });
      p.steps = [...done, ...pending];
      p.edited = true;
      this.check(p, true);
    }
    if (body.mode === 'auto' || body.mode === 'step') p.mode = body.mode;
    if (body.permissionMode && ['default', 'acceptEdits', 'plan'].includes(body.permissionMode)) p.permissionMode = body.permissionMode;
    return this.save(p);
  }

  /** Approve the plan, or continue after a pause. */
  start(id: string): Pipeline {
    const p = this.must(id);
    if (!['review', 'paused', 'failed'].includes(p.status)) throw new BadPipeline('Chuỗi không ở trạng thái chờ');
    const bad = p.steps.find(s => s.status === 'pending' && s.warning);
    if (bad) throw new BadPipeline(`Bước "${bad.title}": ${bad.warning}. Sửa hoặc xoá bước này trước.`);
    const err = (p.issues ?? []).find(i => i.level === 'error');
    if (err) throw new BadPipeline(`Kế hoạch chưa đạt chuẩn: ${err.message}`);
    if (!p.steps.some(s => s.status === 'pending')) throw new BadPipeline('Không còn bước nào để chạy');
    p.status = 'running'; p.error = null; p.note = null;
    return this.runNext(p);
  }

  retry(id: string, stepId: string): Pipeline {
    const p = this.must(id);
    const s = p.steps.find(x => x.id === stepId);
    if (!s || !['failed', 'cancelled'].includes(s.status)) throw new BadPipeline('Chỉ chạy lại được bước lỗi hoặc bị dừng');
    Object.assign(s, { status: 'pending', taskId: null });
    this.save(p);
    return this.start(id);
  }

  skip(id: string, stepId: string): Pipeline {
    const p = this.must(id);
    if (p.status === 'running') throw new BadPipeline('Tạm dừng hoặc chờ bước hiện tại xong rồi mới bỏ qua được');
    const s = p.steps.find(x => x.id === stepId);
    if (!s || !['pending', 'failed', 'cancelled'].includes(s.status)) throw new BadPipeline('Không bỏ qua được bước này');
    s.status = 'skipped';
    return this.save(p);
  }

  async cancel(id: string): Promise<Pipeline> {
    let p = this.must(id);
    if (p.status === 'completed' || p.status === 'cancelled') throw new BadPipeline('Chuỗi đã kết thúc');
    const live = [p.planTaskId, ...p.steps.map(s => s.taskId)].filter((x): x is string => !!x)
      .map(t => this.d.queue.get(t)).filter(t => t && !ENDED.includes(t.status));
    p.status = 'cancelled'; p.endedAt = new Date().toISOString(); p.note = 'Đã huỷ theo yêu cầu.';
    for (const s of p.steps) if (s.status === 'pending') s.status = 'cancelled';
    this.save(p);
    for (const t of live) { try { await this.d.queue.cancel(t!.id); } catch (e) { if (!(e instanceof BadTask)) throw e; } }
    p = this.must(id);
    return p;
  }

  private runNext(p: Pipeline): Pipeline {
    const next = p.steps.find(s => s.status === 'pending');
    if (!next) {
      p.status = 'completed'; p.endedAt = new Date().toISOString(); p.note = 'Đã chạy xong mọi bước.';
      this.bus.emit('log', 'info', `Chuỗi "${cut(p.request, 60)}" đã xong.`);
      return this.save(p);
    }
    try {
      const t = this.d.queue.create({
        ...(next.skill ? { kind: 'skill' as const, skill: next.skill, args: next.args ?? undefined } : { kind: 'prompt' as const, prompt: next.prompt ?? '' }),
        permissionMode: p.permissionMode, ...(p.model ? { model: p.model } : {}), ...(p.sessionId ? { resumeOf: p.sessionId } : {}),
      });
      next.status = 'running'; next.taskId = t.id;
    } catch (e) {
      next.status = 'failed';
      p.status = 'paused'; p.error = `Không tạo được task cho "${next.title}": ${(e as Error).message}`;
    }
    return this.save(p);
  }

  private onTaskEnded(t: Task) {
    for (const p of this.list(200)) {
      if (p.status === 'planning' && p.planTaskId === t.id) return this.planDone(p, t);
      const s = p.steps.find(x => x.taskId === t.id);
      if (s && s.status === 'running') return this.stepDone(p, s, t);
    }
  }

  private planDone(p: Pipeline, t: Task) {
    p.sessionId = t.sessionId;
    if (t.status !== 'completed') {
      p.status = 'failed'; p.endedAt = new Date().toISOString();
      p.error = t.status === 'cancelled' ? 'Đã dừng bước lập kế hoạch.' : `Lập kế hoạch lỗi: ${t.error ?? 'không rõ'}`;
      this.save(p);
      return;
    }
    try {
      const plan = parsePlan(t.resultText ?? '', this.known());
      p.summary = plan.summary; p.steps = plan.steps; p.status = 'review';
      p.planType = plan.type; p.slug = plan.slug;
      this.check(p, false, plan.omitted);
      const errs = (p.issues ?? []).filter(i => i.level === 'error').length;
      p.note = errs ? `Kế hoạch có ${errs} lỗi so với mẫu. Sửa các bước rồi bấm Duyệt và chạy.` : 'Xem lại kế hoạch, sửa nếu cần, rồi bấm Duyệt và chạy.';
    } catch (e) {
      p.status = 'failed'; p.error = (e as Error).message; p.endedAt = new Date().toISOString();
    }
    this.save(p);
  }

  private stepDone(p: Pipeline, s: PipelineStep, t: Task) {
    if (p.status === 'cancelled') { s.status = t.status === 'completed' ? 'completed' : 'cancelled'; this.save(p); return; }
    if (t.sessionId) p.sessionId = t.sessionId;
    if (t.status !== 'completed') {
      s.status = t.status === 'cancelled' ? 'cancelled' : 'failed';
      p.status = 'paused';
      p.error = t.status === 'cancelled' ? `Bước "${s.title}" bị dừng.` : `Bước "${s.title}" lỗi: ${t.error ?? 'không rõ'}`;
      p.note = 'Chạy lại bước, bỏ qua, sửa kế hoạch hoặc huỷ chuỗi.';
      this.save(p);
      return;
    }
    s.status = 'completed';
    if (s.expand === 'stories') {
      const stories = storiesFrom(t);
      const at = p.steps.indexOf(s) + 1;
      const known = this.known();
      const added = stories.flatMap(f => [
        normalizeStep({ title: `Làm story ${f.split('/').pop()}`, skill: 'dev-story', args: f }, known, true),
        normalizeStep({ title: `Đóng story ${f.split('/').pop()}`, skill: 'story-done', args: f }, known, true),
      ]);
      p.steps.splice(at, 0, ...added);
      p.note = stories.length ? `Đã thêm ${added.length} bước cho ${stories.length} story.` : 'Bước chia việc không tạo file story nào; thêm bước tay nếu cần.';
    }
    if (p.mode === 'step') {
      const more = p.steps.some(x => x.status === 'pending');
      if (more) {
        p.status = 'paused'; p.error = null;
        p.note = `${p.note ? p.note + ' ' : ''}Đã xong "${s.title}". Bấm Tiếp tục để chạy bước sau.`;
        this.save(p);
        return;
      }
    }
    this.runNext(p);
  }

  /** After a restart: running steps whose task died with the old process need the user's decision. */
  recover() {
    for (const p of this.list(200)) {
      const ids = p.status === 'planning' ? [p.planTaskId] : p.status === 'running' ? p.steps.filter(s => s.status === 'running').map(s => s.taskId) : [];
      for (const id of ids) {
        const t = id ? this.d.queue.get(id) : null;
        if (t && ENDED.includes(t.status)) this.onTaskEnded(t);
      }
    }
  }
}
