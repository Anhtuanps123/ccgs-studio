// Checkpoint after each pipeline step (P3). Pure rules over the step's reply and changed files: no LLM decides.
// CCGS skills end with a fixed verdict line ("Verdict: NEEDS REVISION", dev-story "Story: <path> — INCOMPLETE"),
// so the verdict word drives the decision: go on, insert a fix (once per step), or stop for the user.
import type { ChangedFile, PipelineStep, PlanStep, StepCheck } from '@ccgs/shared';

// Longest first so "COMPLETE WITH NOTES" wins over "COMPLETE".
const TOKENS = ['MAJOR REVISION NEEDED', 'NEEDS REVISION', 'CHANGES REQUIRED', 'APPROVED WITH SUGGESTIONS', 'COMPLETE WITH NOTES',
  'PASS WITH WARNINGS', 'NOT ASSESSED', 'NEEDS WORK', 'INCOMPLETE', 'IMPLEMENTED', 'APPROVED', 'COMPLETE', 'BLOCKED', 'READY',
  'REDIRECTED', 'PROCEED', 'PIVOT', 'KILL', 'CONCERNS', 'PASS', 'FAIL'];
const TOKEN_RE = new RegExp(`\\b(${TOKENS.map(t => t.replace(/ /g, '\\s+')).join('|')})\\b`, 'g');

const GOOD = new Set(['APPROVED', 'APPROVED WITH SUGGESTIONS', 'COMPLETE', 'COMPLETE WITH NOTES', 'IMPLEMENTED', 'READY', 'PROCEED', 'PASS', 'PASS WITH WARNINGS']);
/** The result points away from the plan: stop and suggest re-planning. */
const OFF_PLAN = new Set(['MAJOR REVISION NEEDED', 'BLOCKED', 'REDIRECTED', 'PIVOT', 'KILL', 'FAIL']);
/** Review skills whose "fix it" verdict gets one automatic fix + re-run. */
const REVIEWS = new Set(['ux-review', 'design-review', 'code-review', 'story-readiness', 'architecture-review']);
const REVISE = new Set(['NEEDS REVISION', 'CHANGES REQUIRED', 'NEEDS WORK']);
/** Skills that should leave at least one changed file behind. */
export const WRITERS = new Set(['quick-design', 'design-system', 'ux-design', 'prototype', 'create-epics', 'create-stories', 'dev-story', 'studio:unity-art-context', 'architecture-decision', 'art-bible']);

