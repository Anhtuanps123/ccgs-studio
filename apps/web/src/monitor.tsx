// Shared helpers for the Monitor views (Phase 2).
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Session } from '@ccgs/shared';
import { api, live, useApi } from './api';

export type SessionRow = Session & { live: boolean; invocationCount: number };

const STATUS_VI: Record<string, string> = {
  queued: 'Queued', running: 'Running', waiting: 'Waiting', completed: 'Completed', failed: 'Failed', unknown: 'Unknown', cancelled: 'Cancelled',
};
export const Status = ({ s }: { s: string }) => <span className="status" data-s={s}>{STATUS_VI[s] ?? s}</span>;
export const Legend = () => <div className="legend small">{['running', 'waiting', 'completed', 'failed', 'unknown'].map(s => <Status key={s} s={s} />)}</div>;

export function fmtDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '?';
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
export const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour12: false }) : '?');
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour12: false }) : '?');
export const agentLabel = (type: string) => (type === 'main' ? 'Main session' : type);

/** Ticks every second while `on`, for live durations of running items. */
export function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [on]);
  return now;
}
export function Duration({ ms, start, status }: { ms: number | null; start: string | null; status: string }) {
  const running = (status === 'running' || status === 'waiting') && !!start;
  const now = useNow(running);
  if (running) return <span className="mono">{fmtDur(now - Date.parse(start!))}</span>;
  return <span className="mono">{status === 'unknown' && ms === null ? '?' : fmtDur(ms)}</span>;
}

/**
 * Like useApi, but refetches (throttled) when a live monitor event for this session arrives.
 * `events` are Socket.IO event names; payloads with a sessionId/id are matched to `sessionId`.
 */
export function useLiveApi<T>(path: string | null, sessionId: string | null, events: string[]) {
  const r = useApi<T>(path);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = r.reload;
  const key = events.join(',');
  useEffect(() => {
    if (!path) return;
    const s = live();
    const h = (p: any) => {
      const sid = p?.sessionId ?? (p && 'external' in p ? p.id : undefined);
      if (sessionId && sid && sid !== sessionId) return;
      if (timer.current) return;
      timer.current = setTimeout(() => { timer.current = null; reload(); }, 250);
    };
    const evs = key.split(',');
    evs.forEach(e => s.on(e, h));
    return () => { evs.forEach(e => s.off(e, h)); if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [path, sessionId, key, reload]);
  return r;
}

/** Selected session from ?s=, defaulting to the most recent one. */
export function useSession() {
  const [sp, setSp] = useSearchParams();
  const list = useLiveApi<SessionRow[]>('/api/sessions', null, ['session:upsert', 'monitor:cleared']);
  const id = sp.get('s') ?? list.data?.[0]?.id ?? null;
  const current = list.data?.find(s => s.id === id) ?? null;
  const select = (sid: string) => { const n = new URLSearchParams(sp); n.set('s', sid); setSp(n, { replace: true }); };
  /** After a delete: back to the most recent session. */
  const clear = () => { const n = new URLSearchParams(sp); n.delete('s'); setSp(n, { replace: true }); list.reload(); };
  return { list: list.data, error: list.error, id, current, select, clear };
}

/** "Xoá session": the selected session with its events, agents, tool calls and logs (DELETE /api/sessions/:id). */
export function DeleteSessionButton({ ses }: { ses: ReturnType<typeof useSession> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!ses.id) return null;
  const running = !!ses.current?.live;
  const go = async () => {
    if (!ses.id || !confirm(`Xoá session ${ses.id.slice(0, 8)} cùng event, agent, tool call và log của nó? Không khôi phục được. Task trong Task Center vẫn giữ.`)) return;
    setBusy(true); setErr(null);
    try { await api(`/api/sessions/${encodeURIComponent(ses.id)}`, { method: 'DELETE' }); ses.clear(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <span className="stack" style={{ gap: 2 }}>
      <button className="btn" disabled={busy || running} title={running ? 'Session đang chạy, chưa xoá được' : ''} onClick={go}>Xoá session</button>
      {err && <span className="badge-err small">{err}</span>}
    </span>
  );
}

export function SessionPicker({ ses }: { ses: ReturnType<typeof useSession> }) {
  if (!ses.list?.length) return null;
  return (
    <div className="field" style={{ margin: 0, minWidth: 280 }}>
      <label htmlFor="sess">Session</label>
      <select id="sess" value={ses.id ?? ''} onChange={e => ses.select(e.target.value)}>
        {ses.list.map(s => (
          <option key={s.id} value={s.id}>
            {s.id.slice(0, 8)} · {when(s.startedAt)}{s.external ? ' (External)' : ''}{s.live ? ' (đang chạy)' : ''}
            {s.firstPrompt ? ` · ${s.firstPrompt.slice(0, 40)}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SessionTags({ s }: { s: SessionRow | null }) {
  if (!s) return null;
  return (
    <span className="row" style={{ gap: 6 }}>
      {s.external && <span className="tag ext">External</span>}
      {s.live ? <Status s="running" /> : <span className="muted small">Kết thúc {clock(s.endedAt)}{s.endReason ? ` (${s.endReason})` : ''}</span>}
    </span>
  );
}

/** Shown when there is no data yet: explains why instead of faking anything. */
export function NoSessions({ error }: { error: string | null }) {
  const sys = useApi<{ studioHooksInstalled: boolean }>('/api/system', ['hooks']);
  return (
    <div className="panel"><div className="empty">
      {error ?? (sys.data?.studioHooksInstalled
        ? 'Chưa nhận session nào. Chạy claude trong project là dữ liệu sẽ hiện ở đây.'
        : <>Chưa có session. Cài hook giám sát ở <a href="/config?tab=hooks">Rules, Hooks, khác → Hooks</a> để theo dõi session chạy từ terminal.</>)}
    </div></div>
  );
}

export { api };
