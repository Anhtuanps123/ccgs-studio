import { Controller, Get, NotFoundException, Param, Query, ServiceUnavailableException } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, Skill } from '@ccgs/shared';
import { CcgsAdapterService } from './adapter.service';

@Controller('api')
export class CcgsController {
  constructor(private readonly adapter: CcgsAdapterService) {}

  private snap() {
    const s = this.adapter.snapshot;
    if (!s) throw new ServiceUnavailableException('Chưa chọn project hợp lệ');
    return s;
  }

  @Get('config/summary') summary() { this.snap(); return this.adapter.summary(); }

  @Get('agents') agents(): AgentDefinition[] { return this.snap().agents.map(({ body, ...a }) => a); }

  @Get('agents/:name') agent(@Param('name') name: string) {
    const a = this.snap().agents.find(x => x.name === name);
    if (!a) throw new NotFoundException();
    return a;
  }

  @Get('skills') skills(): Skill[] { return this.snap().skills.map(({ body, file, ...s }) => s); }

  @Get('skills/:name') skill(@Param('name') name: string) {
    const s = this.snap().skills.find(x => x.name === name);
    if (!s) throw new NotFoundException();
    return s;
  }

  @Get('rules') rules() { return this.snap().rules; }
  @Get('hooks') hooks() { return this.snap().hooks; }
  @Get('templates') templates() { return this.snap().templates; }
  /** T-TP-01: only paths from the template list are readable. */
  @Get('templates/content') template(@Query('path') p: string) {
    const t = this.snap().templates.find(x => x.path === p);
    const root = this.adapter.projectRoot;
    if (!t || !root) throw new NotFoundException('Không có template này');
    return { path: t.path, content: fs.readFileSync(path.join(root, t.path), 'utf8') };
  }
  @Get('workflows') workflows() { return this.snap().workflows; }
}
