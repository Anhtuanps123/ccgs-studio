// Feature pipelines: one request -> plan -> approve -> chained tasks in one session.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CritiqueRound, PermissionMode, Pipeline, PipelineMode, PipelineSetup, PipelineStep, PlanIssue, Rigor, SessionUsage, Skill, StudioSettings } from '@ccgs/shared';
import { api, live, useApi } from '../api';
import { Status, when } from '../monitor';
import { fmtNum, fmtUsd, totalTok } from '../insights';
import { PermissionBox, QuestionBox, useTaskData } from './Tasks';

const MODES: [PipelineMode, string, string][] = [
  ['auto', 'Tự chạy hết', 'Duyệt kế hoạch một lần, các bước chạy liền nhau; chỉ dừng khi Claude hỏi hoặc một bước lỗi.'],
  ['step', 'Dừng sau mỗi bước', 'Sau mỗi bước, chuỗi tạm dừng để bạn xem kết quả rồi bấm Tiếp tục.'],
];
const RIGORS: [Rigor, string, string][] = [
  ['minimal', 'minimal', 'Không GDD, chỉ brief; story to; test tuỳ chọn. Ngắn nhất tới code: quick-design → create-stories → dev-story.'],
  ['standard', 'standard', 'GDD 5 mục, ADR quan trọng, có /ux-design cho màn hình mới, rồi epic → story → dev-story.'],
  ['full', 'full', 'Như standard, thêm design-review, ux-review, architecture-review, vertical slice.'],
];
const PERMS: [PermissionMode, string][] = [['default', 'Hỏi trước khi sửa file'], ['acceptEdits', 'Tự sửa file (xem diff sau)'], ['plan', 'Chỉ lập kế hoạch, không sửa']];
const PSTATUS: Record<string, string> = { planning: 'running', critiquing: 'running', review: 'waiting', running: 'running', paused: 'waiting', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
const PLABEL: Record<string, string> = { planning: 'Đang lập kế hoạch', critiquing: 'Đang phản biện', review: 'Chờ duyệt', running: 'Đang chạy', paused: 'Tạm dừng', completed: 'Xong', failed: 'Lỗi', cancelled: 'Đã huỷ' };
const SLABEL: Record<string, string> = { pending: 'Chờ', running: 'Đang chạy', completed: 'Xong', failed: 'Lỗi', cancelled: 'Đã huỷ', skipped: 'Bỏ qua' };
const PBadge = ({ s }: { s: string }) => <span className="status" data-s={PSTATUS[s] ?? s}>{PLABEL[s] ?? s}</span>;
const SBadge = ({ s }: { s: string }) => <span className="status" data-s={s === 'pending' || s === 'skipped' ? 'unknown' : s}>{SLABEL[s] ?? s}</span>;

function usePipelines() {
  const list = useApi<Pipeline[]>('/api/pipelines');
  const { reload } = list;
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const s = live();
    const h = () => { if (t.current) return; t.current = setTimeout(() => { t.current = null; reload(); }, 150); };
    s.on('pipeline:upsert', h); s.on('connect', h);
    return () => { s.off('pipeline:upsert', h); s.off('connect', h); };
  }, [reload]);
  return list;
}

