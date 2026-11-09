// M-PF-01 task stats, M-PF-02 tokens, M-PF-03 cost (estimate), M-PF-04 agent comparison, M-PF-05 Phoenix export.
import { useState } from 'react';
import type { AgentInvocation, AgentStats, PhoenixExport, SessionUsage, StudioSettings, TaskStats } from '@ccgs/shared';
import { api, useApi } from '../api';
import { NoSessions, SessionPicker, agentLabel, fmtDur, useLiveApi, useSession, when } from '../monitor';
import { UsageTable, fmtUsd } from '../insights';

const enc = encodeURIComponent;

export function Performance() {
  const ses = useSession();
  const tasks = useLiveApi<TaskStats>('/api/stats/tasks', null, ['task:upsert']);
  const agents = useLiveApi<AgentStats[]>('/api/stats/agents', null, ['invocation:upsert']);
  const usage = useLiveApi<SessionUsage>(ses.id ? `/api/sessions/${enc(ses.id)}/usage` : null, ses.id, ['invocation:upsert', 'session:upsert']);
  const inv = useLiveApi<AgentInvocation[]>(ses.id ? `/api/sessions/${enc(ses.id)}/invocations` : null, ses.id, ['invocation:upsert']);
  const settings = useApi<StudioSettings>('/api/settings');
  const [exp, setExp] = useState<PhoenixExport | null>(null);
  const [busy, setBusy] = useState(false);
  const t = tasks.data;
  const names = new Map((inv.data ?? []).map(i => [i.id, agentLabel(i.agentType)]));
  const maxCalls = Math.max(1, ...(agents.data ?? []).map(a => a.calls));
  const maxDur = Math.max(1, ...(agents.data ?? []).map(a => a.avgDurationMs ?? 0));

  const sendPhoenix = async () => {
    if (!ses.id) return;
    setBusy(true);
    try { setExp(await api<PhoenixExport>(`/api/sessions/${enc(ses.id)}/phoenix`, { method: 'POST' })); }
    catch (e) { setExp({ ok: false, spans: 0, status: null, error: (e as Error).message }); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="view-head"><div><h1>Hiệu suất</h1><p>Số liệu tính từ task đã chạy, event hook và transcript. Không có dữ liệu thì hiện Unknown.</p></div></div>

      <div className="panel"><div className="panel-h"><h3>Task (M-PF-01)</h3><span className="muted small">Task đã kết thúc chạy từ Studio</span></div>
        {t ? <div className="big">
          <div><b>{t.total}</b><span>task đã kết thúc</span></div>
          <div><b>{t.completed}</b><span>thành công{t.total ? ` (${Math.round((t.completed / t.total) * 100)}%)` : ''}</span></div>
          <div><b>{t.failed}</b><span>thất bại</span></div>
          <div><b>{t.cancelled}</b><span>bị dừng</span></div>
          <div><b>{t.avgDurationMs === null ? 'Unknown' : fmtDur(t.avgDurationMs)}</b><span>thời lượng TB (task thành công)</span></div>
          <div><b>{fmtUsd(t.totalCostUsd)}</b><span>chi phí ước tính (M-PF-03)</span></div>
        </div> : <div className="empty">{tasks.error ?? 'Đang tải…'}</div>}
        <div className="panel-b small muted">Chi phí là <code>total_cost_usd</code> do Agent SDK báo theo giá niêm yết, chỉ có cho task chạy từ Studio. Đây là ước tính, không phải hoá đơn.</div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}><div className="panel-h"><h3>So sánh agent (M-PF-04)</h3><span className="muted small">Mọi session đã ghi nhận</span></div>
        {agents.data?.length ? <div className="tablewrap"><table>
          <thead><tr><th>Agent</th><th>Số lần gọi</th><th>Thành công</th><th>Thất bại</th><th>Unknown</th><th>Thời lượng TB</th><th style={{ width: '24%' }}>So sánh</th><th>Lần cuối</th></tr></thead>
          <tbody>{agents.data.map(a => (
            <tr key={a.agentType}>
              <td><b>{a.agentType}</b></td><td className="mono">{a.calls}</td>
              <td className="mono">{a.completed}{a.calls ? ` (${Math.round((a.completed / a.calls) * 100)}%)` : ''}</td>
              <td className="mono">{a.failed}</td><td className="mono">{a.unknown}</td>
              <td className="mono">{a.avgDurationMs === null ? 'Unknown' : fmtDur(a.avgDurationMs)}</td>
              <td>
                <div className="hbar" style={{ gridTemplateColumns: '50px 1fr', padding: '1px 0' }}><span className="small muted">lần gọi</span><div className="track"><div className="fill" style={{ width: `${(a.calls / maxCalls) * 100}%` }} /></div></div>
                <div className="hbar" style={{ gridTemplateColumns: '50px 1fr', padding: '1px 0' }}><span className="small muted">thời lượng</span><div className="track"><div className="fill alt" style={{ width: `${((a.avgDurationMs ?? 0) / maxDur) * 100}%` }} /></div></div>
              </td>
              <td className="small">{when(a.lastAt)}</td>
            </tr>
          ))}</tbody>
        </table></div> : <div className="empty">{agents.error ?? 'Chưa có subagent nào được ghi nhận.'}</div>}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><h3>Token theo agent (M-PF-02)</h3><SessionPicker ses={ses} /></div>
        <div className="panel-b">
          {!ses.list?.length ? <NoSessions error={ses.error} /> : usage.data ? <UsageTable u={usage.data} names={names} /> : <div className="empty">{usage.error ?? 'Đang đọc transcript…'}</div>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><h3>Phoenix (M-PF-05)</h3><span className="tag">{settings.data?.phoenix.enabled ? 'Tự gửi khi task xong' : 'Tắt tự gửi'}</span></div>
        <div className="panel-b stack">
          <div className="small">Gửi session đang chọn tới <code>{settings.data?.phoenix.endpoint ?? '?'}</code> dạng trace OTLP: session là span gốc, mỗi agent một span con, mỗi tool call một span lá, token gắn vào span agent. Bật tự gửi và đổi endpoint ở Cài đặt.</div>
          <div className="row"><button className="btn" disabled={!ses.id || busy} onClick={sendPhoenix}>Gửi session này tới Phoenix</button>
            {exp && (exp.ok ? <span className="small">Đã gửi {exp.spans} span (HTTP {exp.status}).</span> : <span className="badge-err">Không gửi được: {exp.error}</span>)}</div>
        </div>
      </div>
    </>
  );
}
