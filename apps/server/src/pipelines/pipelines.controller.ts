import { studioSkills } from '../studio-plugin';
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import type { NewPipeline } from '@ccgs/shared';
import { BadPipeline, PipelineService } from './pipeline.service';
import { BadTask } from '../tasks/task-queue';

const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
  try { return await f(); } catch (e) { if (e instanceof BadPipeline || e instanceof BadTask) throw new BadRequestException(e.message); throw e; }
};

@Controller('api/pipelines')
export class PipelinesController {
  constructor(private readonly p: PipelineService) {}

  @Get() list() { return this.p.list(); }
  @Get('setup') setup() { return this.p.setup(); }
  @Get('studio-skills') studioSkills() { return studioSkills(); }
  @Get('roles') roles() { return this.p.roleList(); }
  @Get(':id') one(@Param('id') id: string) { const x = this.p.get(id); if (!x) throw new NotFoundException('Không có chuỗi này'); return x; }
  @Post() create(@Body() b: NewPipeline) { return wrap(() => this.p.create(b)); }
  @Put(':id/steps') steps(@Param('id') id: string, @Body() b: any) { return wrap(() => this.p.updateSteps(id, b ?? {})); }
  @Post(':id/start') start(@Param('id') id: string) { return wrap(() => this.p.start(id)); }
  @Post(':id/revise') revise(@Param('id') id: string, @Body() b: any) { return wrap(() => this.p.revise(id, b?.note)); }
  @Post(':id/skip-critique') skipCritique(@Param('id') id: string) { return wrap(() => this.p.skipCritique(id)); }
  @Post(':id/restart-plan') restartPlan(@Param('id') id: string) { return wrap(() => this.p.restartPlan(id)); }
  @Post(':id/replan')replan(@Param('id') id: string, @Body() b: any) { return wrap(() => this.p.replan(id, b?.note)); }
  @Post(':id/answer') answer(@Param('id') id: string, @Body() b: any) { return wrap(() => this.p.answer(id, b?.text)); }
  @Post(':id/cancel') cancel(@Param('id') id: string) { return wrap(() => this.p.cancel(id)); }
  @Delete(':id') remove(@Param('id') id: string) { return wrap(() => this.p.remove(id)); }
  @Post(':id/steps/:step/retry') retry(@Param('id') id: string, @Param('step') step: string) { return wrap(() => this.p.retry(id, step)); }
  @Post(':id/steps/:step/skip') skip(@Param('id') id: string, @Param('step') step: string) { return wrap(() => this.p.skip(id, step)); }
}
