import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Skill, SkillDetail, SkillGuide, Task } from '@ccgs/shared';
import { api, live, useApi } from '../api';
import { Duration, Status, when } from '../monitor';

const ORIGIN: Record<Skill['origin'], string> = { ccgs: 'CCGS', local: 'Local', symlink: 'Symlink' };
type Tab = 'guide' | 'runs' | 'md';
const TABS: [Tab, string][] = [['guide', 'Giải thích'], ['runs', 'Lịch sử chạy'], ['md', 'SKILL.md']];
const RUNNING: Task['status'][] = ['queued', 'running', 'waiting'];
const H4 = { margin: '16px 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: '.03em' };

/** One list of the explanation; hidden when Claude left it empty. */
function Items({ title, xs, ordered }: { title: string; xs: string[]; ordered?: boolean }) {
  if (!xs.length) return null;
  const L = ordered ? 'ol' : 'ul';
  return <><h4 style={H4}>{title}</h4><L style={{ margin: 0, paddingLeft: 22, listStyle: ordered ? 'decimal' : 'disc' }}>{xs.map((x, i) => <li key={i}>{x}</li>)}</L></>;
}

/** Tab Giải thích (api-contract §16): facts read from SKILL.md, plus the Vietnamese explanation Claude wrote on request. */
function Guide({ s }: { s: SkillDetail }) {
  const g = useApi<SkillGuide>(`/api/skills/${encodeURIComponent(s.name)}/guide`, ['skills', 'workflows']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = g.data;
  const taskId = d?.taskId ?? null;
  useEffect(() => {
    if (!taskId) return;
    const h = (t: Task) => { if (t.id === taskId && !RUNNING.includes(t.status)) g.reload(); };
    const so = live();
    so.on('task:upsert', h);
    return () => { so.off('task:upsert', h); };
  }, [taskId, g.reload]);
  useEffect(() => { setErr(null); }, [s.name]);

  const ask = () => {
    setBusy(true); setErr(null);
    api<SkillGuide>(`/api/skills/${encodeURIComponent(s.name)}/guide`, { method: 'POST' })
      .then(() => g.reload()).catch(e => setErr(String(e.message ?? e))).finally(() => setBusy(false));
  };
  if (!d) return <div className="panel-b muted">{g.error ?? 'Đang tải…'}</div>;
  const e = d.explain;
  const pending = !!d.taskStatus && RUNNING.includes(d.taskStatus);
  const f = d.facts;

  return (
    <div className="panel-b">
      <h4 style={{ ...H4, marginTop: 0 }}>Dùng để làm gì</h4>
      <p style={{ margin: 0 }}>{e?.purpose ?? s.description}</p>
      {!e && <p className="muted small" style={{ margin: '4px 0 0' }}>Mô tả gốc trong SKILL.md. Bấm nút dưới để Claude giải thích kỹ hơn bằng tiếng Việt.</p>}

      <div className="row" style={{ margin: '10px 0 0', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {pending
          ? <span className="small"><span className="mark pend" style={{ display: 'inline-grid', marginRight: 6 }}>…</span>
            Claude đang viết giải thích ({d.taskStatus === 'queued' ? 'đang chờ trong hàng đợi' : 'đang chạy'}). Task nằm trong <Link to="/tasks">Task Center</Link>.</span>
          : s.hasSkillMd && <button className={`btn sm${e ? '' : ' primary'}`} disabled={busy} onClick={ask}>
            {e ? (d.stale ? 'Giải thích lại theo SKILL.md mới' : 'Viết lại giải thích') : 'Nhờ Claude giải thích bằng tiếng Việt'}</button>}
        {!pending && !e && s.hasSkillMd && <span className="muted small">Tạo 1 task (model sonnet) chỉ đọc SKILL.md, có tốn phí. Kết quả được lưu, mở lại không tốn thêm.</span>}
        {e && d.explainedAt && <span className="muted small">Viết lúc {when(d.explainedAt)}</span>}
      </div>
      {d.stale && <p className="small" style={{ margin: '6px 0 0' }}><span className="mark warn" style={{ display: 'inline-grid', marginRight: 6 }}>!</span>SKILL.md đã đổi sau lần giải thích này, nội dung có thể đã cũ.</p>}
      {(err || d.error) && <p className="badge-err small" style={{ margin: '6px 0 0' }}>{err ?? d.error}</p>}

      {e && <>
        <Items title="Khi nào nên chạy" xs={e.whenToUse} />
        <Items title="Cần có trước khi chạy" xs={e.needs} />
        <Items title="Skill làm những gì" xs={e.steps} ordered />
        <Items title="Kết quả nhận được" xs={e.outputs} />
        {e.writes && <><h4 style={H4}>Ghi hoặc sửa file</h4><p style={{ margin: 0 }}>{e.writes}</p></>}
        <Items title="Không làm gì, cần lưu ý" xs={e.limits} />
        <Items title="Chạy gì tiếp theo" xs={e.next} />
      </>}

      <div style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 10 }}>
        <p className="muted small" style={{ margin: '0 0 6px' }}>Studio đọc thẳng từ SKILL.md và workflow-catalog, không qua Claude:</p>
        <h4 style={{ ...H4, marginTop: 8 }}>Vị trí trong quy trình CCGS</h4>
        {f.workflow.length ? <ul style={{ margin: 0, paddingLeft: 22, listStyle: 'disc' }}>{f.workflow.map((w, i) => (
          <li key={i}><b>{w.phase}</b>: bước "{w.step}" ({w.required ? 'bắt buộc' : 'tuỳ chọn'}).
            {w.prev && <> Trước đó: <code>{w.prev}</code>.</>}{w.next && <> Sau đó: <code>{w.next}</code>.</>}</li>))}</ul>
          : <p className="muted" style={{ margin: 0 }}>Không có trong workflow-catalog. Đây là skill dùng khi cần, không thuộc bước cố định nào.</p>}
        {f.phases.length > 0 && <Items title={`Các phần trong SKILL.md (${f.phases.length})`} xs={f.phases} ordered />}
        {f.mentions.length > 0 && <><h4 style={H4}>Skill được nhắc tới</h4>
          <p style={{ margin: 0 }}>{f.mentions.map((m, i) => <span key={m}>{i ? ', ' : ''}<Link to={`/skills/${m}`}>/{m}</Link></span>)}</p></>}
      </div>
    </div>
  );
}

export function Skills() {
  const { name } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const list = useApi<Skill[]>('/api/skills', ['skills']);
  const ccgs = useMemo(() => (list.data ?? []).filter(s => s.origin === 'ccgs'), [list.data]);
  const hidden = (list.data?.length ?? 0) - ccgs.length;
  const sel = name ?? ccgs[0]?.name ?? null;
  const detail = useApi<SkillDetail>(sel ? `/api/skills/${encodeURIComponent(sel)}` : null, ['skills']);
  const xs = useMemo(() => {
    const ql = q.toLowerCase();
    return ccgs.filter(s => !ql || s.name.includes(ql) || s.description.toLowerCase().includes(ql));
  }, [ccgs, q]);
  const s = detail.data;
  const runs = useApi<Task[]>(s ? `/api/tasks?skill=${encodeURIComponent(s.name)}` : null);
  const [tab, setTab] = useState<Tab>('guide');

  return (
    <>
      <div className="view-head"><div><h1>Skills</h1><p>Slash command đọc từ <code>.claude/skills/</code>. Chạy skill sẽ thêm một task vào hàng đợi.</p>
        {list.data && <p className="small muted">Đang hiện {ccgs.length} skill CCGS{hidden > 0 ? `, ẩn ${hidden} skill khác (Unity symlink, project)` : ''}.</p>}</div></div>
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
              <div className="panel">
                <div className="tabs" role="tablist" style={{ margin: 0, padding: '0 12px' }}>
                  {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                    {l}{k === 'runs' && runs.data?.length ? ` (${runs.data.length})` : ''}</button>)}
                </div>
                {tab === 'guide' && <Guide s={s} />}
                {tab === 'runs' && (runs.data?.length ? <div className="tablewrap"><table>
                  <thead><tr><th>Tham số</th><th>Trạng thái</th><th>Bắt đầu</th><th>Thời lượng</th></tr></thead>
                  <tbody>{runs.data.map(t => (
                    <tr key={t.id}><td>{t.args ?? <span className="muted">không có</span>}</td><td><Status s={t.status} /></td><td className="small">{when(t.startedAt ?? t.createdAt)}</td>
                      <td><Duration ms={t.startedAt && t.endedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : null} start={t.startedAt} status={t.status} /></td></tr>
                  ))}</tbody></table></div>
                  : <div className="panel-b muted">{runs.error ?? 'Chưa chạy skill này từ Studio. Lần chạy từ terminal xem ở Tool và file → Skill và MCP.'}</div>)}
                {tab === 'md' && <div className="panel-b"><pre className="md">{s.body || 'Trống'}</pre></div>}
              </div>
            </>
          ) : <div className="panel"><div className="empty">{detail.error ?? 'Chọn một skill.'}</div></div>}
        </div>
      </div>
    </>
  );
}
