// T-TC-01..05, T-SK-03: create, queue, stop, answer, results.
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { NewTask, PendingInteraction, PermissionMode, QuestionSpec, SessionUsage, Skill, StudioSettings, Task, TaskDiff } from '@ccgs/shared';
import { api, live, useApi } from '../api';
import { Duration, Status, when } from '../monitor';
import { DiffView, UsageTable, fmtUsd, parseGitDiff } from '../insights';

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
    const evs = ['task:upsert', 'interaction:new', 'interaction:resolved', 'connect'];
    evs.forEach(e => s.on(e, h));
    return () => { evs.forEach(e => s.off(e, h)); if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [r1, r2]);
  return { tasks, inter };
}

const title = (t: Task) => (t.kind === 'skill' ? t.prompt : t.prompt.length > 90 ? t.prompt.slice(0, 90) + '…' : t.prompt);
const MODES: [PermissionMode, string][] = [['default', 'Hỏi trước khi sửa'], ['acceptEdits', 'Tự sửa file'], ['plan', 'Chỉ lập kế hoạch']];
const CHANGE: Record<string, string> = { A: 'Tạo', M: 'Sửa', D: 'Xoá', R: 'Đổi tên' };

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

  return (
    <div className="question stack">
      {qs.map(q => (
        <div key={q.question} className="stack" style={{ gap: 8 }}>
          <h3 style={{ margin: 0 }}>Claude hỏi: {q.question}</h3>
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

/** T-TC-07 */
function ResumeForm({ t, onDone }: { t: Task; onDone: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!t.sessionId) return null;
  const send = async () => {
    setBusy(true); setErr(null);
    try { await api(`/api/tasks/${t.id}/resume`, { method: 'POST', body: JSON.stringify({ prompt: text }) }); setText(''); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="muted small" htmlFor={`res-${t.id}`}>Tiếp tục session này với prompt mới (task mới vào hàng đợi, Claude nhớ hội thoại cũ)</label>
      <textarea id={`res-${t.id}`} value={text} onChange={e => setText(e.target.value)} placeholder="Ví dụ: Sửa thêm phần test bị lỗi" style={{ minHeight: 60 }} />
      <div className="row"><button className="btn" disabled={busy || !text.trim()} onClick={send}>Tiếp tục session</button>{err && <span className="badge-err">{err}</span>}</div>
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
  const [tab, setTab] = useState<'result' | 'diff' | 'tokens'>('result');
  return (
    <div className="stack">
      <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
        {([['result', 'Kết quả'], ['diff', `Diff${t.changedFiles?.length ? ` (${t.changedFiles.length})` : ''}`], ['tokens', 'Token']] as const).map(([k, l]) =>
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'result' && <Result t={t} />}
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
      <div className="small muted">Model {t.model ?? 'mặc định'} · Chi phí {fmtUsd(t.costUsd)}{t.costUsd !== null ? ' (ước tính theo giá niêm yết, do SDK báo)' : ''}{t.resumeOf ? ` · Tiếp tục session ${t.resumeOf.slice(0, 8)}` : ''}</div>
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
  const settings = useApi<StudioSettings>('/api/settings');
  const def = settings.data?.taskDefaults;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const s = sp.get('skill'); if (s) setSkill(s); }, [sp]);
  const hint = skills.data?.find(s => s.name === skill)?.argumentHint;

  const submit = async () => {
    // Empty choices are left out so the server applies the task defaults (S-03).
    const extra = { ...(model ? { model } : {}), ...(mode ? { permissionMode: mode } : {}) };
    const body: NewTask = skill ? { kind: 'skill', skill, args: text, ...extra } : { kind: 'prompt', prompt: text, ...extra };
    setBusy(true); setErr(null);
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      setText('');
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
          {(skills.data ?? []).filter(s => s.hasSkillMd && s.userInvocable !== false).map(s => <option key={s.dir} value={s.name}>/{s.name}</option>)}
        </select></div>
      <div className="field"><label htmlFor="t-prompt">{skill ? 'Tham số' : 'Prompt'}</label>
        <textarea id="t-prompt" value={text} onChange={e => setText(e.target.value)} placeholder={skill ? hint ?? 'Không bắt buộc' : 'Ví dụ: Viết test cho hệ thống inventory'} /></div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: 1, minWidth: 120 }}><label htmlFor="t-model">Model</label>
          <select id="t-model" value={model} onChange={e => setModel(e.target.value)}>
            <option value="">Theo cài đặt ({def?.model ?? 'mặc định của Claude Code'})</option><option value="opus">opus</option><option value="sonnet">sonnet</option><option value="haiku">haiku</option></select></div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}><label htmlFor="t-perm">Quyền</label>
          <select id="t-perm" value={mode} onChange={e => setMode(e.target.value as PermissionMode | '')}>
            <option value="">Theo cài đặt ({MODES.find(m => m[0] === (def?.permissionMode ?? 'default'))?.[1]})</option>
            {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      </div>
      {def?.maxRuntimeMin && <p className="small muted" style={{ marginTop: 0 }}>Task chạy quá {def.maxRuntimeMin} phút sẽ bị dừng (đổi ở Cài đặt).</p>}
      <div className="row"><button className="btn primary" onClick={submit} disabled={busy || (!skill && !text.trim())}>Thêm vào hàng đợi</button>{err && <span className="badge-err">{err}</span>}</div>
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
            <div className="tablewrap"><table><thead><tr><th>Task</th><th>Trạng thái</th><th>Bắt đầu</th><th>Thời lượng</th></tr></thead><tbody>
              {done.map(t => (
                <Fragment key={t.id}>
                  <tr className="click" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                    <td><span className="muted small">{t.id.slice(0, 8)}</span> {title(t)}</td><td><Status s={t.status} /></td><td>{when(t.startedAt)}</td>
                    <td><Duration ms={t.startedAt && t.endedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : null} start={t.startedAt} status={t.status} /></td>
                  </tr>
                  {open === t.id && <tr><td colSpan={4}><TaskDetail t={t} onDone={refresh} />{t.sessionId && <div className="small" style={{ marginTop: 8 }}><Link to={`/live?s=${t.sessionId}`}>Mở session</Link> · <Link to={`/timeline?s=${t.sessionId}`}>Timeline</Link></div>}</td></tr>}
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
