import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GameScanService } from './game-scan';

const wrap = <T>(f: () => T): T => { try { return f(); } catch (e) { throw new BadRequestException((e as Error).message); } };

@Controller('api/scan')
export class ScanController {
  constructor(private readonly s: GameScanService) {}
  @Get() get() { return this.s.get(); }
  @Post() async start() { try { return await this.s.startChecked(); } catch (e) { throw new BadRequestException((e as Error).message); } }
  @Post('start-skill') runStart() { return wrap(() => this.s.runStart()); }
  /** Only start, project-stage-detect, adopt (fixed list); anything else is 400. */
  @Post('skill/:name') runSkill(@Param('name') name: string) { return wrap(() => this.s.runSkill(name)); }
  @Get('img/:name') img(@Param('name') name: string, @Res() res: Response) {
    const p = this.s.image(name);
    if (!p) throw new NotFoundException();
    res.sendFile(p);
  }
}
