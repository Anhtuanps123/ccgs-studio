import { useEffect, useState } from 'react';
import type { GitInfo, ProjectInfo, StudioSettings } from '@ccgs/shared';
import { api, useApi } from '../api';
import { useTaskData } from './Tasks';

const GIT_XY: Record<string, string> = { M: 'Sửa', A: 'Thêm', D: 'Xoá', R: 'Đổi tên', C: 'Chép', U: 'Xung đột', '?': 'Chưa theo dõi' };
const xyLabel = (xy: string) => {
  const k = xy === '??' ? '?' : (xy.trim()[0] ?? '?');
  const where = xy === '??' ? '' : xy[0] !== ' ' && xy[1] !== ' ' ? ' (staged + chưa staged)' : xy[0] !== ' ' ? ' (staged)' : '';
  return (GIT_XY[k] ?? xy) + where;
};

/** T-PJ-02 */
function GitPanel({ path }: { path: string | null }) {
  const g = useApi<GitInfo>(path ? '/api/project/git' : null);
  const { reload } = g;
  useEffect(() => { reload(); }, [path, reload]);
  const [q, setQ] = useState('');
  const d = g.data;
  const files = (d?.files ?? []).filter(f => !q || f.path.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="panel"><div className="panel-h"><h3>Git</h3><button className="btn sm" onClick={reload}>Làm mới</button></div>
      {!path ? <div className="panel-b muted">Chưa chọn project. Nhập đường dẫn bên trái để xem git.</div>
        : !d ? <div className="panel-b muted">{g.error ?? 'Đang đọc…'}</div> : !d.isRepo ? <div className="panel-b muted">Thư mục này không phải git repo.</div> : (
        <>
          <div className="panel-b statrow">
            <div><b>{d.branch ?? 'HEAD tách rời'}</b><span>branch{d.head ? ` · ${d.head}` : ''}</span></div>
            <div><b>{d.ahead ?? 'Unknown'} / {d.behind ?? 'Unknown'}</b><span>ahead / behind upstream</span></div>
            <div><b>{d.files.length}{d.truncated ? '+' : ''}</b><span>file chưa commit</span></div>
          </div>
          {d.error && <div className="panel-b badge-err">{d.error}</div>}
          {d.files.length > 0 && <>
            <div className="panel-b" style={{ borderTop: '1px solid var(--line)' }}><input type="search" placeholder="Lọc file" value={q} onChange={e => setQ(e.target.value)} aria-label="Lọc file git" /></div>
            <div className="tablewrap" style={{ maxHeight: 360, overflow: 'auto' }}><table>
              <thead><tr><th>Trạng thái</th><th>File</th></tr></thead>
              <tbody>{files.slice(0, 300).map(f => <tr key={f.path}><td className="small"><code>{f.status}</code> {xyLabel(f.status)}</td><td><code>{f.path}</code></td></tr>)}</tbody>
            </table></div>
            {(files.length > 300 || d.truncated) && <div className="panel-b muted small">Chỉ hiện một phần danh sách.</div>}
          </>}
        </>
      )}
    </div>
  );
}

export function Project({ onChanged }: { onChanged: () => void }) {
  const cur = useApi<ProjectInfo>('/api/project');
  const settings = useApi<StudioSettings>('/api/settings');
  const { tasks } = useTaskData();
  const busy = (tasks.data ?? []).some(t => ['queued', 'running', 'waiting'].includes(t.status));
  const [path, setPath] = useState('');
  const [result, setResult] = useState<ProjectInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (cur.data?.path) setPath(cur.data.path); }, [cur.data?.path]);

  const use = async (p: string) => {
    setErr(null);
    try {
      const r = await api<ProjectInfo>('/api/project', { method: 'PUT', body: JSON.stringify({ path: p }) });
      setResult(r);
      if (r.valid) { setPath(r.path ?? p); cur.reload(); settings.reload(); onChanged(); }
    } catch (e) { setErr((e as Error).message); }
  };
  const [picking, setPicking] = useState(false);
  const browse = async () => {
    setErr(null); setPicking(true);
    try {
      const r = await api<{ path: string | null }>('/api/project/browse', { method: 'POST' });
      if (r.path) { setPath(r.path); await use(r.path); }
    } catch (e) { setErr((e as Error).message); } finally { setPicking(false); }
  };
  const forget = async (p: string) => { await api('/api/projects/recent', { method: 'PUT', body: JSON.stringify({ remove: p }) }); settings.reload(); };
  const shown = result ?? cur.data;
  const recent = (settings.data?.recentProjects ?? []).filter(p => p.toLowerCase() !== (cur.data?.path ?? '').toLowerCase());

  return (
    <>
      <div className="view-head"><div><h1>Project</h1><p>Thư mục project dùng CCGS mà Studio đang làm việc. Chỉ một project hoạt động tại một thời điểm.</p></div></div>
      <div className="grid-eq">
        <div className="stack">
          <div className="panel"><div className="panel-h"><h3>Project hiện tại</h3></div><div className="panel-b">
            <div className="field"><label htmlFor="proj-path">Đường dẫn</label>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <input type="text" id="proj-path" style={{ flex: 1, minWidth: 0 }} value={path} onChange={e => setPath(e.target.value)} placeholder="Ví dụ: D:\Meodoku" />
                <button className="btn" type="button" onClick={browse} disabled={picking || busy}>{picking ? 'Đang chờ chọn…' : 'Chọn thư mục…'}</button>
              </div>
              {picking && <div className="small muted" style={{ marginTop: 6 }}>Hộp thoại chọn thư mục đã mở trên máy (có thể nằm sau cửa sổ trình duyệt).</div>}</div>
            {shown && shown.checks.length > 0 && (
              <ul className="checks">{shown.checks.map(c => (
                <li key={c.label}><span className={`mark ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? '✓' : '✕'}</span><div>{c.label}</div></li>
              ))}</ul>
            )}
            {result && !result.valid && <p className="badge-err">Thư mục này chưa phải project CCGS hợp lệ; Studio giữ nguyên project cũ.</p>}
            {err && <p className="badge-err">{err}</p>}
            {busy && <p className="small muted">Đang có task chạy hoặc chờ: chưa đổi được sang project khác.</p>}
            <div className="row" style={{ marginTop: 10 }}><button className="btn primary" onClick={() => use(path)} disabled={!path.trim()}>Kiểm tra và dùng project này</button></div>
          </div></div>
          <div className="panel"><div className="panel-h"><h3>Project đã dùng</h3><span className="muted small">{recent.length}</span></div>
            {recent.length ? <ul className="queue">{recent.map(p => (
              <li key={p}><div className="t"><b>{p.split(/[\\/]/).pop()}</b><span className="muted small">{p}</span></div>
                <button className="btn sm" disabled={busy} onClick={() => use(p)}>Chuyển sang</button>
                <button className="btn sm" onClick={() => forget(p)} aria-label={`Bỏ ${p} khỏi danh sách`}>Bỏ</button></li>
            ))}</ul> : <div className="empty">Chưa có project nào khác.</div>}
          </div>
        </div>
        <GitPanel path={cur.data?.valid ? cur.data.path : null} />
      </div>
    </>
  );
}
