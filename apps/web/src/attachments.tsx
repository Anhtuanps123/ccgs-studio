// Attaching files to a task or a plan request: button, drag and drop, or Ctrl+V of a screenshot.
// Each file is uploaded right away (POST /api/attachments); the form sends only the ids.
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, ATTACH_TYPES, type Attachment } from '@ccgs/shared';
import { api } from './api';

const ACCEPT = Object.keys(ATTACH_TYPES).map(e => '.' + e).join(',');
const extOf = (n: string) => (n.includes('.') ? n.split('.').pop()!.toLowerCase() : '');
export const fileUrl = (a: Attachment) => `/api/attachments/${a.id}/file`;
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function toBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Không đọc được tệp'));
    r.readAsDataURL(f);
  });
}

/** Pasted screenshots are all called "image.png": give them a readable, distinct name. */
function nameOf(f: File, i: number): string {
  if (f.name && f.name !== 'image.png' && extOf(f.name)) return f.name;
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `anh-dan-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${i ? `-${i}` : ''}.${ext}`;
}

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const count = useRef(0);
  count.current = items.length + uploading;

  const add = useCallback(async (files: File[]) => {
    setErr(null);
    const errors: string[] = [];
    const room = ATTACH_MAX_FILES - count.current;
    if (files.length > room) errors.push(`Tối đa ${ATTACH_MAX_FILES} tệp, bỏ qua ${files.length - Math.max(0, room)} tệp.`);
    const ok = files.slice(0, Math.max(0, room)).map((f, i) => ({ f, name: nameOf(f, i) })).filter(({ f, name }) => {
      if (!ATTACH_TYPES[extOf(name)]) { errors.push(`"${name}": không nhận loại tệp này.`); return false; }
      if (f.size > ATTACH_MAX_BYTES) { errors.push(`"${name}": nặng ${fmtSize(f.size)}, tối đa ${fmtSize(ATTACH_MAX_BYTES)}.`); return false; }
      return true;
    });
    setUploading(n => n + ok.length);
    await Promise.all(ok.map(async ({ f, name }) => {
      try {
        const a = await api<Attachment>('/api/attachments', { method: 'POST', body: JSON.stringify({ name, data: await toBase64(f) }) });
        setItems(cur => [...cur, a]);
      } catch (e) { errors.push((e as Error).message); }
      finally { setUploading(n => n - 1); }
    }));
    if (errors.length) setErr(errors.join(' '));
  }, []);

  const remove = useCallback((id: string) => setItems(cur => cur.filter(a => a.id !== id)), []);
  const clear = useCallback(() => { setItems([]); setErr(null); }, []);
  /** Spread on the box around the text field: paste (Ctrl+V) and drop add files; plain text paste is untouched. */
  const zone = {
    onPaste: (e: ClipboardEvent) => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); void add(f); } },
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); },
    onDrop: (e: DragEvent) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); void add(f); } },
  };
  return { items, ids: items.map(a => a.id), busy: uploading > 0, err, add, remove, clear, zone };
}

export type AttachState = ReturnType<typeof useAttachments>;

/** Button, hint and the files picked so far (removable). */
export function AttachBar({ att }: { att: AttachState }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn sm" onClick={() => input.current?.click()} disabled={att.items.length >= ATTACH_MAX_FILES}>Đính kèm tệp</button>
        <span className="hint">hoặc kéo thả vào ô, hoặc Ctrl+V ảnh chụp màn hình. Ảnh, PDF, md, txt, csv, json; tối đa {ATTACH_MAX_FILES} tệp, mỗi tệp {fmtSize(ATTACH_MAX_BYTES)}.</span>
        <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) void att.add(f); }} />
      </div>
      {(att.items.length > 0 || att.busy) && <AttachList items={att.items} onRemove={att.remove} busy={att.busy} />}
      {att.err && <span className="badge-err">{att.err}</span>}
    </div>
  );
}

/** Attached files as thumbnails (images) or name tags; click opens the file. */
export function AttachList({ items, onRemove, busy }: { items: Attachment[]; onRemove?: (id: string) => void; busy?: boolean }) {
  if (!items.length && !busy) return null;
  return (
    <ul className="att-list" aria-label="Tệp đính kèm">
      {items.map(a => (
        <li key={a.id} className="att">
          <a href={fileUrl(a)} target="_blank" rel="noopener" title={`${a.name} (${fmtSize(a.size)})`}>
            {a.mime.startsWith('image/') ? <img src={fileUrl(a)} alt={a.name} /> : <span className="att-ext">{extOf(a.name) || 'tệp'}</span>}
            <span className="att-name">{a.name}</span>
          </a>
          {onRemove && <button type="button" className="att-x" aria-label={`Bỏ ${a.name}`} onClick={() => onRemove(a.id)}>×</button>}
        </li>
      ))}
      {busy && <li className="att att-busy small muted">Đang tải lên…</li>}
    </ul>
  );
}
