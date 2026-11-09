import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import type { HookEntry, Rule, Template, WorkflowPhase } from '@ccgs/shared';
import { api, useApi } from '../api';
import { HookManager } from './HookManager';

const TABS = [['hooks', 'Hooks'], ['rules', 'Rules'], ['workflows', 'Workflows'], ['templates', 'Templates']] as const;
type Tab = typeof TABS[number][0];

function HookTable({ rows }: { rows: HookEntry[] }) {
  return (
    <div className="tablewrap"><table><thead><tr><th>Event</th><th>Matcher</th><th>Lệnh</th><th>Timeout</th></tr></thead><tbody>
      {rows.map((h, i) => <tr key={i}><td>{h.event}</td><td><code>{h.matcher || '*'}</code></td><td><code>{h.command}</code></td><td>{h.timeout ? `${h.timeout}s` : ''}</td></tr>)}
    </tbody></table></div>
  );
}

export function ConfigView() {
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some(t => t[0] === sp.get('tab')) ? sp.get('tab') : 'hooks') as Tab;
  const hooks = useApi<HookEntry[]>(tab === 'hooks' ? '/api/hooks' : null, ['hooks']);
  const rules = useApi<Rule[]>(tab === 'rules' ? '/api/rules' : null, ['rules']);
  const wfs = useApi<WorkflowPhase[]>(tab === 'workflows' ? '/api/workflows' : null, ['workflows']);
  const tpls = useApi<Template[]>(tab === 'templates' ? '/api/templates' : null, ['templates']);

  return (
    <>
      <div className="view-head"><div><h1>Rules, Hooks, Workflows, Templates</h1><p>Các thành phần cấu hình khác của CCGS. Chỉ xem.</p></div></div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={k === tab} onClick={() => setSp({ tab: k })}>{l}</button>)}
      </div>

      {tab === 'hooks' && hooks.data && (
        <div className="stack">
          <div className="panel"><div className="panel-h"><h3>Hook của CCGS</h3><span className="muted small">.claude/settings.json, chỉ xem</span></div>
            <HookTable rows={hooks.data.filter(h => h.owner === 'ccgs')} /></div>
          <div className="panel"><div className="panel-h"><h3>Hook giám sát của Studio</h3>
            <span className="tag">{hooks.data.some(h => h.owner === 'studio') ? 'Đã cài' : 'Chưa cài'}</span></div>
            <HookManager installed={hooks.data.some(h => h.owner === 'studio')} onDone={hooks.reload} />
            {hooks.data.some(h => h.owner === 'studio') && <HookTable rows={hooks.data.filter(h => h.owner === 'studio')} />}</div>
          {hooks.data.some(h => h.owner === 'user') && (
            <div className="panel"><div className="panel-h"><h3>Hook khác trong settings.local.json</h3></div>
              <HookTable rows={hooks.data.filter(h => h.owner === 'user')} /></div>
          )}
        </div>
      )}

      {tab === 'rules' && rules.data && (
        <div className="stack">{rules.data.map(r => (
          <details key={r.file} className="panel"><summary className="panel-h" style={{ cursor: 'pointer' }}>
            <h3><code>{r.file}</code></h3><span className="small">{r.paths.map(p => <code key={p} style={{ marginLeft: 8 }}>{p}</code>)}</span></summary>
            <div className="panel-b"><pre className="md">{r.body}</pre></div></details>
        ))}</div>
      )}

      {tab === 'workflows' && wfs.data && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>Đọc từ <code>.claude/docs/workflow-catalog.yaml</code>. Mỗi bước là một slash command; bấm để mở Task Center với skill đó. Workflow không có lệnh chạy cả chuỗi: CCGS để người dùng quyết định từng bước.</p>
          {wfs.data.map(w => (
            <div key={w.id} className="panel"><div className="panel-h"><h3>{w.label}</h3><span className="muted small">{w.steps.length} bước</span></div>
              <div className="panel-b row">{w.steps.map((s, j) => (
                <span key={s.id}>{j > 0 && <span className="muted">rồi </span>}
                  {s.command && /^\/[a-z0-9][a-z0-9._-]*$/i.test(s.command.split(' ')[0])
                    ? <Link className="tag" title={`${s.title}: chạy ${s.command}`} to={`/tasks?skill=${encodeURIComponent(s.command.split(' ')[0].slice(1))}`}>▶ {s.command}{s.required ? '' : ' (tuỳ chọn)'}</Link>
                    : <span className="tag" title={s.title}>{s.command ?? s.title}{s.required ? '' : ' (tuỳ chọn)'}</span>}</span>
              ))}{!w.steps.length && <span className="muted">Không có bước.</span>}</div></div>
          ))}
        </div>
      )}

      {tab === 'templates' && tpls.data && (
        <Templates list={tpls.data} />
      )}
    </>
  );
}

/** T-TP-01 */
function Templates({ list }: { list: Template[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const open = async (p: string) => {
    setSel(p); setBody(null); setMsg(null);
    try { setBody((await api<{ content: string }>(`/api/templates/content?path=${encodeURIComponent(p)}`)).content); } catch (e) { setMsg((e as Error).message); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(body ?? ''); setMsg('Đã sao chép nội dung.'); } catch { setMsg('Trình duyệt chặn sao chép; hãy chọn và copy tay.'); }
  };
  return (
    <div className="split">
      <div className="panel"><div className="panel-h"><h3>Template ({list.length})</h3></div>
        <div className="list-scroll" role="listbox" aria-label="Template">{list.map(t => (
          <button key={t.path} className="item" role="option" aria-selected={t.path === sel} onClick={() => open(t.path)}><b>{t.path.split('/').pop()}</b><span>{t.path}</span></button>
        ))}</div></div>
      <div className="panel"><div className="panel-h"><h3>{sel ?? 'Chọn một template'}</h3>{body !== null && <button className="btn sm" onClick={copy}>Sao chép</button>}</div>
        <div className="panel-b">{msg && <p className="small">{msg}</p>}{body !== null ? <pre className="md">{body}</pre> : sel ? !msg && <span className="muted">Đang tải…</span> : <span className="muted">Studio chỉ đọc template; không ghi vào thư mục CCGS.</span>}</div></div>
    </div>
  );
}
