// "Đầu ra" of a task (api-contract §15): the files it added or changed, opened or converted by Studio without calling
// Claude. Only files in the task's changedFiles (plus, for a changed HTML page, the files next to it) can be read, and
// only inside the project's git root.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { ChangedFile, TaskOutput, TaskOutputFormat, TaskOutputKind } from '@ccgs/shared';

export class BadOutput extends Error {}

const ext = (p: string) => path.extname(p).slice(1).toLowerCase();

export function outputKind(p: string): TaskOutputKind {
  const e = ext(p);
  if (e === 'html' || e === 'htm') return 'web';
  if (e === 'md' || e === 'markdown') return 'doc';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return 'image';
  if (e === 'csv' || e === 'json') return 'data';
  return 'other';
}

export const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', md: 'text/plain; charset=utf-8', markdown: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  cs: 'text/plain; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', woff2: 'font/woff2', ttf: 'font/ttf',
};
export const mimeOf = (p: string) => MIME[ext(p)] ?? 'application/octet-stream';

/** Inside `root` (no "..", no absolute path, no symlink pointing out). */
function inside(root: string, rel: string): string | null {
  const r = path.resolve(root);
  const f = path.resolve(r, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
  if (f === r || !f.startsWith(r + path.sep)) return null;
  try {
    const real = fs.realpathSync(f), realRoot = fs.realpathSync(r);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  } catch { /* missing: the caller reports it */ }
  return f;
}

const live = (files: ChangedFile[] | null) => (files ?? []).filter(f => f.change !== 'D');

/** `root` is the git root (changedFiles are relative to it); `project` maps prototypes/ to the /preview URL. */
export function listOutputs(root: string, project: string, files: ChangedFile[] | null): TaskOutput[] {
  const protoRel = path.relative(root, path.join(project, 'prototypes')).replace(/\\/g, '/');
  return live(files).map(f => {
    const abs = inside(root, f.path);
    let size: number | null = null;
    try { const st = abs ? fs.statSync(abs) : null; size = st?.isFile() ? st.size : null; } catch { /* gone */ }
    const kind = outputKind(f.path);
    const exists = size !== null;
    const preview = exists && kind === 'web' && !protoRel.startsWith('..') && f.path.startsWith(protoRel + '/')
      ? '/preview/' + f.path.slice(protoRel.length + 1).split('/').map(encodeURIComponent).join('/') : null;
    let tables: number | null = null;
    if (exists && kind === 'doc' && size! <= MD_MAX) { try { tables = parseMarkdown(fs.readFileSync(abs!, 'utf8')).tables.length; } catch { /* unreadable */ } }
    return { path: f.path, change: f.change, kind, exists, size, preview, tables };
  });
}

/**
 * A file the task changed, or any file under the folder of an HTML page it changed (its CSS, JS, images).
 * Returns the absolute path; throws BadOutput otherwise.
 */
export function resolveOutput(root: string, files: ChangedFile[] | null, rel: string): string {
  const norm = path.posix.normalize(String(rel ?? '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!norm || norm.startsWith('..')) throw new BadOutput('Đường dẫn không hợp lệ');
  const ok = live(files).some(f => f.path === norm
    || (outputKind(f.path) === 'web' && path.posix.dirname(f.path) !== '.' && norm.startsWith(path.posix.dirname(f.path) + '/')));
  if (!ok) throw new BadOutput('File này không phải đầu ra của task');
  const abs = inside(root, norm);
  if (!abs) throw new BadOutput('File nằm ngoài project');
  try { if (!fs.statSync(abs).isFile()) throw new Error(); } catch { throw new BadOutput('File không còn trên đĩa'); }
  return abs;
}

// ---------- Output asked for when creating the task (Task.output) ----------

/** Files Claude wrote to the task's Studio folder are listed and opened as `~studio/<rel>`. */
export const STUDIO_PREFIX = '~studio/';
export const studioOutputDir = (home: string, taskId: string) => path.join(home, 'outputs', taskId);

const NOTES: Record<TaskOutputFormat, (dir: string) => string> = {
  web: d => `Requested output: a web page. Besides the work itself, write ONE self-contained HTML file to ${path.join(d, 'index.html')}:
inline CSS and JavaScript (classic <script>, not type="module"), no CDN or network requests, opens by double-click.
For a prototype or gameplay idea, make it playable in the browser. For a design, document or report, lay its content out
so it is easy to read (headings, tables, states, numbers). Keep the facts the same as in the project files.`,
  xlsx: d => `Requested output: an Excel workbook. Besides the work itself, write the result as Markdown to ${path.join(d, 'output.md')}:
a "# " title, "## " sections, and every list of values as a pipe table (header row, then one row per item), e.g.
tuning values, rewards, states, acceptance criteria. Studio turns this file into output.xlsx when the task ends
(sheet "Nội dung" plus one sheet per table). Do not try to create the .xlsx file yourself.`,
  csv: d => `Requested output: CSV. Besides the work itself, write each table of the result as its own CSV file in ${d}
(UTF-8, comma separated, header row first, cells with commas, quotes or line breaks in double quotes; quotes doubled),
named after its content, e.g. rewards.csv, tuning.csv.`,
};

/** Appended to the prompt (after the attachments note) when an output format was asked for. */
export function withOutput(prompt: string, format: TaskOutputFormat | null | undefined, dir: string | null): string {
  if (!format || !dir || !NOTES[format]) return prompt;
  return `${prompt}\n\n${NOTES[format](dir)}\nThis folder is outside the project and only holds this output; say in your final reply which file(s) you wrote there.`;
}

function walk(dir: string, rel = '', out: string[] = [], depth = 0): string[] {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory() && depth < 4) walk(dir, r, out, depth + 1);
    else if (e.isFile() && out.length < 200) out.push(r);
  }
  return out;
}

/**
 * Files in the task's Studio folder. For an Excel output, every .md there gets a .xlsx next to it, rebuilt when the .md
 * is newer, so the workbook appears as soon as the output is listed.
 */
export async function studioOutputs(dir: string, format: TaskOutputFormat | null | undefined): Promise<TaskOutput[]> {
  if (format === 'xlsx') {
    for (const r of walk(dir).filter(r => outputKind(r) === 'doc')) {
      const md = path.join(dir, r), xlsx = md.replace(/\.[^.]+$/, '.xlsx');
      try {
        const sm = fs.statSync(md);
        if (sm.size > MD_MAX) continue;
        let fresh = false;
        try { fresh = fs.statSync(xlsx).mtimeMs >= sm.mtimeMs; } catch { /* not built yet */ }
        if (!fresh) fs.writeFileSync(xlsx, await markdownToXlsx(fs.readFileSync(md, 'utf8'), path.basename(r).replace(/\.[^.]+$/, '')));
      } catch { /* left as .md only */ }
    }
  }
  return walk(dir).sort().map(r => {
    const abs = path.join(dir, r);
    const size = fs.statSync(abs).size;
    const kind = outputKind(r);
    let tables: number | null = null;
    if (kind === 'doc' && size <= MD_MAX) { try { tables = parseMarkdown(fs.readFileSync(abs, 'utf8')).tables.length; } catch { /* unreadable */ } }
    return { path: STUDIO_PREFIX + r, change: 'A' as const, kind, exists: true, size, preview: null, tables };
  });
}

/** A file under the task's Studio folder (`~studio/<rel>`); throws BadOutput otherwise. */
export function resolveStudioOutput(dir: string, rel: string): string {
  const r = String(rel ?? '').replace(/\\/g, '/').slice(STUDIO_PREFIX.length);
  const abs = r ? inside(dir, r) : null;
  if (!abs) throw new BadOutput('Đường dẫn không hợp lệ');
  try { if (!fs.statSync(abs).isFile()) throw new Error(); } catch { throw new BadOutput('File không còn trên đĩa'); }
  return abs;
}

// ---------- Markdown → sections and tables ----------

export const MD_MAX = 5 * 1024 * 1024;
export interface MdTable { section: string; header: string[]; rows: string[][] }
export interface MdSection { heading: string; level: number; lines: string[] }

const cells = (line: string) => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(c => clean(c.trim().replace(/\\\|/g, '|')));
};
const isSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
/** Markdown emphasis and code marks removed, links kept as their text; the words stay as written. */
const clean = (s: string) => s.replace(/<br\s*\/?>/gi, '\n').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
  .replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

