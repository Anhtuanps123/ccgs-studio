// Studio rules for using CCGS (the 9 rules on the "Quy tắc" screen; api-contract §12).
// Pure helpers over files on disk and plan steps: no LLM decides. plan-rules.ts calls them while checking a plan,
// pipeline.service.ts before /dev-story (open-question gate) and when it expands stories.
import fs from 'node:fs';
import path from 'node:path';
import type { OpenItem, PipelineStep, PlanIssue, ProjectRuleState, Rigor, RuleCheck } from '@ccgs/shared';

export const CONVENTIONS_SKILL = 'studio:project-conventions';
export const COMPARE_SKILL = 'studio:ui-compare';
const ART_SKILL_NAME = 'studio:unity-art-context';
export const CONVENTIONS_FILE = 'design/conventions.md';
export const ACTIVE_FILE = 'production/session-state/active.md';
/** Rigor minimal with at least this many epics or GDDs: suggest standard (rule 1). */
export const RIGOR_SIZE_HINT = 3;

/** Skills that write design (rule 4: existing stories must follow a design change). */
export const DESIGN_SKILLS = new Set(['quick-design', 'design-system', 'ux-design']);
/** Skills that only report or judge: never the fix of a bug (rule 5). */
export const EVALUATORS = new Set(['team-qa', 'qa-plan', 'code-review', 'ux-review', 'design-review', 'architecture-review', 'test-evidence-review',
  'smoke-check', 'bug-report', 'bug-triage', 'story-readiness', 'regression-suite', 'gate-check', 'scope-check', 'balance-check', 'consistency-check',
  'review-all-gdds', 'playtest-report', 'soak-test', 'unity-code-reviewer', COMPARE_SKILL]);
/** Steps that can change code or assets. */
const fixes = (s: PipelineStep) => !s.skill || s.skill === 'dev-story';

const FIX_RE = /(sửa|fix|lỗi|bug|hỏng|crash|không chạy|sai\b)/i;
const UI_RE = /(popup|pop-up|màn hình|\bmàn\b|giao diện|\bui\b|\bux\b|\bnút\b|button|hiển thị|layout|prefab|canvas|sprite|\blệch\b|\bvỡ\b|\bméo\b|\bicon\b|\bhud\b|font)/i;
export const isFixRequest = (request: string) => FIX_RE.test(request);
export const isUiRequest = (request: string) => UI_RE.test(request);

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const read = (f: string): string | null => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const listDir = (d: string): fs.Dirent[] => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

// ---------- Project facts ----------

/** Story files already in production/epics/<slug>/ (project-relative, sorted). */
export function existingStories(root: string | null, slug: string | null): string[] {
  if (!root || !slug) return [];
  const rel = `production/epics/${slug}`;
  return listDir(path.join(root, rel)).filter(d => d.isFile() && /^story-.*\.md$/i.test(d.name)).map(d => `${rel}/${d.name}`).sort();
}

/** What the rules look at in the project (GET /api/pipelines/project-state). Missing files count as none. */
export function projectState(root: string | null, rigor: Rigor | null): ProjectRuleState {
  const none: ProjectRuleState = { rigor, epics: 0, gdds: 0, conventions: { path: CONVENTIONS_FILE, exists: false }, openItems: [], openSource: null };
  if (!root) return none;
  const epics = listDir(path.join(root, 'production/epics')).filter(d => d.isDirectory()).length;
  const gdds = listDir(path.join(root, 'design/gdd')).filter(d => d.isFile() && /\.md$/i.test(d.name)).length;
  const active = read(path.join(root, ACTIVE_FILE));
  return {
    rigor, epics, gdds,
    conventions: { path: CONVENTIONS_FILE, exists: fs.existsSync(path.join(root, CONVENTIONS_FILE)) },
    openItems: active ? activeOpenItems(active) : [], openSource: active ? ACTIVE_FILE : null,
  };
}

// ---------- active.md (rule 9) ----------

const NONE_RE = /^(none|nothing|không|không có|n\/a|-|—|\(none\))\.?$/i;

