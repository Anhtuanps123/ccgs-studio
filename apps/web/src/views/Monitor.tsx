import { useEffect, useMemo, useState } from 'react';
import type { AgentInvocation, ConversationItem, FileActivity, LogEntry, TimelineStep, ToolCall, ToolCallDetail, TranscriptItem } from '@ccgs/shared';
import { api, live, useApi } from '../api';
import {
  Duration, Legend, NoSessions, SessionPicker, SessionTags, Status, agentLabel, clock, fmtDur, useLiveApi, useNow, useSession, when,
} from '../monitor';
import { DiffView, TranscriptView } from '../insights';

const MON = ['invocation:upsert', 'toolcall:upsert', 'session:upsert'];
const enc = encodeURIComponent;

function Head({ title, sub, ses, right }: { title: string; sub: React.ReactNode; ses: ReturnType<typeof useSession>; right?: React.ReactNode }) {
  return (
    <div className="view-head">
      <div><h1>{title}</h1><p>{sub}</p></div>
      <div className="row" style={{ alignItems: 'flex-end' }}>{right}<SessionPicker ses={ses} /></div>
    </div>
  );
}

// ---------- M-LS-01 / M-LS-02 ----------
export function LiveSession() {
  const ses = useSession();
  const conv = useLiveApi<ConversationItem[]>(ses.id ? `/api/sessions/${enc(ses.id)}/conversation` : null, ses.id, [...MON, 'event:new']);
  return (
    <>
      <Head title="Session trực tiếp" ses={ses} sub="Prompt, phản hồi cuối mỗi lượt và các tool call của main session, cập nhật theo thời gian thực." />
      {!ses.list?.length ? <NoSessions error={ses.error} /> : (
        <div className="panel">
          <div className="panel-h"><h3 className="mono">{ses.id}</h3><SessionTags s={ses.current} /></div>
          <div className="panel-b conv">
            {conv.data?.length ? conv.data.map((it, i) => <ConvItem key={i} it={it} />) : <div className="empty">{conv.error ?? 'Chưa có nội dung.'}</div>}
            <p className="muted small">Hook không gửi phần chữ Claude viết giữa các tool call; chỉ phản hồi cuối mỗi lượt được hiện.</p>
          </div>
        </div>
      )}
    </>
  );
}

function ConvItem({ it }: { it: ConversationItem }) {
  if (it.kind === 'user') return <div className="msg user"><div className="who">Bạn, {clock(it.at)}</div><div className="bubble" style={{ whiteSpace: 'pre-wrap' }}>{it.text}</div></div>;
  if (it.kind === 'assistant') return <div className="msg ai"><div className="who">Claude, {clock(it.at)}</div><div className="bubble" style={{ whiteSpace: 'pre-wrap' }}>{it.text}</div></div>;
  const c = it.call, inv = it.invocation;
  const card = (
    <details className="tool">
      <summary><b>{c.toolName}</b>{inv ? ` ${inv.agentType}` : <code>{c.inputSummary}</code>}<Status s={inv?.status ?? c.status} />
        <span className="muted small"><Duration ms={inv?.durationMs ?? c.durationMs} start={inv?.startedAt ?? c.startedAt} status={inv?.status ?? c.status} /></span></summary>
      <div className="body small">
        {inv ? <><div><b>Nhiệm vụ:</b> {inv.description ?? 'Unknown'}</div>{inv.output && <pre className="md">{inv.output}</pre>}</>
          : c.error ? <span className="badge-err">{c.error}</span> : <span className="muted">{c.outputSummary ?? 'Chưa có kết quả'}</span>}
      </div>
    </details>
  );
  return inv ? <div className="sub-call stack" style={{ gap: 8 }}>{card}</div> : card;
}

