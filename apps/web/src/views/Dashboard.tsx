import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConfigSummary, CurrentTask, GameScan, GraphStatus, PipelineSetup, SystemStatus, Task } from "@ccgs/shared";
import { api, live, useApi } from "../api";
import { Duration, Status, when } from '../monitor';
import { useTaskData } from './Tasks';

/** T-DB-03 */
function CurrentTaskCard() {
  const { tasks } = useTaskData();
  const cur = useApi<CurrentTask>('/api/tasks/current');
  const { reload } = cur;
  const key = (tasks.data ?? []).map(t => t.id + t.status).join();
  useEffect(() => { reload(); }, [key, reload]);
  const c = cur.data;
  if (!c) return <div className="panel"><div className="empty">{cur.error ?? 'Đang tải…'}</div></div>;
  const t = c.task;
  return (
    <div className="panel"><div className="panel-h"><h3>Task hiện tại</h3><Link to="/tasks" className="small">Task Center</Link></div><div className="panel-b stack">
      {t ? (
        <>
          <div className="row"><Status s={t.status} /><b>{t.prompt.length > 100 ? t.prompt.slice(0, 100) + '…' : t.prompt}</b></div>
          <div className="small muted">Đã chạy <Duration ms={null} start={t.startedAt} status={t.status} />{c.pending ? `. ${c.pending} câu hỏi đang chờ bạn trả lời` : ''}</div>
          <div><div className="muted small">Agent đang hoạt động</div>
            {c.activeAgents.length ? <div className="row">{c.activeAgents.map(a => <span key={a.id} className="tag">{a.agentType}</span>)}</div>
              : <div className="small">Không có subagent nào đang chạy.</div>}</div>
        </>
      ) : <div className="muted">Không có task đang chạy.</div>}
      <div className="small">Hàng đợi: {c.queued} task</div>
    </div></div>
  );
}

