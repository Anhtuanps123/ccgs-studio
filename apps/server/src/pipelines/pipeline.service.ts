// Feature pipelines: one request -> a plan (written by Claude, read-only) -> the user edits and approves ->
// Studio runs each step as a task in the same session, one after another.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Attachment, CriticIssue, CritiqueRound, NewPipeline, OpenItem, Pipeline, PipelineGraphContext, PipelineMode, PipelineSetup, PipelineStep, PlanIssue, PlanRoleInfo, ProjectRuleState, Rigor, Task } from '@ccgs/shared';
import type { Db } from '../store/db';
import { BadTask, TaskQueue } from '../tasks/task-queue';
import { activeRoles, checkPlan, fillRoles, loadRoles, loadTemplates, roleOfSkill, rolesPrompt, slugOf, templatesPrompt, type PlanRoleDef, type PlanTemplate } from './plan-rules';
import { checkStep } from './checkpoint';
import { openItemsPrompt, PLANNER_RULES, projectState, ruleChecklist, storyGate, storySteps } from './studio-rules';
import { keywordsFromInput, keywordsFromRequest } from '../graph/graph-core';
import type { GraphContext } from '../graph/graph.service';
import type { SessionExtras } from '../tasks/runner';

export interface SkillInfo { name: string; description: string; argumentHint: string | null }
export interface PipelineDeps {
  db: Db; queue: TaskQueue; skills: () => SkillInfo[]; project?: () => string | null;
  scan?: () => { status: string; summary: string | null; startDoneAt?: string | null }; templates?: () => PlanTemplate[];
  /** Roles the user can pick (default: plugin/plan-roles.yaml). */
  roles?: () => PlanRoleDef[];
  /** Default for the critic loop when the request does not say (default true). */
  critic?: boolean;
  /**
   * Code map (graphify): pre-query for the first plan when the request names code identifiers, and the MCP server
   * attached to every task (Claude queries the graph itself; brief 6.2).
   */
  graph?: { enabled(): boolean; context(keywords: string[]): Promise<GraphContext>; mcpSession?(): Promise<{ extras: SessionExtras | null; detail: string }> };
  /** Turns the attachment ids of a request into files (AttachmentStore). */
  attachments?: { resolve(ids: unknown): Attachment[] };
}

/** Attachment ids to give a task of this pipeline (planner, critic, steps); nothing when the request has none. */
const attachOf = (p: Pipeline) => (p.attachments?.length ? { attachments: p.attachments.map(a => a.id) } : {});

/** Moved to the graph module: it is now the system prompt of every task with the graphify MCP server. */
export { CODE_TOOLS_HINT } from '../graph/graph-core';

/** How many times the planner is sent back to fix the plan after a critique. */
export const MAX_REVISIONS = 2;

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

export function plannerPrompt(request: string, skills: SkillInfo[], rigor?: Rigor | null, setup?: PipelineSetup | null, gameScan?: string | null, templates: PlanTemplate[] = [], codeMap?: { keywords: string[]; text: string } | null, roles: PlanRoleDef[] = [], chosen: string[] | null = null, openItems: OpenItem[] = []): string {
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
${PLANNER_RULES}

${openItems.length ? openItemsPrompt(openItems) + '\n\n' : ''}${roles.length ? rolesPrompt(roles, chosen) + '\n\n' : ''}${gameScan ? `What the game already has (scanned from the Unity Editor through Unity MCP; build on it, do not redo existing screens):
"""
${cut(gameScan, 6000)}
"""

` : ''}${codeMap ? `Code map (graphify, built from the project's code by tree-sitter, read-only; it can be slightly behind the files on disk). The studio looked up: ${codeMap.keywords.join(', ')}. Each NODE line gives the source file and line (loc=L…). Use it to find the relevant code; Read only the line ranges you need instead of searching the whole project:
"""
${codeMap.text}
"""

` : ''}If a step creates stories (for example /create-stories), set "expand": "stories" on it: the studio will then add /dev-story and /story-done steps for each story file it creates, so do not list those per-story steps yourself.

Available skills:
${list}

Reply with a short explanation in Vietnamese, then exactly one JSON block in this shape:
\`\`\`json
{"summary": "<1-2 câu tiếng Việt>",${templates.length ? ' "type": "<template id>", "slug": "<feature-slug>", "omitted": [{"skill": "<skill>", "why": "<tiếng Việt>"}],' : ''} "steps": [
  {"title": "<tiếng Việt, ngắn>", "skill": "<skill name without slash, or null>", "args": "<arguments or null>", "prompt": "<only when skill is null>", "why": "<tiếng Việt, ngắn>", "expand": null${roles.length ? ', "role": "<role id>"' : ''}}
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

const planJson = (p: Pipeline) => JSON.stringify({
  type: p.planType ?? null, slug: p.slug ?? null, omitted: p.omitted ?? [],
  steps: p.steps.filter(s => s.status === 'pending').map(s => ({ title: s.title, skill: s.skill, args: s.args, prompt: s.prompt ? cut(s.prompt, 300) : null, why: s.why, ...(s.role ? { role: s.role } : {}), ...(s.generated ? { addedByStudio: true } : {}) })),
}, null, 1);
const doneLines = (p: Pipeline) => p.steps.filter(s => s.status !== 'pending')
  .map(s => `- [${s.status}] ${s.title} (${s.skill ? `/${s.skill}${s.args ? ' ' + s.args : ''}` : 'prompt'})${s.check?.verdict ? ` verdict ${s.check.verdict}` : ''}${s.check && s.check.decision !== 'continue' ? `; ${s.check.reason}` : ''}`).join('\n');

/** Sent to the work session when the user asks to re-plan the remaining steps after a checkpoint. */
export function replanPrompt(p: Pipeline, note: string | null, templates: PlanTemplate[], roles: PlanRoleDef[] = []): string {
  const t = templates.find(x => x.id === p.planType);
  const rigor = (p.rigor ?? 'minimal') as Rigor;
  const pending = p.steps.filter(s => s.status === 'pending').map(s => ({ title: s.title, skill: s.skill, args: s.args, prompt: s.prompt ? cut(s.prompt, 300) : null, why: s.why, ...(s.role ? { role: s.role } : {}) }));
  return `The situation changed while running the plan. Make a new plan for the REMAINING work only. Do NOT modify any file now and do not run commands that change anything; only read what the steps produced.

Original request:
"""
${p.request}
"""

Steps already run:
${doneLines(p) || '(none)'}
${p.checkpoint ? `\nWhy the run stopped: ${p.checkpoint.reason}\n` : ''}${note ? `\nThe user's note: ${note}\n` : ''}
Remaining steps of the current plan:
\`\`\`json
${JSON.stringify(pending, null, 1)}
\`\`\`

Keep the rules of the first plan (rigor ${rigor}${t ? `; template ${templatesPrompt([t], rigor).replace(/^- /, '')}` : ''}; art context before UI; "expand": "stories" on /create-stories${rolesNote(p, roles)}). Do not repeat a completed step unless its result must be redone, and then say why.
${PLANNER_RULES}
Reply with a short explanation in Vietnamese, then exactly one JSON block: {"summary", ${templates.length ? '"type", "slug", "omitted", ' : ''}"steps"} where "steps" are ONLY the steps still to run, in order.`;
}
/** "; only the roles Designer, Developer" when the user limited the roles, else ''. */
const rolesNote = (p: Pipeline, roles: PlanRoleDef[]) => {
  const act = activeRoles(p.roles, roles);
  return act ? `; only the roles ${act.map(id => roles.find(r => r.id === id)?.title ?? id).join(', ')} (role ids ${act.join(', ')}), every step with its "role"` : '';
};
const issueLines = (xs: PlanIssue[]) => xs.map(i => `- [${i.level}] ${i.message}`).join('\n');

