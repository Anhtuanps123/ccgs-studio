import fs from 'node:fs';
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Attachment } from '@ccgs/shared';
import { AttachmentStore, BadAttachment } from './attachments';

@Controller('api/attachments')
export class AttachmentsController {
  constructor(private readonly store: AttachmentStore) {}

  /** Body: { name, data } with data the file in base64 (JSON body limit 20 MB, file limit ATTACH_MAX_BYTES). */
  @Post() upload(@Body() b: { name?: string; data?: string }): Attachment {
    try { return this.store.save(b?.name, b?.data); }
    catch (e) { if (e instanceof BadAttachment) throw new BadRequestException(e.message); throw e; }
  }

  /** The file itself (thumbnails, opening it from a task card). Only the allowed types are ever stored. */
  @Get(':id/file') file(@Param('id') id: string, @Res() res: Response) {
    const a = this.store.get(id);
    if (!a) throw new NotFoundException('Không có tệp đính kèm này');
    res.setHeader('Content-Type', a.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(a.path).on('error', () => res.destroy()).pipe(res);
  }
}
