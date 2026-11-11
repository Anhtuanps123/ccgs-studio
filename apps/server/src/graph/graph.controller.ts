import { BadRequestException, ConflictException, Controller, Get, Post } from '@nestjs/common';
import type { GraphStatus } from '@ccgs/shared';
import { GraphError, GraphService } from './graph.service';

@Controller('api/graph')
export class GraphController {
  constructor(private readonly g: GraphService) {}
  @Get() get(): Promise<GraphStatus> { return this.g.status(); }
  @Post('build') async build(): Promise<GraphStatus> {
    try { return await this.g.build(); } catch (e) {
      if (e instanceof GraphError) throw e.status === 409 ? new ConflictException(e.message) : new BadRequestException(e.message);
      throw e;
    }
  }
}