/** First words of every critic prompt: the runner uses them to skip /compact (the critic session is never resumed). */
export const CRITIC_PROMPT_HEAD = 'You review a work plan for CCGS Studio';
export const isCriticPrompt = (prompt: string | null | undefined) => !!prompt?.startsWith(CRITIC_PROMPT_HEAD);

/**
 * Read-only review of a plan version, done as the CCGS producer would. Runs in its own session.
 * The review is done here, not delegated to the producer subagent: a second agent layer loads the whole
 * system prompt again and gets the plan twice, while the session above it only relays the answer.
 */
export function criticPrompt(p: Pipeline, round: number, templates: PlanTemplate[], roles: PlanRoleDef[] = []): string {
  const t = templates.find(x => x.id === p.planType);
  const found = (p.issues ?? []).filter(i => i.level !== 'info');
  return `${CRITIC_PROMPT_HEAD} (round ${round}). Do NOT modify any file, do not run commands that change anything, and do not ask the user questions; only read (Read, Glob, Grep).

Review it yourself, as the project's producer: scope (what the request asked, no more, no less), order and dependencies, wasted or repeated work, risk of a step failing for want of input. Do NOT spawn subagents (no Agent tool).

Keep it cheap: check only what a concern needs. Glob to see if an output exists; Grep headings (\`^#\`) or a key, then Read that range with offset/limit. Do not read whole skill files or the whole catalog: Grep \`.claude/docs/workflow-catalog.yaml\` for the plan type and the skills in the plan, and a skill's \`argument-hint\` in its SKILL.md. About 10 tool calls is enough; stop when the questions below are answered.

The user's request:
"""
${p.request}
"""

Rigor chosen for this plan: ${p.rigor ?? 'minimal'}.${rolesNote(p, roles) ? ` Roles:${rolesNote(p, roles).replace(/^;/, '')}. Work of other roles is left out on purpose: do not report it as missing.` : ''} Plan template: ${t ? `${t.id} (${t.title})\n${templatesPrompt([t], (p.rigor ?? 'minimal') as Rigor)}` : (p.planType ?? 'Unknown')}

${doneLines(p) ? `Steps already run (keep them; review only what follows):\n${doneLines(p)}\n\n` : ''}The plan (steps run in this order, one Claude session; "/create-stories" later adds /dev-story + /story-done per story by itself):
\`\`\`json
${planJson(p)}
\`\`\`
${found.length ? `\nThe studio's code check already reported these (do not repeat them):\n${issueLines(found)}\n` : ''}
Check, against .claude/docs/workflow-catalog.yaml, project.yaml and what is on disk (design/, production/, prototypes/, the code):
1. Does the plan deliver what the request asks? Anything missing, or work the request did not ask for?
2. Does it follow the project's workflow for this rigor and stage?
3. Does a step redo work whose output already exists?
4. Are args concrete enough for the skill to run without guessing (paths, screen names, slug)?
5. Order and dependencies between steps.

Report only real problems. level "error": the plan would produce wrong or wasted work and must change. level "warn": worth the user's attention. No problems: "ok": true and an empty list.
Reply with a short note in Vietnamese, then exactly one JSON block:
\`\`\`json
{"ok": true, "issues": [{"level": "error", "message": "<tiếng Việt>", "stepTitle": "<step title or null>"}]}
\`\`\``;
}

/** What the user adds when they ask for a revision themselves ("Sửa theo phản biện"). */
export interface UserRevision { note: string | null; plan: string }