function CreateForm({ onCreated }: { onCreated: (id: string) => void }) {
  const settings = useApi<StudioSettings>('/api/settings');
  const [request, setRequest] = useState('');
  const [mode, setMode] = useState<PipelineMode>('auto');
  const [perm, setPerm] = useState<PermissionMode>('default');
  const [model, setModel] = useState('');
  const [critic, setCritic] = useState(true);
  const setup = useApi<PipelineSetup>('/api/pipelines/setup');
  const [rigor, setRigor] = useState<Rigor>('minimal');
  useEffect(() => { if (setup.data?.rigor) setRigor(setup.data.rigor); }, [setup.data]);
  const started = !!setup.data?.started;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (settings.data) setPerm(settings.data.taskDefaults.permissionMode); }, [settings.data]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const p = await api<Pipeline>('/api/pipelines', { method: 'POST', body: JSON.stringify({ request, mode, permissionMode: perm, model: model || null, rigor, critic }) });
      setRequest(''); onCreated(p.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="panel"><div className="panel-h"><h3>Yêu cầu mới</h3></div><div className="panel-b">
      {setup.data && !started && (
        <div className="field" style={{ border: '1px solid var(--warn, #c90)', borderRadius: 6, padding: 10 }}>
          <b>Bắt buộc chạy /start trước</b>
          <div className="small muted">project.yaml chưa có <code>modes.rigor</code>{setup.data.error ? ` (${setup.data.error})` : ''}. /start đọc project, hỏi bạn vài câu rồi lưu stage, rigor và mức tự động. Chạy xong quay lại đây rồi bấm Kiểm tra lại.</div>
          <div className="row" style={{ marginTop: 6 }}><Link className="btn sm primary" to="/tasks?skill=start">Chạy /start</Link><button className="btn sm" onClick={() => setup.reload()}>Kiểm tra lại</button></div>
        </div>)}
      {started && setup.data?.source === 'session' && <p className="small muted" style={{ marginTop: 0 }}>Đã chạy /start trong phiên nhưng không lưu project.yaml: rigor mặc định {setup.data?.rigor}, chọn lại bên dưới nếu cần.</p>}
      {started && setup.data?.source !== 'session' && <p className="small muted" style={{ marginTop: 0 }}>Đã chạy /start: stage {setup.data?.stage ?? 'Unknown'}, rigor {setup.data?.rigor}, tự động {setup.data?.automation ?? 'Unknown'}.</p>}
      <div className="field"><label htmlFor="pl-req">Bạn muốn làm gì?</label>
        <textarea id="pl-req" value={request} onChange={e => setRequest(e.target.value)} placeholder="Ví dụ: Tôi muốn tạo chức năng Lucky Spin: 1 lượt quay miễn phí mỗi ngày, thêm lượt qua quảng cáo" style={{ minHeight: 90 }} /></div>
      <div className="field"><label>Cách chạy</label>
        <div className="opt-list">{MODES.map(([v, l, d]) => (
          <label key={v} className="opt"><input type="radio" name="pl-mode" checked={mode === v} onChange={() => setMode(v)} /><div><b>{l}</b><div className="small muted">{d}</div></div></label>
        ))}</div></div>
      <div className="field"><label>Rigor (mức quy trình cho kế hoạch này)</label>
        <div className="opt-list">{RIGORS.map(([v, l, d]) => (
          <label key={v} className="opt"><input type="radio" name="pl-rigor" checked={rigor === v} onChange={() => setRigor(v)} /><div><b>{l}{setup.data?.rigor === v ? (setup.data?.source === 'session' ? ' (mặc định)' : ' (theo project.yaml)') : ''}</b><div className="small muted">{d}</div></div></label>
        ))}</div>
        {setup.data?.rigor && rigor !== setup.data.rigor && <div className="small muted">Chỉ áp dụng cho kế hoạch này, không ghi vào project.yaml. Đổi hẳn thì dùng /settings.</div>}</div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: 1, minWidth: 160 }}><label htmlFor="pl-perm">Quyền khi chạy các bước</label>
          <select id="pl-perm" value={perm} onChange={e => setPerm(e.target.value as PermissionMode)}>{PERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field" style={{ flex: 1, minWidth: 120 }}><label htmlFor="pl-model">Model</label>
          <select id="pl-model" value={model} onChange={e => setModel(e.target.value)}>
            <option value="">Theo cài đặt</option><option value="opus">opus</option><option value="sonnet">sonnet</option><option value="haiku">haiku</option></select></div>
      </div>
      <label className="opt" style={{ marginBottom: 8 }}><input type="checkbox" checked={critic} onChange={e => setCritic(e.target.checked)} /><div><b>Phản biện kế hoạch</b><div className="small muted">Soát kế hoạch theo góc nhìn producer (chỉ đọc). Nếu thấy lỗi, planner sửa lại, tối đa 2 lần. Tốn thêm token.</div></div></label>
      <p className="small muted" style={{ marginTop: 0 }}>Bước đầu Claude chỉ đọc project để lập kế hoạch, không sửa file. Bạn xem và sửa kế hoạch trước khi chạy.</p>
      <div className="row"><button className="btn primary" disabled={busy || !request.trim() || !started} onClick={submit}>Lập kế hoạch</button>{err && <span className="badge-err">{err}</span>}</div>
    </div></div>
  );
}