/** Bước 0 trước /start và lập kế hoạch: đọc game qua Unity MCP (chỉ đọc). */
function GameScanCard() {
  const scan = useApi<GameScan>('/api/scan');
  const setup = useApi<PipelineSetup>('/api/pipelines/setup');
  const { reload } = scan;
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const s = live(); const h = () => { reload(); setup.reload(); };
    s.on('scan:upsert', h); s.on('connect', h);
    return () => { s.off('scan:upsert', h); s.off('connect', h); };
  }, [reload, setup.reload]);
  const post = async (p: string) => { setErr(null); try { await api(p, { method: 'POST' }); reload(); } catch (e) { setErr(String((e as Error).message ?? e)); } };
  const g = scan.data;
  if (!g) return <div className="panel"><div className="empty">{scan.error ?? 'Đang tải…'}</div></div>;
  const label = { none: 'Chưa quét', running: 'Đang quét…', ok: 'Đã quét', failed: 'Quét thất bại' }[g.status];
  const st = setup.data;
  return (
    <div className="panel"><div className="panel-h"><h3>Bước 0: Quét game (Unity MCP)</h3>
      {g.taskId && <Link to="/tasks" className="small">Xem task</Link>}</div><div className="panel-b stack">
      <div className="small muted">Bắt buộc trước khi lập kế hoạch. Mở Unity Editor có MCP for Unity đang kết nối. Task chỉ đọc: scene, cây UI, prefab, script UI và ảnh Game View; không bấm Play, không ghi vào project.</div>
      <ul className="checks">
        <li><Mark ok={g.status === 'ok'} /><div><b>{label}</b>
          <div className="muted small">{g.error ?? (g.at ? `Lúc ${new Date(g.at).toLocaleString()}` : 'Unknown')}{g.status === 'running' ? '. Nếu Claude hỏi quyền dùng tool Unity, trả lời trong Task Center.' : ''}</div></div></li>
        <li><Mark ok={!!st?.started} /><div><b>/start {st?.started ? (st.source === 'session' ? `đã chạy trong phiên (không lưu project.yaml, rigor mặc định ${st.rigor})` : `đã chạy (rigor ${st.rigor}, stage ${st.stage ?? 'Unknown'})`) : 'chưa chạy'}</b>
          <div className="muted small">Chạy /start tiếp nối session quét để nó biết UI/UX đang có.</div></div></li>
      </ul>
      <div className="row">
        <button className="btn primary" disabled={g.status === 'running'} onClick={() => post('/api/scan')}>{g.status === 'none' ? 'Quét game' : 'Quét lại'}</button>
        <button className="btn" disabled={g.status !== 'ok'} onClick={() => post('/api/scan/start-skill')}>Chạy /start với kết quả quét</button>
        <Link to="/pipelines" className="btn">Lập kế hoạch</Link>
      </div>
      {err && <div className="badge-err">{err}</div>}
      {g.summary && <div><button className="btn small" onClick={() => setOpen(!open)}>{open ? 'Ẩn' : 'Xem'} kết quả quét</button>
        {open && <pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto' }}>{g.summary}</pre>}</div>}
      {g.images.length > 0 && <div className="row" style={{ flexWrap: 'wrap' }}>{g.images.map(n =>
        <a key={n} href={`/api/scan/img/${encodeURIComponent(n)}`} target="_blank" rel="noreferrer"><img src={`/api/scan/img/${encodeURIComponent(n)}`} alt={n} style={{ height: 140, borderRadius: 6 }} /></a>)}</div>}
    </div></div>
  );
}

const GRAPH_STATE: Record<GraphStatus['state'], string> = { missing: 'Chưa dựng', building: 'Đang dựng…', ready: 'Sẵn sàng', stale: 'Cũ', error: 'Lần dựng cuối lỗi' };

/** Code map (graphify, brief A8): built outside the project, used to look up code before planning. */
function CodeMapCard() {
  const g = useApi<GraphStatus>('/api/graph');
  const { reload } = g;
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const s = live(); const h = () => reload();
    s.on('graph:upsert', h); s.on('connect', h);
    return () => { s.off('graph:upsert', h); s.off('connect', h); };
  }, [reload]);
  const build = async () => { setErr(null); try { await api('/api/graph/build', { method: 'POST' }); reload(); } catch (e) { setErr(String((e as Error).message ?? e)); } };
  const d = g.data;
  if (!d) return <div className="panel"><div className="empty">{g.error ?? 'Đang tải…'}</div></div>;
  const usable = d.state === 'ready' || d.state === 'stale';
  return (
    <div className="panel"><div className="panel-h"><h3>Bản đồ code (graphify)</h3><Link to="/preferences" className="small">Cài đặt</Link></div><div className="panel-b stack">
      <div className="small muted">Đồ thị lớp/hàm của code, dựng bằng tree-sitter (không gọi LLM), lưu ngoài project. Khi lập kế hoạch, Studio tra sẵn các tên lớp/hàm có trong yêu cầu để Claude tìm đúng chỗ.</div>
      <ul className="checks">
        <li><Mark ok={!!d.graphify && d.mcp !== false} /><div><b>graphify {d.graphify ?? 'chưa cài'}</b>
          <div className="muted small">{d.toolError ?? (d.mcp === null ? 'graphify-mcp chưa kiểm tra (chạy Kiểm tra môi trường trong Cài đặt).' : 'graphify-mcp chạy được.')}</div></div></li>
        <li><Mark ok={d.state === 'ready'} warn={d.state === 'stale' || d.state === 'building'} /><div><b>{GRAPH_STATE[d.state]}{d.updating ? ' · đang cập nhật sau task' : ''}{!d.enabled ? ' · đang tắt cho Pipelines' : ''}</b>
          <div className="muted small">
            {d.nodes !== null ? `${d.nodes.toLocaleString()} node, ${(d.edges ?? 0).toLocaleString()} cạnh. ` : ''}
            {d.builtAt ? `Dựng lúc ${new Date(d.builtAt).toLocaleString()}${d.durationMs ? ` (${(d.durationMs / 1000).toFixed(1)} s)` : ''}. ` : ''}
            {d.lastUpdateAt ? `Cập nhật lúc ${new Date(d.lastUpdateAt).toLocaleString()}. ` : ''}
            {d.commit ? `Commit ${d.commit.slice(0, 7)}.` : ''}
            {d.state === 'missing' && !d.nodes ? 'Bấm "Dựng bản đồ code" để dựng lần đầu.' : ''}
          </div>
          {d.staleReason && <div className="small">{d.staleReason}</div>}
          {d.lastError && <div className="badge-err">{d.lastError}</div>}</div></li>
      </ul>
      <div className="row">
        <button className="btn primary" disabled={!d.projectId || !d.graphify || d.state === 'building' || d.updating} onClick={build}>{usable || d.state === 'error' ? 'Dựng lại' : 'Dựng bản đồ code'}</button>
        {d.dir && <span className="small muted" title={d.dir}>Lưu ở {d.dir}</span>}
      </div>
      {err && <div className="badge-err">{err}</div>}
    </div></div>
  );
}