/** Sent to the planner's own session after a critique with errors, or when the user asks (then warnings count too). */
export function revisePrompt(round: number, critic: CriticIssue[], server: PlanIssue[], hasTemplates: boolean, user?: UserRevision): string {
  const lines = [
    ...critic.map(i => `- [phản biện ${i.level}] ${i.message}${i.stepTitle ? ` (bước "${i.stepTitle}")` : ''}`),
    ...server.map(i => `- [studio, ${i.level === 'error' ? 'bắt buộc' : 'cảnh báo'}] ${i.message}`),
  ].join('\n');
  const shape = `Reply with a short explanation in Vietnamese, then exactly one JSON block in the same shape as before: {"summary", ${hasTemplates ? '"type", "slug", "omitted", ' : ''}"steps"}.`;
  if (!user) return `A reviewer checked your plan (round ${round}) and the studio's code check ran. Fix the plan for the issues below and keep the rest. Still do NOT modify any file. If you disagree with a reviewer issue, keep the step and say why in its "why"; studio issues must be fixed.

${lines}

${shape}`;
  return `The user read the review of your plan${round ? ` (round ${round})` : ''} and asks you to revise the plan for ALL the issues below, warnings included. Still do NOT modify any file and do not run commands that change anything; only read.

The current plan (it may include the user's own edits, which take precedence over your earlier version):
\`\`\`json
${user.plan}
\`\`\`

Issues:
${lines || "(none listed; follow the user's note)"}
${user.note ? `\nThe user's note (their decisions override the reviewer):\n"""\n${user.note}\n"""\n` : ''}
For each issue:
- When the fix is clear, change the plan: add a missing step (e.g. a setup or config step first), reorder steps whose checks depend on a later step, or put the decision into the step's args or prompt so the step does not have to stop and ask.
- When it needs a decision only the user can make and the note does not give it, keep the step and start its "why" with "CẦN QUYẾT: <câu hỏi>".
- When the issue is already resolved or does not apply, change nothing for it.
Keep the rest of the plan as it is. Studio errors must be fixed.

${shape}`;
}

/** Extracts the critic's verdict. Throws BadPipeline when there is no readable JSON. */
export function parseCritique(text: string): { ok: boolean; issues: CriticIssue[] } {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  let j: any = null;
  for (const c of candidates) { try { j = JSON.parse(c); if (j && (Array.isArray(j.issues) || typeof j.ok === 'boolean')) break; } catch { /* next */ } j = null; }
  if (!j) throw new BadPipeline('Không đọc được kết quả phản biện (thiếu khối JSON có "ok"/"issues").');
  const issues: CriticIssue[] = (Array.isArray(j.issues) ? j.issues : [])
    .filter((i: any) => typeof i?.message === 'string' && i.message.trim())
    .slice(0, 20)
    .map((i: any) => ({ level: i.level === 'error' ? 'error' : 'warn', message: cut(i.message.trim(), 500), stepTitle: typeof i.stepTitle === 'string' && i.stepTitle.trim() ? i.stepTitle.trim() : null }));
  return { ok: typeof j.ok === 'boolean' ? j.ok && !issues.some(i => i.level === 'error') : !issues.some(i => i.level === 'error'), issues };
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
    role: str(s?.role), // checked against plan-roles.yaml by fillRoles (unknown -> the skill's role)
  };
}

/** Story files a step created or changed, from the task's changed-file list. */
export function storiesFrom(t: Task): string[] {
  return (t.changedFiles ?? []).filter(f => f.change !== 'D' && STORY_RE.test(f.path)).map(f => f.path).sort();
}

export class PipelineService {
  readonly bus = new EventEmitter<{ pipeline: [Pipeline]; removed: [string]; log: ['info' | 'warn' | 'error', string] }>();

  constructor(private readonly d: PipelineDeps) {
    d.db.$client.exec('CREATE TABLE IF NOT EXISTS pipelines (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL)');
    d.queue.bus.on('task', t => { if (ENDED.includes(t.status)) this.onTaskEnded(t); });
    if (d.graph?.mcpSession) d.queue.setSessionExtras(t => this.sessionExtras(t));
    d.queue.setKeep(() => this.taskKeep());
  }

  /** Tasks the history must keep: every task of a plan that has not ended (it may continue, re-plan or count cost). */
  taskKeep(): Map<string, string> {
    const keep = new Map<string, string>();
    for (const p of this.list(500)) {
      if (p.status === 'completed' || p.status === 'cancelled') continue;
      const why = `thuộc chuỗi kế hoạch "${cut(p.request, 50)}" chưa kết thúc (${p.status})`;
      const ids = [p.planTaskId, p.critiqueTaskId, ...(p.planTasks ?? []), ...(p.critiques ?? []).flatMap(c => [c.planTaskId, c.taskId]), ...p.steps.map(s => s.taskId)];
      for (const id of ids) if (id) keep.set(id, why);
    }
    return keep;
  }

  /**
   * Right before any task starts (planner, critic, steps, game scan, plain tasks): the graphify MCP server and its
   * system prompt when the graph is usable (brief 6.2). The prompt asks Claude to query the graph first only when the
   * task has to find code. For a planner task it is also recorded on Pipeline.graph.
   */
  async sessionExtras(t: Task): Promise<SessionExtras | null> {
    if (!this.d.graph?.mcpSession) return null;
    let r: { extras: SessionExtras | null; detail: string };
    try { r = await this.d.graph.mcpSession(); }
    catch (e) { r = { extras: null, detail: `Không chuẩn bị được MCP graphify: ${(e as Error).message}` }; }
    const p = this.list(200).find(x => x.status === 'planning' && x.planTaskId === t.id) ?? null;
    if (p) {
      p.graph = { ...(p.graph ?? { status: 'skipped', keywords: [], source: null, detail: '', chars: 0 }), mcp: !!r.extras, mcpDetail: r.detail, mcpCalls: null };
      this.save(p);
      if (!r.extras) this.bus.emit('log', 'info', `Lập kế hoạch không gắn MCP graphify: ${r.detail}`);
    }
    return { ...(r.extras ?? {}), note: r.detail };
  }

  private known() { return new Set(this.d.skills().map(s => s.name)); }
  private roles(): PlanRoleDef[] {
    if (this.d.roles) return this.d.roles();
    const r = loadRoles();
    for (const e of r.errors) this.bus.emit('log', 'warn', `plan-roles.yaml lỗi: ${e}`);
    return r.roles;
  }
  /** GET /api/pipelines/roles */
  roleList(): PlanRoleInfo[] { return this.roles().map(r => ({ id: r.id, title: r.title, hint: r.hint, skills: r.skills })); }
  private templates(): PlanTemplate[] {
    if (this.d.templates) return this.d.templates();
    const r = loadTemplates();
    for (const e of r.errors) this.bus.emit('log', 'warn', `Mẫu kế hoạch lỗi: ${e}`);
    return r.templates;
  }

  private root() { return this.d.project ? this.d.project() : null; }

  /** Runs the plan check and stores steps + issues + the studio rules checklist on the pipeline. */
  private check(p: Pipeline, byUser: boolean, omitted = p.omitted ?? []) {
    const known = this.known();
    const rigor = (p.rigor ?? 'minimal') as Rigor;
    const r = checkPlan({
      steps: p.steps, type: p.planType ?? null, slug: p.slug ?? null, omitted, rigor, request: p.request,
      templates: this.templates(), root: this.root(), byUser, known,
      make: s => normalizeStep(s, known, true), roles: this.roles(), chosen: p.roles ?? null,
    });
    p.steps = r.steps; p.issues = r.issues; p.omitted = omitted; p.planTypeTitle = r.template?.title ?? null;
    p.rules = ruleChecklist({ steps: p.steps, issues: r.issues, ui: !!r.template?.ui, request: p.request, type: r.template?.id ?? p.planType ?? null, slug: p.slug ?? null, root: this.root(), rigor });
  }

  /** GET /api/pipelines/project-state: what the studio rules see in the project (rigor, epics, GDDs, conventions, active.md). */
  projectState(): ProjectRuleState { return projectState(this.root(), this.setup().rigor); }

  get(id: string): Pipeline | null {
    const r = this.d.db.$client.prepare('SELECT data FROM pipelines WHERE id = ?').get(id) as any;
    return r ? JSON.parse(r.data) : null;
  }
  list(limit = 50): Pipeline[] {
    return (this.d.db.$client.prepare('SELECT data FROM pipelines ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(r => JSON.parse(r.data));
  }
  private save(p: Pipeline): Pipeline {
    fillRoles(p.steps, this.roles()); // steps added outside the plan check (stories, fixes) get their skill's role
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
    const { setup, scan } = this.planGates();
    const rigor = (input.rigor ?? setup.rigor) as Rigor;
    if (!RIGORS.includes(rigor)) throw new BadPipeline('rigor phải là minimal, standard hoặc full');
    let typed: string[];
    try { typed = keywordsFromInput(input.codeKeywords); } catch (e) { throw new BadPipeline((e as Error).message); }
    const critic = typeof input.critic === 'boolean' ? input.critic : this.d.critic ?? true;
    let roles: string[] | null = null;
    if (Array.isArray(input.roles)) {
      const ids = new Set(this.roles().map(r => r.id));
      roles = [...new Set(input.roles.filter((r): r is string => typeof r === 'string' && ids.has(r)))];
      if (ids.size && !roles.length) throw new BadPipeline('Chọn ít nhất một vai trò');
      if (!ids.size) roles = null;
    }
    let attachments: Attachment[] = [];
    if (input.attachments !== undefined && input.attachments !== null) {
      if (!this.d.attachments) throw new BadPipeline('Studio chưa bật tệp đính kèm');
      try { attachments = this.d.attachments.resolve(input.attachments); } catch (e) { throw new BadPipeline((e as Error).message); }
    }
    const p: Pipeline = {
      id: randomUUID(), request, summary: null, mode, permissionMode, model, rigor, status: 'planning', planTaskId: null, planTasks: [], sessionId: null,
      steps: [], createdAt: new Date().toISOString(), endedAt: null, error: null, note: null, critic, critiqueTaskId: null, critiques: [],
      codeKeywords: typed, graph: null, roles, ...(attachments.length ? { attachments } : {}),
    };
    return this.plan(p, setup, scan?.summary ?? null);
  }

  /** What planning needs: /start done and a finished game scan. */
  private planGates() {
    const setup = this.setup();
    if (!setup.started) throw new BadPipeline(`Project chưa chạy /start (project.yaml chưa có modes.rigor)${setup.error ? `: ${setup.error}` : ''}. Chạy /start trước rồi lập kế hoạch.`);
    const scan = this.d.scan?.();
    if (scan && scan.status !== 'ok') throw new BadPipeline('Chưa quét game qua Unity MCP. Vào Tổng quan, bấm "Quét game" (cần mở Unity Editor) rồi lập kế hoạch.');
    return { setup, scan };
  }

  /** First plan of a pipeline (new or restarted): code map lookup in the background when there are keywords, then the planner. */
  private plan(p: Pipeline, setup: PipelineSetup, gameScan: string | null): Pipeline {
    const typed = p.codeKeywords ?? [];
    const keywords = typed.length ? typed : keywordsFromRequest(p.request);
    const source = typed.length ? 'user' : 'request';
    // No identifier, or the code map is off: plan right away, as before.
    if (!keywords.length || !this.d.graph || !this.d.graph.enabled()) {
      p.graph = { status: keywords.length ? 'unavailable' : 'skipped', keywords, source: keywords.length ? source : null, chars: 0,
        detail: !keywords.length ? 'Yêu cầu không có tên lớp/hàm (PascalCase, camelCase) và ô "Từ khoá mã nguồn" trống: không tra bản đồ code.'
          : !this.d.graph ? 'Studio chưa có module bản đồ code.' : 'Bản đồ code đang tắt trong Cài đặt.' };
      return this.save(this.startPlanner(p, null, setup, gameScan));
    }
    p.note = `Đang tra bản đồ code: ${keywords.join(', ')}…`;
    this.save(p);
    void this.planWithGraph(p.id, keywords, source);
    return p;
  }

  /**
   * A pipeline that failed or was cancelled before any step ran (e.g. the planner hit the usage limit): plan it again
   * from scratch in a new session, same request and options. The previous plan, checks and critiques are dropped;
   * their tasks stay in planTasks so the cost still counts them.
   */
  restartPlan(id: string): Pipeline {
    const p = this.must(id);
    if (!['failed', 'cancelled'].includes(p.status)) throw new BadPipeline('Chỉ lập kế hoạch lại được khi chuỗi đã lỗi hoặc đã huỷ');
    if (p.steps.some(s => s.taskId)) throw new BadPipeline('Chuỗi đã chạy bước, không lập kế hoạch lại từ đầu được. Dùng "Lập lại kế hoạch" cho các bước còn lại.');
    const { setup, scan } = this.planGates();
    const old = [p.planTaskId, ...(p.planTasks ?? []), p.critiqueTaskId, ...(p.critiques ?? []).flatMap(c => [c.planTaskId, c.taskId])];
    Object.assign(p, {
      status: 'planning', planTaskId: null, planTasks: [...new Set(old.filter((x): x is string => !!x))], sessionId: null,
      steps: [], summary: null, error: null, note: null, endedAt: null, critiqueTaskId: null, critiques: [], checkpoint: null,
      issues: [], planType: null, planTypeTitle: null, slug: null, omitted: [], edited: false, replans: 0, replanning: false, graph: null,
    } satisfies Partial<Pipeline>);
    return this.plan(p, setup, scan?.summary ?? null);
  }

  /** Creates the first planner task (with the code map lookup, if any) and records it on the pipeline (not saved). */
  private startPlanner(p: Pipeline, codeMap: { keywords: string[]; text: string } | null, setup = this.setup(), gameScan: string | null = this.d.scan?.().summary ?? null): Pipeline {
    const open = projectState(this.root(), p.rigor ?? null).openItems;
    const t = this.d.queue.create({ kind: 'prompt', prompt: plannerPrompt(p.request, this.d.skills(), p.rigor, setup, gameScan, this.templates(), codeMap, this.roles(), p.roles ?? null, open), permissionMode: 'default', ...(p.model ? { model: p.model } : {}), ...attachOf(p) });
    p.planTaskId = t.id; p.planTasks = [...(p.planTasks ?? []), t.id];
    return p;
  }

  /** Runs the code map lookup in the background, then starts the planner. A lookup failure never blocks planning. */
  private async planWithGraph(id: string, keywords: string[], source: 'user' | 'request') {
    let ctx: GraphContext;
    try {
      ctx = !keywords.length ? { status: 'unavailable', text: null, detail: 'Không có từ khoá mã nguồn.' }
        : !this.d.graph ? { status: 'unavailable', text: null, detail: 'Studio chưa có module bản đồ code.' }
        : await this.d.graph.context(keywords);
    } catch (e) { ctx = { status: 'error', text: null, detail: `Tra bản đồ code lỗi: ${(e as Error).message}` }; }
    const p = this.get(id);
    if (!p || p.status !== 'planning' || p.planTaskId) return; // cancelled meanwhile, or already started
    const g: PipelineGraphContext = { status: ctx.status, keywords, source, detail: ctx.detail, chars: ctx.text?.length ?? 0 };
    p.graph = g; p.note = null;
    if (ctx.status !== 'used') this.bus.emit('log', 'warn', `Lập kế hoạch không dùng bản đồ code: ${ctx.detail}`);
    try {
      this.save(this.startPlanner(p, ctx.status === 'used' && ctx.text ? { keywords, text: ctx.text } : null));
    } catch (e) {
      p.status = 'failed'; p.error = `Không tạo được task lập kế hoạch: ${(e as Error).message}`; p.endedAt = new Date().toISOString();
      this.save(p);
    }
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
        const n = normalizeStep(s, known, old?.generated ?? false, old && old.status === 'pending' ? { id: old.id } : undefined);
        return old?.fixOf && old.status === 'pending' ? { ...n, fixOf: old.fixOf } : n; // keep the one-fix limit
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
    // Continuing after the open-question gate (rule 3) means the user accepts those questions for that step.
    const gated = p.steps.find(s => s.status === 'pending');
    if (gated?.gate && !gated.gate.acknowledged && p.checkpoint?.stepId === gated.id) gated.gate.acknowledged = true;
    p.status = 'running'; p.error = null; p.note = null; p.checkpoint = null;
    return this.runNext(p);
  }

  /**
   * Rule 3: right before /dev-story, open questions in the story and its GDD/UX stop the run once.
   * Returns true when the pipeline was paused (saved) instead of running the step.
   */
  private gateStory(p: Pipeline, s: PipelineStep): boolean {
    const root = this.root();
    if (s.skill !== 'dev-story' || !s.args || !root || s.gate?.acknowledged) return false;
    let g: { items: string[]; files: string[] };
    try { g = storyGate(root, s.args, p.slug ?? null); } catch (e) { this.bus.emit('log', 'warn', `Không đọc được story để kiểm câu hỏi mở: ${(e as Error).message}`); return false; }
    if (!g.items.length) { s.gate = null; return false; }
    s.gate = { kind: 'open-questions', items: g.items, files: g.files, acknowledged: false };
    const reason = `Còn ${g.items.length} câu hỏi chưa chốt trong ${g.files.join(', ')} trước khi code "${s.title}".`;
    p.status = 'paused'; p.error = null;
    p.checkpoint = { decision: 'pause', verdict: null, reason, replan: false, question: null, stepId: s.id };
    p.note = `${reason} Chốt rồi sửa tài liệu, hoặc bấm Tiếp tục để code theo hiện trạng (quy tắc 3).`;
    this.save(p);
    return true;
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
    const live = [p.planTaskId, p.critiqueTaskId, ...p.steps.map(s => s.taskId)].filter((x): x is string => !!x)
      .map(t => this.d.queue.get(t)).filter(t => t && !ENDED.includes(t.status));
    p.status = 'cancelled'; p.endedAt = new Date().toISOString(); p.note = 'Đã huỷ theo yêu cầu.';
    for (const s of p.steps) if (s.status === 'pending') s.status = 'cancelled';
    this.save(p);
    for (const t of live) { try { await this.d.queue.cancel(t!.id); } catch (e) { if (!(e instanceof BadTask)) throw e; } }
    p = this.must(id);
    return p;
  }

  /**
   * "Xoá kế hoạch": removes a plan the user no longer needs. Only when nothing of it runs (cancel first).
   * The tasks it ran stay in the Task Center (log, cost); nothing in the project changes.
   */
  remove(id: string): { id: string } {
    const p = this.must(id);
    if (['planning', 'critiquing', 'running'].includes(p.status)) throw new BadPipeline('Chuỗi đang chạy. Bấm "Huỷ chuỗi" trước rồi mới xoá.');
    this.d.db.$client.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
    this.bus.emit('removed', id);
    this.bus.emit('log', 'info', `Đã xoá kế hoạch "${cut(p.request, 60)}".`);
    return { id };
  }

  /** The file the plan template expects this step to produce, when the template names one. */
  private outputOf(p: Pipeline, s: PipelineStep): { rel: string; exists: boolean } | null {
    const root = this.d.project ? this.d.project() : null;
    const slot = this.templates().find(t => t.id === p.planType)?.steps.find(x => x.skill === s.skill && x.output && !x.repeat);
    if (!root || !slot?.output || (slot.output.includes('{slug}') && !p.slug)) return null;
    const rel = slot.output.replace(/\{slug\}/g, p.slug ?? '');
    return { rel, exists: fs.existsSync(path.join(root, rel)) };
  }

  /** Re-plan the steps still to run, in the work session (it knows what happened). Steps that ran stay. */
  replan(id: string, note?: unknown): Pipeline {
    const p = this.must(id);
    if (!['paused', 'failed', 'review'].includes(p.status) || !p.steps.some(s => s.status !== 'pending')) throw new BadPipeline('Chỉ lập lại kế hoạch được khi chuỗi đã chạy ít nhất một bước và đang dừng');
    if (!p.sessionId) throw new BadPipeline('Chuỗi chưa có session để lập lại kế hoạch');
    const text = typeof note === 'string' && note.trim() ? cut(note.trim(), 2000) : null;
    const t = this.d.queue.create({ kind: 'prompt', prompt: replanPrompt(p, text, this.templates(), this.roles()), resumeOf: p.sessionId, permissionMode: 'default', ...(p.model ? { model: p.model } : {}) });
    p.replans = (p.replans ?? 0) + 1; p.replanning = true;
    p.planTaskId = t.id; (p.planTasks ??= []).push(t.id); p.status = 'planning'; p.error = null; p.endedAt = null;
    p.note = `Đang lập lại kế hoạch cho các bước còn lại (lần ${p.replans}).`;
    return this.save(p);
  }

  /** Answer the question Claude ended a step with: the answer runs next as a prompt step in the same session. */
  answer(id: string, text: unknown): Pipeline {
    const p = this.must(id);
    const a = typeof text === 'string' ? text.trim() : '';
    if (!a) throw new BadPipeline('Câu trả lời trống');
    if (!['paused', 'failed', 'review'].includes(p.status)) throw new BadPipeline('Chỉ trả lời được khi chuỗi đang dừng');
    const at = p.steps.findIndex(s => s.status === 'pending');
    const q = p.checkpoint?.question;
    const step = { ...normalizeStep({ title: 'Trả lời Claude', prompt: cut(a, 4000), why: q ? `Trả lời: ${q}` : 'Người dùng trả lời' }, this.known(), true), fixOf: p.checkpoint?.stepId ?? null };
    p.steps.splice(at < 0 ? p.steps.length : at, 0, step);
    this.save(p);
    return this.start(id);
  }

  private runNext(p: Pipeline): Pipeline {
    const next = p.steps.find(s => s.status === 'pending');
    if (!next) {
      p.status = 'completed'; p.endedAt = new Date().toISOString(); p.note = 'Đã chạy xong mọi bước.';
      this.bus.emit('log', 'info', `Chuỗi "${cut(p.request, 60)}" đã xong.`);
      return this.save(p);
    }
    if (this.gateStory(p, next)) return p;
    try {
      const t = this.d.queue.create({
        ...(next.skill ? { kind: 'skill' as const, skill: next.skill, args: next.args ?? undefined } : { kind: 'prompt' as const, prompt: next.prompt ?? '' }),
        permissionMode: p.permissionMode, ...(p.model ? { model: p.model } : {}), ...(p.sessionId ? { resumeOf: p.sessionId } : {}),
        ...attachOf(p),
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
      if (p.status === 'critiquing' && p.critiqueTaskId === t.id) return this.critiqueDone(p, t);
      const s = p.steps.find(x => x.taskId === t.id);
      if (s && s.status === 'running') return this.stepDone(p, s, t);
    }
  }

  private planDone(p: Pipeline, t: Task) {
    if (t.sessionId) p.sessionId = t.sessionId;
    if (p.graph?.mcp && t.mcp?.calls) p.graph = { ...p.graph, mcpCalls: t.mcp.calls.graphify ?? 0 };
    // A revision (after a critique) or a re-plan: on failure the plan there was stays.
    const revision = p.steps.length > 0;
    let failure: string | null = null;
    if (t.status !== 'completed') failure = t.status === 'cancelled' ? 'Đã dừng bước lập kế hoạch.' : `Lập kế hoạch lỗi: ${t.error ?? 'không rõ'}`;
    else {
      try {
        const plan = parsePlan(t.resultText ?? '', this.known());
        // Steps that already ran stay; the reply replaces only what is still to run.
        p.summary = plan.summary ?? p.summary; p.steps = [...p.steps.filter(s => s.status !== 'pending'), ...plan.steps];
        p.planType = plan.type ?? p.planType ?? null; p.slug = plan.slug ?? p.slug ?? null;
        this.check(p, false, plan.omitted);
      } catch (e) { failure = (e as Error).message; }
    }
    if (failure && revision) {
      // A failed revision keeps the previous plan; the critique stays visible for the user.
      this.toReview(p, `Planner không ${p.replanning ? 'lập lại' : 'sửa'} được kế hoạch (${failure}). Giữ các bước trước đó.`);
      return;
    }
    if (failure) {
      p.status = 'failed'; p.error = failure; p.endedAt = new Date().toISOString();
      this.save(p);
      return;
    }
    if (p.critic) { this.startCritique(p); return; }
    this.toReview(p);
  }

  /** Review state; the note says what still needs the user. */
  private toReview(p: Pipeline, extra?: string) {
    p.status = 'review'; p.critiqueTaskId = null; p.replanning = false;
    const errs = (p.issues ?? []).filter(i => i.level === 'error').length;
    const last = p.critiques?.[p.critiques.length - 1];
    const critic = last && !last.error ? last.issues.filter(i => i.level === 'error').length : 0;
    const warns = last && !last.error ? last.issues.length - critic : 0;
    p.note = [
      extra,
      errs ? `Kế hoạch có ${errs} lỗi so với mẫu. Sửa các bước rồi bấm Duyệt và chạy.` : 'Xem lại kế hoạch, sửa nếu cần, rồi bấm Duyệt và chạy.',
      critic ? `Phản biện vẫn còn ${critic} ý kiến cần xem (không chặn chạy).` : null,
      warns && p.sessionId && !p.steps.some(s => s.status !== 'pending') ? `Phản biện có ${warns} cảnh báo: sửa tay, hoặc bấm "Sửa theo phản biện" để planner chỉnh.` : null,
    ].filter(Boolean).join(' ');
    this.save(p);
  }

  private startCritique(p: Pipeline) {
    const rounds = (p.critiques ??= []);
    const round: CritiqueRound = { round: rounds.length + 1, planTaskId: p.planTaskId, taskId: null, ok: null, issues: [], error: null, revised: false, epoch: p.replans ?? 0 };
    rounds.push(round);
    try {
      const t = this.d.queue.create({ kind: 'prompt', prompt: criticPrompt(p, round.round, this.templates(), this.roles()), permissionMode: 'default', ...(p.model ? { model: p.model } : {}), ...attachOf(p) });
      round.taskId = t.id; p.critiqueTaskId = t.id; p.status = 'critiquing';
      p.note = `Đang phản biện kế hoạch (vòng ${round.round}).`;
      this.save(p);
    } catch (e) {
      round.error = `Không tạo được task phản biện: ${(e as Error).message}`;
      this.toReview(p);
    }
  }

  private critiqueDone(p: Pipeline, t: Task) {
    const round = p.critiques![p.critiques!.length - 1];
    if (t.status !== 'completed') {
      round.error = t.status === 'cancelled' ? 'Đã dừng phản biện.' : `Phản biện lỗi: ${t.error ?? 'không rõ'}`;
      return this.toReview(p);
    }
    try { Object.assign(round, parseCritique(t.resultText ?? '')); }
    catch (e) { round.error = (e as Error).message; return this.toReview(p); }
    const critic = round.issues.filter(i => i.level === 'error');
    const server = (p.issues ?? []).filter(i => i.level === 'error');
    const revisions = p.critiques!.filter(c => c.revised && c.revisedBy !== 'user' && (c.epoch ?? 0) === (p.replans ?? 0)).length;
    if (!(critic.length || server.length) || revisions >= MAX_REVISIONS || !p.sessionId) {
      return this.toReview(p, critic.length && revisions >= MAX_REVISIONS ? `Đã sửa ${MAX_REVISIONS} lần theo phản biện.` : undefined);
    }
    try {
      const r = this.d.queue.create({
        kind: 'prompt', prompt: revisePrompt(round.round, critic, server, this.templates().length > 0),
        resumeOf: p.sessionId, permissionMode: 'default', ...(p.model ? { model: p.model } : {}),
      });
      round.revised = true; round.revisedBy = 'auto';
      p.planTaskId = r.id; (p.planTasks ??= []).push(r.id); p.critiqueTaskId = null; p.status = 'planning';
      p.note = `Phản biện vòng ${round.round} thấy ${critic.length + server.length} lỗi; planner đang sửa kế hoạch (lần ${revisions + 1}/${MAX_REVISIONS}).`;
      this.save(p);
    } catch (e) {
      this.toReview(p, `Không gửi lại được planner: ${(e as Error).message}.`);
    }
  }

  /**
   * "Sửa theo phản biện": the user sends the plan back to the planner session for every issue of the last
   * critique (warnings too) plus the studio's warnings, with their note. The revised plan is critiqued again.
   * Not counted against MAX_REVISIONS (that limit is for the automatic loop).
   */
  revise(id: string, note?: unknown): Pipeline {
    const p = this.must(id);
    if (p.status !== 'review') throw new BadPipeline('Chỉ sửa theo phản biện được khi kế hoạch đang chờ duyệt');
    if (p.steps.some(s => s.status !== 'pending')) throw new BadPipeline('Chuỗi đã chạy bước đầu; dùng "Lập lại kế hoạch" cho các bước còn lại');
    if (!p.sessionId) throw new BadPipeline('Chuỗi chưa có session của planner để sửa kế hoạch');
    const text = typeof note === 'string' && note.trim() ? cut(note.trim(), 2000) : null;
    const last = p.critiques?.[p.critiques.length - 1];
    const critic = last && !last.error ? last.issues : [];
    const server = (p.issues ?? []).filter(i => i.level !== 'info');
    if (!critic.length && !server.length && !text) throw new BadPipeline('Không có ý kiến phản biện nào để sửa; nhập ghi chú nếu muốn planner chỉnh kế hoạch');
    const t = this.d.queue.create({
      kind: 'prompt', prompt: revisePrompt(last?.round ?? 0, critic, server, this.templates().length > 0, { note: text, plan: planJson(p) }),
      resumeOf: p.sessionId, permissionMode: 'default', ...(p.model ? { model: p.model } : {}),
    });
    if (last && !last.error) { last.revised = true; last.revisedBy = 'user'; }
    p.planTaskId = t.id; (p.planTasks ??= []).push(t.id); p.status = 'planning'; p.error = null;
    p.note = `Planner đang sửa kế hoạch theo ${critic.length + server.length} ý kiến${text ? ' và ghi chú của bạn' : ''}.`;
    return this.save(p);
  }

  /** Stop the critic loop now: keep the current plan and go to review. */
  async skipCritique(id: string): Promise<Pipeline> {
    const p = this.must(id);
    const revising = p.status === 'planning' && p.steps.length > 0;
    if (p.status !== 'critiquing' && !revising) throw new BadPipeline('Chuỗi không ở bước phản biện');
    const live = p.status === 'critiquing' ? p.critiqueTaskId : p.planTaskId;
    const last = p.critiques?.[p.critiques.length - 1];
    if (p.status === 'critiquing' && last) last.error = 'Bỏ qua theo yêu cầu.';
    this.toReview(p, revising ? 'Đã dừng việc sửa kế hoạch; giữ các bước trước đó.' : 'Đã bỏ qua phản biện.');
    if (live) { try { await this.d.queue.cancel(live); } catch (e) { if (!(e instanceof BadTask)) throw e; } }
    return this.must(id);
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
      // Rules 2 and 8: readiness before code (standard/full), UI compare before closing (UI template); never a skill of a role the user left out.
      const roles = this.roles();
      const act = activeRoles(p.roles, roles);
      const allow = (skill: string) => { const r = act ? roleOfSkill(skill, roles) : null; return !r || act!.includes(r); };
      const ui = !!this.templates().find(x => x.id === p.planType)?.ui;
      const added = stories.flatMap(f => storySteps(f, { rigor: (p.rigor ?? 'minimal') as Rigor, ui, known, allow }).map(x => normalizeStep(x, known, true)));
      p.steps.splice(at, 0, ...added);
      p.note = stories.length ? `Đã thêm ${added.length} bước cho ${stories.length} story.` : 'Bước chia việc không tạo file story nào; thêm bước tay nếu cần.';
    }
    // Checkpoint (P3): rules decide whether to go on, insert a fix, or stop for the user.
    const out = this.outputOf(p, s);
    const c = checkStep({ step: s, resultText: t.resultText, changedFiles: t.changedFiles, permissionMode: p.permissionMode, output: out?.rel ?? null, outputExists: !!out?.exists });
    s.check = c.check;
    if (c.fix.length) {
      const known = this.known();
      p.steps.splice(p.steps.indexOf(s) + 1, 0, ...c.fix.map(x => ({ ...normalizeStep(x, known, true), fixOf: x.fixOf })));
      p.note = `${p.note ? p.note + ' ' : ''}Điểm kiểm tra: ${c.check.reason}`;
    }
    if (c.check.decision === 'pause') {
      p.status = 'paused'; p.error = null;
      p.checkpoint = { ...c.check, stepId: s.id };
      p.note = `${p.note ? p.note + ' ' : ''}Điểm kiểm tra sau "${s.title}": ${c.check.reason}${c.check.replan ? ' Nên lập lại kế hoạch cho các bước còn lại.' : ' Xem kết quả rồi Tiếp tục, trả lời, sửa hoặc lập lại kế hoạch.'}`;
      this.save(p);
      return;
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
      // Server stopped during the code map lookup: do it again.
      if (p.status === 'planning' && !p.planTaskId && !(p.planTasks ?? []).length) {
        const kw = p.graph?.keywords ?? (p.codeKeywords?.length ? p.codeKeywords : keywordsFromRequest(p.request));
        void this.planWithGraph(p.id, kw, p.codeKeywords?.length ? 'user' : 'request');
        continue;
      }
      const ids = p.status === 'planning' ? [p.planTaskId] : p.status === 'critiquing' ? [p.critiqueTaskId ?? null]
        : p.status === 'running' ? p.steps.filter(s => s.status === 'running').map(s => s.taskId) : [];
      for (const id of ids) {
        const t = id ? this.d.queue.get(id) : null;
        if (t && ENDED.includes(t.status)) this.onTaskEnded(t);
      }
    }
  }
}