type Draft = Pick<PipelineStep, 'title' | 'skill' | 'args' | 'prompt' | 'why'> & { id?: string; expand: PipelineStep['expand'] };

function StepEditor({ d, skills, onChange, onDelete, onUp, onDown }: {
  d: Draft; skills: Pick<Skill, 'name' | 'argumentHint'>[]; onChange: (d: Draft) => void; onDelete: () => void; onUp?: () => void; onDown?: () => void;
}) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <input type="text" value={d.title} onChange={e => onChange({ ...d, title: e.target.value })} aria-label="Tên bước" style={{ flex: 2, minWidth: 160 }} />
        <select value={d.skill ?? ''} onChange={e => onChange({ ...d, skill: e.target.value || null, prompt: e.target.value ? null : d.prompt ?? '' })} aria-label="Skill" style={{ flex: 1, minWidth: 150 }}>
          <option value="">Prompt tự do</option>
          {d.skill && !skills.some(s => s.name === d.skill) && <option value={d.skill}>/{d.skill} (không có)</option>}
          {skills.map(s => <option key={s.name} value={s.name}>/{s.name}</option>)}
        </select>
        <button className="btn sm" disabled={!onUp} onClick={onUp} aria-label="Đưa lên">Lên</button>
        <button className="btn sm" disabled={!onDown} onClick={onDown} aria-label="Đưa xuống">Xuống</button>
        <button className="btn sm danger" onClick={onDelete}>Xoá</button>
      </div>
      {d.skill
        ? <input type="text" value={d.args ?? ''} onChange={e => onChange({ ...d, args: e.target.value || null })} placeholder={skills.find(s => s.name === d.skill)?.argumentHint ?? 'Tham số (không bắt buộc)'} aria-label="Tham số" />
        : <textarea value={d.prompt ?? ''} onChange={e => onChange({ ...d, prompt: e.target.value })} placeholder="Prompt cho bước này" style={{ minHeight: 50 }} aria-label="Prompt" />}
    </div>
  );
}

