// Phase 4/5 read endpoints: stats, tokens, transcripts, tool detail, file activity, git, Phoenix export.
import { Controller, Get, NotFoundException, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import type { GitInfo, PhoenixExport } from '@ccgs/shared';
import { MonitorService } from '../monitor/monitor.service';
import { SettingsService } from '../settings/settings.service';
import { projectInfo } from '../system/system.controller';
import { gitInfo } from '../tasks/git-snapshot';
import { encodeTraces, sendTraces, sessionSpans } from '../phoenix/otlp';

export class PhoenixExporter {
  constructor(private readonly monitor: MonitorService, private readonly settings: SettingsService) {}

  async exportSession(sid: string, endpoint = this.settings.get().phoenix.endpoint): Promise<PhoenixExport> {
    const s = this.monitor.getSession(sid);
    if (!s) return { ok: false, spans: 0, status: null, error: 'Không có session này' };
    const spans = sessionSpans(s, this.monitor.invocations(sid), this.monitor.toolcalls(sid), this.monitor.usage(sid));
    const project = projectInfo(this.settings.get().projectPath).name ?? 'ccgs-studio';
    const r = await sendTraces(endpoint, encodeTraces(spans, project));
    const out = { ok: !r.error, spans: spans.length, ...r };
    this.monitor.log(out.ok ? 'info' : 'warn', 'studio', out.ok ? `Đã gửi ${spans.length} span của session ${sid.slice(0, 8)} tới Phoenix.` : `Gửi trace tới Phoenix lỗi: ${r.error}`, sid);
    return out;
  }
}

@Controller('api')
export class InsightsController {
  constructor(private readonly monitor: MonitorService, private readonly settings: SettingsService, private readonly phoenix: PhoenixExporter) {}

  private sid(id: string) { if (!this.monitor.getSession(id)) throw new NotFoundException('Không có session này'); return id; }

  @Get('stats/tasks') taskStats() { return this.monitor.taskStats(); }
  @Get('stats/agents') agentStats() { return this.monitor.agentStats(); }

  @Get('sessions/:id/usage') usage(@Param('id') id: string) { return this.monitor.usage(this.sid(id)); }
  @Get('sessions/:id/files') files(@Param('id') id: string) { return this.monitor.files(this.sid(id)); }
  @Get('sessions/:id/invocations/:inv/transcript') transcript(@Param('id') id: string, @Param('inv') inv: string) {
    const t = this.monitor.transcript(this.sid(id), inv);
    if (!t) throw new NotFoundException('Không có agent này trong session');
    return t;
  }
  @Get('toolcalls/:id') toolcall(@Param('id') id: string) {
    const d = this.monitor.toolcallDetail(id);
    if (!d) throw new NotFoundException('Không có tool call này');
    return d;
  }

  @Get('project/git') async git(): Promise<GitInfo> {
    const p = this.settings.get().projectPath;
    if (!p || !projectInfo(p).valid) throw new ServiceUnavailableException('Chưa chọn project hợp lệ');
    return gitInfo(p);
  }

  @Post('sessions/:id/phoenix') exportPhoenix(@Param('id') id: string): Promise<PhoenixExport> { return this.phoenix.exportSession(this.sid(id)); }
}
