import { BadRequestException, Body, ConflictException, Controller, Get, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import type { DoctorCheck, HookPreview } from '@ccgs/shared';
import { SettingsService } from '../settings/settings.service';
import { MonitorService } from '../monitor/monitor.service';
import { HashMismatch, HookInstaller } from './hook-installer';
import { claudeVersion, projectInfo } from '../system/system.controller';

type Action = 'install' | 'uninstall';
const asAction = (a: unknown): Action => {
  if (a !== 'install' && a !== 'uninstall') throw new BadRequestException('action phải là install hoặc uninstall');
  return a;
};

@Controller('api')
export class HooksController {
  constructor(
    private readonly settings: SettingsService,
    private readonly installer: HookInstaller,
    private readonly monitor: MonitorService,
  ) {}

  private project(): string {
    const p = this.settings.get().projectPath;
    if (!p || !projectInfo(p).valid) throw new ServiceUnavailableException('Chưa chọn project hợp lệ');
    return p;
  }

  @Get('hooks/studio/preview') preview(@Query('action') action: string): HookPreview {
    try { return this.installer.preview(this.project(), asAction(action)); } catch (e) {
      if (e instanceof Error && !(e instanceof BadRequestException) && !(e instanceof ServiceUnavailableException)) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Post('hooks/studio/install') install(@Body() b: { confirmHash?: string }) { return this.apply('install', b?.confirmHash); }
  @Post('hooks/studio/uninstall') uninstall(@Body() b: { confirmHash?: string }) { return this.apply('uninstall', b?.confirmHash); }

  private apply(action: Action, hash: string | undefined) {
    if (!hash) throw new BadRequestException('Thiếu confirmHash');
    const project = this.project();
    try {
      const pv = this.installer.apply(project, action, hash);
      this.monitor.log('info', 'studio', `${action === 'install' ? 'Đã cài' : 'Đã gỡ'} hook Studio trong ${path.join(project, '.claude', 'settings.local.json')}`);
      return { ok: true, changed: pv.changed };
    } catch (e) {
      if (e instanceof HashMismatch) throw new ConflictException(e.message);
      throw e;
    }
  }

  /** S-02. Each check runs independently; one failing does not hide the others. */
  @Post('doctor') async doctor(): Promise<DoctorCheck[]> {
    const s = this.settings.get();
    const checks: DoctorCheck[] = [];

    const v = await claudeVersion(s.claudeCommand);
    checks.push({ id: 'claude', label: 'Đã cài Claude Code', ok: !!v.version, detail: v.version ?? v.error ?? 'Unknown' });

    const auth = await new Promise<DoctorCheck>(resolve => {
      execFile(s.claudeCommand, ['auth', 'status'], { timeout: 15_000, shell: process.platform === 'win32', windowsHide: true }, (err, out) => {
        try {
          const j = JSON.parse(String(out));
          resolve({ id: 'auth', label: 'Đã đăng nhập', ok: j.loggedIn === true, detail: j.loggedIn ? `${j.authMethod ?? ''} ${j.apiProvider ?? ''}`.trim() : 'Chưa đăng nhập: chạy claude rồi /login' });
        } catch {
          resolve({ id: 'auth', label: 'Đã đăng nhập', ok: null, detail: `Không đọc được "claude auth status": ${err?.message.split('\n')[0] ?? 'kết quả lạ'}` });
        }
      });
    });
    checks.push(auth);

    const pi = projectInfo(s.projectPath);
    checks.push({ id: 'project', label: 'Project hợp lệ', ok: pi.valid, detail: pi.path ?? 'Chưa chọn project' });

    const installed = pi.valid ? this.installer.installed(pi.path!) : false;
    checks.push({ id: 'hook-installed', label: 'Hook Studio đã cài', ok: installed, detail: installed ? '.claude/settings.local.json' : 'Chưa cài (chỉ cần cho session chạy ngoài Studio)' });

    checks.push(await this.hookRoundTrip());

    try {
      const c = this.monitor.db.$client;
      const val = crypto.randomUUID();
      c.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('doctor', val);
      const ok = (c.prepare('SELECT value FROM meta WHERE key = ?').get('doctor') as any)?.value === val;
      checks.push({ id: 'db', label: 'Database ghi được', ok, detail: c.name });
    } catch (e) {
      checks.push({ id: 'db', label: 'Database ghi được', ok: false, detail: (e as Error).message });
    }
    return checks;
  }

  /** Runs the real hook client with a test payload and waits for it to reach /ingest. */
  private hookRoundTrip(): Promise<DoctorCheck> {
    const label = 'Hook gửi được event test';
    try { this.installer.ensureScript(); } catch (e) {
      return Promise.resolve({ id: 'hook', label, ok: false, detail: (e as Error).message });
    }
    const nonce = crypto.randomUUID();
    const t0 = Date.now();
    return new Promise(resolve => {
      const done = (ok: boolean, detail: string) => { clearTimeout(timer); this.monitor.bus.off('doctor', on); resolve({ id: 'hook', label, ok, detail }); };
      const on = (n: string) => { if (n === nonce) done(true, `Nhận sau ${Date.now() - t0} ms`); };
      const timer = setTimeout(() => done(false, 'Không nhận được event sau 3 giây'), 3000);
      this.monitor.bus.on('doctor', on);
      const child = spawn(process.execPath, [this.installer.scriptPath, 'doctor'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', e => done(false, e.message));
      child.stdin.end(JSON.stringify({ hook_event_name: 'StudioDoctor', session_id: 'doctor', nonce }));
    });
  }
}
