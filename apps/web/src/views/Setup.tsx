import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SetupJob, SetupLevel, SetupPackage, SetupState } from '@ccgs/shared';
import { api, live, useApi } from '../api';

const LEVEL: Record<SetupLevel, string> = { required: 'Bắt buộc', recommended: 'Nên có', optional: 'Tuỳ chọn' };

function statusOf(p: SetupPackage, job: SetupJob | null): [string, string] {
  if (job?.status === 'running' && job.packageId === p.id) return ['running', 'Đang cài'];
  return p.installed === true ? ['completed', 'Đã có'] : p.installed === false ? ['failed', 'Chưa có'] : ['unknown', 'Unknown'];
}

export function Setup() {
  const st = useApi<SetupState>('/api/setup/packages');
  const [job, setJob] = useState<SetupJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [showLog, setShowLog] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (st.data) setJob(st.data.job); }, [st.data]);
  useEffect(() => {
    const s = live();
    const h = (j: SetupJob) => { setJob(j); if (j.status !== 'running') st.reload(); };
    s.on('setup:job', h);
    return () => { s.off('setup:job', h); };
  }, [st.reload]);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [job?.log.length]);

  const recheck = async () => { setChecking(true); setErr(null); try { await api('/api/setup/packages'); st.reload(); } catch (e) { setErr((e as Error).message); } finally { setChecking(false); } };
  const post = async (path: string) => {
    setErr(null);
    try { return await api<SetupJob>(path, { method: 'POST' }); } catch (e) { setErr((e as Error).message); return null; }
  };
  const install = async (p: SetupPackage) => {
    if (p.install?.confirm && !window.confirm(p.install.confirm)) return;
    const j = await post(`/api/setup/packages/${encodeURIComponent(p.id)}/install`);
    if (j) { setJob(j); setShowLog(true); st.reload(); }
  };

  const running = job?.status === 'running';
  const pk = st.data?.packages ?? [];
  const grow = { flex: 1 } as const;
  const claudeOk = pk.find(x => x.id === 'claude')?.installed === true;

  return (
    <>
      <div className="view-head">
        <div><h1>Cài package</h1><p>Cài những gì Studio cần (xem <code>CAI-DAT.md</code>). Lệnh cài chạy trên máy này bằng quyền của bạn và tải từ internet; winget có thể hỏi quyền admin.</p></div>
        <div className="row"><button className="btn" onClick={recheck} disabled={checking}>{checking ? 'Đang kiểm tra…' : 'Kiểm tra lại tất cả'}</button>{err && <span className="badge-err">{err}</span>}</div>
      </div>
      {st.error && <div className="badge-err">{st.error}</div>}
      {!st.data ? <div className="empty">{st.error ? '' : 'Đang kiểm tra máy…'}</div> : (
        <div className="stack">
          {st.data.platform !== 'win32' && <div className="panel"><div className="panel-b muted">Nút cài chỉ có trên Windows. Trên máy này hãy cài tay theo CAI-DAT.md.</div></div>}
          {(['required', 'recommended', 'optional'] as SetupLevel[]).map(lv => (
            <div className="panel" key={lv}><div className="panel-h"><h3>{LEVEL[lv]}</h3></div><div className="panel-b">
              <ul className="checks">
                {pk.filter(p => p.level === lv).map(p => {
                  const [s, label] = statusOf(p, job);
                  return (
                    <li key={p.id}>
                      <span className="status" data-s={s}>{label}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <b>{p.label}</b>{p.version && <span className="tag" style={{ marginLeft: 8 }}>{p.version}</span>}
                        <div className="muted small">{p.why}</div>
                        <div className="muted small" style={{ overflowWrap: 'anywhere' }}>{p.detail}</div>
                        {p.install && <div className="small" style={{ overflowWrap: 'anywhere' }}><code>{p.install.command}</code></div>}
                      </div>
                      <div className="row" style={{ alignSelf: 'center' }}>
                        {p.install && (
                          <button className={`btn${p.installed === false ? ' primary' : ''}`} disabled={!!p.install.blockedBy || running}
                            title={p.install.blockedBy ?? undefined} onClick={() => void install(p)}>
                            {p.installed ? 'Cài lại' : 'Cài'}</button>
                        )}
                        {p.install?.blockedBy && !running && <span className="small muted">{p.install.blockedBy}</span>}
                        {p.action === 'login' && (
                          <button className={`btn${p.installed === false ? ' primary' : ''}`} disabled={!claudeOk || st.data!.platform !== 'win32'}
                            title="Mở cửa sổ terminal chạy claude, rồi gõ /login trong đó. Xong bấm Kiểm tra lại tất cả."
                            onClick={() => void post('/api/setup/login')}>Mở terminal</button>
                        )}
                        {p.id === 'unity-mcp' && <button className="btn" onClick={recheck} disabled={checking}>Kiểm tra lại</button>}
                        {p.id === 'context-mode' && p.installed && <Link className="btn" to="/preferences">Bật trong Cài đặt</Link>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div></div>
          ))}

          <div className="panel"><div className="panel-h"><h3>Bước làm trong Studio</h3></div><div className="panel-b">
            <ul className="checks">
              <li><div><b>Chọn project game</b><div className="muted small">Thư mục có <code>.claude/</code>, <code>agents/</code>, <code>skills/</code>.</div></div><span style={grow} /><Link className="btn" to="/projects">Mở Project</Link></li>
              <li><div><b>Chạy <code>/start</code> trong project game</b><div className="muted small">Cần có <code>modes.rigor</code> trong <code>project.yaml</code> thì mới lập được kế hoạch.</div></div><span style={grow} /><Link className="btn" to="/pipelines">Mở Lập kế hoạch</Link></li>
              <li><div><b>Cài hook giám sát</b><div className="muted small">Chỉ cần cho session tự mở ở terminal. Studio hiện diff trước khi ghi.</div></div><span style={grow} /><Link className="btn" to="/config">Mở Rules, Hooks</Link></li>
              <li><div><b>Quét game</b><div className="muted small">Cần Unity mở và MCP for Unity đang bật.</div></div><span style={grow} /><Link className="btn" to="/dashboard">Mở Tổng quan</Link></li>
              <li><div><b>Kiểm tra môi trường</b><div className="muted small">Kiểm tra cả hook, database, graphify-mcp.</div></div><span style={grow} /><Link className="btn" to="/preferences">Mở Cài đặt</Link></li>
            </ul>
          </div></div>

          {job && (
            <div className="panel">
              <div className="panel-h"><h3>Lần cài gần nhất: {job.label}</h3>
                <div className="row">
                  <span className="status" data-s={job.status}>{job.status === 'running' ? 'Đang chạy' : job.status === 'completed' ? 'Xong' : job.status === 'cancelled' ? 'Đã huỷ' : 'Lỗi'}</span>
                  {running && <button className="btn" onClick={() => void post('/api/setup/job/cancel')}>Huỷ</button>}
                  <button className="btn" onClick={() => setShowLog(v => !v)}>{showLog ? 'Ẩn log' : 'Hiện log'}</button>
                </div></div>
              {showLog && <div className="panel-b"><div className="diff" ref={logRef} style={{ maxHeight: 360, overflowY: 'auto' }}>
                {job.log.map((l, i) => <div key={i}>{l}</div>)}
              </div>
                {job.status === 'completed' && <p className="small muted">Nếu package mới vẫn báo "Chưa có", hãy restart Studio để nạp PATH mới.</p>}
              </div>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