// ---------- M-AM-01 / M-AM-02 ----------
export function AgentMonitor() {
  const ses = useSession();
  const inv = useLiveApi<AgentInvocation[]>(ses.id ? `/api/sessions/${enc(ses.id)}/invocations` : null, ses.id, MON);
  const rows = useMemo(() => treeOrder(inv.data ?? []), [inv.data]);
  const byId = new Map((inv.data ?? []).map(i => [i.id, i]));
  const [sel, setSel] = useState<string | null>(null);
  const picked = sel && byId.has(sel) ? byId.get(sel)! : null;
  return (
    <>
      <Head title="Agent Monitor" ses={ses} right={<Legend />}
        sub="Mỗi dòng là một lần gọi agent. Trạng thái chỉ lấy từ event; thiếu dữ liệu thì hiện Unknown." />
      {!ses.list?.length ? <NoSessions error={ses.error} /> : (
        <div className="panel"><div className="tablewrap"><table>
          <thead><tr><th>Agent</th><th>Được gọi bởi</th><th>Nhiệm vụ được giao</th><th>Trạng thái</th><th>Bắt đầu</th><th>Thời lượng</th></tr></thead>
          <tbody>{rows.map(i => (
            <tr key={i.id} className={`click${i.id === sel ? ' sel' : ''}`} onClick={() => setSel(i.id === sel ? null : i.id)} tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && setSel(i.id)} aria-selected={i.id === sel}>
              <td style={{ paddingLeft: 12 + i.depth * 18 }}><b>{agentLabel(i.agentType)}</b></td>
              <td className="muted">{i.parentInvocationId ? agentLabel(byId.get(i.parentInvocationId)?.agentType ?? 'unknown') : i.depth === 0 ? 'Bạn' : 'Unknown'}</td>
              <td>{i.description ?? (i.depth > 0 ? 'Unknown' : '')}</td>
              <td><Status s={i.status} /></td>
              <td className="mono">{clock(i.startedAt)}</td>
              <td><Duration ms={i.durationMs} start={i.startedAt} status={i.status} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="panel-b muted small">Bấm một dòng để xem hội thoại riêng của agent đó (đọc từ transcript).</div></div>
      )}
      {picked && ses.id && <AgentTranscript sid={ses.id} inv={picked} />}
    </>
  );
}

/** M-AM-04 */
function AgentTranscript({ sid, inv }: { sid: string; inv: AgentInvocation }) {
  const t = useLiveApi<{ file: string | null; items: TranscriptItem[]; truncated: boolean }>(
    `/api/sessions/${enc(sid)}/invocations/${enc(inv.id)}/transcript`, sid, ['invocation:upsert']);
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h"><div><h3>Transcript: {agentLabel(inv.agentType)}</h3><div className="muted small mono">{t.data?.file ?? 'Không có đường dẫn transcript'}</div></div><Status s={inv.status} /></div>
      <div className="panel-b">
        {t.data?.truncated && <p className="muted small">Chỉ hiện 1.500 mục cuối.</p>}
        {t.data ? <TranscriptView items={t.data.items} /> : <div className="empty">{t.error ?? 'Đang tải…'}</div>}
      </div>
    </div>
  );
}

/** Depth-first order so children sit under their parent. */
function treeOrder(xs: AgentInvocation[]): AgentInvocation[] {
  const kids = new Map<string | null, AgentInvocation[]>();
  const ids = new Set(xs.map(x => x.id));
  for (const x of xs) {
    const p = x.parentInvocationId && ids.has(x.parentInvocationId) ? x.parentInvocationId : x.depth === 0 ? null : '__orphan';
    kids.set(p, [...(kids.get(p) ?? []), x]);
  }
  const out: AgentInvocation[] = [];
  const walk = (p: string | null) => (kids.get(p) ?? []).sort((a, b) => (a.startedAt ?? '~').localeCompare(b.startedAt ?? '~')).forEach(x => { out.push(x); walk(x.id); });
  walk(null);
  (kids.get('__orphan') ?? []).forEach(x => { out.push(x); walk(x.id); });
  return out;
}

// ---------- M-TL-01 ----------
export function Timeline() {
  const ses = useSession();
  const tl = useLiveApi<TimelineStep[]>(ses.id ? `/api/sessions/${enc(ses.id)}/timeline` : null, ses.id, MON);
  const inv = useLiveApi<AgentInvocation[]>(ses.id ? `/api/sessions/${enc(ses.id)}/invocations` : null, ses.id, MON);
  const names = new Map((inv.data ?? []).map(i => [i.id, agentLabel(i.agentType)]));
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<'list' | 'gantt'>('gantt');
  const [limit, setLimit] = useState(500);
  const steps = tl.data ?? [];
  const cur = steps.find(s => s.id === sel) ?? steps[0];
  return (
    <>
      <Head title="Execution Timeline" ses={ses} sub="Các bước theo thời gian: lần gọi agent và tool call. Bấm một bước để xem input, output, thời lượng."
        right={<div className="chips" role="group" aria-label="Kiểu hiển thị">{([['gantt', 'Làn agent'], ['list', 'Danh sách']] as const).map(([k, l]) =>
          <button key={k} className="chip" aria-pressed={mode === k} onClick={() => setMode(k)}>{l}</button>)}</div>} />
      {!ses.list?.length ? <NoSessions error={ses.error} /> : (
        <>
          {mode === 'gantt' && <div className="panel"><Gantt invs={inv.data ?? []} steps={steps} sel={cur?.id ?? null} onSel={setSel} /></div>}
          {mode === 'list' && <div className="panel">
            {steps.length ? <ol className="steps">{steps.map(s => (
              <li key={s.id} onClick={() => setSel(s.id)} style={s.id === cur?.id ? { background: 'var(--accent-soft)' } : undefined}
                tabIndex={0} onKeyDown={e => e.key === 'Enter' && setSel(s.id)} aria-current={s.id === cur?.id}>
                <span className="mono small">{clock(s.startedAt)}</span>
                <span><b>{names.get(s.invocationId) ?? s.invocationId}</b>{s.kind === 'invocation' ? ' ▸ ' : ': '}{s.label}</span>
                <Status s={s.status} />
              </li>
            )).slice(0, limit)}</ol> : <div className="empty">{tl.error ?? 'Chưa có bước nào.'}</div>}
            {steps.length > limit && <div className="panel-b"><button className="btn" onClick={() => setLimit(l => l + 500)}>Hiện thêm ({steps.length - limit} bước)</button></div>}
          </div>}
          {cur && (
            <div className="panel" style={{ marginTop: 16 }}>
              <div className="panel-h"><h3>{cur.label}</h3><Status s={cur.status} /></div>
              <div className="panel-b"><dl className="detail-grid">
                <dt>Agent</dt><dd>{names.get(cur.invocationId) ?? cur.invocationId}</dd>
                <dt>Bắt đầu</dt><dd>{cur.startedAt ? when(cur.startedAt) : 'Không xác định'}</dd>
                <dt>Kết thúc</dt><dd>{cur.endedAt ? when(cur.endedAt) : cur.status === 'running' || cur.status === 'waiting' ? 'Đang chạy' : 'Không xác định'}</dd>
                <dt>Thời lượng</dt><dd><Duration ms={cur.durationMs} start={cur.startedAt} status={cur.status} /></dd>
                <dt>Input</dt><dd><pre className="md">{cur.input ?? 'Unknown'}</pre></dd>
                <dt>Output</dt><dd><pre className="md">{cur.output ?? (cur.status === 'running' ? 'Chưa có' : 'Unknown')}</pre></dd>
              </dl></div>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** M-TL-02: one lane per agent; the agent's span on top, its tool calls below. */
function Gantt({ invs, steps, sel, onSel }: { invs: AgentInvocation[]; steps: TimelineStep[]; sel: string | null; onSel: (id: string) => void }) {
  const live = steps.some(s => s.status === 'running' || s.status === 'waiting');
  const now = useNow(live);
  const t = (iso: string | null) => (iso ? Date.parse(iso) : null);
  const starts = steps.map(s => t(s.startedAt)).filter((x): x is number => x !== null);
  if (!starts.length) return <div className="empty">Chưa có bước nào có thời điểm bắt đầu.</div>;
  const endOf = (s: TimelineStep) => t(s.endedAt) ?? (s.status === 'running' || s.status === 'waiting' ? Math.max(now, t(s.startedAt) ?? now) : t(s.startedAt));
  const t0 = Math.min(...starts);
  const t1 = Math.max(t0 + 1000, ...steps.map(s => endOf(s) ?? t0));
  const span = t1 - t0;
  const pct = (x: number) => ((x - t0) / span) * 100;
  const ticks = Array.from({ length: 6 }, (_, i) => t0 + (span * i) / 5);
  const lanes = treeOrder(invs);
  const noStart = steps.filter(s => !s.startedAt).length;
  const bar = (s: TimelineStep, top: number, h: number) => {
    const a = t(s.startedAt);
    if (a === null) return null;
    const b = endOf(s) ?? a;
    const left = pct(a), width = Math.max(0.4, pct(b) - left);
    return (
      <button key={s.id} className="bar" data-s={s.status} aria-pressed={s.id === sel} onClick={() => onSel(s.id)}
        title={`${s.label} · ${fmtDur(s.durationMs ?? (b - a))}`}
        style={{ left: `${left}%`, width: `${width}%`, top, height: h, fontSize: h < 20 ? 10.5 : 12, padding: h < 20 ? '0 4px' : undefined }}>
        {s.kind === 'invocation' ? s.label : s.label.split(' ')[0]}
      </button>
    );
  };
  return (
    <div className="panel-b"><div className="tablewrap"><div className="tl" style={{ minWidth: 720 }}>
      <div className="tl-ruler"><div /><div className="track">{ticks.map((x, i) => <span key={i} className="tick" style={{ left: `${pct(x)}%` }}>{fmtDur(x - t0)}</span>)}</div></div>
      {lanes.map(i => {
        const inv = steps.find(s => s.kind === 'invocation' && s.id === i.id);
        const tools = steps.filter(s => s.kind === 'tool' && s.invocationId === i.id);
        return (
          <div key={i.id} className="tl-lane" style={{ minHeight: tools.length ? 66 : 48 }}>
            <div className="lab" style={{ paddingLeft: i.depth * 12 }}><b>{agentLabel(i.agentType)}</b><span>{tools.length} tool call</span></div>
            <div className="track">
              {inv && bar(inv, 8, 24)}
              {tools.map(s => bar(s, 38, 18))}
              {live && <div className="nowline" style={{ left: `${pct(now)}%` }} />}
            </div>
          </div>
        );
      })}
    </div></div>
      {noStart > 0 && <p className="muted small">{noStart} bước không có thời điểm bắt đầu (thiếu event) nên không vẽ được trên trục thời gian.</p>}
    </div>
  );
}

// ---------- M-TS-01 ----------
const TS_TABS = [['calls', 'Tool call'], ['bash', 'Lệnh Bash'], ['files', 'Hoạt động file'], ['skills', 'Skill và MCP']] as const;
const FILE_OP: Record<string, string> = { read: 'Đọc', create: 'Tạo', edit: 'Sửa', write: 'Ghi đè' };

export function ToolActivity() {
  const ses = useSession();
  const [tab, setTab] = useState<(typeof TS_TABS)[number][0]>('calls');
  const [tool, setTool] = useState('all');
  const [sel, setSel] = useState<string | null>(null);
  const all = useLiveApi<ToolCall[]>(ses.id ? `/api/sessions/${enc(ses.id)}/toolcalls` : null, ses.id, MON);
  const inv = useLiveApi<AgentInvocation[]>(ses.id ? `/api/sessions/${enc(ses.id)}/invocations` : null, ses.id, MON);
  const files = useLiveApi<FileActivity[]>(ses.id && tab === 'files' ? `/api/sessions/${enc(ses.id)}/files` : null, ses.id, MON);
  const names = new Map((inv.data ?? []).map(i => [i.id, agentLabel(i.agentType)]));
  const group = (t: string) => (t.startsWith('mcp__') ? 'MCP' : t);
  const tools = ['all', ...new Set((all.data ?? []).map(t => group(t.toolName)))];
  const rows = (all.data ?? []).filter(t => tool === 'all' || group(t.toolName) === tool);
  const bash = (all.data ?? []).filter(t => t.toolName === 'Bash' || t.toolName === 'PowerShell');
  const skills = (all.data ?? []).filter(t => t.toolName === 'Skill' || t.toolName.startsWith('mcp__'));
  const mcpServers = [...new Set(skills.filter(t => t.toolName.startsWith('mcp__')).map(t => t.toolName.split('__')[1]))];
  const rowProps = (id: string) => ({ className: `click${id === sel ? ' sel' : ''}`, onClick: () => setSel(id === sel ? null : id), tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && setSel(id) });
  return (
    <>
      <Head title="Tool và file" ses={ses} sub="Tool, skill, MCP và lệnh mà các agent đã gọi. Bấm một dòng để xem chi tiết." />
      {!ses.list?.length ? <NoSessions error={ses.error} /> : (<>
        <div className="tabs" role="tablist">{TS_TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={k === tab} onClick={() => { setTab(k); setSel(null); }}>{l}</button>)}</div>
        {tab === 'bash' && <div className="panel"><div className="panel-h"><h3>Lệnh Bash ({bash.length})</h3></div><div className="tablewrap"><table>
          <thead><tr><th>Thời gian</th><th>Agent</th><th>Lệnh</th><th>Trạng thái</th><th>Thời lượng</th></tr></thead>
          <tbody>{bash.length ? bash.map(t => (
            <tr key={t.id} {...rowProps(t.id)}><td className="mono">{clock(t.startedAt)}</td><td>{names.get(t.invocationId) ?? t.invocationId}</td>
              <td><code>{t.inputSummary}</code></td><td><Status s={t.status} /></td><td><Duration ms={t.durationMs} start={t.startedAt} status={t.status} /></td></tr>
          )) : <tr><td colSpan={5} className="muted">Không có lệnh Bash.</td></tr>}</tbody></table></div></div>}
        {tab === 'files' && <div className="panel"><div className="panel-h"><h3>Hoạt động file ({files.data?.length ?? 0})</h3></div><div className="tablewrap"><table>
          <thead><tr><th>Thời gian</th><th>Agent</th><th>Thao tác</th><th>File</th><th>Trạng thái</th></tr></thead>
          <tbody>{files.data?.length ? files.data.map(f => (
            <tr key={f.toolCallId} {...rowProps(f.toolCallId)}><td className="mono">{clock(f.at)}</td><td>{names.get(f.invocationId) ?? f.invocationId}</td>
              <td><span className="tag">{FILE_OP[f.op]}</span></td><td><code>{f.path}</code></td><td><Status s={f.status} /></td></tr>
          )) : <tr><td colSpan={5} className="muted">{files.error ?? 'Không có thao tác file.'}</td></tr>}</tbody></table></div></div>}
        {tab === 'skills' && <div className="panel"><div className="panel-h"><h3>Skill và MCP ({skills.length})</h3>
          <span className="muted small">{mcpServers.length ? `MCP server: ${mcpServers.join(', ')}` : 'Không có MCP server nào được gọi'}</span></div><div className="tablewrap"><table>
          <thead><tr><th>Thời gian</th><th>Agent</th><th>Loại</th><th>Tên</th><th>Trạng thái</th><th>Thời lượng</th></tr></thead>
          <tbody>{skills.length ? skills.map(t => {
            const mcp = t.toolName.startsWith('mcp__') ? t.toolName.split('__') : null;
            return (
              <tr key={t.id} {...rowProps(t.id)}><td className="mono">{clock(t.startedAt)}</td><td>{names.get(t.invocationId) ?? t.invocationId}</td>
                <td><span className="tag">{mcp ? `MCP ${mcp[1]}` : 'Skill'}</span></td><td><code>{mcp ? mcp.slice(2).join('__') : t.inputSummary}</code></td>
                <td><Status s={t.status} /></td><td><Duration ms={t.durationMs} start={t.startedAt} status={t.status} /></td></tr>
            );
          }) : <tr><td colSpan={6} className="muted">Không có skill hay MCP tool nào được gọi.</td></tr>}</tbody></table></div></div>}
        {tab === 'calls' && <div className="panel">
          <div className="panel-h"><h3>Tool call ({rows.length})</h3>
            <div className="chips" role="group" aria-label="Lọc theo tool">{tools.map(t => <button key={t} className="chip" aria-pressed={t === tool} onClick={() => setTool(t)}>{t === 'all' ? 'Tất cả' : t}</button>)}</div></div>
          <div className="tablewrap"><table>
            <thead><tr><th>Thời gian</th><th>Agent</th><th>Tool</th><th>Input</th><th>Trạng thái</th><th>Thời lượng</th></tr></thead>
            <tbody>{rows.length ? rows.slice(0, 1000).map(t => (
              <tr key={t.id} title={t.error ?? t.outputSummary ?? ''} {...rowProps(t.id)}>
                <td className="mono">{clock(t.startedAt)}</td><td>{names.get(t.invocationId) ?? t.invocationId}</td>
                <td><b>{t.toolName}</b></td><td><code>{t.inputSummary}</code>{t.error && <div className="badge-err small">{t.error}</div>}</td>
                <td><Status s={t.status} /></td><td><Duration ms={t.durationMs} start={t.startedAt} status={t.status} /></td>
              </tr>
            )) : <tr><td colSpan={6} className="muted">{all.error ?? 'Chưa có tool call.'}</td></tr>}</tbody>
          </table></div>
          {rows.length > 1000 && <div className="panel-b muted small">Hiện 1.000 / {rows.length} tool call. Lọc theo tool để xem phần còn lại.</div>}
        </div>}
        {sel && <ToolDetail id={sel} />}
      </>)}
    </>
  );
}

function ToolDetail({ id }: { id: string }) {
  const d = useLiveApi<ToolCallDetail>(`/api/toolcalls/${enc(id)}`, null, ['toolcall:upsert']);
  const x = d.data;
  if (!x) return <div className="panel" style={{ marginTop: 16 }}><div className="empty">{d.error ?? 'Đang tải…'}</div></div>;
  const SRC = { response: 'từ kết quả tool', error: 'từ thông báo lỗi', inferred: 'suy ra: Claude Code báo lệnh thoát khác 0 là lỗi' } as const;
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h"><h3>{x.toolName} <code className="small">{x.inputSummary}</code></h3><Status s={x.status} /></div>
      <div className="panel-b stack">
        <dl className="detail-grid">
          <dt>Bắt đầu</dt><dd>{x.startedAt ? when(x.startedAt) : 'Không xác định'}</dd>
          <dt>Thời lượng</dt><dd><Duration ms={x.durationMs} start={x.startedAt} status={x.status} /></dd>
          {x.bash && <><dt>Lệnh</dt><dd><pre className="md" style={{ margin: 0 }}>{x.bash.command}</pre></dd>
            <dt>Exit code</dt><dd>{x.bash.exitCode === null ? 'Unknown' : <><b>{x.bash.exitCode}</b> <span className="muted small">({SRC[x.bash.exitCodeSource!]})</span></>}</dd>
            <dt>Output</dt><dd><pre className="md" style={{ margin: 0 }}>{x.bash.output || '(trống)'}</pre></dd></>}
          {x.file && <><dt>File</dt><dd><code>{x.file.path}</code> <span className="tag">{FILE_OP[x.file.op]}</span></dd></>}
          {x.error && <><dt>Lỗi</dt><dd className="badge-err">{x.error}</dd></>}
        </dl>
        {x.file?.diff && <div><div className="muted small">Thay đổi</div><DiffView lines={x.file.diff} /></div>}
        {!x.bash && !x.file?.diff && <>
          <details><summary className="small">Input đầy đủ</summary><pre className="md">{JSON.stringify(x.input, null, 2)}</pre></details>
          <details><summary className="small">Kết quả</summary><pre className="md">{x.response === null ? 'Unknown' : typeof x.response === 'string' ? x.response : JSON.stringify(x.response, null, 2)}</pre></details>
        </>}
      </div>
    </div>
  );
}

// ---------- M-LG-01 ----------
const LVL: Record<string, [string, string]> = { info: ['Info', 'var(--done)'], warn: ['Warning', 'var(--wait)'], error: ['Error', 'var(--fail)'] };
const SRC: Record<string, string> = { studio: 'Studio', claude: 'Claude Code', hook: 'Hook' };

export function Logs() {
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [session, setSession] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const sessions = useApi<{ id: string; startedAt: string; external: boolean; firstPrompt: string | null }[]>('/api/sessions');
  const iso = (v: string) => (v ? new Date(v).toISOString() : '');
  const [items, setItems] = useState<LogEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = (before?: number | null) => `/api/logs?level=${level}&source=${source}&q=${enc(q)}&session=${enc(session)}&from=${enc(iso(from))}&to=${enc(iso(to))}${before ? `&before=${before}` : ''}`;

  useEffect(() => {
    let off = false;
    const t = setTimeout(() => api<{ items: LogEntry[]; next: number | null }>(qs()).then(r => { if (!off) { setItems(r.items); setNext(r.next); setError(null); } }).catch(e => setError(String(e.message))), 200);
    return () => { off = true; clearTimeout(t); };
  }, [level, source, q, session, from, to]);

  useEffect(() => {
    const h = (l: LogEntry) => {
      if ((level && l.level !== level) || (source && l.source !== source) || (q && !l.message.toLowerCase().includes(q.toLowerCase()))) return;
      if ((session && l.sessionId !== session) || (to && l.timestamp > iso(to)) || (from && l.timestamp < iso(from))) return;
      setItems(xs => [l, ...xs]);
    };
    const s = live(); s.on('log:new', h);
    return () => { s.off('log:new', h); };
  }, [level, source, q, session, from, to]);

  const more = () => next && api<{ items: LogEntry[]; next: number | null }>(qs(next)).then(r => { setItems(xs => [...xs, ...r.items]); setNext(r.items.length ? r.next : null); });

  return (
    <>
      <div className="view-head"><div><h1>Logs và lỗi</h1><p>Log của Studio, Claude Code và hook. Giá trị bí mật đã được che trước khi lưu. Log không ghi agent nào phát sinh, nên không lọc theo agent được.</p></div></div>
      <div className="panel">
        <div className="panel-b row" style={{ borderBottom: '1px solid var(--line)' }}>
          <input type="search" placeholder="Tìm trong log" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 280 }} aria-label="Tìm trong log" />
          <div className="chips">{[['', 'Mọi mức'], ['info', 'Info'], ['warn', 'Warning'], ['error', 'Error']].map(([k, l]) => <button key={k} className="chip" aria-pressed={k === level} onClick={() => setLevel(k)}>{l}</button>)}</div>
          <select value={source} onChange={e => setSource(e.target.value)} style={{ maxWidth: 180 }} aria-label="Nguồn">
            <option value="">Mọi nguồn</option>{Object.entries(SRC).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select value={session} onChange={e => setSession(e.target.value)} style={{ maxWidth: 260 }} aria-label="Session">
            <option value="">Mọi session</option>
            {(sessions.data ?? []).map(s => <option key={s.id} value={s.id}>{s.id.slice(0, 8)} · {when(s.startedAt)}{s.external ? ' (External)' : ''}</option>)}
          </select>
          <label className="small muted row" style={{ gap: 4 }}>Từ <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} style={{ width: 'auto' }} /></label>
          <label className="small muted row" style={{ gap: 4 }}>Đến <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} style={{ width: 'auto' }} /></label>
          {(session || from || to) && <button className="btn sm" onClick={() => { setSession(''); setFrom(''); setTo(''); }}>Bỏ lọc</button>}
        </div>
        <div className="tablewrap"><table>
          <thead><tr><th>Thời gian</th><th>Mức</th><th>Nguồn</th><th>Session</th><th>Nội dung</th></tr></thead>
          <tbody>{items.length ? items.map(l => (
            <tr key={l.id}><td className="mono">{when(l.timestamp)}</td><td><b style={{ color: LVL[l.level]?.[1] }}>{LVL[l.level]?.[0] ?? l.level}</b></td>
              <td>{SRC[l.source] ?? l.source}</td><td className="mono small">{l.sessionId?.slice(0, 8) ?? ''}</td><td><Redacted text={l.message} /></td></tr>
          )) : <tr><td colSpan={5} className="muted">{error ?? 'Không có log khớp bộ lọc.'}</td></tr>}</tbody>
        </table></div>
        {next && items.length >= 200 && <div className="panel-b"><button className="btn" onClick={more}>Tải thêm</button></div>}
      </div>
    </>
  );
}

const Redacted = ({ text }: { text: string }) => {
  const parts = text.split('[đã che]');
  return <>{parts.map((p, i) => <span key={i}>{p}{i < parts.length - 1 && <span className="redacted">đã che</span>}</span>)}</>;
};
