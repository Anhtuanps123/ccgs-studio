import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { AlertKey, ConfigSummary, NavAlerts, SystemStatus } from '@ccgs/shared';
import { ALL_KINDS, api, live, useApi } from './api';
import { Dashboard } from './views/Dashboard';
import { Agents } from './views/Agents';
import { Skills } from './views/Skills';
import { ConfigView } from './views/Config';
import { Project } from './views/Project';
import { Preferences } from './views/Preferences';
import { Performance } from './views/Performance';
import { Pipelines } from './views/Pipelines';
import { Tasks } from './views/Tasks';
import { Setup } from './views/Setup';
import { AgentMonitor, LiveSession, Logs, Timeline, ToolActivity } from './views/Monitor';

function toggleTheme() {
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('ccgs-theme', r.dataset.theme); } catch { /* ignore */ }
}

// Items whose count means "new since you last opened the page"; opening it resets the count.
const SINCE_KEYS: AlertKey[] = ['tasks', 'pipelines', 'agent-monitor', 'tool-activity', 'logs'];
const SEEN_KEY = 'ccgs-alerts-seen';
const LIVE_EVENTS = ['task:upsert', 'pipeline:upsert', 'interaction:new', 'interaction:resolved', 'log:new', 'toolcall:upsert', 'invocation:upsert', 'config:changed'];

function readSeen(): Partial<Record<AlertKey, string>> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

/** Problem counts per sidebar item, refreshed on live events (throttled) and every 30s. */
function useAlerts() {
  const [alerts, setAlerts] = useState<NavAlerts>({});
  const seen = useRef(readSeen());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    const q = new URLSearchParams();
    for (const k of SINCE_KEYS) if (seen.current[k]) q.set(k, seen.current[k]!);
    api<NavAlerts>(`/api/alerts?${q}`).then(setAlerts).catch(() => { /* backend down: topbar shows it */ });
  }, []);
  const soon = useCallback(() => { if (!timer.current) timer.current = setTimeout(() => { timer.current = null; load(); }, 1000); }, [load]);
  useEffect(() => {
    load();
    const s = live();
    for (const e of LIVE_EVENTS) s.on(e, soon);
    const iv = setInterval(load, 30_000);
    return () => { for (const e of LIVE_EVENTS) s.off(e, soon); clearInterval(iv); };
  }, [load, soon]);
  const markSeen = useCallback((k: AlertKey) => {
    if (!SINCE_KEYS.includes(k)) return;
    seen.current = { ...seen.current, [k]: new Date().toISOString() };
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen.current)); } catch { /* ignore */ }
    load();
  }, [load]);
  return { alerts, markSeen };
}

const Item = ({ to, label, count, alert }: { to: string; label: string; count?: number | string; alert?: { count: number; reasons: string[] } }) => (
  <NavLink to={to} title={alert ? alert.reasons.join('\n') : undefined}>
    {label} <span>{count !== undefined && <span className="count">{count}</span>}
    {alert && alert.count > 0 && <span className="alert-badge" aria-label={`${alert.count} vấn đề: ${alert.reasons.join(', ')}`}>{alert.count > 99 ? '99+' : alert.count}</span>}</span>
  </NavLink>
);

export function App() {
  const sys = useApi<SystemStatus>('/api/system', ['hooks']);
  const sum = useApi<ConfigSummary>(sys.data?.project.valid ? '/api/config/summary' : null, ALL_KINDS);
  const p = sys.data?.project;
  const { alerts, markSeen } = useAlerts();
  const loc = useLocation();
  const here = loc.pathname.split('/')[1] as AlertKey;
  useEffect(() => { markSeen(here); }, [here, markSeen]);
  const al: NavAlerts = { ...alerts };
  if (sys.data?.claude.error) al.preferences = { count: 1, reasons: [`Không chạy được Claude CLI: ${sys.data.claude.error}`] };

  return (
    <div className="app">
      <aside className="side" aria-label="Điều hướng">
        <div className="brand"><div className="brand-mark" aria-hidden="true">CS</div><div><b>CCGS Studio</b><small>Bảng điều khiển local</small></div></div>
        <nav className="nav-group" aria-label="Tools">
          <h2>Tools</h2>
          <Item to="/dashboard" label="Tổng quan" alert={al["dashboard"]} />
          <Item to="/agents" label="Agents" alert={al["agents"]} count={sum.data?.agents} />
          <Item to="/skills" label="Skills" alert={al["skills"]} count={sum.data?.skills} />
          <Item to="/config" label="Rules, Hooks, khác" alert={al["config"]} />
          <Item to="/projects" label="Project" alert={al["projects"]} />
          <Item to="/pipelines" label="Lập kế hoạch" alert={al["pipelines"]} />
          <Item to="/tasks" label="Task Center" alert={al["tasks"]} />
        </nav>
        <nav className="nav-group" aria-label="Monitor">
          <h2>Monitor</h2>
          <Item to="/live" label="Session trực tiếp" alert={al["live"]} />
          <Item to="/agent-monitor" label="Agent Monitor" alert={al["agent-monitor"]} />
          <Item to="/timeline" label="Timeline" alert={al["timeline"]} />
          <Item to="/tool-activity" label="Tool và file" alert={al["tool-activity"]} />
          <Item to="/logs" label="Logs" alert={al["logs"]} />
          <Item to="/performance" label="Hiệu suất" alert={al["performance"]} />
        </nav>
        <nav className="nav-group" aria-label="Hệ thống">
          <h2>Hệ thống</h2>
          <Item to="/preferences" label="Cài đặt" alert={al["preferences"]} />
          <Item to="/setup" label="Cài package" />
        </nav>
        <div className="side-foot">
          Claude Code {sys.data?.claude.version ?? 'Unknown'}<br />Backend 127.0.0.1:4310
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="proj">{p?.name ?? 'Chưa chọn project'} <span>{p?.path ?? ''}</span></div>
          <span className="grow" />
          {sys.error && <span className="badge-err">Không kết nối được backend</span>}
          <button className="iconbtn" type="button" onClick={toggleTheme} aria-label="Đổi giao diện sáng tối">Sáng / tối</button>
        </header>
        <section className="view">
          {!sys.data && !sys.error ? <div className="empty">Đang tải…</div> : (
            <Routes>
              <Route path="/" element={<Navigate to={p?.valid ? '/dashboard' : '/projects'} replace />} />
              <Route path="/dashboard" element={<Dashboard sys={sys.data} summary={sum.data} />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/agents/:name" element={<Agents />} />
              <Route path="/skills" element={<Skills />} />
              <Route path="/skills/:name" element={<Skills />} />
              <Route path="/config" element={<ConfigView />} />
              <Route path="/projects" element={<Project onChanged={() => { sys.reload(); sum.reload(); }} />} />
              <Route path="/preferences" element={<Preferences onChanged={sys.reload} />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/pipelines" element={<Pipelines />} />
              <Route path="/live" element={<LiveSession />} />
              <Route path="/agent-monitor" element={<AgentMonitor />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="/tool-activity" element={<ToolActivity />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/performance" element={<Performance />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </section>
      </div>
    </div>
  );
}
