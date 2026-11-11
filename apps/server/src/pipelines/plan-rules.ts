// Plan standard: templates (plugin/plan-templates/*.yaml) say which steps a kind of request needs and in
// which order; checkPlan() enforces them and a few global rules in code, so the result does not depend on
// what the planner remembered. Planner output gets safe auto-fixes; a plan edited by the user is only checked.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { PipelineStep, PlanIssue, Rigor } from '@ccgs/shared';
import { STUDIO_PLUGIN_DIR } from '../studio-plugin';

export interface TemplateSlot { skill: string; rigor: Rigor[] | null; optional: boolean; repeat: boolean; output: string | null }
export interface PlanTemplate { id: string; title: string; when: string; ui: boolean; free: boolean; steps: TemplateSlot[] }

export const TEMPLATE_DIR = path.join(STUDIO_PLUGIN_DIR, 'plan-templates');
export const ART_SKILL = 'studio:unity-art-context';
const UI_SKILLS = new Set(['ux-design', 'ux-review', 'prototype', 'dev-story']);
/** Skills that may sit anywhere in a plan without a reason (per-story work and its checks). */
const ANYWHERE = new Set(['dev-story', 'story-done', 'code-review', 'story-readiness']);
const ASK_FIRST = ['start', 'settings', 'gate-check'];
const RIGORS: Rigor[] = ['minimal', 'standard', 'full'];

/** Reads every template; a broken file is skipped with its reason rather than breaking planning. */
export function loadTemplates(dir = TEMPLATE_DIR): { templates: PlanTemplate[]; errors: string[] } {
  const templates: PlanTemplate[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(dir)) return { templates, errors: [`Không có thư mục mẫu: ${dir}`] };
  for (const f of fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f)).sort()) {
    try {
      const y = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) ?? {};
      if (typeof y.id !== 'string' || !/^[a-z0-9-]+$/.test(y.id)) throw new Error('thiếu id dạng kebab-case');
      if (!Array.isArray(y.steps)) throw new Error('thiếu steps');
      const steps = y.steps.map((s: any, i: number): TemplateSlot => {
        if (typeof s?.skill !== 'string' || !s.skill.trim()) throw new Error(`bước ${i + 1} thiếu skill`);
        const rigor = Array.isArray(s.rigor) ? s.rigor.filter((r: any) => RIGORS.includes(r)) : null;
        return { skill: s.skill.trim().replace(/^\//, ''), rigor: rigor?.length ? rigor : null, optional: s.optional === true, repeat: s.repeat === true, output: typeof s.output === 'string' ? s.output : null };
      });
      templates.push({ id: y.id, title: String(y.title ?? y.id), when: String(y.when ?? ''), ui: y.ui === true, free: y.free === true, steps });
    } catch (e) { errors.push(`${f}: ${(e as Error).message}`); }
  }
  return { templates, errors };
}

// ---------- Roles (plugin/plan-roles.yaml) ----------

export interface PlanRoleDef { id: string; title: string; hint: string; skills: string[] }
export const ROLES_FILE = path.join(STUDIO_PLUGIN_DIR, 'plan-roles.yaml');