/** Splits by headings; every pipe table (header + --- line) is lifted out with the heading it sits under. */
export function parseMarkdown(md: string): { title: string | null; sections: MdSection[]; tables: MdTable[] } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const sections: MdSection[] = [{ heading: '', level: 0, lines: [] }];
  const tables: MdTable[] = [];
  let title: string | null = null, fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const cur = sections[sections.length - 1];
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; cur.lines.push(l); continue; }
    if (fence) { cur.lines.push(l); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      const text = clean(h[2]);
      if (h[1].length === 1 && title === null) title = text;
      sections.push({ heading: text, level: h[1].length, lines: [] });
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = cells(l);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i++; }
      i--;
      tables.push({ section: cur.heading, header, rows });
      cur.lines.push(`[Bảng ${tables.length}]`);
      continue;
    }
    cur.lines.push(l);
  }
  for (const s of sections) {
    while (s.lines.length && !s.lines[0].trim()) s.lines.shift();
    while (s.lines.length && !s.lines[s.lines.length - 1].trim()) s.lines.pop();
  }
  return { title, sections: sections.filter(s => s.heading || s.lines.length), tables };
}

// ---------- CSV ----------

const csvCell = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvRow = (r: string[]) => r.map(csvCell).join(',');

/**
 * The tables of the document. One table: just that table. Several: a "Mục" column with the heading each table sits
 * under when they share the same columns; otherwise each table in turn, a title row before it and a blank line between.
 * Starts with a UTF-8 BOM so Excel reads Vietnamese correctly. Throws when the document has no table.
 */
