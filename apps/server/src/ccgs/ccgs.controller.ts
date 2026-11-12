import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, Skill, SkillGuide } from '@ccgs/shared';
import { CcgsAdapterService } from './adapter.service';
import { BadGuide, SkillGuideService } from './skill-guide';

@Controller('api')
export class CcgsController {
  constructor(private readonly adapter: CcgsAdapterService, private readonly guides: SkillGuideService) {}

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

  /** Giải thích skill (api-contract §16). */
  @Get('skills/:name/guide') guide(@Param('name') name: string): SkillGuide { return this.guideCall(() => this.guides.get(name)); }
  @Post('skills/:name/guide') explain(@Param('name') name: string): SkillGuide { return this.guideCall(() => this.guides.explain(name)); }
  private guideCall(f: () => SkillGuide | null): SkillGuide {
    let g: SkillGuide | null;
    try { g = f(); } catch (e) {
      if (e instanceof BadGuide) throw e.message.startsWith('Không có skill') ? new NotFoundException(e.message) : new BadRequestException(e.message);
      throw e;
    }
    if (!g) throw new ServiceUnavailableException('Chưa chọn project hợp lệ');
    return g;
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
