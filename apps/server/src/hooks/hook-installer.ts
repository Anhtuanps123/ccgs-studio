// T-HK-02: install / uninstall the Studio hook in <project>/.claude/settings.local.json.
// Only that file is touched. Every write needs the hash of a preview the user has seen.
// Uninstall restores the exact original bytes when nothing else changed meanwhile.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HookPreview } from '@ccgs/shared';
import { STUDIO_HOOK_MARKER } from '../ccgs/parser';

export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'Notification', 'PreCompact',
] as const;
export const HOOK_TIMEOUT_S = 2;

const SETTINGS_REL = '.claude/settings.local.json';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function hookCommand(scriptPath: string, origin: 'local' | 'studio') {
  return `node "${scriptPath.replace(/\\/g, '/')}" ${origin}`;
}

/** Settings object with the Studio hook added for every event (existing hooks kept, ours appended). */
export function withStudioHooks(json: any, command: string): any {
  const out = structuredClone(json ?? {});
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const groups = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    out.hooks[ev] = [...groups, { matcher: '', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }];
  }
  return out;
}

/** Settings object with every Studio hook command removed; empty groups/events/hooks key dropped. */
export function withoutStudioHooks(json: any): any {
  const out = structuredClone(json ?? {});
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const [ev, groups] of Object.entries<any>(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map(g => ({ ...g, hooks: (g?.hooks ?? []).filter((h: any) => !String(h?.command ?? '').includes(STUDIO_HOOK_MARKER)) }))
      .filter(g => g.hooks.length > 0);
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export const hasStudioHooks = (json: any) =>
  Object.values<any>(json?.hooks ?? {}).some(gs => Array.isArray(gs) && gs.some(g => (g?.hooks ?? []).some((h: any) => String(h?.command ?? '').includes(STUDIO_HOOK_MARKER))));

/** Minimal LCS line diff; settings files are small. */
export function lineDiff(a: string, b: string): HookPreview['diff'] {
  const x = a ? a.split(/\r?\n/) : [], y = b ? b.split(/\r?\n/) : [];
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: HookPreview['diff'] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push({ op: 'ctx', line: x[i] }); i++; j++; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) out.push({ op: 'add', line: y[j++] });
    else out.push({ op: 'del', line: x[i++] });
  }
  return out;
}

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

export class HookInstaller {
  /** @param studioHome ~/.ccgs-studio; holds hook.json (token, port), the hook script copy and backups. */
  constructor(private readonly studioHome: string, private readonly sourceScript: string, private readonly port: number) {}

  get scriptPath() { return path.join(this.studioHome, 'ccgs-studio-hook.mjs'); }
  private backupPath(project: string) {
    return path.join(this.studioHome, 'backups', sha(path.resolve(project).toLowerCase()).slice(0, 16) + '.settings.local.json.bak');
  }

  /** Token for /ingest; created once and shared by every project. */
  token(): string {
    const f = path.join(this.studioHome, 'hook.json');
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.token && j.port === this.port) return j.token;
      if (j.token) { this.writeHookJson(j.token); return j.token; }
    } catch { /* create */ }
    const t = crypto.randomBytes(24).toString('hex');
    this.writeHookJson(t);
    return t;
  }
  private writeHookJson(token: string) {
    fs.mkdirSync(this.studioHome, { recursive: true });
    fs.writeFileSync(path.join(this.studioHome, 'hook.json'), JSON.stringify({ token, port: this.port }), { mode: 0o600 });
  }

  /** Copies the hook client next to the token so settings never point into a dev checkout. */
  ensureScript() {
    fs.mkdirSync(this.studioHome, { recursive: true });
    const src = fs.readFileSync(this.sourceScript);
    if (!fs.existsSync(this.scriptPath) || !fs.readFileSync(this.scriptPath).equals(src)) fs.writeFileSync(this.scriptPath, src);
    this.token();
  }

  /** Settings passed to the SDK for Studio-run tasks (origin "studio"); merged with the project's, no project file written. */
  studioSettingsFile(): string {
    this.ensureScript();
    const f = path.join(this.studioHome, 'studio-settings.json');
    const body = JSON.stringify(withStudioHooks({}, hookCommand(this.scriptPath, 'studio')), null, 2);
    if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== body) fs.writeFileSync(f, body);
    return f;
  }

  installed(project: string): boolean {
    try { return hasStudioHooks(JSON.parse(fs.readFileSync(path.join(project, SETTINGS_REL), 'utf8'))); } catch { return false; }
  }

  preview(project: string, action: 'install' | 'uninstall'): HookPreview {
    const file = path.join(project, SETTINGS_REL);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    let json: any = {};
    if (before !== null) {
      try { json = JSON.parse(before); } catch (e) { throw new Error(`settings.local.json không phải JSON hợp lệ: ${(e as Error).message}`); }
    }
    let after: string | null;
    if (action === 'install') {
      after = hasStudioHooks(json) ? before : JSON.stringify(withStudioHooks(json, hookCommand(this.scriptPath, 'local')), null, 2) + '\n';
    } else {
      const stripped = withoutStudioHooks(json);
      const bak = this.readBackup(project);
      if (bak && deepEqual(stripped, bak.content === null ? {} : JSON.parse(bak.content))) after = bak.content;
      else if (!hasStudioHooks(json)) after = before;
      else after = JSON.stringify(stripped, null, 2) + '\n';
    }
    return {
      action, file: SETTINGS_REL, before, after, diff: lineDiff(before ?? '', after ?? ''),
      hash: sha(`${action}\0${before ?? '<absent>'}\0${after ?? '<absent>'}`), changed: before !== after,
    };
  }

  apply(project: string, action: 'install' | 'uninstall', confirmHash: string): HookPreview {
    const pv = this.preview(project, action);
    if (pv.hash !== confirmHash) throw new HashMismatch();
    if (!pv.changed) return pv;
    const file = path.join(project, SETTINGS_REL);
    if (action === 'install') {
      this.ensureScript();
      const bp = this.backupPath(project);
      fs.mkdirSync(path.dirname(bp), { recursive: true });
      fs.writeFileSync(bp, JSON.stringify({ content: pv.before }));
    }
    if (pv.after === null) fs.rmSync(file, { force: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, pv.after); }
    if (action === 'uninstall') fs.rmSync(this.backupPath(project), { force: true });
    return pv;
  }

  private readBackup(project: string): { content: string | null } | null {
    try { return JSON.parse(fs.readFileSync(this.backupPath(project), 'utf8')); } catch { return null; }
  }
}

export class HashMismatch extends Error {
  constructor() { super('settings.local.json đã thay đổi kể từ lúc xem trước. Hãy xem lại diff.'); }
}
