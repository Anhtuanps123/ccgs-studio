// "Cài package": checks and installs what Studio needs (CAI-DAT.md). Commands are fixed here; the client only sends an id.
// One install at a time. Node itself is not installable from here (Studio runs on it): cai-dat.cmd does that.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { DoctorCheck, SetupJob, SetupLevel, SetupPackage, SetupState } from '@ccgs/shared';
import { contextModeVersion } from '../context-mode';

export class SetupError extends Error { constructor(msg: string, readonly status: 400 | 409) { super(msg); } }

export type Exec = (cmd: string, args: string[], o: { shell: boolean; timeoutMs: number }) => Promise<{ ok: boolean; out: string; error: string | null }>;
/** cwd: folder to run in (the user's home when not given). */
export type Spawn = (cmd: string, args: string[], cwd?: string) => ChildProcess;

export interface SetupDeps {
  claudeCommand: () => string;
  unityCheck: () => Promise<DoctorCheck>;
  platform?: string;
  exec?: Exec;
  spawn?: Spawn;
  /** Re-read PATH (an installer adds to it; this server started before). */
  refreshPath?: () => Promise<void>;
  /** Called after a job ends with exit code 0. */
  onInstalled?: (id: string) => void;
  timeoutMs?: number;
  /** Version of the context-mode plugin installed with the server, null when missing (tests swap it). */
  contextMode?: () => string | null;
}