/** Reads the roles; a missing or broken file means no roles (the role picker is hidden, nothing is filtered). */
export function loadRoles(file = ROLES_FILE): { roles: PlanRoleDef[]; errors: string[] } {
  if (!fs.existsSync(file)) return { roles: [], errors: [] };
  const roles: PlanRoleDef[] = [];
  const errors: string[] = [];
  let y: any;
  try { y = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch (e) { return { roles, errors: [`${path.basename(file)}: ${(e as Error).message}`] }; }
  const seen = new Set<string>();
  for (const [i, r] of (Array.isArray(y.roles) ? y.roles : []).entries()) {
    if (typeof r?.id !== 'string' || !/^[a-z0-9-]+$/.test(r.id) || seen.has(r.id)) { errors.push(`vai trò ${i + 1}: id thiếu, sai dạng hoặc trùng`); continue; }
    seen.add(r.id);
    const skills = (Array.isArray(r.skills) ? r.skills : []).filter((s: unknown) => typeof s === 'string' && s.trim()).map((s: string) => s.trim().replace(/^\//, ''));
    roles.push({ id: r.id, title: String(r.title ?? r.id), hint: String(r.hint ?? ''), skills });
  }
  return { roles, errors };
}

/** The role of a skill (first role that lists it), or null. */
export const roleOfSkill = (skill: string | null | undefined, roles: PlanRoleDef[]): string | null =>
  (skill && roles.find(r => r.skills.includes(skill))?.id) || null;

/** Keeps a step's role when it is a known id, otherwise takes the role of its skill. Mutates and returns the steps. */
export function fillRoles<T extends { skill: string | null; role?: string | null }>(steps: T[], roles: PlanRoleDef[]): T[] {
  if (!roles.length) return steps;
  for (const s of steps) if (!s.role || !roles.some(r => r.id === s.role)) s.role = roleOfSkill(s.skill, roles);
  return steps;
}

/** The chosen role ids that actually filter: null when nothing is chosen or every role is. */
export function activeRoles(chosen: string[] | null | undefined, roles: PlanRoleDef[]): string[] | null {
  if (!roles.length || !chosen?.length) return null;
  const ids = chosen.filter(c => roles.some(r => r.id === c));
  return ids.length && ids.length < roles.length ? ids : null;
}

/** Role section of the planner prompt: the role list, which ones the user chose, and the "role" field per step. */
export function rolesPrompt(roles: PlanRoleDef[], chosen: string[] | null | undefined): string {
  if (!roles.length) return '';
  const act = activeRoles(chosen, roles);
  const title = (id: string) => roles.find(r => r.id === id)?.title ?? id;
  const list = roles.map(r => `- ${r.id} (${r.title}): ${r.hint}${r.skills.length ? ` Skills: ${r.skills.map(s => '/' + s).join(', ')}` : ''}`).join('\n');
  return `Roles (who does each step):
${list}
${act ? `The user chose ONLY these roles for this plan: ${act.map(title).join(', ')}. Plan steps for these roles only. Do not add a step of another role; a template step of another role goes into "omitted" with why "Không chọn vai trò <title>". If the request cannot be done without another role, say so in the summary.`
    : 'The user chose every role.'}
Give every step a "role": one of the role ids above (a prompt step too: the role whose work it is).`;
}

const forRigor = (t: PlanTemplate, rigor: Rigor) => t.steps.filter(s => !s.rigor || s.rigor.includes(rigor));

/** The template list as the planner sees it, already filtered to the plan's rigor. */
export function templatesPrompt(templates: PlanTemplate[], rigor: Rigor): string {
  return templates.map(t => {
    const seq = forRigor(t, rigor).map(s => `/${s.skill}${s.optional ? ' (tuỳ chọn)' : ''}${s.repeat ? ' (lặp được)' : ''}${s.output ? ` [bỏ nếu đã có ${s.output}]` : ''}`).join(' -> ');
    return `- ${t.id}: ${t.title}. Khi: ${t.when}${t.free ? ' Không có bước bắt buộc; mọi bước cần "why".' : `\n  Thứ tự: ${seq || '(trống)'}`}`;
  }).join('\n');
}

export const slugOf = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
  return s || null;
};

export interface CheckInput {
  steps: PipelineStep[];
  type: string | null;
  slug: string | null;
  omitted: { skill: string; why: string }[];
  rigor: Rigor;
  request: string;
  templates: PlanTemplate[];
  /** Project root, to see which outputs already exist. */
  root: string | null;
  /** The user edited the plan: no auto-fix, and template errors become warnings (the user decides). */
  byUser: boolean;
  /** Builds a new step the same way the planner's steps are built. */
  make: (s: { title: string; skill: string; args: string | null; why: string }) => PipelineStep;
  /** Roles from plan-roles.yaml and the ones the user chose (null/all = no filter). */
  roles?: PlanRoleDef[];
  chosen?: string[] | null;
}

export function checkPlan(c: CheckInput): { steps: PipelineStep[]; issues: PlanIssue[]; template: PlanTemplate | null } {
  const issues: PlanIssue[] = [];
  const add = (level: PlanIssue['level'], rule: string, message: string, stepId: string | null = null) =>
    issues.push({ level: c.byUser && level === 'error' ? 'warn' : level, rule, message, stepId });
  const steps = [...c.steps];
  const live = () => steps.filter(s => s.status !== 'skipped' && s.status !== 'cancelled');
  const exists = (p: string | null) => {
    if (!p || !c.root) return false;
    if (p.includes('{slug}') && !c.slug) return false;
    return fs.existsSync(path.join(c.root, p.replace(/\{slug\}/g, c.slug ?? '')));
  };
  const outPath = (p: string) => p.replace(/\{slug\}/g, c.slug ?? '{slug}');
  const roles = c.roles ?? [];
  const act = activeRoles(c.chosen, roles);
  /** The role of this skill when the user did not choose it (its steps are not required, nor auto-added). */
  const offRole = (skill: string | null) => {
    const r = act ? roleOfSkill(skill, roles) : null;
    return r && !act!.includes(r) ? roles.find(x => x.id === r)! : null;
  };
  fillRoles(steps, roles);
  if (act) {
    for (const s of steps) {
      const r = s.status === 'pending' && s.role && !act.includes(s.role) ? roles.find(x => x.id === s.role) : null;
      if (r) add('warn', 'role', `"${s.title}" thuộc vai trò ${r.title}, bạn không chọn vai trò này cho kế hoạch.`, s.id);
    }
  }
  if (!c.templates.length) return { steps, issues, template: null }; // no templates on disk: standard off

  let t = c.templates.find(x => x.id === c.type) ?? null;
  if (!t) {
    add('error', 'type', c.type ? `Không có mẫu kế hoạch "${c.type}". Chọn một trong: ${c.templates.map(x => x.id).join(', ')}.` : 'Kế hoạch chưa chọn loại (mẫu). Xem theo luật của mẫu "other".');
    t = c.templates.find(x => x.id === 'other') ?? null;
  }
  const slots = t ? forRigor(t, c.rigor) : [];
  if (t && !c.slug && slots.some(s => s.output?.includes('{slug}'))) add('warn', 'slug', 'Kế hoạch thiếu "slug" (mã tính năng) nên không kiểm được file đã có.');

  // Auto-fix 1: art context before the first UI step (read-only skill, safe to add).
  const artSlot = slots.find(s => s.skill === ART_SKILL);
  if (t?.ui && artSlot && !c.byUser && !offRole(ART_SKILL) && !live().some(s => s.skill === ART_SKILL) && !exists(artSlot.output)) {
    const firstUi = steps.findIndex(s => s.status === 'pending' && s.skill && UI_SKILLS.has(s.skill));
    const at = firstUi >= 0 ? firstUi : steps.findIndex(s => s.status === 'pending');
    const fix = c.make({ title: 'Đọc art thật của game (Unity MCP)', skill: ART_SKILL, args: c.slug, why: 'Studio tự chèn: luật art-context trước bước UI.' });
    steps.splice(at >= 0 ? at : steps.length, 0, fix);
    add('info', 'art-context', 'Đã tự chèn bước đọc art trước bước UI đầu tiên.', fix.id);
  }
  // Auto-fix 2: every explicit /dev-story gets its /story-done right after.
  if (!c.byUser) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.skill !== 'dev-story' || !s.args || s.status !== 'pending') continue;
      if (steps.slice(i + 1).some(x => x.skill === 'story-done' && x.args === s.args)) continue;
      const fix = c.make({ title: `Đóng story ${s.args.split('/').pop()}`, skill: 'story-done', args: s.args, why: 'Studio tự chèn: mỗi /dev-story cần /story-done.' });
      steps.splice(i + 1, 0, fix);
      add('info', 'story-done', `Đã tự chèn /story-done cho ${s.args}.`, fix.id);
    }
  }

  const L = live();
  // Required steps of the template.
  for (const slot of slots.filter(s => !s.optional)) {
    if (L.some(s => s.skill === slot.skill)) continue;
    const why = c.omitted.find(o => o.skill.replace(/^\//, '') === slot.skill)?.why;
    const off = offRole(slot.skill);
    if (slot.output && exists(slot.output)) add('info', 'required', `Bỏ /${slot.skill}: đã có ${outPath(slot.output)}.`);
    else if (off) add('info', 'role', `Bỏ /${slot.skill}: không chọn vai trò ${off.title}.`);
    else if (why) add('info', 'required', `Bỏ /${slot.skill}: ${why}`);
    else add('error', 'required', `Thiếu bước /${slot.skill} theo mẫu "${t!.id}" (rigor ${c.rigor}). Thêm bước hoặc ghi lý do bỏ.`);
  }
  // Output already on disk while the step is still planned.
  for (const slot of slots.filter(s => s.output && !s.repeat)) {
    const s = L.find(x => x.skill === slot.skill && x.status === 'pending');
    if (s && exists(slot.output)) add('warn', 'exists', `Đã có ${outPath(slot.output!)}; có thể bỏ bước "${s.title}".`, s.id);
  }
  // Order: template steps keep the template order; a run of repeatable slots is one group (per-screen interleave).
  const rank = new Map<string, number>();
  slots.forEach((s, i) => { if (!rank.has(s.skill)) rank.set(s.skill, s.repeat && i > 0 && slots[i - 1].repeat ? rank.get(slots[i - 1].skill)! : i); });
  let top: { r: number; s: PipelineStep } | null = null;
  for (const s of L) {
    const r = s.skill ? rank.get(s.skill) : undefined;
    if (r === undefined) continue;
    if (top && r < top.r) add('error', 'order', `/${s.skill} ("${s.title}") phải đứng trước /${top.s.skill} ("${top.s.title}") theo mẫu.`, s.id);
    else top = { r, s };
  }
  // Global rules.
  const idx = (pred: (s: PipelineStep) => boolean) => L.findIndex(pred);
  const firstUi = idx(s => !!s.skill && UI_SKILLS.has(s.skill));
  const art = idx(s => s.skill === ART_SKILL);
  if (art >= 0 && firstUi >= 0 && art > firstUi) add('error', 'art-context', 'Bước đọc art phải đứng trước bước UI đầu tiên.', L[art].id);
  if (t && !t.ui && L.some(s => s.skill === 'ux-design' || s.skill === 'prototype')) add('warn', 'type', `Kế hoạch có bước UI nhưng chọn mẫu "${t.id}"; có lẽ nên là "feature-ui".`);
  const stories = idx(s => s.skill === 'create-stories');
  L.forEach((s, i) => {
    if (s.skill === 'dev-story' && stories > i) add('error', 'stories', `"${s.title}" chạy trước /create-stories.`, s.id);
    if (s.skill === 'dev-story' && !s.args) add('warn', 'stories', `"${s.title}" thiếu đường dẫn story.`, s.id);
    if (s.skill === 'prototype' && !L.slice(0, i).some(x => x.skill === 'ux-design')) add('warn', 'prototype', `"${s.title}" không có /ux-design trước nó.`, s.id);
    if (s.skill && ASK_FIRST.includes(s.skill) && !c.request.includes(s.skill)) add('warn', 'ask-first', `/${s.skill} không nằm trong yêu cầu; thường không đưa vào kế hoạch.`, s.id);
    const inTemplate = !!s.skill && rank.has(s.skill);
    if (s.status === 'pending' && !s.generated && !inTemplate && !(s.skill && ANYWHERE.has(s.skill)) && !s.why)
      add('warn', 'why', `"${s.title}" nằm ngoài mẫu nhưng không có lý do.`, s.id);
  });
  fillRoles(steps, roles); // steps the auto-fixes added
  return { steps, issues, template: t };
}
