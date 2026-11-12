import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { CurrentTask, NewTask, PermissionDecision, QuestionAnswer, Task, TaskOutput, TaskOutputFormat } from '@ccgs/shared';
import { BadTask, TaskQueue } from './task-queue';
import { MonitorService } from '../monitor/monitor.service';
import { gitRoot } from './git-snapshot';
import { BadOutput, MD_MAX, STUDIO_PREFIX, listOutputs, markdownToCsv, markdownToXlsx, mimeOf, outputKind, resolveOutput, resolveStudioOutput, studioOutputs } from './outputs';

const wrap = <T>(f: () => T): T => {
  try { return f(); } catch (e) { if (e instanceof BadTask) throw new BadRequestException(e.message); throw e; }
};
const out = <T>(f: () => T): T => {
  try { return f(); } catch (e) { if (e instanceof BadOutput) throw new BadRequestException(e.message); throw e; }
};

@Controller('api')
export class TasksController {
  constructor(private readonly q: TaskQueue, private readonly monitor: MonitorService) {}

  @Get('tasks') list(@Query('status') status?: string, @Query('q') q?: string, @Query('skill') skill?: string, @Query('from') from?: string) {
    return this.q.list({ status: status || undefined, q: q || undefined, skill: skill || undefined, from: from || undefined });
  }

  /** T-DB-03 */
  @Get('tasks/current') current(): CurrentTask {
    const task = this.q.running();
    const activeAgents = task?.sessionId
      ? this.monitor.invocations(task.sessionId).filter(i => i.agentType !== 'main' && (i.status === 'running' || i.status === 'waiting'))
      : [];
    return { task, activeAgents, queued: this.q.queuedCount(), pending: this.q.interactions().length };
  }

  @Get('tasks/:id') one(@Param('id') id: string) {
    const t = this.q.get(id);
    if (!t) throw new NotFoundException('Không có task này');
    return t;
  }

  @Post('tasks') create(@Body() body: NewTask) { return wrap(() => this.q.create(body)); }

  /** Xoá lịch sử: ended tasks matching the history filter, except tasks of unfinished plans (api-contract §13). */
  @Post('tasks/clear') clear(@Body() b: { status?: string; q?: string; skill?: string; before?: string }) {
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return wrap(() => this.q.clear({ status: s(b?.status), q: s(b?.q), skill: s(b?.skill), before: s(b?.before) }));
  }
  @Delete('tasks/:id') remove(@Param('id') id: string) { return wrap(() => this.q.remove(id)); }

  /** T-TC-06 */
  @Get('tasks/:id/diff') diff(@Param('id') id: string) {
    const t = this.one(id);
    return { baseRef: t.baseRef, files: this.q.diffs(id) ?? [] };
  }
  /** Đầu ra (api-contract §15): files the task added or changed, with what Studio can do with each. */
  @Get('tasks/:id/outputs') async outputs(@Param('id') id: string): Promise<TaskOutput[]> {
    const t = this.one(id);
    const dir = this.q.outputDir(id);
    const mine = dir ? await studioOutputs(dir, t.output) : [];
    const project = this.q.project();
    if (!project) return mine;
    return [...mine, ...listOutputs((await gitRoot(project)) ?? project, project, t.changedFiles)];
  }
  /** `~studio/<rel>`: the task's Studio output folder; anything else: a project file the task changed. */
  private async resolve(t: Task, rel: string) {
    if (rel.startsWith(STUDIO_PREFIX)) {
      const dir = this.q.outputDir(t.id);
      if (!dir) throw new NotFoundException('Không có thư mục đầu ra');
      return out(() => resolveStudioOutput(dir, rel));
    }
    const { root } = await this.roots();
    return out(() => resolveOutput(root, t.changedFiles, rel));
  }
  /**
   * One output file, sandboxed (opaque origin: its scripts cannot call /api). The path is in the URL so an HTML page's
   * relative CSS, JS and images resolve to files next to it. `?download=1` saves it instead.
   */
  @Get('tasks/:id/outputs/raw/*path') async raw(@Param('id') id: string, @Param('path') p: string | string[], @Query('download') dl: string | undefined, @Res() res: Response) {
    const abs = await this.resolve(this.one(id), Array.isArray(p) ? p.join('/') : String(p ?? ''));
    res.setHeader('Content-Type', mimeOf(abs));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }
  /** A .md output converted to Excel (sections + tables) or CSV (tables only); no Claude call. */
  @Get('tasks/:id/outputs/export') async exportDoc(@Param('id') id: string, @Query('path') p: string, @Query('format') format: string, @Res() res: Response) {
    if (format !== 'xlsx' && format !== 'csv') throw new BadRequestException('format phải là xlsx hoặc csv');
    const abs = await this.resolve(this.one(id), String(p ?? ''));
    if (outputKind(abs) !== 'doc') throw new BadRequestException('Chỉ xuất được file .md');
    if (fs.statSync(abs).size > MD_MAX) throw new BadRequestException('File quá lớn (tối đa 5 MB)');
    const md = fs.readFileSync(abs, 'utf8');
    const base = path.basename(abs).replace(/\.[^.]+$/, '');
    const body = format === 'xlsx' ? await markdownToXlsx(md, base) : Buffer.from(out(() => markdownToCsv(md)), 'utf8');
    res.setHeader('Content-Type', format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.${format}`)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }
  /** changedFiles are relative to the git root of the project (the project itself when it is not in git). */
  private async roots() {
    const project = this.q.project();
    if (!project) throw new BadRequestException('Chưa chọn project');
    return { project, root: (await gitRoot(project)) ?? project };
  }

  /** T-TC-07 */
  @Post('tasks/:id/resume') resume(@Param('id') id: string, @Body() b: { prompt?: string; attachments?: string[]; output?: TaskOutputFormat | null }) {
    return wrap(() => this.q.resume(id, String(b?.prompt ?? ''), b?.attachments ?? undefined, b?.output ?? null));
  }
  /** M-PF-02 per task */
  @Get('tasks/:id/usage') usage(@Param('id') id: string) {
    const t = this.one(id);
    return t.sessionId ? this.monitor.usage(t.sessionId) : null;
  }
  @Patch('tasks/:id/position') move(@Param('id') id: string, @Body() b: { position: number }) { return wrap(() => this.q.move(id, b?.position)); }
  @Post('tasks/:id/cancel') async cancel(@Param('id') id: string) {
    try { return await this.q.cancel(id); } catch (e) { if (e instanceof BadTask) throw new BadRequestException(e.message); throw e; }
  }

  @Get('interactions') interactions() { return this.q.interactions(); }
  @Post('interactions/:id/answer') answer(@Param('id') id: string, @Body() b: QuestionAnswer) { return wrap(() => { this.q.answer(id, b); return { ok: true }; }); }
  @Post('interactions/:id/decision') decide(@Param('id') id: string, @Body() b: PermissionDecision) { return wrap(() => { this.q.answer(id, b); return { ok: true }; }); }
}