const MAX_LOG = 400;
const GRAPHIFY = 'graphifyy[mcp]==0.9.103';
const WINGET_FLAGS = ['-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
const PS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'];
const VSWHERE = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

/** Root of the Studio repo (package.json with the workspaces): same depth from src/system and dist/system. */
export const STUDIO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const CONTEXT_MODE_PKG = 'context-mode@2.1.8';

interface InstallCmd { cmd: string; args: string[]; confirm?: string; cwd?: string }
interface Def {
  id: string; label: string; level: SetupLevel; why: string;
  /** Windows only. */
  install?: InstallCmd;
  needs?: { id: string; text: string };
  action?: 'login';
}

export const DEFS: Def[] = [
  { id: 'node', label: 'Node.js', level: 'required', why: 'Studio chạy bằng Node. Hook giám sát gọi lệnh node.' },
  { id: 'claude', label: 'Claude Code CLI', level: 'required', why: 'Chạy task và kiểm tra đăng nhập.',
    install: { cmd: 'powershell.exe', args: [...PS, 'irm https://claude.ai/install.ps1 | iex'] } },
  { id: 'login', label: 'Đăng nhập Claude Code', level: 'required', why: 'Mọi task tính phí vào tài khoản này.', action: 'login', needs: { id: 'claude', text: 'Cài Claude Code CLI trước' } },
  { id: 'unity-mcp', label: 'MCP for Unity', level: 'required', why: 'Quét game trước khi lập kế hoạch.' },
  { id: 'git', label: 'Git', level: 'recommended', why: 'Biết task đã đổi file nào và xem diff.',
    install: { cmd: 'winget', args: ['install', '--id', 'Git.Git', ...WINGET_FLAGS] } },
  { id: 'vsbuild', label: 'Visual Studio Build Tools (C++)', level: 'recommended', why: 'Chỉ cần khi npm install báo lỗi build better-sqlite3.',
    install: { cmd: 'winget', args: ['install', '--id', 'Microsoft.VisualStudio.2022.BuildTools', ...WINGET_FLAGS, '--override', '--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'],
      confirm: 'Bản cài nặng vài GB, có thể mất 10–30 phút và Windows sẽ hỏi quyền admin. Chỉ cần khi npm install báo lỗi build better-sqlite3. Vẫn cài?' } },
  { id: 'uv', label: 'uv', level: 'optional', why: 'Dùng để cài graphify.',
    install: { cmd: 'powershell.exe', args: [...PS, 'irm https://astral.sh/uv/install.ps1 | iex'] } },
  { id: 'graphify', label: 'graphify (bản đồ code)', level: 'optional', why: 'Claude tra class, method, file:dòng thay vì đọc cả file. Không cài vào project game.',
    install: { cmd: 'uv', args: ['tool', 'install', '--force', GRAPHIFY] }, needs: { id: 'uv', text: 'Cài uv trước' } },
  { id: 'context-mode', label: 'context-mode (tiết kiệm context)', level: 'optional',
    why: 'Plugin giữ kết quả công cụ lớn (file dài, log) ngoài context của task. Cài vào thư mục Studio, không cài vào Claude Code toàn máy hay project game.',
    // npm is a .cmd on Windows: run it through cmd.exe, in the Studio folder (npm workspaces).
    install: { cmd: 'cmd.exe', args: ['/d', '/c', 'npm', 'install', CONTEXT_MODE_PKG, '--save-exact', '--no-audit', '--no-fund', '-w', 'apps/server'], cwd: STUDIO_ROOT } },
];

const quote = (a: string) => (/[\s|"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
export const commandText = (c: InstallCmd) => [c.cmd, ...c.args].map(quote).join(' ');
const semver = (s: string) => s.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? null;

/** Splits raw output into lines: drops ANSI codes, keeps the last state of \r-rewritten lines, drops spinner/progress-only lines. */
export function outputLines(text: string): string[] {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/)
    .map(l => { const parts = l.split('\r').filter(p => p.trim()); return (parts[parts.length - 1] ?? '').trimEnd(); })
    .filter(l => l.trim() && !/^[\s\-\\|/█▒░▓]*$/.test(l) && !/^\s*[█▒░▓]+/.test(l));
}

const defaultExec: Exec = (cmd, args, o) => new Promise(resolve => {
  execFile(cmd, args, { timeout: o.timeoutMs, shell: o.shell, windowsHide: true, cwd: os.tmpdir() }, (err, out, errOut) => {
    if (err) return resolve({ ok: false, out: String(out ?? ''), error: (String(errOut ?? '').trim() || err.message).split('\n')[0] });
    resolve({ ok: true, out: String(out ?? ''), error: null });
  });
});

const defaultSpawn: Spawn = (cmd, args, cwd) => spawn(cmd, args, { cwd: cwd ?? os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/** Windows: adds PATH entries from the registry (user + machine) and ~/.local/bin that this process does not have yet. */
export async function refreshWindowsPath(exec: Exec = defaultExec): Promise<void> {
  if (process.platform !== 'win32') return;
  const read = async (key: string) => {
    const r = await exec('reg', ['query', key, '/v', 'Path'], { shell: false, timeoutMs: 5000 });
    const m = r.out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (x, v) => process.env[v] ?? x).split(';') : [];
  };
  const extra = [...await read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), ...await read('HKCU\\Environment'), path.join(os.homedir(), '.local', 'bin')];
  const cur = (process.env.PATH ?? '').split(';').filter(Boolean);
  const have = new Set(cur.map(x => x.toLowerCase().replace(/\\$/, '')));
  const add = extra.map(x => x.trim()).filter(x => x && !have.has(x.toLowerCase().replace(/\\$/, '')));
  if (add.length) process.env.PATH = [...cur, ...[...new Set(add)]].join(';');
}

export class SetupService {
  readonly bus = new EventEmitter<{ job: [SetupJob] }>();
  private job: SetupJob | null = null;
  private child: ChildProcess | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private readonly platform: string;
  private readonly exec: Exec;
  private readonly spawnFn: Spawn;

  constructor(private readonly d: SetupDeps) {
    this.platform = d.platform ?? process.platform;
    this.exec = d.exec ?? defaultExec;
    this.spawnFn = d.spawn ?? defaultSpawn;
  }

  current(): SetupJob | null { return this.job; }

  async state(): Promise<SetupState> {
    try { await (this.d.refreshPath ?? (() => refreshWindowsPath(this.exec)))(); } catch { /* keep the old PATH */ }
    const found = new Map<string, { installed: boolean | null; version: string | null; detail: string }>();
    const results = await Promise.all(DEFS.map(async def => [def.id, await this.check(def.id)] as const));
    for (const [id, r] of results) found.set(id, r);
    // login needs claude; its check already ran (and said so) but blockedBy is computed below like the others.
    const packages: SetupPackage[] = DEFS.map(def => {
      const r = found.get(def.id)!;
      const blocked = def.needs && !found.get(def.needs.id)?.installed ? def.needs.text : null;
      const busy = this.job?.status === 'running' ? 'Đang cài một package khác' : null;
      return {
        id: def.id, label: def.label, level: def.level, why: def.why, installed: r.installed, version: r.version, detail: r.detail,
        install: def.install && this.platform === 'win32' ? { command: commandText(def.install), confirm: def.install.confirm ?? null, blockedBy: blocked ?? busy } : null,
        action: def.action ?? null,
      };
    });
    return { platform: this.platform, packages, job: this.job };
  }

  private async version(cmd: string, args: string[], shell = false) {
    const r = await this.exec(cmd, args, { shell, timeoutMs: 15_000 });
    const v = r.ok ? semver(r.out) : null;
    return v ? { installed: true, version: v, detail: r.out.trim().split('\n')[0] } : { installed: false, version: null, detail: r.error ?? 'Chưa cài' };
  }

  private async check(id: string): Promise<{ installed: boolean | null; version: string | null; detail: string }> {
    const win = this.platform === 'win32';
    switch (id) {
      case 'node': return { installed: true, version: process.versions.node, detail: `${process.execPath}. Studio đang chạy bằng bản này; đổi bản Node thì dùng cai-dat.cmd hoặc cài tay.` };
      case 'claude': return this.version(this.d.claudeCommand(), ['--version'], win);
      case 'login': {
        const r = await this.exec(this.d.claudeCommand(), ['auth', 'status'], { shell: win, timeoutMs: 15_000 });
        try {
          const j = JSON.parse(r.out);
          return j.loggedIn === true
            ? { installed: true, version: null, detail: `${j.authMethod ?? ''} ${j.apiProvider ?? ''}`.trim() || 'Đã đăng nhập' }
            : { installed: false, version: null, detail: 'Chưa đăng nhập. Bấm "Mở terminal", rồi gõ /login trong cửa sổ Claude.' };
        } catch { return { installed: null, version: null, detail: `Không đọc được "claude auth status": ${r.error ?? 'kết quả lạ'}` }; }
      }
      case 'unity-mcp': {
        const c = await this.d.unityCheck();
        return { installed: c.ok, version: null, detail: `${c.detail} Cài trong Unity (MCP for Unity), bật ở Window → MCP for Unity, đăng ký với Claude Code tên UnityMCP. Xem CAI-DAT.md mục 8.` };
      }
      case 'git': return this.version('git', ['--version']);
      case 'uv': return this.version('uv', ['--version']);
      case 'graphify': return this.version('graphify', ['--version']);
      case 'context-mode': {
        const v = (this.d.contextMode ?? (() => contextModeVersion()))();
        return v
          ? { installed: true, version: v, detail: 'Đã có. Bật ở Cài đặt → Tiết kiệm context (context-mode); áp dụng cho task bắt đầu sau khi lưu.' }
          : { installed: false, version: null, detail: 'Chưa cài. Nếu bấm Cài báo lỗi EPERM: tắt Studio, chạy "npm install" trong thư mục Studio rồi mở lại.' };
      }
      case 'vsbuild': {
        if (!win) return { installed: null, version: null, detail: 'Chỉ kiểm tra trên Windows' };
        const r = await this.exec(VSWHERE, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'catalog_productDisplayVersion'], { shell: false, timeoutMs: 15_000 });
        const v = r.ok ? semver(r.out) : null;
        return v ? { installed: true, version: v, detail: 'Có bộ build C++' } : { installed: false, version: null, detail: 'Chưa có bộ build C++ (chỉ cần khi npm install lỗi better-sqlite3)' };
      }
      default: return { installed: null, version: null, detail: 'Unknown' };
    }
  }

  async install(id: string): Promise<SetupJob> {
    const def = DEFS.find(x => x.id === id);
    if (!def) throw new SetupError(`Không có package "${id}"`, 400);
    if (!def.install || this.platform !== 'win32') throw new SetupError(`Studio không tự cài được ${def.label}. Làm theo hướng dẫn trên màn hình.`, 400);
    if (def.needs) {
      const dep = await this.check(def.needs.id);
      if (!dep.installed) throw new SetupError(def.needs.text, 400);
    }
    // Checked after the await so two quick clicks cannot start two installers.
    if (this.job?.status === 'running') throw new SetupError(`Đang cài ${this.job.label}. Chờ xong rồi cài tiếp.`, 409);
    const { cmd, args, cwd } = def.install;
    const job: SetupJob = { id: crypto.randomUUID(), packageId: id, label: def.label, command: commandText(def.install), status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, log: [`> ${commandText(def.install)}`] };
    this.job = job;
    let child: ChildProcess;
    try { child = this.spawnFn(cmd, args, cwd); } catch (e) { this.finish(job, 'failed', null, (e as Error).message); return job; }
    this.child = child;
    const timer = setTimeout(() => { this.push(job, `Quá ${Math.round((this.d.timeoutMs ?? 45 * 60_000) / 60_000)} phút, dừng.`); this.kill(); }, this.d.timeoutMs ?? 45 * 60_000);
    timer.unref?.();
    const onData = (b: Buffer) => this.push(job, ...outputLines(b.toString('utf8')));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', e => { clearTimeout(timer); this.finish(job, 'failed', null, e.message); });
    child.on('close', code => {
      clearTimeout(timer);
      if (job.status !== 'running') return;
      this.finish(job, code === 0 ? 'completed' : (this.cancelled ? 'cancelled' : 'failed'), code);
    });
    this.emit(true);
    return job;
  }

  cancel(): SetupJob {
    if (!this.job || this.job.status !== 'running') throw new SetupError('Không có lệnh cài nào đang chạy', 400);
    this.cancelled = true;
    this.push(this.job, 'Đã bấm huỷ, đang dừng…');
    this.kill();
    return this.job;
  }

  /** Opens a console window running claude (Windows) so the user types /login there. */
  openLogin(): { ok: true } {
    if (this.platform !== 'win32') throw new SetupError('Chỉ mở được terminal trên Windows. Tự chạy "claude" rồi gõ /login.', 400);
    const c = spawn('cmd.exe', ['/c', 'start', 'Claude login', 'cmd.exe', '/k', this.d.claudeCommand()], { detached: true, stdio: 'ignore', cwd: os.homedir() });
    c.on('error', () => { /* nothing to do: the UI says to run it by hand if no window opens */ });
    c.unref();
    return { ok: true };
  }

  private kill() {
    const c = this.child;
    if (!c?.pid) return;
    if (this.platform === 'win32') {
      const k = spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => c.kill());
    } else c.kill();
  }

  private push(job: SetupJob, ...lines: string[]) {
    if (!lines.length) return;
    job.log.push(...lines);
    if (job.log.length > MAX_LOG) job.log.splice(1, job.log.length - MAX_LOG); // keep the command line
    this.emit(false);
  }

  private finish(job: SetupJob, status: SetupJob['status'], code: number | null, error?: string) {
    if (error) job.log.push(`Lỗi: ${error}`);
    job.status = status; job.exitCode = code; job.endedAt = new Date().toISOString();
    job.log.push(status === 'completed' ? 'Xong.' : status === 'cancelled' ? 'Đã huỷ.' : `Không thành công${code !== null ? ` (mã thoát ${code})` : ''}.`);
    this.child = null; this.cancelled = false;
    if (status === 'completed') {
      void (this.d.refreshPath ?? (() => refreshWindowsPath(this.exec)))().catch(() => {}).finally(() => this.d.onInstalled?.(job.packageId));
    }
    this.emit(true);
  }

  private emit(now: boolean) {
    if (!this.job) return;
    if (now) {
      if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
      this.bus.emit('job', { ...this.job, log: [...this.job.log] });
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; if (this.job) this.bus.emit('job', { ...this.job, log: [...this.job.log] }); }, 300);
  }
}
