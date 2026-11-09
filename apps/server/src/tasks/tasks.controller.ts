import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import type { CurrentTask, NewTask, PermissionDecision, QuestionAnswer } from '@ccgs/shared';
import { BadTask, TaskQueue } from './task-queue';
import { MonitorService } from '../monitor/monitor.service';

const wrap = <T>(f: () => T): T => {
  try { return f(); } catch (e) { if (e instanceof BadTask) throw new BadRequestException(e.message); throw e; }
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

  /** T-TC-06 */
  @Get('tasks/:id/diff') diff(@Param('id') id: string) {
    const t = this.one(id);
    return { baseRef: t.baseRef, files: this.q.diffs(id) ?? [] };
  }
  /** T-TC-07 */
  @Post('tasks/:id/resume') resume(@Param('id') id: string, @Body() b: { prompt?: string }) { return wrap(() => this.q.resume(id, String(b?.prompt ?? ''))); }
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
