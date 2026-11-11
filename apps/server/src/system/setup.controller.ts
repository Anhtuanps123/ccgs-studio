import { BadRequestException, ConflictException, Controller, Get, Param, Post } from '@nestjs/common';
import type { SetupJob, SetupState } from '@ccgs/shared';
import { SetupError, SetupService } from './packages';

const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
  try { return await f(); } catch (e) {
    if (e instanceof SetupError) throw e.status === 409 ? new ConflictException(e.message) : new BadRequestException(e.message);
    throw e;
  }
};

/** Màn "Cài package". Lệnh cài cố định trong packages.ts; client chỉ gửi id. */
@Controller('api/setup')
export class SetupController {
  constructor(private readonly s: SetupService) {}

  @Get('packages') packages(): Promise<SetupState> { return this.s.state(); }
  @Post('packages/:id/install') install(@Param('id') id: string): Promise<SetupJob> { return wrap(() => this.s.install(id)); }
  @Post('job/cancel') cancel(): Promise<SetupJob> { return wrap(() => this.s.cancel()); }
  @Post('login') login() { return wrap(() => this.s.openLogin()); }
}