const clean = (l: string) => l.replace(/[*_`#>]/g, ' ').replace(/\s+/g, ' ').trim();

/** The verdict word of a skill reply, from the last line that states one; null when there is none. */
export function verdictOf(text: string | null): string | null {
  const lines = (text ?? '').split(/\r?\n/).map(clean).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    // dev-story: "Story: production/epics/x/story-001.md — Implemented | INCOMPLETE — … | BLOCKED — …"
    const story = l.match(/^Story:\s*\S+\s*[—–-]+\s*(Implemented|INCOMPLETE|BLOCKED)\b/i);
    if (story) return story[1].toUpperCase();
    const at = l.search(/\b(verdict|recommendation)\b/i);
    if (at < 0) continue;
    const found = [...l.slice(at).matchAll(TOKEN_RE)].map(m => m[1].replace(/\s+/g, ' '));
    if (!found.length) continue;
    if (found.length > 1 && /[|/]/.test(l)) continue; // a template line listing the options, not a verdict
    return found[0];
  }
  return null;
}

/** The question Claude ended its reply with (plain text, not AskUserQuestion), or null. */
export function trailingQuestion(text: string | null): string | null {
  const lines = (text ?? '').split(/\r?\n/).map(clean).filter(Boolean);
  const last = lines[lines.length - 1];
  return last && /[?？]\s*$/.test(last) ? (last.length > 300 ? last.slice(0, 299) + '…' : last) : null;
}

export interface CheckInput {
  step: PipelineStep;
  resultText: string | null;
  changedFiles: ChangedFile[] | null;
  permissionMode: string;
  /** Output the plan template expects from this step (already resolved), and whether it is on disk now. */
  output: string | null;
  outputExists: boolean;
}
export interface CheckResult { check: StepCheck; fix: (PlanStep & { fixOf: string })[] }

export function checkStep(c: CheckInput): CheckResult {
  const s = c.step;
  const verdict = verdictOf(c.resultText);
  const question = trailingQuestion(c.resultText);
  const cmd = s.skill ? `/${s.skill}${s.args ? ' ' + s.args : ''}` : 'prompt';
  const out = (decision: StepCheck['decision'], reason: string, replan = false, fix: CheckResult['fix'] = []): CheckResult =>
    ({ check: { decision, verdict, reason, replan, question: decision === 'pause' ? question : null }, fix });
  const root = s.fixOf ?? s.id;
  const already = !!s.fixOf; // this step is itself a fix or a re-run: no second automatic fix
  const step = (p: Partial<PlanStep>): PlanStep & { fixOf: string } =>
    ({ title: '', skill: null, args: null, prompt: null, why: 'Studio tự chèn ở điểm kiểm tra.', expand: null, ...p, fixOf: root });

  if (verdict && !GOOD.has(verdict)) {
    const fixable = (s.skill && REVIEWS.has(s.skill) && REVISE.has(verdict)) || (s.skill === 'dev-story' && verdict === 'INCOMPLETE')
      || (s.skill === 'story-done' && verdict === 'BLOCKED' && !!s.args);
    if (fixable && !already) {
      if (s.skill === 'dev-story') return out('fix', `${cmd} báo INCOMPLETE: chạy lại một lần để làm nốt.`, false, [step({ title: `${s.title} (làm nốt)`, skill: 'dev-story', args: s.args })]);
      if (s.skill === 'story-done') return out('fix', `${cmd} báo BLOCKED: sửa story rồi đóng lại một lần.`, false, [
        step({ title: `Sửa story ${s.args!.split('/').pop()}`, skill: 'dev-story', args: s.args }),
        step({ title: `${s.title} (chạy lại)`, skill: 'story-done', args: s.args }),
      ]);
      return out('fix', `${cmd} báo ${verdict}: sửa theo review rồi review lại một lần.`, false, [
        step({ title: `Sửa theo ${s.skill === 'code-review' ? 'code review' : `/${s.skill}`}`, prompt: `Sửa ${s.args ? `"${s.args}"` : 'tài liệu/code vừa được review'} theo đúng các vấn đề mà /${s.skill} vừa nêu (verdict ${verdict}). Chỉ sửa những điểm đó, theo quy tắc của project (hỏi trước khi ghi file).` }),
        step({ title: `${s.title} (chạy lại)`, skill: s.skill, args: s.args }),
      ]);
    }
    if (fixable) return out('pause', `${cmd} vẫn báo ${verdict} sau một lần tự sửa.`, true);
    if (OFF_PLAN.has(verdict)) return out('pause', `${cmd} báo ${verdict}: kết quả lệch kế hoạch.`, true);
    return out('pause', `${cmd} báo ${verdict}: cần bạn xem.`);
  }
  if (c.output && !c.outputExists) return out('pause', `${cmd} đã xong nhưng không thấy ${c.output}.`);
  if (verdict) return out('continue', `${cmd}: ${verdict}.`);
  if (question) return out('pause', `Claude kết thúc ${cmd} bằng một câu hỏi.`);
  if (s.skill && WRITERS.has(s.skill) && c.permissionMode !== 'plan' && Array.isArray(c.changedFiles) && !c.changedFiles.some(f => f.change !== 'D'))
    return out('pause', `${cmd} đã xong nhưng không tạo hoặc sửa file nào.`);
  return out('continue', verdict ? `${cmd}: ${verdict}.` : `${cmd}: không có verdict.`);
}
