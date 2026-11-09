import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Skill, SkillDetail, Task } from '@ccgs/shared';
import { useApi } from '../api';
import { Duration, Status, when } from '../monitor';

const ORIGIN: Record<Skill['origin'], string> = { ccgs: 'CCGS', local: 'Local', symlink: 'Symlink' };

export function Skills() {
  const { name } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const list = useApi<Skill[]>('/api/skills', ['skills']);
  const sel = name ?? list.data?.[0]?.name ?? null;
  const detail = useApi<SkillDetail>(sel ? `/api/skills/${encodeURIComponent(sel)}` : null, ['skills']);
  const xs = useMemo(() => {
    const ql = q.toLowerCase();
    return (list.data ?? []).filter(s => !ql || s.name.includes(ql) || s.description.toLowerCase().includes(ql));
  }, [list.data, q]);
  const s = detail.data;
  const runs = useApi<Task[]>(s ? `/api/tasks?skill=${encodeURIComponent(s.name)}` : null);

  return (
    <>
      <div className="view-head"><div><h1>Skills</h1><p>Slash command đọc từ <code>.claude/skills/</code>. Chạy skill sẽ thêm một task vào hàng đợi.</p></div></div>
      {list.error && <div className="panel"><div className="empty">{list.error}</div></div>}
      <div className="split">
        <div className="panel">
          <div className="panel-b" style={{ borderBottom: '1px solid var(--line)' }}>
            <input type="search" placeholder="Tìm skill" value={q} onChange={e => setQ(e.target.value)} aria-label="Tìm skill" />
          </div>
          <div className="list-scroll" role="listbox" aria-label="Danh sách skill">
            {xs.map(x => (
              <button key={x.dir} className="item" role="option" aria-selected={x.name === sel} onClick={() => nav(`/skills/${x.name}`)}>
                <b>/{x.name} <span className="muted" style={{ display: 'inline', fontWeight: 400 }}>{x.argumentHint ?? ''}</span>
                  {x.origin !== 'ccgs' && <span className="tag" style={{ marginLeft: 6 }}>{ORIGIN[x.origin]}</span>}
                  {!x.hasSkillMd && <span className="badge-err"> thiếu SKILL.md</span>}</b>
                <span>{x.description}</span>
              </button>
            ))}
            {!xs.length && <div className="empty">Không có skill khớp.</div>}
          </div>
        </div>
        <div className="stack">
          {s ? (
            <>
              <div className="panel"><div className="panel-h"><h3>/{s.name}</h3><div className="row"><span className="tag">{ORIGIN[s.origin]}</span>
                {s.hasSkillMd && <button className="btn sm primary" onClick={() => nav(`/tasks?skill=${encodeURIComponent(s.name)}`)}>Chạy skill</button>}</div></div><div className="panel-b">
                <p style={{ marginTop: 0 }}>{s.description}</p>
                <dl className="meta">
                  <dt>File</dt><dd><code>{s.file ?? `${s.dir} (không có SKILL.md)`}</code></dd>
                  {s.linkTarget && <><dt>Symlink tới</dt><dd><code>{s.linkTarget}</code></dd></>}
                  <dt>Tham số</dt><dd>{s.argumentHint ?? 'Không có'}</dd>
                  <dt>Model</dt><dd>{s.model ?? 'Mặc định'}</dd>
                  <dt>Allowed tools</dt><dd className="small">{s.allowedTools.length ? s.allowedTools.join(', ') : 'Không giới hạn'}</dd>
                  <dt>Agent liên quan</dt><dd>{s.relatedAgents.length ? s.relatedAgents.map((r, i) => (
                    <span key={r.name}>{i ? ', ' : ''}<Link to={`/agents/${r.name}`}>{r.name}</Link>
                      {r.via === 'mention' && <span className="muted small"> (nhắc tới)</span>}</span>
                  )) : 'Không tìm thấy'}
                    <div className="muted small">Suy ra từ nội dung SKILL.md: <code>subagent_type:</code> hoặc tên agent được nhắc.</div></dd>
                  {s.parseError && <><dt>Lỗi</dt><dd className="badge-err">{s.parseError}</dd></>}
                </dl>
              </div></div>
              <div className="panel"><div className="panel-h"><h3>Lịch sử chạy</h3><span className="muted small">Task chạy skill này từ Studio</span></div>
                {runs.data?.length ? <div className="tablewrap"><table>
                  <thead><tr><th>Tham số</th><th>Trạng thái</th><th>Bắt đầu</th><th>Thời lượng</th></tr></thead>
                  <tbody>{runs.data.map(t => (
                    <tr key={t.id}><td>{t.args ?? <span className="muted">không có</span>}</td><td><Status s={t.status} /></td><td className="small">{when(t.startedAt ?? t.createdAt)}</td>
                      <td><Duration ms={t.startedAt && t.endedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : null} start={t.startedAt} status={t.status} /></td></tr>
                  ))}</tbody></table></div>
                  : <div className="panel-b muted">{runs.error ?? 'Chưa chạy skill này từ Studio. Lần chạy từ terminal xem ở Tool và file → Skill và MCP.'}</div>}
              </div>
              <div className="panel"><div className="panel-h"><h3>Nội dung SKILL.md</h3></div><div className="panel-b">
                <pre className="md">{s.body || 'Trống'}</pre></div></div>
            </>
          ) : <div className="panel"><div className="empty">{detail.error ?? 'Chọn một skill.'}</div></div>}
        </div>
      </div>
    </>
  );
}