/** T-DB-04 */
function RecentActivity() {
  const { tasks } = useTaskData();
  const recent = (tasks.data ?? []).filter(t => ['completed', 'failed', 'cancelled'].includes(t.status))
    .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '')).slice(0, 8);
  const dur = (t: Task) => (t.startedAt && t.endedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : null);
  return (
    <div className="panel"><div className="panel-h"><h3>Hoạt động gần đây</h3><Link to="/tasks" className="small">Xem tất cả</Link></div>
      {recent.length ? <div className="tablewrap"><table>
        <thead><tr><th>Task</th><th>Trạng thái</th><th>Kết thúc</th><th>Thời lượng</th></tr></thead>
        <tbody>{recent.map(t => (
          <tr key={t.id}><td>{t.prompt.length > 70 ? t.prompt.slice(0, 70) + '…' : t.prompt}</td><td><Status s={t.status} /></td>
            <td className="small">{when(t.endedAt)}</td><td><Duration ms={dur(t)} start={t.startedAt} status={t.status} /></td></tr>
        ))}</tbody>
      </table></div> : <div className="empty">{tasks.error ?? 'Chưa có task nào kết thúc.'}</div>}
    </div>
  );
}

const Mark = ({ ok, warn }: { ok: boolean; warn?: boolean }) =>
  <span className={`mark ${ok ? 'ok' : warn ? 'warn' : 'bad'}`}>{ok ? '✓' : '!'}</span>;

export function Dashboard({ sys, summary }: { sys: SystemStatus | null; summary: ConfigSummary | null }) {
  if (!sys) return <div className="empty">Không kết nối được backend.</div>;
  const p = sys.project;
  return (
    <>
      <div className="view-head"><div><h1>Tổng quan</h1><p>Việc đang chạy, tình trạng kết nối và cấu hình đọc được từ project.</p></div></div>
      <div className="grid2">
        <div className="stack">
          <GameScanCard />
          <CodeMapCard />
          <CurrentTaskCard />
          <RecentActivity />
        </div>
        <div className="stack">
          <div className="panel"><div className="panel-h"><h3>Tình trạng hệ thống</h3></div><div className="panel-b">
            <ul className="checks">
              <li><Mark ok={!!sys.claude.version} /><div><b>Claude Code {sys.claude.version ?? 'Unknown'}</b>
                <div className="muted small">{sys.claude.error ?? `Lệnh: ${sys.claude.command}`}</div></div></li>
              <li><Mark ok={p.valid} /><div><b>Project {p.valid ? 'hợp lệ' : 'chưa hợp lệ'}</b>
                <div className="muted small">{p.path ?? <Link to="/projects">Chọn project</Link>}</div></div></li>
              <li><Mark ok={sys.studioHooksInstalled} warn /><div><b>Hook giám sát</b>
                <div className="muted small">{sys.studioHooksInstalled ? 'Đã cài trong settings.local.json' : 'Chưa cài. Session chạy từ terminal sẽ không được theo dõi'}</div></div></li>
              <li><Mark ok={!!sys.lastEventAt} warn /><div><b>Backend nhận event</b>
                <div className="muted small">{sys.lastEventAt ?? 'Chưa nhận event nào'}</div></div></li>
            </ul>
          </div></div>
        </div>
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><h3>Cấu hình đọc từ .claude/</h3>
          {summary && <span className="muted small">Đọc lúc {new Date(summary.loadedAt).toLocaleTimeString()}</span>}</div>
        {summary ? (
          <div className="counts" style={{ borderTop: 0 }}>
            <Link to="/agents"><b>{summary.agents}</b><span>agents</span></Link>
            <Link to="/skills"><b>{summary.skills}</b><span>skills{summary.skillsWithoutSkillMd.length ? ` (+${summary.skillsWithoutSkillMd.length} thiếu SKILL.md)` : ''}</span></Link>
            <Link to="/config?tab=rules"><b>{summary.rules}</b><span>rules</span></Link>
            <Link to="/config?tab=hooks"><b>{summary.hooks}</b><span>hooks của CCGS</span></Link>
            <Link to="/config?tab=templates"><b>{summary.templates}</b><span>templates</span></Link>
            <Link to="/config?tab=workflows"><b>{summary.workflows}</b><span>workflows</span></Link>
          </div>
        ) : <div className="empty">Chưa có project hợp lệ.</div>}
      </div>
    </>
  );
}
