import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ConfigKind } from '@ccgs/shared';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

let socket: Socket | null = null;
export function live(): Socket {
  if (!socket) socket = io('/live', { transports: ['websocket'] });
  return socket;
}

/**
 * Fetch JSON and refetch when the server reports a config change of one of `kinds`.
 * Keeps the previous data while reloading so views do not flicker.
 */
export function useApi<T>(path: string | null, kinds: ConfigKind[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kindsKey = kinds.join(',');
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(() => {
    if (!path) return;
    api<T>(path).then(d => { if (pathRef.current === path) { setData(d); setError(null); } })
      .catch(e => { if (pathRef.current === path) setError(String(e.message ?? e)); });
  }, [path]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!kindsKey) return;
    const want = kindsKey.split(',');
    const h = (p: { kinds: string[] }) => { if (p.kinds.some(k => want.includes(k))) load(); };
    const s = live();
    s.on('config:changed', h);
    return () => { s.off('config:changed', h); };
  }, [kindsKey, load]);

  return { data, error, reload: load };
}

export const ALL_KINDS: ConfigKind[] = ['agents', 'skills', 'rules', 'hooks', 'templates', 'workflows'];
