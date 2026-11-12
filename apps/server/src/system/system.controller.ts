import { BadRequestException, Body, ConflictException, Controller, Get, Post, Put } from '@nestjs/common';
import { PickerUnsupported, pickFolder } from './folder-picker';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ProjectInfo, StudioSettings, SystemStatus } from '@ccgs/shared';
import { BadSettings, SettingsService, mergeSettings } from '../settings/settings.service';
import { TaskQueue } from '../tasks/task-queue';
import { CcgsAdapterService } from '../ccgs/adapter.service';
import { checkProject } from '../ccgs/parser';
import { LiveGateway } from '../live/live.gateway';
import { MonitorService } from '../monitor/monitor.service';
import { contextModeVersion } from '../context-mode';

export function projectInfo(p: string | null): ProjectInfo {
  if (!p) return { path: null, name: null, valid: false, checks: [] };
  const { valid, checks } = checkProject(p);
  return { path: p, name: path.basename(p), valid, checks };
}

export function claudeVersion(cmd: string): Promise<{ version: string | null; error: string | null }> {
  return new Promise(resolve => {
    execFile(cmd, ['--version'], { timeout: 10_000, shell: process.platform === 'win32', windowsHide: true }, (err, out) => {
      if (err) return resolve({ version: null, error: err.message.split('\n')[0] });
      resolve({ version: String(out).trim().split(/\s/)[0] || null, error: null });
    });
  });
}

let versionCache: { cmd: string; v: { version: string | null; error: string | null } } | null = null;
/** After Claude Code is (re)installed from the setup screen. */
export function forgetClaudeVersion() { versionCache = null; }

@Controller('api')
export class SystemController {

  constructor(
    private readonly settings: SettingsService,
    private readonly adapter: CcgsAdapterService,
    private readonly live: LiveGateway,
    private readonly monitor: MonitorService,
    private readonly tasks: TaskQueue,
  ) {}

  @Get('system') async system(): Promise<SystemStatus> {
    const s = this.settings.get();
    if (!versionCache || versionCache.cmd !== s.claudeCommand) {
      versionCache = { cmd: s.claudeCommand, v: await claudeVersion(s.claudeCommand) };
    }
    const hooks = this.adapter.snapshot?.hooks ?? [];
    return {
      project: projectInfo(s.projectPath),
      claude: { command: s.claudeCommand, ...versionCache.v },
      studioHooksInstalled: hooks.some(h => h.owner === 'studio'),
      lastEventAt: this.monitor.lastEventAt,
      contextModeVersion: contextModeVersion(),
    };
  }

  @Get('project') project(): ProjectInfo { return projectInfo(this.settings.get().projectPath); }

  /** Opens the native folder dialog on this machine; does not switch project (the UI then calls PUT /project). */
  @Post('project/browse') async browse(): Promise<{ path: string | null }> {
    try { return { path: await pickFolder(this.settings.get().projectPath) }; } catch (e) {
      if (e instanceof PickerUnsupported) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Put('project') async setProject(@Body() body: { path?: string }): Promise<ProjectInfo> {
    const p = body?.path?.trim();
    if (!p) throw new BadRequestException('Thiếu đường dẫn');
    const resolved = path.resolve(p);
    const info = projectInfo(resolved);
    if (!info.valid) return info; // do not switch to an invalid project
    const cur = this.settings.get();
    // T-PJ-03: tasks run in the current project; switching under them would run them elsewhere.
    if (cur.projectPath && path.resolve(cur.projectPath).toLowerCase() !== resolved.toLowerCase() && this.tasks.busy()) {
      throw new ConflictException('Đang có task chạy hoặc chờ trong hàng đợi. Đợi xong hoặc huỷ chúng rồi hãy đổi project.');
    }
    const recent = [resolved, ...cur.recentProjects.filter(x => x.toLowerCase() !== resolved.toLowerCase())].slice(0, 10);
    this.settings.update({ projectPath: resolved, recentProjects: recent });
    await this.adapter.open(resolved);
    this.live.emitConfigChanged(['agents', 'skills', 'rules', 'hooks', 'templates', 'workflows']);
    return info;
  }

  @Get('settings') getSettings(): StudioSettings { return this.settings.get(); }

  @Put('settings') async putSettings(@Body() body: Partial<StudioSettings>): Promise<StudioSettings> {
    let next: StudioSettings;
    try { next = mergeSettings(this.settings.get(), body); } catch (e) {
      if (e instanceof BadSettings) throw new BadRequestException(e.message);
      throw e;
    }
    const { projectPath: _p, recentProjects: _r, ...patch } = next; // changed only through PUT /api/project
    versionCache = null;
    return this.settings.update(patch);
  }

  /** T-PJ-03 */
  @Put('projects/recent') removeRecent(@Body() b: { remove?: string }) {
    const cur = this.settings.get();
    return this.settings.update({ recentProjects: cur.recentProjects.filter(x => x !== b?.remove) }).recentProjects;
  }
}
