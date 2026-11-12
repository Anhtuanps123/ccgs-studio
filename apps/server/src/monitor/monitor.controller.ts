import { Body, ConflictException, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import crypto from 'node:crypto';
import type { IngestBody } from '@ccgs/shared';
import { MonitorService } from './monitor.service';
import { HookInstaller } from '../hooks/hook-installer';

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

@Controller()
export class IngestController {
  private rejected = 0;
  constructor(private readonly monitor: MonitorService, private readonly installer: HookInstaller) {}

  @Post('ingest') @HttpCode(204)
  ingest(@Headers('x-studio-token') token: string | undefined, @Body() body: IngestBody) {
    if (!token || !safeEq(token, this.installer.token())) {
      // Log the first few only; a stale hook would otherwise flood the log.
      if (this.rejected++ < 5) this.monitor.log('warn', 'hook', 'Từ chối event: token không khớp (hook cũ hoặc studio home khác).');
      throw new UnauthorizedException();
    }
    try { this.monitor.ingest(body); } catch (e) {
      this.monitor.log('error', 'studio', `Không xử lý được event ${(body?.payload as any)?.hook_event_name ?? '?'}: ${(e as Error).message}`);
    }
  }
}

@Controller('api')
export class MonitorController {
  constructor(private readonly monitor: MonitorService) {}

  @Get('sessions') sessions(@Query('external') external?: string, @Query('live') live?: string) {
    return this.monitor.listSessions().filter(s =>
      (external === undefined || s.external === (external === 'true')) && (live === undefined || s.live === (live === 'true')));
  }

  private session(id: string) {
    const s = this.monitor.getSession(id);
    if (!s) throw new NotFoundException('Không có session này');
    return s;
  }

  @Get('sessions/:id') one(@Param('id') id: string) { return this.session(id); }
  @Get('sessions/:id/conversation') conversation(@Param('id') id: string) { this.session(id); return this.monitor.conversation(id); }
  @Get('sessions/:id/invocations') invocations(@Param('id') id: string) { this.session(id); return this.monitor.invocations(id); }
  @Get('sessions/:id/toolcalls') toolcalls(@Param('id') id: string, @Query('tool') tool?: string, @Query('agent') agent?: string) {
    this.session(id); return this.monitor.toolcalls(id, { tool, agent });
  }
  @Get('sessions/:id/timeline') timeline(@Param('id') id: string) { this.session(id); return this.monitor.timeline(id); }
  @Get('sessions/:id/events') events(@Param('id') id: string) { this.session(id); return this.monitor.events(id); }

  /** "Xoá session": 409 while it (or its task) is running. */
  @Delete('sessions/:id') remove(@Param('id') id: string) {
    const r = this.monitor.deleteSession(id);
    if (!r) throw new NotFoundException('Không có session này');
    if ('busy' in r) throw new ConflictException(r.busy);
    return { ok: true, ...r };
  }

  /** "Xoá log": same filter as GET /api/logs; no filter deletes every log. */
  @Delete('logs') removeLogs(@Query() q: Record<string, string>) {
    return { deleted: this.monitor.deleteLogs({
      session: q.session || undefined, level: q.level || undefined, source: q.source || undefined, q: q.q || undefined,
      from: q.from || undefined, to: q.to || undefined,
    }) };
  }

  /** Hiệu suất "Xoá số liệu": stats count from now on; tasks and sessions are kept. */
  @Delete('stats') resetStats() { return { since: this.monitor.resetStats() }; }

  @Get('logs') logs(@Query() q: Record<string, string>) {
    return this.monitor.logs({
      session: q.session || undefined, level: q.level || undefined, source: q.source || undefined, q: q.q || undefined,
      before: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : undefined,
      from: q.from || undefined, to: q.to || undefined,
    });
  }
}