export function markdownToCsv(md: string): string {
  const { tables } = parseMarkdown(md);
  if (!tables.length) throw new BadOutput('Tài liệu không có bảng nào để xuất CSV. Dùng Xuất Excel để lấy cả phần chữ.');
  const same = tables.every(t => t.header.join('\u0000') === tables[0].header.join('\u0000'));
  let out: string[];
  if (tables.length === 1) out = [csvRow(tables[0].header), ...tables[0].rows.map(csvRow)];
  else if (same) out = [csvRow(['Mục', ...tables[0].header]), ...tables.flatMap(t => t.rows.map(r => csvRow([t.section, ...r])))];
  else out = tables.flatMap((t, k) => [...(k ? [''] : []), csvRow([t.section || `Bảng ${k + 1}`]), csvRow(t.header), ...t.rows.map(csvRow)]);
  return '﻿' + out.join('\r\n') + '\r\n';
}

// ---------- Excel ----------

/**
 * Sheet "Nội dung": each section as a block (heading row, then its text), tables placed where they are in the
 * document as real cells. Then one sheet per table, with filters on, for sorting and tuning.
 */
export async function markdownToXlsx(md: string, name: string): Promise<Buffer> {
  const doc = parseMarkdown(md);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CCGS Studio';
  const ws = wb.addWorksheet('Nội dung', { views: [{ state: 'frozen', ySplit: 1 }] });
  const width = Math.max(2, ...doc.tables.map(t => Math.max(t.header.length, ...t.rows.map(r => r.length))));
  ws.columns = Array.from({ length: width }, (_, i) => ({ width: i === 0 ? 60 : 28 }));
  const title = ws.addRow([doc.title ?? name]);
  title.font = { bold: true, size: 14 };
  const tableRows = (t: MdTable, sheet: ExcelJS.Worksheet) => {
    const h = sheet.addRow(t.header);
    h.font = { bold: true };
    h.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } }; c.border = { bottom: { style: 'thin' } }; });
    for (const r of t.rows) sheet.addRow(r).alignment = { wrapText: true, vertical: 'top' };
    return h.number;
  };
  for (const s of doc.sections) {
    if (s.heading && s.heading !== doc.title) {
      ws.addRow([]);
      const r = ws.addRow([s.heading]);
      r.font = { bold: true, size: s.level <= 2 ? 13 : 11 };
    }
    for (const l of s.lines) {
      const m = /^\[Bảng (\d+)\]$/.exec(l.trim());
      if (m) { tableRows(doc.tables[Number(m[1]) - 1], ws); continue; }
      if (!l.trim()) continue;
      ws.addRow([clean(l.replace(/^\s*[-*+]\s+/, '• ').replace(/^\s*>\s?/, ''))]).alignment = { wrapText: true, vertical: 'top' };
    }
  }
  const used = new Set(['nội dung']); // Excel sheet names are unique ignoring case, max 31 chars
  doc.tables.forEach((t, k) => {
    const base = (t.section || `Bảng ${k + 1}`).replace(/[\\/?*[\]:']/g, ' ').trim().slice(0, 28) || `Bảng ${k + 1}`;
    let n = base;
    for (let j = 2; used.has(n.toLowerCase()); j++) n = `${base.slice(0, 25)} ${j}`;
    used.add(n.toLowerCase());
    const sh = wb.addWorksheet(n, { views: [{ state: 'frozen', ySplit: 1 }] });
    sh.columns = t.header.map(h => ({ width: Math.min(60, Math.max(12, h.length + 4, ...t.rows.map(r => Math.min(60, (r[t.header.indexOf(h)] ?? '').length + 2)))) }));
    tableRows(t, sh);
    if (t.header.length) sh.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.header.length } };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
