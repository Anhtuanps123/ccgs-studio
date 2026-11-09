import { useState } from 'react';
import type { DoctorCheck, HookPreview } from '@ccgs/shared';
import { api } from '../api';

/** T-HK-02: show the exact settings.local.json diff, write only after the user confirms it. */
export function HookManager({ installed, onDone }: { installed: boolean; onDone: () => void }) {
  const [pv, setPv] = useState<HookPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const action = installed ? 'uninstall' : 'install';

  const preview = async () => {
    setMsg(null);
    try { setPv(await api<HookPreview>(`/api/hooks/studio/preview?action=${action}`)); } catch (e) { setMsg((e as Error).message); }
  };
  const confirm = async () => {
    if (!pv) return;
    setBusy(true);
    try {
      await api(`/api/hooks/studio/${pv.action}`, { method: 'POST', body: JSON.stringify({ confirmHash: pv.hash }) });
      setMsg(pv.action === 'install' ? 'Đã cài hook.' : 'Đã gỡ hook.');
      setPv(null);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
      setPv(null);
    } finally { setBusy(false); }
  };

  return (
    <div className="panel-b stack">
      <p className="muted small" style={{ margin: 0 }}>
        Hook chỉ ghi vào <code>.claude/settings.local.json</code> (không đụng file của CCGS), dùng để theo dõi session chạy từ terminal.
        Hook luôn thoát 0 và bỏ qua nếu Studio không chạy.
      </p>
      <div className="row">
        <button className={`btn ${installed ? 'danger' : 'primary'}`} onClick={preview} disabled={busy}>{installed ? 'Xem trước khi gỡ hook' : 'Xem trước khi cài hook'}</button>
        {msg && <span className="small">{msg}</span>}
      </div>
      {pv && (
        <div className="stack">
          <b className="small">{pv.file}: {pv.before === null ? 'file chưa có, sẽ được tạo' : pv.after === null ? 'file sẽ bị xoá (trước khi cài nó chưa tồn tại)' : 'thay đổi'}</b>
          {pv.changed ? (
            <div className="diff" style={{ maxHeight: 360, overflow: 'auto' }}>
              {pv.diff.map((d, i) => <div key={i} className={d.op === 'ctx' ? '' : d.op}>{d.op === 'add' ? '+ ' : d.op === 'del' ? '- ' : '  '}{d.line}</div>)}
            </div>
          ) : <span className="muted small">Không có gì thay đổi.</span>}
          <div className="row">
            {pv.changed && <button className="btn primary" onClick={confirm} disabled={busy}>Xác nhận {pv.action === 'install' ? 'cài' : 'gỡ'}</button>}
            <button className="btn" onClick={() => setPv(null)} disabled={busy}>Huỷ</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** S-02 */
export function Doctor() {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setChecks(await api<DoctorCheck[]>('/api/doctor', { method: 'POST' })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="panel-b stack">
      <div className="row"><button className="btn primary" onClick={run} disabled={busy}>{busy ? 'Đang kiểm tra…' : 'Chạy kiểm tra'}</button>{err && <span className="badge-err">{err}</span>}</div>
      {checks && (
        <ul className="checks">
          {checks.map(c => (
            <li key={c.id}>
              <span className="status" data-s={c.ok === true ? 'completed' : c.ok === false ? 'failed' : 'unknown'}>{c.ok === true ? 'Đạt' : c.ok === false ? 'Lỗi' : 'Unknown'}</span>
              <div><b>{c.label}</b><div className="muted small">{c.detail}</div></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
