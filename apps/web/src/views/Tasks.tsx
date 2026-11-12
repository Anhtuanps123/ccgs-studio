// T-TC-01..05, T-SK-03: create, queue, stop, answer, results.
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { NewTask, PendingInteraction, PermissionMode, QuestionSpec, SessionUsage, Skill, StudioSettings, Task, TaskDiff, TaskOutput, TaskOutputFormat, TaskRemoveResult } from '@ccgs/shared';
import { api, live, useApi } from '../api';
import { Duration, Status, when } from '../monitor';
import { DiffView, UsageTable, fmtUsd, parseGitDiff } from '../insights';
import { AttachBar, AttachList, useAttachments } from '../attachments';

/** Refetch (throttled) on any task / interaction event. */
export function useTaskData() {
  const tasks = useApi<Task[]>('/api/tasks');
  const inter = useApi<PendingInteraction[]>('/api/interactions');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { reload: r1 } = tasks, { reload: r2 } = inter;
  useEffect(() => {
    const s = live();
    const h = () => {
      if (timer.current) return;
      timer.current = setTimeout(() => { timer.current = null; r1(); r2(); }, 150);
    };
    const evs = ['task:upsert', 'task:delete', 'interaction:new', 'interaction:resolved', 'connect'];
    evs.forEach(e => s.on(e, h));
    return () => { evs.forEach(e => s.off(e, h)); if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [r1, r2]);
  return { tasks, inter };
}

const title = (t: Task) => (t.kind === 'skill' ? t.prompt : t.prompt.length > 90 ? t.prompt.slice(0, 90) + '…' : t.prompt);
const MODES: [PermissionMode, string][] = [['default', 'Hỏi trước khi sửa'], ['acceptEdits', 'Tự sửa file'], ['plan', 'Chỉ lập kế hoạch']];
const CHANGE: Record<string, string> = { A: 'Tạo', M: 'Sửa', D: 'Xoá', R: 'Đổi tên' };
/** A question that asks to approve content (then the content should have been written before it). */
const APPROVE_RE = /đúng chưa|ổn chưa|được chưa|duyệt|phê duyệt|approve|look(s)? (good|right)|is (this|it|the .+) (right|correct|ok)/i;

export function QuestionBox({ it, onDone }: { it: PendingInteraction; onDone: () => void }) {
  const qs = it.question?.questions ?? [];
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const OTHER = '\u0000other';

  const toggle = (q: QuestionSpec, label: string) => setSel(s => {
    const cur = s[q.question] ?? [];
    return { ...s, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : [label] };
  });
  const send = async () => {
    const answers: Record<string, string> = {};
    for (const q of qs) {
      const picked = (sel[q.question] ?? []).map(l => (l === OTHER ? (other[q.question] ?? '').trim() : l)).filter(Boolean);
      if (!picked.length) { setErr(`Chưa trả lời: ${q.question}`); return; }
      answers[q.question] = picked.join(', ');
    }
    setBusy(true); setErr(null);
    try { await api(`/api/interactions/${it.id}/answer`, { method: 'POST', body: JSON.stringify({ answers }) }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const draft = it.context?.trim() ?? '';
  // Claude asks to approve something it never showed (it.context === "" means it wrote nothing since its last question).
  const noDraft = it.context !== undefined && !draft && qs.some(q => APPROVE_RE.test(`${q.question} ${q.header ?? ''}`));

  return (
    <div className="question stack">
      {draft && (
        <details open={draft.length <= 3000}>
          <summary className="small"><b>Claude viết trước câu hỏi</b> (bản nháp cần duyệt){draft.length > 3000 ? ', bấm để mở' : ''}</summary>
          <pre className="md" style={{ marginTop: 8, maxHeight: 420, overflowY: 'auto' }}>{draft}</pre>
        </details>
      )}
      {noDraft && <div className="badge-err" style={{ alignSelf: 'flex-start' }}>Claude chưa đưa bản nháp trước câu hỏi này. Chọn "Câu trả lời khác" và nhờ Claude in bản nháp ra rồi hỏi lại.</div>}
      {qs.map(q => (
        <div key={q.question} className="stack" style={{ gap: 8 }}>
          <h3 style={{ margin: 0, whiteSpace: 'pre-wrap' }}>Claude hỏi: {q.question}</h3>
          {q.header && <div className="muted small">{q.header}{q.multiSelect ? ', chọn được nhiều' : ''}</div>}
          <div className="opt-list">
            {q.options.map(o => (
              <label key={o.label} className="opt">
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${it.id}-${q.question}`} checked={(sel[q.question] ?? []).includes(o.label)} onChange={() => toggle(q, o.label)} />
                <div><b>{o.label}</b>{o.description && <div className="small muted">{o.description}</div>}</div>
              </label>
            ))}
            <label className="opt">
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${it.id}-${q.question}`} checked={(sel[q.question] ?? []).includes(OTHER)} onChange={() => toggle(q, OTHER)} />
              <div style={{ flex: 1 }}><b>Câu trả lời khác</b>
                <input type="text" placeholder="Nhập câu trả lời" style={{ marginTop: 6 }} value={other[q.question] ?? ''}
                  onChange={e => { setOther(o => ({ ...o, [q.question]: e.target.value })); if (!(sel[q.question] ?? []).includes(OTHER)) toggle(q, OTHER); }} /></div>
            </label>
          </div>
        </div>
      ))}
      <div className="row"><button className="btn primary" onClick={send} disabled={busy}>Gửi câu trả lời</button>{err && <span className="badge-err">{err}</span>}</div>
    </div>
  );
}

export function PermissionBox({ it, onDone }: { it: PendingInteraction; onDone: () => void }) {
  const p = it.permission!;
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'allow' | 'deny', always = false) => {
    setBusy(true); setErr(null);
    try { await api(`/api/interactions/${it.id}/decision`, { method: 'POST', body: JSON.stringify({ decision, message: msg || undefined, ...(always ? { always: true } : {}) }) }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="question stack" style={{ borderColor: 'var(--accent)' }}>
      <h3 style={{ margin: 0 }}>{p.title ?? `Claude xin quyền dùng ${p.toolName}`}</h3>
      <div className="muted small">{it.agentInvocationId ? 'Subagent' : 'Main session'}{p.decisionReason ? `. Lý do hỏi: ${p.decisionReason}` : ''}</div>
      <pre className="md" style={{ margin: 0 }}><b>{p.toolName}</b> {p.inputSummary}</pre>
      {p.blockedPath && <div className="small">Đường dẫn: <code>{p.blockedPath}</code></div>}
      <input type="text" placeholder="Lời nhắn cho Claude khi từ chối (tuỳ chọn)" value={msg} onChange={e => setMsg(e.target.value)} />
      <div className="row">
        <button className="btn primary" onClick={() => decide('allow')} disabled={busy}>Cho phép</button>
        <button className="btn" onClick={() => decide('allow', true)} disabled={busy} title={`Ghi nhớ trong Cài đặt > Quyền công cụ: từ giờ ${p.toolName} chạy luôn, không hỏi lại`}>Luôn cho phép {p.toolName}</button>
        <button className="btn" onClick={() => decide('deny')} disabled={busy}>Từ chối</button>
        {err && <span className="badge-err">{err}</span>}
      </div>
    </div>
  );
}

/** T-TC-06 */
function TaskDiffs({ t }: { t: Task }) {
  const d = useApi<{ baseRef: string | null; files: TaskDiff[] }>(`/api/tasks/${t.id}/diff`);
  const [open, setOpen] = useState<string | null>(null);
  if (!d.data) return <div className="small muted">{d.error ?? 'Đang tải diff…'}</div>;
  if (!d.data.files.length) return <div className="small muted">Không có diff (task không đổi file, hoặc chạy trước khi Studio lưu diff).</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="small muted">So với trạng thái thư mục ngay trước khi task chạy{d.data.baseRef ? <> (commit tạm <code>{d.data.baseRef.slice(0, 10)}</code>)</> : ''}.</div>
      {d.data.files.map(f => (
        <div key={f.path}>
          <button className="btn sm" onClick={() => setOpen(open === f.path ? null : f.path)} aria-expanded={open === f.path}>
            <span className="tag">{CHANGE[f.change]}</span> <code>{f.path}</code></button>
          {open === f.path && <div style={{ marginTop: 6 }}>
            {f.note && <div className="small muted">{f.note}</div>}
            {f.diff ? <DiffView lines={parseGitDiff(f.diff)} /> : !f.note && <div className="small muted">Unknown</div>}
          </div>}
        </div>
      ))}
    </div>
  );
}

const OUT_KIND: Record<TaskOutput['kind'], string> = { web: 'Web', doc: 'Tài liệu', image: 'Ảnh', data: 'Dữ liệu', other: 'File' };
const OUT_FMT: [TaskOutputFormat, string, string][] = [
  ['web', 'Trang web (HTML)', 'Claude viết thêm 1 trang HTML tự chạy: prototype chơi được, hoặc trình bày thiết kế dễ đọc.'],
  ['xlsx', 'Excel', 'Claude ghi kết quả thành các bảng; Studio dựng file .xlsx khi task xong.'],
  ['csv', 'CSV', 'Claude ghi mỗi bảng thành 1 file .csv.'],
];
/** "Đầu ra" select of the create and resume forms. Files go to a Studio folder, not into the game project. */
function OutputSelect({ id, value, onChange }: { id: string; value: TaskOutputFormat | ''; onChange: (v: TaskOutputFormat | '') => void }) {
  return (
    <div className="field" style={{ marginBottom: 0 }}><label htmlFor={id}>Đầu ra</label>
      <select id={id} value={value} onChange={e => onChange(e.target.value as TaskOutputFormat | '')}>
        <option value="">Không thêm (chỉ file task tự tạo)</option>
        {OUT_FMT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {value && <div className="small muted" style={{ marginTop: 4 }}>{OUT_FMT.find(f => f[0] === value)?.[2]} Tốn thêm token cho phần này. File nằm ở thư mục riêng của Studio, xem ở tab Đầu ra.</div>}
    </div>
  );
}
const fmtSize = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Đầu ra (api-contract §15): open HTML in Studio, export .md to Excel or CSV, view or save the rest. No Claude call. */
function TaskOutputs({ t }: { t: Task }) {
  const d = useApi<TaskOutput[]>(`/api/tasks/${t.id}/outputs`);
  const [view, setView] = useState<string | null>(null);
  if (!d.data) return <div className="small muted">{d.error ?? 'Đang tải…'}</div>;
  if (!d.data.length) return <div className="small muted">{t.output && (t.status === 'running' || t.status === 'queued' || t.status === 'waiting') ? 'Task chưa xong, đầu ra sẽ hiện ở đây.'
    : t.changedFiles === null ? 'Unknown (project không phải git repo, Studio không biết task đã tạo file nào).'
    : t.output ? 'Claude chưa ghi file đầu ra nào. Xem Phản hồi cuối, hoặc tiếp tục session và nhắc lại.' : 'Task không tạo hay sửa file nào. Lần sau chọn "Đầu ra" khi tạo task để có trang web, Excel hoặc CSV.'}</div>;
  const base = `/api/tasks/${t.id}/outputs`;
  const raw = (p: string) => `${base}/raw/${p.split('/').map(encodeURIComponent).join('/')}`;
  const exp = (p: string, f: 'xlsx' | 'csv') => `${base}/export?path=${encodeURIComponent(p)}&format=${f}`;
  const order: TaskOutput['kind'][] = ['web', 'doc', 'image', 'data', 'other'];
  const mine = (o: TaskOutput) => o.path.startsWith('~studio/');
  const items = [...d.data].sort((a, b) => Number(mine(b)) - Number(mine(a)) || order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">File task đã tạo hoặc sửa. Xuất Excel/CSV do Studio tự chuyển từ file .md, không gọi Claude. Sửa trong Excel không cập nhật lại file .md.</div>
      {items.map(o => {
        const url = o.preview ?? raw(o.path);
        return (
          <div key={o.path} className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="tag">{OUT_KIND[o.kind]}</span>{mine(o) && <span className="tag" title="Đầu ra bạn chọn khi tạo task; nằm ở thư mục riêng của Studio, không trong project">Đầu ra đã chọn</span>}
              <code className="small">{mine(o) ? o.path.slice('~studio/'.length) : o.path}</code>
              <span className="small muted">{o.exists ? fmtSize(o.size) : 'không còn trên đĩa'}</span>
              {o.exists && <>
                {o.kind === 'web' && <button className="btn sm primary" onClick={() => setView(view === o.path ? null : o.path)} aria-expanded={view === o.path}>{view === o.path ? 'Đóng' : 'Xem trong Studio'}</button>}
                {o.kind === 'web' && <a className="btn sm" href={url} target="_blank" rel="noopener">Mở tab mới</a>}
                {o.kind === 'doc' && <a className="btn sm primary" href={exp(o.path, 'xlsx')} download>Xuất Excel</a>}
                {o.kind === 'doc' && (o.tables ? <a className="btn sm" href={exp(o.path, 'csv')} download>Xuất CSV ({o.tables} bảng)</a>
                  : <button className="btn sm" disabled title="File không có bảng nào; Xuất Excel lấy được cả phần chữ">Xuất CSV</button>)}
                {o.kind === 'image' && <button className="btn sm" onClick={() => setView(view === o.path ? null : o.path)} aria-expanded={view === o.path}>{view === o.path ? 'Đóng' : 'Xem'}</button>}
                {(o.kind === 'doc' || o.kind === 'data' || o.kind === 'other') && <a className="btn sm" href={raw(o.path)} target="_blank" rel="noopener">Xem</a>}
                <a className={`btn sm${o.kind === 'other' && /\.xlsx$/i.test(o.path) ? ' primary' : ''}`} href={`${raw(o.path)}?download=1`} download>Tải về</a>
              </>}
            </div>
            {view === o.path && o.kind === 'web' && <iframe title={o.path} src={url} sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock"
              style={{ width: '100%', height: 560, border: '1px solid var(--line)', borderRadius: 6, background: '#fff' }} />}
            {view === o.path && o.kind === 'image' && <img src={raw(o.path)} alt={o.path} style={{ maxWidth: '100%', maxHeight: 480, border: '1px solid var(--line)', borderRadius: 6, alignSelf: 'flex-start' }} />}
          </div>
        );
      })}
    </div>
  );
}

/** T-TC-07 */
function ResumeForm({ t, onDone }: { t: Task; onDone: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const att = useAttachments();
  const [output, setOutput] = useState<TaskOutputFormat | ''>('');
  if (!t.sessionId) return null;
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/api/tasks/${t.id}/resume`, { method: 'POST', body: JSON.stringify({ prompt: text, ...(att.ids.length ? { attachments: att.ids } : {}), ...(output ? { output } : {}) }) });
      setText(''); att.clear(); setOutput(''); onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 6 }} {...att.zone}>
      <label className="muted small" htmlFor={`res-${t.id}`}>Tiếp tục session này với prompt mới (task mới vào hàng đợi, Claude nhớ hội thoại cũ)</label>
      <textarea id={`res-${t.id}`} value={text} onChange={e => setText(e.target.value)} placeholder="Ví dụ: Sửa thêm phần test bị lỗi" style={{ minHeight: 60 }} />
      <AttachBar att={att} />
      <OutputSelect id={`res-out-${t.id}`} value={output} onChange={setOutput} />
      <div className="row"><button className="btn" disabled={busy || att.busy || !text.trim()} onClick={send}>Tiếp tục session</button>{err && <span className="badge-err">{err}</span>}</div>
    </div>
  );
}

function TaskUsage({ t }: { t: Task }) {
  const u = useApi<SessionUsage | null>(t.sessionId ? `/api/tasks/${t.id}/usage` : null);
  if (!t.sessionId) return <div className="small muted">Unknown (task chưa có session)</div>;
  if (!u.data) return <div className="small muted">{u.error ?? 'Đang đọc transcript…'}</div>;
  return <UsageTable u={u.data} />;
}

/** Everything about a finished task: result, files, diff, tokens, resume. */
function TaskDetail({ t, onDone }: { t: Task; onDone: () => void }) {
  const [tab, setTab] = useState<'result' | 'outputs' | 'diff' | 'tokens'>(t.output ? 'outputs' : 'result');
  const outs = t.changedFiles?.filter(f => f.change !== 'D').length ?? 0;
  return (
    <div className="stack">
      <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
        {([['result', 'Kết quả'], ['outputs', `Đầu ra${t.output ? ` · ${OUT_FMT.find(f => f[0] === t.output)?.[1]}` : ''}${outs ? ` (${outs})` : ''}`], ['diff', `Diff${t.changedFiles?.length ? ` (${t.changedFiles.length})` : ''}`], ['tokens', 'Token']] as const).map(([k, l]) =>
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'result' && <Result t={t} />}
      {tab === 'outputs' && <TaskOutputs t={t} />}
      {tab === 'diff' && <TaskDiffs t={t} />}
      {tab === 'tokens' && <TaskUsage t={t} />}
      <ResumeForm t={t} onDone={onDone} />
    </div>
  );
}

function Result({ t }: { t: Task }) {
  return (
    <div className="stack">
      {t.error && <div className="badge-err">{t.error}</div>}
      <div className="small muted">Model {t.model ?? 'mặc định'} · Chi phí {fmtUsd(t.costUsd)}{t.costUsd !== null ? ' (ước tính theo giá niêm yết, do SDK báo)' : ''}{t.compactCostUsd != null ? ` · /compact trước task ${fmtUsd(t.compactCostUsd)}` : ''}{t.resumeOf ? ` · Tiếp tục session ${t.resumeOf.slice(0, 8)}` : ''}</div>
      <TaskCodeMap t={t} />
      {!!t.attachments?.length && <div><div className="muted small">Tệp đính kèm</div><AttachList items={t.attachments} /></div>}
      <div><div className="muted small">Phản hồi cuối</div><pre className="md" style={{ margin: '4px 0 0' }}>{t.resultText ?? (t.status === 'cancelled' ? 'Task bị dừng trước khi trả lời.' : 'Unknown')}</pre></div>
      <div><div className="muted small">File đã thay đổi</div>
        {t.changedFiles === null ? <div className="small">Unknown (project không phải git repo hoặc không đọc được git status)</div>
          : t.changedFiles.length ? <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {t.changedFiles.map(f => <li key={f.path}><span className="tag">{CHANGE[f.change]}</span> <code>{f.path}</code>
              {f.change !== 'D' && /^prototypes\/.+\.html?$/i.test(f.path) && <> <a className="btn sm primary" href={`/preview/${f.path.split('/').slice(1).map(encodeURIComponent).join('/')}`} target="_blank" rel="noopener">Mở prototype</a></>}</li>)}</ul>
            : <div className="small">Không có file nào thay đổi.</div>}
      </div>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [sp, setSp] = useSearchParams();
  const skills = useApi<Skill[]>('/api/skills', ['skills']);
  const [skill, setSkill] = useState(sp.get('skill') ?? '');
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<PermissionMode | ''>('');
  const [output, setOutput] = useState<TaskOutputFormat | ''>('');
  const settings = useApi<StudioSettings>('/api/settings');
  const def = settings.data?.taskDefaults;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const att = useAttachments();
  useEffect(() => { const s = sp.get('skill'); if (s) setSkill(s); }, [sp]);
  const hint = skills.data?.find(s => s.name === skill)?.argumentHint;

  const submit = async () => {
    // Empty choices are left out so the server applies the task defaults (S-03).
    const extra = { ...(model ? { model } : {}), ...(mode ? { permissionMode: mode } : {}), ...(att.ids.length ? { attachments: att.ids } : {}), ...(output ? { output } : {}) };
    const body: NewTask = skill ? { kind: 'skill', skill, args: text, ...extra } : { kind: 'prompt', prompt: text, ...extra };
    setBusy(true); setErr(null);
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      setText(''); att.clear();
      if (sp.get('skill')) setSp({});
      onCreated();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="panel"><div className="panel-h"><h3>Tạo task</h3></div><div className="panel-b">
      <div className="field"><label htmlFor="t-skill">Skill</label>
        <select id="t-skill" value={skill} onChange={e => setSkill(e.target.value)}>
          <option value="">Không dùng skill, chỉ prompt</option>
          {skill && !skills.data?.some(s => s.name === skill) && <option value={skill}>/{skill}</option>}
          {(skills.data ?? []).filter(s => s.origin === 'ccgs' && s.hasSkillMd && s.userInvocable !== false).map(s => <option key={s.dir} value={s.name}>/{s.name}</option>)}
        </select></div>
      <div className="field" {...att.zone}><label htmlFor="t-prompt">{skill ? 'Tham số' : 'Prompt'}</label>
        <textarea id="t-prompt" value={text} onChange={e => setText(e.target.value)} placeholder={skill ? hint ?? 'Không bắt buộc' : 'Ví dụ: Viết test cho hệ thống inventory'} />
        <AttachBar att={att} /></div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: 1, minWidth: 120 }}><label htmlFor="t-model">Model</label>
          <select id="t-model" value={model} onChange={e => setModel(e.target.value)}>
            <option value="">Theo cài đặt ({def?.model ?? 'mặc định của Claude Code'})</option><option value="opus">opus</option><option value="sonnet">sonnet</option><option value="haiku">haiku</option></select></div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}><label htmlFor="t-perm">Quyền</label>
          <select id="t-perm" value={mode} onChange={e => setMode(e.target.value as PermissionMode | '')}>
            <option value="">Theo cài đặt ({MODES.find(m => m[0] === (def?.permissionMode ?? 'default'))?.[1]})</option>
            {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      </div>
      <OutputSelect id="t-out" value={output} onChange={setOutput} />
      {def?.maxRuntimeMin && <p className="small muted" style={{ marginTop: 0 }}>Task chạy quá {def.maxRuntimeMin} phút sẽ bị dừng (đổi ở Cài đặt).</p>}
      <div className="row"><button className="btn primary" onClick={submit} disabled={busy || att.busy || (!skill && !text.trim())}>Thêm vào hàng đợi</button>{err && <span className="badge-err">{err}</span>}</div>
    </div></div>
  );
}

export function Tasks() {
  const { tasks, inter } = useTaskData();
  const [hist, setHist] = useState<'all' | 'completed' | 'failed' | 'cancelled'>('all');
  const [hq, setHq] = useState('');
  const [hSkill, setHSkill] = useState('');
  const [debq, setDebq] = useState('');
  useEffect(() => { const x = setTimeout(() => setDebq(hq), 250); return () => clearTimeout(x); }, [hq]);
  const history = useApi<Task[]>(`/api/tasks?status=${hist === 'all' ? 'completed,failed,cancelled' : hist}&q=${encodeURIComponent(debq)}&skill=${encodeURIComponent(hSkill)}`);
  const skillsUsed = [...new Set((tasks.data ?? []).map(t => t.skill).filter((x): x is string => !!x))];
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const all = tasks.data ?? [];
  const cur = all.find(t => t.status === 'running' || t.status === 'waiting') ?? null;
  const queue = all.filter(t => t.status === 'queued').sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const finished = all.filter(t => ['completed', 'failed', 'cancelled'].includes(t.status)).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  const done = (history.data ?? []).slice().sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  const { reload: reloadHistory } = history;
  const finKey = finished.map(t => t.id).join();
  useEffect(() => { reloadHistory(); }, [finKey, reloadHistory]);
  const mine = (inter.data ?? []).filter(i => cur && i.taskId === cur.id);
  const refresh = () => { tasks.reload(); inter.reload(); };
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; refresh(); } catch (e) { setErr((e as Error).message); } };
  const post = (path: string, body?: unknown, method = 'POST') => api(path, { method, body: body ? JSON.stringify(body) : undefined });
  const last = finished[0] && !cur ? finished[0] : null;
  // Xoá lịch sử (api-contract §13): the current filter, optionally only tasks older than N days.
  const [olderThan, setOlderThan] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const HIST_LABEL: Record<typeof hist, string> = { all: 'đã kết thúc', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
  const report = (r: TaskRemoveResult) => setMsg(`Đã xoá ${r.deleted.length} task.${r.kept.length ? ` Giữ ${r.kept.length} task vì ${r.kept[0].reason}${r.kept.length > 1 ? ' (và các chuỗi khác)' : ''}.` : ''}`);
  const clearHistory = async () => {
    const scope = [`mọi task ${HIST_LABEL[hist]}`, debq && `khớp "${debq}"`, hSkill && `của /${hSkill}`, olderThan && `kết thúc trước ${olderThan} ngày nay`].filter(Boolean).join(', ');
    if (!window.confirm(`Xoá ${scope} khỏi lịch sử?\nKhông khôi phục được. Task của chuỗi kế hoạch chưa xong được giữ lại. Dữ liệu Monitor, tệp đính kèm và file trong project không bị xoá.`)) return;
    setErr(null); setMsg(null);
    try {
      const before = olderThan ? new Date(Date.now() - olderThan * 86_400_000).toISOString() : undefined;
      report(await api<TaskRemoveResult>('/api/tasks/clear', { method: 'POST', body: JSON.stringify({ status: hist === 'all' ? undefined : hist, q: debq || undefined, skill: hSkill || undefined, before }) }));
      setOpen(null); refresh(); reloadHistory();
    } catch (e) { setErr((e as Error).message); }
  };
  const removeOne = async (t: Task) => {
    if (!window.confirm(`Xoá task ${t.id.slice(0, 8)} khỏi lịch sử?\nKhông khôi phục được. Dữ liệu Monitor và file trong project không bị xoá.`)) return;
    setErr(null); setMsg(null);
    try { report(await api<TaskRemoveResult>(`/api/tasks/${t.id}`, { method: 'DELETE' })); setOpen(null); refresh(); reloadHistory(); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <div className="view-head"><div><h1>Task Center</h1><p>Mỗi lần chỉ chạy một task. Task mới vào cuối hàng đợi.</p></div>{err && <span className="badge-err">{err}</span>}</div>
      <div className="grid2">
        <div className="stack">
          {cur ? (
            <div className="panel">
              <div className="panel-h"><div><div className="muted small">Đang chạy, {cur.id.slice(0, 8)}</div><h3>{title(cur)}</h3></div>
                <div className="row"><Status s={cur.status} /><button className="btn sm danger" onClick={() => act(post(`/api/tasks/${cur.id}/cancel`))}>Dừng task</button></div></div>
              <div className="panel-b stack">
                {mine.map(it => it.kind === 'question' ? <QuestionBox key={it.id} it={it} onDone={refresh} /> : <PermissionBox key={it.id} it={it} onDone={refresh} />)}
                {!mine.length && <p className="muted" style={{ margin: 0 }}>Không có câu hỏi nào đang chờ. Task đang chạy tiếp.</p>}
                <div className="row small muted">Đã chạy <Duration ms={null} start={cur.startedAt} status={cur.status} />. Model {cur.model ?? 'mặc định'}, quyền {MODES.find(m => m[0] === cur.permissionMode)?.[1]}.
                  {cur.sessionId && <Link to={`/live?s=${cur.sessionId}`}>Xem session trực tiếp</Link>}</div>
                {!!cur.attachments?.length && <AttachList items={cur.attachments} />}
              </div>
            </div>
          ) : <div className="panel"><div className="empty">Không có task đang chạy.</div></div>}

          {last && (
            <div className="panel"><div className="panel-h"><div><div className="muted small">Task vừa xong, {last.id.slice(0, 8)}</div><h3>{title(last)}</h3></div><Status s={last.status} /></div>
              <div className="panel-b"><TaskDetail t={last} onDone={refresh} /></div></div>
          )}

          <div className="panel"><div className="panel-h"><h3>Lịch sử</h3>
            <div className="chips">{([['all', 'Tất cả'], ['completed', 'Completed'], ['failed', 'Failed'], ['cancelled', 'Cancelled']] as const).map(([k, l]) =>
              <button key={k} className="chip" aria-pressed={k === hist} onClick={() => setHist(k)}>{l}</button>)}</div></div>
            <div className="panel-b row" style={{ borderBottom: '1px solid var(--line)' }}>
              <input type="search" placeholder="Tìm trong prompt, kết quả hoặc mã task" value={hq} onChange={e => setHq(e.target.value)} aria-label="Tìm task" style={{ flex: 1, minWidth: 180 }} />
              <select value={hSkill} onChange={e => setHSkill(e.target.value)} aria-label="Lọc theo skill" style={{ maxWidth: 200 }}>
                <option value="">Mọi skill</option>{skillsUsed.map(k => <option key={k} value={k}>/{k}</option>)}</select>
            </div>
            <div className="panel-b row" style={{ borderBottom: '1px solid var(--line)', gap: 8 }}>
              <select value={olderThan} onChange={e => setOlderThan(Number(e.target.value))} aria-label="Xoá task cũ hơn" style={{ width: 'auto' }}>
                <option value={0}>Mọi thời điểm</option><option value={1}>Cũ hơn 1 ngày</option><option value={7}>Cũ hơn 7 ngày</option><option value={30}>Cũ hơn 30 ngày</option></select>
              <button className="btn sm danger" disabled={!done.length} onClick={clearHistory}
                title="Xoá các task đã kết thúc theo bộ lọc đang chọn (trạng thái, tìm kiếm, skill, thời điểm)">Xoá lịch sử</button>
              <span className="small muted" style={{ flex: 1, minWidth: 160 }}>Theo bộ lọc đang chọn. Giữ task của chuỗi kế hoạch chưa xong.</span>
              {msg && <span className="small">{msg}</span>}
            </div>
            <div className="tablewrap"><table><thead><tr><th>Task</th><th>Trạng thái</th><th>Bắt đầu</th><th>Thời lượng</th></tr></thead><tbody>
              {done.map(t => (
                <Fragment key={t.id}>
                  <tr className="click" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                    <td><span className="muted small">{t.id.slice(0, 8)}</span> {title(t)}</td><td><Status s={t.status} /></td><td>{when(t.startedAt)}</td>
                    <td><Duration ms={t.startedAt && t.endedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : null} start={t.startedAt} status={t.status} /></td>
                  </tr>
                  {open === t.id && <tr><td colSpan={4}><TaskDetail t={t} onDone={refresh} /><div className="row small" style={{ marginTop: 8 }}>
                    {t.sessionId && <><Link to={`/live?s=${t.sessionId}`}>Mở session</Link><Link to={`/timeline?s=${t.sessionId}`}>Timeline</Link></>}
                    <span className="grow" /><button className="btn sm danger" onClick={() => removeOne(t)}>Xoá task này</button></div></td></tr>}
                </Fragment>
              ))}
              {!done.length && <tr><td colSpan={4} className="muted">{history.error ?? 'Không có task nào khớp.'}</td></tr>}
            </tbody></table></div></div>
        </div>

        <div className="stack">
          <CreateForm onCreated={refresh} />
          <div className="panel"><div className="panel-h"><h3>Hàng đợi</h3><span className="muted small">{queue.length} task</span></div>
            {queue.length ? <ul className="queue">{queue.map((t, i) => (
              <li key={t.id}><span className="pos">{i + 1}</span><div className="t"><b>{title(t)}</b><span className="muted small">{t.id.slice(0, 8)}</span></div>
                <button className="btn sm" disabled={i === 0} aria-label="Đưa lên" onClick={() => act(post(`/api/tasks/${t.id}/position`, { position: i }, 'PATCH'))}>Lên</button>
                <button className="btn sm" disabled={i === queue.length - 1} aria-label="Đưa xuống" onClick={() => act(post(`/api/tasks/${t.id}/position`, { position: i + 2 }, 'PATCH'))}>Xuống</button>
                <button className="btn sm danger" onClick={() => act(post(`/api/tasks/${t.id}/cancel`))}>Huỷ</button></li>
            ))}</ul> : <div className="empty">Hàng đợi trống.</div>}
          </div>
        </div>
      </div>
    </>
  );
}

/** Whether the task had the graphify MCP server, and how many times Claude queried it (counted when the task ended). */
function TaskCodeMap({ t }: { t: Task }) {
  const m = t.mcp;
  if (!m) return null;
  const on = m.servers.includes('graphify');
  const n = m.calls?.graphify;
  const text = !on ? `Bản đồ code: không gắn${m.note ? ` (${m.note.replace(/\.$/, '')})` : ''}.`
    : n == null ? 'Bản đồ code: có gắn, Claude tự tra được (đếm số lần tra khi task xong).'
    : n ? `Bản đồ code: Claude đã tra ${n} lần (kể cả subagent).` : 'Bản đồ code: có gắn nhưng Claude không tra.';
  return <div className="small muted">{text}</div>;
}
