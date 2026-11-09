import { useEffect, useState } from 'react';
import type { PermissionMode, StudioSettings, SystemStatus } from '@ccgs/shared';
import { api, useApi } from '../api';
import { Doctor } from './HookManager';

const MODES: [PermissionMode, string][] = [['default', 'Hỏi trước khi sửa'], ['acceptEdits', 'Tự sửa file'], ['plan', 'Chỉ lập kế hoạch']];

export function Preferences({ onChanged }: { onChanged: () => void }) {
  const settings = useApi<StudioSettings>('/api/settings');
  const sys = useApi<SystemStatus>('/api/system');
  const [f, setF] = useState<StudioSettings | null>(null);
  const [pats, setPats] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (settings.data) { setF(settings.data); setPats(settings.data.redactPatterns.join('\n')); } }, [settings.data]);
  if (!f) return <div className="empty">{settings.error ?? 'Đang tải…'}</div>;

  const set = (patch: (s: StudioSettings) => StudioSettings) => { setF(patch(structuredClone(f))); setMsg(null); };
  const save = async () => {
    try {
      const body = { ...f, redactPatterns: pats.split('\n').map(x => x.trim()).filter(Boolean) };
      const r = await api<StudioSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      setF(r); setPats(r.redactPatterns.join('\n'));
      setMsg({ ok: true, text: 'Đã lưu' });
      sys.reload(); onChanged();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  return (
    <>
      <div className="view-head"><div><h1>Cài đặt</h1><p>Lưu trên máy này (<code>~/.ccgs-studio/config.json</code>). Server chỉ lắng nghe 127.0.0.1.</p></div>
        <div className="row"><button className="btn primary" onClick={save}>Lưu cài đặt</button>{msg && <span className={msg.ok ? 'small muted' : 'badge-err'}>{msg.text}</span>}</div></div>
      <div className="grid-eq">
        <div className="stack">
          <div className="panel"><div className="panel-h"><h3>Đường dẫn (S-01)</h3></div><div className="panel-b">
            <div className="field"><label htmlFor="p-claude">Lệnh claude</label>
              <input type="text" id="p-claude" value={f.claudeCommand} onChange={e => set(s => ({ ...s, claudeCommand: e.target.value }))} />
              <span className="hint">Phiên bản phát hiện: {sys.data?.claude.version ?? sys.data?.claude.error ?? 'Unknown'}. Dùng cho kiểm tra môi trường; task chạy bằng Claude Code đi kèm Agent SDK.</span></div>
          </div></div>

          <div className="panel"><div className="panel-h"><h3>Mặc định cho task (S-03)</h3></div><div className="panel-b">
            <div className="field"><label htmlFor="p-model">Model</label>
              <select id="p-model" value={f.taskDefaults.model ?? ''} onChange={e => set(s => ({ ...s, taskDefaults: { ...s.taskDefaults, model: e.target.value || null } }))}>
                <option value="">Mặc định của Claude Code</option><option value="opus">opus</option><option value="sonnet">sonnet</option><option value="haiku">haiku</option></select></div>
            <div className="field"><label htmlFor="p-mode">Quyền</label>
              <select id="p-mode" value={f.taskDefaults.permissionMode} onChange={e => set(s => ({ ...s, taskDefaults: { ...s.taskDefaults, permissionMode: e.target.value as PermissionMode } }))}>
                {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="field"><label htmlFor="p-max">Thời gian chạy tối đa (phút)</label>
              <input type="number" id="p-max" min={1} max={1440} value={f.taskDefaults.maxRuntimeMin ?? ''} placeholder="Không giới hạn"
                onChange={e => set(s => ({ ...s, taskDefaults: { ...s.taskDefaults, maxRuntimeMin: num(e.target.value) } }))} />
              <span className="hint">Quá thời gian này Studio dừng task và đánh dấu Failed.</span></div>
            <label className="opt"><input type="checkbox" checked={f.taskDefaults.compactAfter !== false} onChange={e => set(s => ({ ...s, taskDefaults: { ...s.taskDefaults, compactAfter: e.target.checked } }))} />
              <div><b>/compact sau khi task xong</b><div className="small muted">Task thành công thì gửi /compact vào session đó, để bước sau (resume) không mang cả context cũ. Task lỗi hoặc bị dừng thì không compact.</div></div></label>
          </div></div>

          <div className="panel"><div className="panel-h"><h3>Phoenix (S-06)</h3></div><div className="panel-b">
            <label className="opt" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.phoenix.enabled} onChange={e => set(s => ({ ...s, phoenix: { ...s.phoenix, enabled: e.target.checked } }))} />
              <div><b>Tự gửi trace khi task kết thúc</b><div className="small muted">Mặc định tắt. Session chạy ngoài Studio gửi tay ở trang Hiệu suất.</div></div></label>
            <div className="field"><label htmlFor="p-phx">Endpoint OTLP/HTTP</label>
              <input type="text" id="p-phx" value={f.phoenix.endpoint} onChange={e => set(s => ({ ...s, phoenix: { ...s.phoenix, endpoint: e.target.value } }))} />
              <span className="hint">Phoenix chạy local mặc định nhận ở <code>http://127.0.0.1:6006/v1/traces</code>.</span></div>
          </div></div>
        </div>

        <div className="stack">
          <div className="panel"><div className="panel-h"><h3>Lưu trữ (S-04)</h3></div><div className="panel-b">
            <div className="field"><label htmlFor="p-days">Xoá session không hoạt động quá (ngày)</label>
              <input type="number" id="p-days" min={1} value={f.retention.days ?? ''} placeholder="Giữ mãi"
                onChange={e => set(s => ({ ...s, retention: { ...s.retention, days: num(e.target.value) } }))} />
              <span className="hint">Kiểm tra lúc khởi động và mỗi giờ. Xoá cả event, agent, tool call và log của session đó. Lịch sử task được giữ.</span></div>
            <div className="field"><label htmlFor="p-payload">Giới hạn mỗi chuỗi trong payload (KB)</label>
              <input type="number" id="p-payload" min={1} max={1024} value={f.retention.maxPayloadKB}
                onChange={e => set(s => ({ ...s, retention: { ...s.retention, maxPayloadKB: Number(e.target.value) } }))} />
              <span className="hint">Chuỗi dài hơn bị cắt trước khi lưu (ví dụ nội dung file trong PostToolUse). Áp dụng cho event mới.</span></div>
          </div></div>

          <div className="panel"><div className="panel-h"><h3>Mẫu che bí mật (S-05)</h3></div><div className="panel-b">
            <div className="field"><label htmlFor="p-pats">Regex thêm, mỗi dòng một mẫu</label>
              <textarea id="p-pats" value={pats} onChange={e => { setPats(e.target.value); setMsg(null); }} placeholder={'Ví dụ: MYCORP-[0-9]{6}'} style={{ fontFamily: 'var(--mono, monospace)' }} />
              <span className="hint">Cú pháp JavaScript, áp dụng thêm vào các mẫu có sẵn (API key, token, JWT, private key…) trước khi lưu. Dữ liệu đã lưu không bị che lại.</span></div>
          </div></div>

          <div className="panel"><div className="panel-h"><h3>Kiểm tra môi trường (S-02)</h3></div><Doctor /></div>
        </div>
      </div>
    </>
  );
}
