// Files the user attaches to a task or a plan request. Stored under ~/.ccgs-studio/attachments/<id>/<name> (never in
// the game project); the runner adds that folder to the session's directories and appends the paths to the prompt,
// so Claude opens them with Read (images, PDF, text).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, ATTACH_TYPES, type Attachment } from '@ccgs/shared';

export class BadAttachment extends Error {}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const extOf = (n: string) => path.extname(n).slice(1).toLowerCase();
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** File name without folders or characters Windows refuses; keeps the extension. */
export function safeName(name: string): string {
  const base = (String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? '').normalize('NFC');
  const clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').trim();
  if (clean.length <= 120) return clean || 'file';
  const ext = path.extname(clean);
  return clean.slice(0, 120 - ext.length) + ext;
}

export class AttachmentStore {
  constructor(readonly root: string) {}

  /** data: the file's bytes in base64. */
  save(name: unknown, data: unknown): Attachment {
    const n = safeName(String(name ?? ''));
    const mime = ATTACH_TYPES[extOf(n)];
    if (!mime) throw new BadAttachment(`Không nhận tệp "${n}". Chỉ nhận: ${Object.keys(ATTACH_TYPES).join(', ')}.`);
    if (typeof data !== 'string' || !data) throw new BadAttachment(`Tệp "${n}" rỗng`);
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) throw new BadAttachment(`Tệp "${n}" rỗng`);
    if (buf.length > ATTACH_MAX_BYTES) throw new BadAttachment(`Tệp "${n}" nặng ${kb(buf.length)}, tối đa ${kb(ATTACH_MAX_BYTES)}`);
    const id = randomUUID();
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, n);
    fs.writeFileSync(file, buf);
    return { id, name: n, size: buf.length, mime, path: file };
  }

  get(id: string): Attachment | null {
    if (!ID_RE.test(String(id))) return null;
    const dir = path.join(this.root, id);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return null; }
    const name = names.find(x => ATTACH_TYPES[extOf(x)]);
    if (!name) return null;
    const file = path.join(dir, name);
    try { return { id, name, size: fs.statSync(file).size, mime: ATTACH_TYPES[extOf(name)], path: file }; } catch { return null; }
  }

  /** Ids from a request -> attachments; throws when one is missing or there are too many. */
  resolve(ids: unknown): Attachment[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new BadAttachment('attachments phải là danh sách mã tệp');
    const uniq = [...new Set(ids.map(x => String(x)))];
    if (uniq.length > ATTACH_MAX_FILES) throw new BadAttachment(`Tối đa ${ATTACH_MAX_FILES} tệp đính kèm`);
    return uniq.map(id => {
      const a = this.get(id);
      if (!a) throw new BadAttachment(`Không tìm thấy tệp đính kèm ${id.slice(0, 8)} (có thể đã bị xoá). Đính kèm lại.`);
      return a;
    });
  }
}

/** Text appended to the prompt sent to Claude; "" when there is nothing attached. */
export function attachmentNote(list: Attachment[] | null | undefined): string {
  if (!list?.length) return '';
  return `Attached files: the user attached these to the request. Open each one with the Read tool (it shows images and PDFs) before you rely on it; when you hand work to a subagent, pass the paths it needs.
${list.map(a => `- ${a.path} (${a.mime}, ${kb(a.size)})`).join('\n')}`;
}

export function withAttachments(prompt: string, list: Attachment[] | null | undefined): string {
  const note = attachmentNote(list);
  return note ? `${prompt}\n\n${note}` : prompt;
}

/** Folders Claude must be able to read for these attachments (SDK additionalDirectories). */
export function attachmentDirs(list: Attachment[] | null | undefined): string[] {
  return [...new Set((list ?? []).map(a => path.dirname(a.path)))];
}