/** Pending items of production/session-state/active.md: checkpoint next step / blockers / open questions, "Open:" lines, unreviewed docs. */
export function activeOpenItems(text: string, max = 15): OpenItem[] {
  const out: OpenItem[] = [];
  const seen = new Set<string>();
  const add = (kind: OpenItem['kind'], raw: string) => {
    const t = cut(raw.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(), 240);
    if (!t || NONE_RE.test(t) || seen.has(t)) return;
    seen.add(t); out.push({ kind, text: t });
  };
  const cp = text.match(/<!--\s*CHECKPOINT\s*-->([\s\S]*?)<!--\s*\/CHECKPOINT\s*-->/i)?.[1] ?? '';
  for (const l of cp.split(/\r?\n/)) {
    const m = l.match(/^\s*\*\*(Next step|Blocked on|Open questions)\s*:\*\*\s*(.*)$/i);
    if (m && m[2].trim() && !NONE_RE.test(m[2].trim())) add('checkpoint', `${m[1]}: ${m[2]}`);
  }
  const rest = text.replace(/<!--\s*CHECKPOINT\s*-->[\s\S]*?<!--\s*\/CHECKPOINT\s*-->/i, '');
  let task = ''; // the "- Task: …" (or "## …") line the item belongs to, so the item says which work it is about
  for (const l of rest.split(/\r?\n/)) {
    const head = l.match(/^\s*[-*]\s*Task\s*:\s*(.+)$/i)?.[1] ?? l.match(/^#{1,6}\s+(.+)$/)?.[1];
    if (head) { task = cut(head.trim(), 80); continue; }
    const of = task ? `${task} — ` : '';
    const open = l.match(/^\s*[-*]\s*(Open|Còn treo|Mở|Open questions)\s*:\s*(.+)$/i);
    if (open) { add('open', of + open[2]); continue; }
    if (/chưa chạy\s+\/[a-z-]*review/i.test(l) || /\bnot (yet )?reviewed\b/i.test(l)) add('unreviewed', of + l.replace(/^\s*[-*]\s*/, ''));
  }
  return out.slice(0, max);
}

// ---------- Open questions (rule 3) ----------

const QUESTION_HEAD = /^#{1,6}\s*(open questions?|unresolved( questions?)?|câu hỏi mở|câu hỏi còn mở|còn treo|việc cần quyết)\b/i;
const MARKERS = /(\bTBD\b|CẦN QUYẾT|chưa chốt|chưa quyết|\bundecided\b|\bto be decided\b)/i;
const RESOLVED = /(~~.*~~|^\[x\]|\bresolved\b|đã chốt|đã quyết|\bdone\b)/i;

/** Open questions in a design doc or story: bullets under an "Open Questions" heading, "**Open questions:** …" lines, TBD / CẦN QUYẾT markers. */
export function openQuestions(text: string, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = cut(raw.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(), 200);
    if (!t || NONE_RE.test(t) || RESOLVED.test(t) || seen.has(t)) return;
    seen.add(t); out.push(t);
  };
  let inQ = false;
  let fence = false;
  for (const l of text.split(/\r?\n/)) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^#{1,6}\s/.test(l)) { inQ = QUESTION_HEAD.test(l); continue; }
    const bold = l.match(/^\s*[-*]?\s*\*\*(open questions?|câu hỏi mở)\s*:?\*\*\s*:?\s*(.*)$/i);
    if (bold) { if (bold[2].trim()) add(bold[2]); continue; }
    const item = l.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[ \]\s*)?(.+)$/);
    if (inQ && item) { add(item[1]); continue; }
    if (MARKERS.test(l)) add(l.replace(/^\s*(?:[-*]|\d+[.)]|\|)\s*/, ''));
  }
  return out.slice(0, max);
}

