import type { NextFunction, Request, Response } from 'express';

/**
 * Only same-machine browser origins may call the API (CSRF / DNS-rebinding guard).
 * Requests without Origin (curl, the hook client) are allowed only when Host is loopback.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK_HOSTS.has(name);
}

export function originGuard(req: Request, res: Response, next: NextFunction) {
  if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    res.status(403).json({ message: 'Origin hoặc Host không hợp lệ' });
    return;
  }
  next();
}
