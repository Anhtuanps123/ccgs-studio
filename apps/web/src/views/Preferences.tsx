import { useEffect, useState } from 'react';
import type { GraphSettings, GraphStatus, PermissionMode, StudioSettings, SystemStatus } from '@ccgs/shared';
import { api, useApi } from '../api';
import { Doctor } from './HookManager';

const MODES: [PermissionMode, string][] = [['default', 'Hỏi trước khi sửa'], ['acceptEdits', 'Tự sửa file'], ['plan', 'Chỉ lập kế hoạch']];

export function Preferences({ onChanged }: { onChanged: () => void }) {
  const settings = useApi<StudioSettings>('/api/settings');
  const sys = useApi<SystemStatus>('/api/system');
  const [f, setF] = useState<StudioSettings | null>(null);
  const [pats, setPats] = useState('');
  const graph = useApi<GraphStatus>('/api/graph');
  const pid = graph.data?.projectId ?? null;
  const [exc, setExc] = useState('');
  useEffect(() => { if (settings.data && pid) setExc((settings.data.graphify?.projects?.[pid]?.excludes ?? []).join('\n')); }, [settings.data, pid]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (settings.data) { setF(settings.data); setPats(settings.data.redactPatterns.join('\n')); } }, [settings.data]);
  if (!f) return <div className="empty">{settings.error ?? 'Đang tải…'}</div>;

  const set = (patch: (s: StudioSettings) => StudioSettings) => { setF(patch(structuredClone(f))); setMsg(null); };
  const save = async () => {
    try {
      const gs = gset(f);
      const graphify: GraphSettings = pid ? { ...gs, projects: { ...gs.projects, [pid]: { includePlugins: !!gs.projects[pid]?.includePlugins, excludes: exc.split('\n').map(x => x.trim()).filter(Boolean) } } } : gs;
      const body = { ...f, graphify, redactPatterns: pats.split('\n').map(x => x.trim()).filter(Boolean) };
      const r = await api<StudioSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      setF(r); setPats(r.redactPatterns.join('\n'));
      if (pid) setExc((r.graphify?.projects?.[pid]?.excludes ?? []).join('\n'));
      graph.reload();
      setMsg({ ok: true, text: 'Đã lưu' });
      sys.reload(); onChanged();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const g = gset(f);
  const setG = (patch: (g: GraphSettings) => GraphSettings) => set(s => ({ ...s, graphify: patch(gset(s)) }));

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
              <div><b>Tự /compact trước khi tiếp tục session lớn</b><div className="small muted">Ngay trước khi một task resume session, nếu lượt cuối của session đã dùng từ ngưỡng dưới đây trở lên thì Studio gửi /compact trước rồi mới chạy task. Session không ai resume hoặc còn nhỏ thì không compact (compact tốn tiền và làm mất cache). Chi phí /compact ghi riêng.</div></div></label>
            <div className="field"><label htmlFor="p-compact">Ngưỡng /compact (token)</label>
              <input type="number" id="p-compact" min={10000} max={1000000} step={10000} value={f.taskDefaults.compactMinTokens ?? ''} placeholder="100000"
                disabled={f.taskDefaults.compactAfter === false}
                onChange={e => set(s => ({ ...s, taskDefaults: { ...s.taskDefaults, compactMinTokens: num(e.target.value) } }))} />
              <span className="hint">Ngữ cảnh cố định (system prompt, CLAUDE.md, tool, skill) đã khoảng 55–70k token, nên ngưỡng thấp hơn mức đó gần như lần nào cũng compact.</span></div>
          </div></div>

          <div className="panel"><div className="panel-h"><h3>Quyền công cụ</h3></div><div className="panel-b">
            <label className="opt" style={{ marginBottom: 10 }}><input type="checkbox" checked={(f.autoAllow ?? []).includes('*')}
              onChange={e => set(s => ({ ...s, autoAllow: e.target.checked ? [...(s.autoAllow ?? []).filter(x => x !== '*'), '*'] : (s.autoAllow ?? []).filter(x => x !== '*') }))} />
              <div><b>Tự cho phép mọi công cụ</b><div className="small muted">Studio không hiện hộp xin quyền nữa. Luật deny và hook của project vẫn chặn như cũ; câu hỏi (AskUserQuestion) vẫn hỏi.</div></div></label>
            <div className="field"><label>Công cụ đã chọn "Luôn cho phép"</label>
              {(f.autoAllow ?? []).filter(x => x !== '*').length === 0 ? <span className="hint">Chưa có. Bấm "Luôn cho phép" trong hộp xin quyền để thêm.</span> :
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{(f.autoAllow ?? []).filter(x => x !== '*').map(t => (
                  <span key={t} className="tag">{t} <button className="btn sm" aria-label={`Bỏ ${t}`} onClick={() => set(s => ({ ...s, autoAllow: s.autoAllow.filter(x => x !== t) }))}>×</button></span>))}</div>}
              <span className="hint">Bỏ một công cụ rồi bấm Lưu để Studio hỏi lại.</span></div>
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

          <div className="panel"><div className="panel-h"><h3>Bản đồ code (graphify)</h3></div><div className="panel-b">
            <label className="opt" style={{ marginBottom: 10 }}><input type="checkbox" checked={g.enabled} onChange={e => setG(x => ({ ...x, enabled: e.target.checked }))} />
              <div><b>Dùng bản đồ code khi lập kế hoạch</b><div className="small muted">Khi yêu cầu có tên lớp/hàm (hoặc ô "Từ khoá mã nguồn" có nội dung), Studio tra đồ thị rồi đưa kết quả cho Claude. Tắt thì lập kế hoạch như cũ. Đồ thị vẫn tự cập nhật sau task.</div></div></label>
            <div className="field"><label htmlFor="p-gbudget">Budget truy vấn (token)</label>
              <input type="number" id="p-gbudget" min={200} max={20000} step={100} value={g.budget} onChange={e => setG(x => ({ ...x, budget: Number(e.target.value) }))} />
              <span className="hint">Tổng cho mọi từ khoá của một lần lập kế hoạch (chia đều, tối thiểu 300 mỗi từ). Mặc định 2000.</span></div>
            {pid ? <>
              <label className="opt" style={{ marginBottom: 10 }}><input type="checkbox" checked={!!g.projects[pid]?.includePlugins}
                onChange={e => setG(x => ({ ...x, projects: { ...x.projects, [pid]: { excludes: x.projects[pid]?.excludes ?? [], includePlugins: e.target.checked } } }))} />
                <div><b>Đưa <code>Assets/Plugins/</code> vào đồ thị</b><div className="small muted">Mặc định loại trừ (thường là plugin bên thứ ba).</div></div></label>
              <div className="field"><label htmlFor="p-gexc">Loại trừ thêm cho project này, mỗi dòng một mục</label>
                <textarea id="p-gexc" value={exc} onChange={e => { setExc(e.target.value); setMsg(null); }} placeholder={'Ví dụ:\nAssets/Spine/\nAssets/Firebase/'} style={{ fontFamily: 'var(--mono, monospace)' }} />
                <span className="hint">Đường dẫn tương đối với thư mục project (thư viện bên thứ ba…). Luôn loại trừ sẵn: {graph.data?.defaultExcludes.join(' ')}. Đổi danh sách thì bấm "Dựng lại" ở Tổng quan để áp dụng.</span></div>
            </> : <span className="hint">Chọn project hợp lệ để chỉnh danh sách loại trừ.</span>}
          </div></div>

          <div className="panel"><div className="panel-h"><h3>Kiểm tra môi trường (S-02)</h3></div><Doctor /></div>
        </div>
      </div>
    </>
  );
}

const gset = (s: StudioSettings): GraphSettings => ({ enabled: true, budget: 2000, ...(s.graphify ?? {}), projects: { ...(s.graphify?.projects ?? {}) } });