/** Files the gate reads for a story: the story, design/gdd/<slug>.md, design/ux/*<slug>*.md (only those on disk). */
export function gateFiles(root: string, story: string, slug: string | null): string[] {
  const files = [story];
  const s = slug ?? story.match(/^production\/epics\/([^/]+)\//)?.[1] ?? null;
  if (s) {
    files.push(`design/gdd/${s}.md`);
    for (const d of listDir(path.join(root, 'design/ux'))) if (d.isFile() && /\.md$/i.test(d.name) && d.name.toLowerCase().includes(s)) files.push(`design/ux/${d.name}`);
  }
  return files.filter(f => fs.existsSync(path.join(root, f)));
}

/** Rule 3 gate: open questions of a story and its design docs, with the files they came from. */
export function storyGate(root: string, story: string, slug: string | null): { items: string[]; files: string[] } {
  const items: string[] = [];
  const files: string[] = [];
  for (const f of gateFiles(root, story, slug)) {
    const qs = openQuestions(read(path.join(root, f)) ?? '');
    if (!qs.length) continue;
    files.push(f);
    for (const q of qs) if (items.length < 12) items.push(`${f.split('/').pop()}: ${q}`);
  }
  return { items, files };
}

// ---------- Plan rules (called from checkPlan) ----------

export interface RulesInput {
  steps: PipelineStep[];
  slug: string | null;
  rigor: Rigor;
  request: string;
  root: string | null;
  byUser: boolean;
  /** The chosen template has UI (feature-ui), and its id. */
  ui: boolean;
  type: string | null;
  /** Skills the project (and the studio plugin) has; undefined = assume all. */
  known?: Set<string>;
  make: (s: { title: string; skill: string | null; args: string | null; prompt?: string | null; why: string }) => PipelineStep;
  add: (level: PlanIssue['level'], rule: string, message: string, stepId?: string | null) => void;
}

const has = (k: Set<string> | undefined, skill: string) => !k || k.has(skill);
const live = (steps: PipelineStep[]) => steps.filter(s => s.status !== 'skipped' && s.status !== 'cancelled');
export const PROPAGATE_TAG = 'Studio tự chèn: quy tắc 4';
export const COMPARE_TAG = 'Studio tự chèn: quy tắc 8';

/** Rules 1, 4, 5, 8 over a plan. Mutates `steps` (auto-fixes on the planner's plan only) and reports through `add`. */
export function applyStudioRules(c: RulesInput): void {
  const steps = c.steps;
  // Rule 1: rigor fits the project's size.
  if (c.rigor === 'minimal' && c.root) {
    const st = projectState(c.root, c.rigor);
    if (st.epics >= RIGOR_SIZE_HINT || st.gdds >= RIGOR_SIZE_HINT)
      c.add('warn', 'rigor', `Rigor minimal nhưng project đã có ${st.epics} epic và ${st.gdds} GDD: không có review thiết kế, dễ thiếu ý. Cân nhắc rigor standard (/settings).`);
  }

  // Rule 4: a design change on a feature that already has stories.
  const stories = existingStories(c.root, c.slug);
  const designAt = steps.map((s, i) => (s.status === 'pending' && s.skill && DESIGN_SKILLS.has(s.skill) ? i : -1)).filter(i => i >= 0);
  if (stories.length && designAt.length) {
    const done = steps.some(s => s.status !== 'skipped' && (s.skill === 'propagate-design-change' || s.why?.startsWith(PROPAGATE_TAG)));
    if (!done && !c.byUser) {
      let at = designAt[designAt.length - 1] + 1;
      while (at < steps.length && ['ux-review', 'design-review', 'prototype', ART_SKILL_NAME].includes(steps[at].skill ?? '')) at++;
      const add: PipelineStep[] = [];
      if (steps.some(s => s.status === 'pending' && s.skill === 'design-system') && has(c.known, 'propagate-design-change'))
        add.push(c.make({ title: 'Lan truyền thay đổi GDD', skill: 'propagate-design-change', args: `design/gdd/${c.slug}.md`, why: `${PROPAGATE_TAG} (GDD đổi, tìm ADR bị ảnh hưởng).` }));
      add.push(c.make({
        title: 'Cập nhật story cũ theo thiết kế mới', skill: null, args: null, why: `${PROPAGATE_TAG} (đã có ${stories.length} story).`,
        prompt: `Thiết kế của "${c.slug}" vừa đổi trong các bước trước. Đọc các story đã có (${stories.join(', ')}) và so với tài liệu thiết kế mới (design/gdd, design/ux, design/quick-specs, design/game-brief.md). Liệt kê story nào lệch (luật, acceptance criteria, trạng thái biên) và đề xuất sửa từng story. Hỏi trước khi ghi. Không sửa code.`,
      }));
      steps.splice(at, 0, ...add);
      c.add('info', 'propagate', `Đã tự chèn bước cập nhật ${stories.length} story cũ của "${c.slug}" sau bước thiết kế.`, add[add.length - 1].id);
    } else if (!done) {
      c.add('warn', 'propagate', `Kế hoạch đổi thiết kế của "${c.slug}" nhưng đã có ${stories.length} story; nên thêm bước cập nhật story cũ trước /dev-story.`);
    }
  }

  // Rule 5: a fix needs a step that can change something.
  const L = live(steps).filter(s => s.status === 'pending');
  const fixReq = isFixRequest(c.request) || c.type === 'bugfix';
  if (fixReq && L.length && !L.some(fixes)) {
    const onlyEval = L.every(s => !!s.skill && EVALUATORS.has(s.skill));
    if (c.type === 'bugfix') c.add('error', 'fix-step', 'Kế hoạch sửa lỗi không có bước nào sửa được (bước prompt hoặc /dev-story). Skill review/QA chỉ báo cáo, không sửa.');
    else if (onlyEval) c.add('warn', 'fix-step', 'Yêu cầu là sửa lỗi nhưng kế hoạch chỉ có skill đánh giá (review/QA). Các skill này không sửa code hay asset.');
  }

  // Rule 8: a UI fix gets compared with the reference screen after the fix.
  if (c.type === 'bugfix' && isUiRequest(c.request) && L.some(fixes) && !steps.some(s => s.status !== 'skipped' && s.skill === COMPARE_SKILL)) {
    if (!c.byUser && has(c.known, COMPARE_SKILL)) {
      let last = -1;
      steps.forEach((s, i) => { if (s.status === 'pending' && fixes(s)) last = i; });
      const fix = c.make({ title: 'So màn đã sửa với màn mẫu (Unity MCP)', skill: COMPARE_SKILL, args: c.slug, why: `${COMPARE_TAG}: lỗi UI phải được so với màn mẫu sau khi sửa.` });
      steps.splice(last + 1, 0, fix);
      c.add('info', 'ui-compare', 'Đã tự chèn bước so màn đã sửa với màn mẫu sau bước sửa cuối.', fix.id);
    } else c.add('warn', 'ui-compare', `Lỗi UI nhưng kế hoạch không có /${COMPARE_SKILL} để so với màn mẫu sau khi sửa.`);
  }
}

/** Steps for one story when /create-stories expands (rules 2, 8): readiness before dev at standard/full, UI compare before story-done. */
export function storySteps(story: string, o: { rigor: Rigor; ui: boolean; known?: Set<string>; allow?: (skill: string) => boolean }) {
  const name = story.split('/').pop();
  const ok = (skill: string) => has(o.known, skill) && (o.allow ? o.allow(skill) : true);
  return [
    ...(o.rigor !== 'minimal' && ok('story-readiness') ? [{ title: `Kiểm story ${name} sẵn sàng`, skill: 'story-readiness', args: story, why: 'Studio tự thêm: quy tắc 2, story phải sẵn sàng trước khi code.' }] : []),
    { title: `Làm story ${name}`, skill: 'dev-story', args: story, why: null },
    ...(o.ui && ok(COMPARE_SKILL) ? [{ title: `So màn của story ${name} với màn mẫu`, skill: COMPARE_SKILL, args: story, why: `${COMPARE_TAG}: evidence UI phải có đối chiếu.` }] : []),
    { title: `Đóng story ${name}`, skill: 'story-done', args: story, why: null },
  ];
}

// ---------- Checklist (display) ----------

export const RULE_TITLES = ['', 'Cấu hình đúng', 'Đi đúng pipeline', 'Chốt trước khi code', 'Đổi thiết kế thì lan truyền', 'Đúng skill, đúng việc',
  'Giới hạn subagent', 'Quy ước dự án', 'Evidence có đối chiếu', 'Giữ checkpoint'];

/** One line per rule for the plan card. */
export function ruleChecklist(c: { steps: PipelineStep[]; issues: PlanIssue[]; ui: boolean; request: string; type: string | null; slug: string | null; root: string | null; rigor: Rigor }): RuleCheck[] {
  const L = live(c.steps);
  const iss = (rule: string) => c.issues.filter(i => i.rule === rule);
  const worst = (rules: string[]) => (c.issues.some(i => rules.includes(i.rule) && i.level !== 'info') ? 'warn' : 'ok');
  const st = projectState(c.root, c.rigor);
  const skills = new Set(L.map(s => s.skill));
  const line = (rule: number, state: RuleCheck['state'], detail: string): RuleCheck => ({ rule, title: RULE_TITLES[rule], state, detail });
  const coding = skills.has('dev-story') || skills.has('create-stories');
  const stories = existingStories(c.root, c.slug).length;
  const designs = L.some(s => s.status === 'pending' && s.skill && DESIGN_SKILLS.has(s.skill));
  const fixReq = isFixRequest(c.request) || c.type === 'bugfix';
  return [
    line(1, iss('rigor').length ? 'warn' : 'ok', iss('rigor')[0]?.message ?? `Rigor ${c.rigor}; project có ${st.epics} epic, ${st.gdds} GDD.`),
    line(2, worst(['required', 'order', 'stories']), worst(['required', 'order', 'stories']) === 'ok' ? 'Đúng thứ tự và đủ bước của mẫu.' : 'Còn bước thiếu hoặc sai thứ tự so với mẫu (xem phần kiểm luật).'),
    line(3, coding ? 'todo' : 'na', coding ? 'Studio đọc story và GDD/UX ngay trước mỗi /dev-story; còn câu hỏi mở thì dừng để bạn quyết.' : 'Kế hoạch không có bước code.'),
    line(4, !stories || !designs ? 'na' : worst(['propagate']), !stories || !designs ? 'Không đổi thiết kế của tính năng đã có story.' : iss('propagate')[0]?.message ?? 'Có bước cập nhật story cũ.'),
    line(5, !fixReq ? 'na' : worst(['fix-step']), !fixReq ? 'Không phải yêu cầu sửa lỗi.' : iss('fix-step')[0]?.message ?? 'Có bước sửa thật, không chỉ review/QA.'),
    line(6, 'ok', 'Mọi task được dặn: việc cần nhìn hoặc thao tác engine làm ở session chính, không giao subagent.'),
    line(7, !c.ui ? 'na' : st.conventions.exists ? 'ok' : skills.has(CONVENTIONS_SKILL) ? 'todo' : 'warn',
      !c.ui ? 'Không có UI mới.' : st.conventions.exists ? `Có ${CONVENTIONS_FILE}.` : skills.has(CONVENTIONS_SKILL) ? `Bước /${CONVENTIONS_SKILL} sẽ ghi ${CONVENTIONS_FILE}.` : `Chưa có ${CONVENTIONS_FILE} và kế hoạch không tạo nó.`),
    line(8, !(c.ui || (fixReq && isUiRequest(c.request))) ? 'na' : skills.has(COMPARE_SKILL) || (c.ui && skills.has('create-stories')) ? 'todo' : 'warn',
      !(c.ui || (fixReq && isUiRequest(c.request))) ? 'Không có UI.' : skills.has(COMPARE_SKILL) || (c.ui && skills.has('create-stories')) ? `/${COMPARE_SKILL} chạy trước khi đóng việc UI.` : `Thiếu /${COMPARE_SKILL}: ảnh evidence sẽ không có đối chiếu.`),
    line(9, st.openItems.length ? 'warn' : 'ok', st.openItems.length ? `${ACTIVE_FILE} còn ${st.openItems.length} mục đang treo; planner đã được xem.` : st.openSource ? 'Không có mục đang treo.' : `Không có ${ACTIVE_FILE}.`),
  ];
}

// ---------- Prompts ----------

/** Section of the planner prompt: the rules the planner applies itself. */
export const PLANNER_RULES = `Studio rules (apply them; the studio also checks some of them in code):
- Do not plan /dev-story while the feature's GDD, UX spec or stories still have open questions. Resolve them first (a step that asks the user), or start the step's "why" with "CẦN QUYẾT: <question>".
- If the feature already has stories in production/epics/<slug>/ and the plan changes its design, add a step that updates those stories before any /dev-story (and /propagate-design-change for a changed GDD).
- Fixing a bug needs a step that changes code or assets (a prompt step or /dev-story). Review and QA skills (/team-qa, /code-review, /qa-plan, /ux-review…) only report: never plan them as the fix.
- A UI or visual bug: the fix is a prompt step that works in the main session with Unity MCP (read real component values, edit, render, look). Then ${COMPARE_SKILL} compares the result with the reference screen.
- New UI starts from the reference screen in ${CONVENTIONS_FILE} (${CONVENTIONS_SKILL} writes it when missing): name the prefab it is based on in the step's args or prompt.`;

/** Pending items of active.md for the planner prompt (empty string when none). */
export function openItemsPrompt(items: OpenItem[], max = 2000): string {
  if (!items.length) return '';
  const body = cut(items.map(i => `- [${i.kind}] ${i.text}`).join('\n'), max);
  return `Pending items in ${ACTIVE_FILE} (the project's checkpoint). Account for the ones this request touches: resolve them in the plan or say why not; do not plan over them silently:
"""
${body}
"""`;
}
