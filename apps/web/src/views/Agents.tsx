import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentDefinition, AgentDetail, AgentStats } from '@ccgs/shared';
import { useApi } from '../api';
import { fmtDur, when } from '../monitor';

export function Agents() {
  const { name } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const list = useApi<AgentDefinition[]>('/api/agents', ['agents']);
  const sel = name ?? list.data?.[0]?.name ?? null;
  const detail = useApi<AgentDetail>(sel ? `/api/agents/${encodeURIComponent(sel)}` : null, ['agents']);

  const groups = useMemo(() => {
    const ql = q.toLowerCase();
    const xs = (list.data ?? []).filter(a => !ql || a.name.includes(ql) || a.description.toLowerCase().includes(ql));
    const m = new Map<string, { order: number; items: AgentDefinition[] }>();
    for (const a of xs) {
      const t = a.tier ?? 'Khác';
      const g = m.get(t) ?? { order: a.tierOrder ?? Number.MAX_SAFE_INTEGER, items: [] };
      g.items.push(a);
      m.set(t, g);
    }
    return [...m.entries()].sort((x, y) => x[1].order - y[1].order).map(([t, g]) => [t, g.items] as const);
  }, [list.data, q]);

  const a = detail.data;
  const stats = useApi<AgentStats[]>('/api/stats/agents');
  const st = a ? stats.data?.find(x => x.agentType === a.name) : undefined;
  return (
    <>
      <div className="view-head"><div><h1>Agents</h1><p>Định nghĩa agent đọc từ <code>.claude/agents/</code>. Đây là cấu hình, không có trạng thái chạy; lần chạy thực tế xem ở Agent Monitor.</p></div></div>
      {list.error && <div className="panel"><div className="empty">{list.error}</div></div>}
      <div className="split">
        <div className="panel">
          <div className="panel-b" style={{ borderBottom: '1px solid var(--line)' }}>
            <input type="search" placeholder="Tìm theo tên hoặc mô tả" value={q} onChange={e => setQ(e.target.value)} aria-label="Tìm agent" />
          </div>
          <div className="list-scroll" role="listbox" aria-label="Danh sách agent">
            {groups.length ? groups.map(([tier, xs]) => (
              <div className="tier" key={tier}><h4>{tier} ({xs.length})</h4>
                {xs.map(x => (
                  <button key={x.name} className="item" role="option" aria-selected={x.name === sel} onClick={() => nav(`/agents/${x.name}`)}>
                    <b>{x.name}{x.parseError && <span className="badge-err"> lỗi frontmatter</span>}</b><span>{x.description}</span>
                  </button>
                ))}
              </div>
            )) : <div className="empty">Không có agent khớp.</div>}
          </div>
        </div>
        <div className="stack">
          {a ? (
            <>
              <div className="panel"><div className="panel-h"><h3>{a.name}</h3></div><div className="panel-b">
                <dl className="meta">
                  <dt>Tên file</dt><dd><code>{a.file}</code></dd>
                  <dt>Cấp</dt><dd>{a.tier ?? 'Không có trong agent-roster.md'}</dd>
                  <dt>Model</dt><dd>{a.model ?? 'Unknown'}</dd>
                  <dt>Max turns</dt><dd>{a.maxTurns ?? 'Không đặt'}</dd>
                  <dt>Tools được phép</dt><dd>{a.tools.map(t => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>)}</dd>
                  {a.disallowedTools.length > 0 && <><dt>Tools bị cấm</dt><dd>{a.disallowedTools.map(t => <span key={t} className="tag" style={{ marginRight: 4 }}>{t}</span>)}</dd></>}
                  <dt>Mô tả</dt><dd>{a.description}</dd>
                  {a.parseError && <><dt>Lỗi</dt><dd className="badge-err">{a.parseError}</dd></>}
                </dl>
              </div></div>
              <div className="panel"><div className="panel-h"><h3>Thống kê chạy</h3><span className="muted small">Từ event hook, mọi session</span></div><div className="panel-b">
                {st ? <div className="statrow">
                  <div><b>{st.calls}</b><span>lần được gọi</span></div>
                  <div><b>{Math.round((st.completed / st.calls) * 100)}%</b><span>thành công ({st.failed} lỗi, {st.unknown} unknown)</span></div>
                  <div><b>{st.avgDurationMs === null ? 'Unknown' : fmtDur(st.avgDurationMs)}</b><span>thời lượng trung bình</span></div>
                  <div><b>{when(st.lastAt)}</b><span>lần cuối</span></div>
                </div> : <span className="muted">{stats.error ?? 'Agent này chưa được gọi trong session nào Studio ghi nhận.'}</span>}
              </div></div>
              <div className="panel"><div className="panel-h"><h3>Frontmatter</h3></div><div className="panel-b">
                <pre className="md">{JSON.stringify(a.frontmatter, null, 2)}</pre></div></div>
              <div className="panel"><div className="panel-h"><h3>Nội dung file</h3></div><div className="panel-b">
                <pre className="md">{a.body}</pre></div></div>
            </>
          ) : <div className="panel"><div className="empty">{detail.error ?? 'Chọn một agent.'}</div></div>}
        </div>
      </div>
    </>
  );
}