function Detail({ p }: { p: Pipeline }) {
  const skills = useApi<Skill[]>('/api/skills', ['skills']);
  const { tasks, inter } = useTaskData();
  const usage = useApi<SessionUsage>(p.sessionId ? `/api/sessions/${encodeURIComponent(p.sessionId)}/usage` : null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [mode, setMode] = useState(p.mode);
  const [perm, setPerm] = useState(p.permissionMode);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = ['review', 'paused', 'failed'].includes(p.status) && p.steps.length > 0;
  const pending = p.steps.filter(s => s.status === 'pending');
  const revising = p.status === 'planning' && p.steps.length > 0;
  const ran = p.steps.some(s => s.status !== 'pending');
  const stopped = ['review', 'paused', 'failed'].includes(p.status);
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [fixNote, setFixNote] = useState('');
  const lastCrit = p.critiques?.[p.critiques.length - 1];
  const opinions = (lastCrit && !lastCrit.error ? lastCrit.issues.length : 0) + (p.issues ?? []).filter(i => i.level !== 'info').length;
  const canRevise = p.status === 'review' && !ran && !!p.sessionId && pending.length > 0;
  useEffect(() => { setDrafts(null); setMode(p.mode); setPerm(p.permissionMode); }, [p.id, p.status, p.mode, p.permissionMode]);
  const { reload: reloadUsage } = usage;
  useEffect(() => { reloadUsage(); }, [p.steps.map(s => s.status).join(), reloadUsage]);

  const runningTask = p.status === 'planning' ? p.planTaskId : p.status === 'critiquing' ? p.critiqueTaskId ?? null : p.steps.find(s => s.status === 'running')?.taskId ?? null;
  const asks = (inter.data ?? []).filter(i => i.taskId === runningTask);
  const taskOf = (id: string | null) => (id ? (tasks.data ?? []).find(t => t.id === id) : undefined);
  const extra = [...new Set([p.planTaskId, ...(p.planTasks ?? []), ...(p.critiques ?? []).flatMap(c => [c.planTaskId, c.taskId])])];
  const cost = p.steps.map(s => taskOf(s.taskId)?.costUsd).concat(extra.map(id => taskOf(id)?.costUsd))
    .filter((x): x is number => typeof x === 'number');
  const refresh = () => { tasks.reload(); inter.reload(); };

  const call = async (path: string, body?: unknown, method = 'POST') => {
    setBusy(true); setErr(null);
    try { await api(`/api/pipelines/${p.id}${path}`, { method, body: body ? JSON.stringify(body) : undefined }); setDrafts(null); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const editing = drafts ?? pending.map(s => ({ id: s.id, title: s.title, skill: s.skill, args: s.args, prompt: s.prompt, why: s.why, expand: s.expand }));
  const dirty = drafts !== null || mode !== p.mode || perm !== p.permissionMode;
  const setAt = (i: number, d: Draft) => setDrafts(editing.map((x, k) => (k === i ? d : x)));
  const move = (i: number, j: number) => { const xs = editing.slice(); [xs[i], xs[j]] = [xs[j], xs[i]]; setDrafts(xs); };
  const save = () => call('/steps', { steps: editing, mode, permissionMode: perm }, 'PUT');
  const revise = async () => {
    if (dirty) await call('/steps', { steps: editing, mode, permissionMode: perm }, 'PUT');
    await call('/revise', { note: fixNote.trim() || null }); setFixNote('');
  };
  const startNow = async () => { if (dirty) await call('/steps', { steps: editing, mode, permissionMode: perm }, 'PUT'); await call('/start'); };
  const studio = useApi<{ name: string; description: string; argumentHint: string | null }[]>('/api/pipelines/studio-skills');
  const allSkills = [...(studio.data ?? []), ...(skills.data ?? []).filter(s => s.hasSkillMd && s.userInvocable !== false)] as Pick<Skill, 'name' | 'argumentHint'>[];

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-h"><div><div className="muted small">{when(p.createdAt)} · {MODES.find(m => m[0] === p.mode)?.[1]} · {PERMS.find(m => m[0] === p.permissionMode)?.[1]}{p.model ? ` · ${p.model}` : ''}</div>
          <h3 style={{ whiteSpace: 'pre-wrap' }}>{p.request}</h3></div><span>{p.rigor && <span className="tag">rigor {p.rigor}</span>} <PBadge s={p.status} /></span></div>
        <div className="panel-b stack">
          {p.summary && <div>{p.summary}</div>}
          {p.note && <div className="small">{p.note}</div>}
          {p.error && <div className="badge-err">{p.error}</div>}
          {err && <div className="badge-err">{err}</div>}
          <PlanCheck p={p} />
          <Critique p={p} />
          {canRevise && <details open={opinions > 0}><summary className="small">Sửa theo phản biện{opinions ? ` (${opinions} ý kiến)` : ''}</summary>
            <div className="row" style={{ marginTop: 6 }}><input type="text" value={fixNote} onChange={e => setFixNote(e.target.value)} placeholder='Quyết định của bạn, vd: "Rigor giữ minimal. Nút dùng chữ Claim."' aria-label="Ghi chú sửa theo phản biện" style={{ flex: 1, minWidth: 160 }} />
              <button className="btn sm" disabled={busy || (!opinions && !fixNote.trim())} onClick={revise}>Sửa theo phản biện</button></div>
            <div className="small muted">Planner (cùng session đã lập kế hoạch) sửa theo mọi lỗi và cảnh báo ở trên, cộng ghi chú của bạn, giữ các bước bạn đã sửa tay; rồi phản biện lại. Việc cần bạn quyết mà ghi chú chưa có sẽ hiện "CẦN QUYẾT" ở bước đó.</div></details>}
          {asks.map(it => it.kind === 'question' ? <QuestionBox key={it.id} it={it} onDone={refresh} /> : <PermissionBox key={it.id} it={it} onDone={refresh} />)}
          {p.status === 'planning' && !asks.length && <div className="muted">{p.replanning ? 'Claude đang lập lại kế hoạch cho các bước còn lại…' : revising ? 'Planner đang sửa kế hoạch theo phản biện…' : 'Claude đang đọc project để lập kế hoạch…'} <Link to="/tasks">xem ở Task Center</Link></div>}
          {p.checkpoint && stopped && <div className="stack" style={{ gap: 6, border: '1px solid var(--line)', borderRadius: 6, padding: 10 }}>
            <div className="small"><b>Điểm kiểm tra</b>{p.checkpoint.verdict && <span className="tag" style={{ marginLeft: 6 }}>{p.checkpoint.verdict}</span>} {p.checkpoint.reason}</div>
            {p.checkpoint.question && <>
              <div className="small">Claude hỏi: <i>{p.checkpoint.question}</i></div>
              <div className="row"><input type="text" value={answer} onChange={e => setAnswer(e.target.value)} placeholder="Câu trả lời của bạn" aria-label="Trả lời Claude" style={{ flex: 1, minWidth: 160 }} />
                <button className="btn sm primary" disabled={busy || !answer.trim()} onClick={async () => { await call('/answer', { text: answer }); setAnswer(''); }}>Trả lời và chạy tiếp</button></div></>}
            {p.checkpoint.replan && <div className="small muted">Kết quả lệch kế hoạch: nên lập lại kế hoạch cho các bước còn lại.</div>}
          </div>}
          {stopped && ran && <details open={!!p.checkpoint?.replan}><summary className="small">Lập lại kế hoạch cho các bước còn lại</summary>
            <div className="row" style={{ marginTop: 6 }}><input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Ghi chú cho Claude (không bắt buộc)" aria-label="Ghi chú lập lại kế hoạch" style={{ flex: 1, minWidth: 160 }} />
              <button className="btn sm" disabled={busy} onClick={async () => { await call('/replan', { note: note.trim() || null }); setNote(''); }}>Lập lại kế hoạch</button></div>
            <div className="small muted">Các bước đã chạy giữ nguyên; Claude (trong session đang làm) chỉ thay các bước còn chờ, rồi kiểm luật và phản biện lại.</div></details>}
          {p.status === 'critiquing' && !asks.length && <div className="muted">Đang soát kế hoạch (vòng {p.critiques?.length ?? 1})… <Link to="/tasks">xem ở Task Center</Link></div>}
          <div className="row small muted">
            {p.sessionId && <><Link to={`/live?s=${p.sessionId}`}>Session</Link><Link to={`/timeline?s=${p.sessionId}`}>Timeline</Link><Link to={`/agent-monitor?s=${p.sessionId}`}>Agent</Link></>}
            <span>Token: {usage.data ? fmtNum(totalTok(usage.data.total)) : 'Unknown'}</span>
            <span>Chi phí ước tính: {cost.length ? fmtUsd(cost.reduce((a, b) => a + b, 0)) : 'Unknown'}</span>
          </div>
          <div className="row">
            {['review', 'paused', 'failed'].includes(p.status) && pending.length > 0 &&
              <button className="btn primary" disabled={busy} onClick={startNow}>{p.status === 'review' ? 'Duyệt và chạy' : 'Tiếp tục'}</button>}
            {editable && dirty && <button className="btn" disabled={busy} onClick={save}>Lưu kế hoạch</button>}
            {(p.status === 'critiquing' || revising) && <button className="btn" disabled={busy} onClick={() => call('/skip-critique')}>{revising ? 'Dừng, giữ kế hoạch cũ' : 'Bỏ qua phản biện'}</button>}
            {!['completed', 'cancelled'].includes(p.status) && <button className="btn danger" disabled={busy} onClick={() => call('/cancel')}>Huỷ chuỗi</button>}
          </div>
        </div>
      </div>

      {p.steps.length > 0 && <div className="panel"><div className="panel-h"><h3>Các bước ({p.steps.length})</h3>
        {editable && <div className="row">
          <select value={mode} onChange={e => setMode(e.target.value as PipelineMode)} aria-label="Cách chạy" style={{ width: 'auto' }}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select value={perm} onChange={e => setPerm(e.target.value as PermissionMode)} aria-label="Quyền" style={{ width: 'auto' }}>{PERMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>}</div>
        <ol className="steps" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {p.steps.filter(s => s.status !== 'pending' || !editable).map(s => {
            const t = taskOf(s.taskId);
            return (
              <li key={s.id} style={{ display: 'block', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div><b>{s.title}</b> <code className="small">{s.skill ? `/${s.skill}${s.args ? ' ' + s.args : ''}` : (s.prompt ?? '').slice(0, 80)}</code>
                    {s.generated && <span className="tag" style={{ marginLeft: 6 }}>{s.fixOf ? 'điểm kiểm tra thêm' : 'tự thêm'}</span>}{s.expand && <span className="tag" style={{ marginLeft: 6 }}>sinh bước story</span>}</div>
                  <div className="row">{t && <Status s={t.status} />}{!t && <SBadge s={s.status} />}
                    {['failed', 'cancelled'].includes(s.status) && p.status !== 'cancelled' && <>
                      <button className="btn sm" disabled={busy} onClick={() => call(`/steps/${s.id}/retry`)}>Chạy lại</button>
                      <button className="btn sm" disabled={busy || p.status === 'running'} onClick={() => call(`/steps/${s.id}/skip`)}>Bỏ qua</button></>}</div>
                </div>
                {s.why && <div className="small muted">{s.why}</div>}
                {s.check && s.status !== 'running' && <div className={s.check.decision === 'pause' ? 'badge-err' : 'small muted'}>
                  Điểm kiểm tra: {s.check.decision === 'continue' ? 'chạy tiếp' : s.check.decision === 'fix' ? 'tự chèn bước sửa' : 'dừng'} · {s.check.reason}</div>}
                {s.warning && <div className="badge-err">{s.warning}</div>}
                {t?.resultText && s.status !== 'running' && <details><summary className="small">Kết quả</summary><pre className="md small">{t.resultText}</pre>
                  {t.changedFiles?.length ? <div className="small">File đã đổi: {t.changedFiles.map(f => <span key={f.path} style={{ marginRight: 6 }}><code>{f.path}</code>{f.change !== 'D' && /^prototypes\/.+\.html?$/i.test(f.path) && <> <a className="btn sm primary" href={`/preview/${f.path.split('/').slice(1).map(encodeURIComponent).join('/')}`} target="_blank" rel="noopener">Mở prototype</a></>}</span>)}</div> : null}</details>}
              </li>
            );
          })}
          {editable && editing.map((d, i) => {
            const orig = pending.find(s => s.id === d.id);
            return (
              <li key={d.id ?? `new-${i}`} style={{ display: 'block', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <StepEditor d={d} skills={allSkills} onChange={x => setAt(i, x)} onDelete={() => setDrafts(editing.filter((_, k) => k !== i))}
                  onUp={i > 0 ? () => move(i, i - 1) : undefined} onDown={i < editing.length - 1 ? () => move(i, i + 1) : undefined} />
                {d.why && <div className="small muted" style={{ marginTop: 4 }}>{d.why}</div>}
                {orig?.warning && !drafts && <div className="badge-err">{orig.warning}</div>}
                {d.expand && <div className="small muted">Sau bước này Studio tự thêm /dev-story và /story-done cho từng story được tạo.</div>}
              </li>
            );
          })}
        </ol>
        {editable && <div className="panel-b"><button className="btn sm" onClick={() => setDrafts([...editing, { title: 'Bước mới', skill: null, args: null, prompt: '', why: null, expand: null }])}>Thêm bước</button></div>}
      </div>}
    </div>
  );
}

const ISSUE: Record<PlanIssue['level'], [string, string]> = { error: ['✕', 'Lỗi (chặn chạy)'], warn: ['!', 'Cảnh báo'], info: ['i', 'Ghi chú'] };
/** Plan standard: the template the planner chose and what the server check found (plan-rules.ts). */
function PlanCheck({ p }: { p: Pipeline }) {
  if (!p.planType && !p.issues?.length && !p.omitted?.length) return null;
  const titleOf = (id: string | null) => p.steps.find(s => s.id === id)?.title;
  const order: PlanIssue['level'][] = ['error', 'warn', 'info'];
  const issues = [...(p.issues ?? [])].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row small">
        <span className="tag">mẫu: {p.planTypeTitle ?? p.planType ?? 'Unknown'}</span>
        <span className="tag">slug: {p.slug ?? 'Unknown'}</span>
        {p.edited && <span className="tag">bạn đã sửa tay</span>}
        {!issues.length && <span className="muted">Đạt chuẩn mẫu.</span>}
      </div>
      {issues.length > 0 && <ul className="checks">{issues.map((i, k) => (
        <li key={k}><span className={`mark ${i.level === 'error' ? 'bad' : i.level === 'info' ? 'ok' : ''}`} title={ISSUE[i.level][1]}>{ISSUE[i.level][0]}</span>
          <div className={i.level === 'error' ? 'badge-err' : 'small'}>{i.message}{i.stepId && titleOf(i.stepId) ? <span className="muted"> · bước "{titleOf(i.stepId)}"</span> : null}</div></li>
      ))}</ul>}
      {!!p.omitted?.length && <div className="small muted">Bước mẫu planner bỏ: {p.omitted.map(o => `/${o.skill} (${o.why})`).join('; ')}</div>}
    </div>
  );
}

/** Critic loop (P2): one row per round; opinions only, the run is never blocked by them. */
function Critique({ p }: { p: Pipeline }) {
  const rounds = p.critiques ?? [];
  if (!rounds.length) return null;
  const head = (c: CritiqueRound) => {
    if (c.error) return c.error;
    if (c.ok === null) return 'Đang soát…';
    const e = c.issues.filter(i => i.level === 'error').length, w = c.issues.length - e;
    const res = c.ok && !c.issues.length ? 'Không thấy vấn đề.' : `${e} lỗi, ${w} cảnh báo.`;
    return c.revised ? `${res} ${c.revisedBy === 'user' ? 'Đã gửi planner sửa theo yêu cầu của bạn.' : 'Đã gửi planner sửa.'}` : res;
  };
  const last = rounds.length - 1;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="small"><b>Phản biện (producer)</b> <span className="muted">· ý kiến tham khảo, không chặn chạy</span></div>
      {rounds.map((c, k) => (
        <details key={k} open={k === last && c.issues.length > 0}>
          <summary className="small">Vòng {c.round}: {head(c)}</summary>
          {c.issues.length > 0 && <ul className="checks">{c.issues.map((i, n) => (
            <li key={n}><span className={`mark ${i.level === 'error' ? 'bad' : ''}`} title={i.level === 'error' ? 'Lỗi' : 'Cảnh báo'}>{i.level === 'error' ? '✕' : '!'}</span>
              <div className="small">{i.message}{i.stepTitle ? <span className="muted"> · bước "{i.stepTitle}"</span> : null}</div></li>
          ))}</ul>}
        </details>
      ))}
    </div>
  );
}

export function Pipelines() {
  const list = usePipelines();
  const [sp, setSp] = useSearchParams();
  const sel = sp.get('p') ?? list.data?.[0]?.id ?? null;
  const cur = list.data?.find(p => p.id === sel) ?? null;
  const pick = (id: string) => setSp({ p: id }, { replace: true });
  return (
    <>
      <div className="view-head"><div><h1>Lập kế hoạch tính năng</h1><p>Nhập một yêu cầu; Claude chia thành các bước dùng skill của project. Bạn duyệt, Studio tự chạy lần lượt trong cùng một session.</p></div></div>
      <div className="grid2" style={{ gridTemplateColumns: 'minmax(300px, 380px) 1fr' }}>
        <div className="stack">
          <CreateForm onCreated={id => { list.reload(); pick(id); }} />
          <div className="panel"><div className="panel-h"><h3>Các chuỗi</h3></div>
            {list.data?.length ? <div className="list-scroll" role="listbox" aria-label="Các chuỗi">{list.data.map(p => (
              <button key={p.id} className="item" role="option" aria-selected={p.id === sel} onClick={() => pick(p.id)}>
                <b>{p.request.length > 60 ? p.request.slice(0, 60) + '…' : p.request}</b>
                <span><PBadge s={p.status} /> {p.steps.filter(s => s.status === 'completed').length}/{p.steps.length} bước · {when(p.createdAt)}</span>
              </button>
            ))}</div> : <div className="empty">{list.error ?? 'Chưa có chuỗi nào.'}</div>}
          </div>
        </div>
        {cur ? <Detail p={cur} /> : <div className="panel"><div className="empty">Nhập yêu cầu bên trái để bắt đầu.</div></div>}
      </div>
    </>
  );
}
