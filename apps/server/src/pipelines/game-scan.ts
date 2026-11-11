// Game scan: a read-only task that reads the open Unity project through Unity MCP (scenes, UI, screenshots)
// before /start and planning. The result lives in the Studio home, never in the project.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { DoctorCheck, GameScan, Task } from '@ccgs/shared';
import type { TaskQueue } from '../tasks/task-queue';

export const NO_MCP = 'UNITY_MCP_UNAVAILABLE';
const ENDED = ['completed', 'failed', 'cancelled'];

export function scanPrompt(outDir: string): string {
  return [
    'You are scanning an existing Unity game for CCGS Studio. READ-ONLY: do not modify, create or delete anything in the project,',
    'do not enter Play mode, do not save scenes, do not change selection persistently.',
    'Use ONLY the Unity MCP tools (server "UnityMCP" / mcp__UnityMCP__*) plus Read/Glob/Grep.',
    `If no Unity MCP tool is available or the Unity Editor is not connected, reply with exactly the line ${NO_MCP} followed by the reason, and stop.`,
    '',
    'Collect:',
    '1. Unity version, render pipeline, the open scene, and the scenes in Build Settings.',
    '2. UI structure: Canvases, top-level screens/popups/panels (name, path, whether active), and the UI prefabs under Assets.',
    '3. Main UI scripts (screen/popup controllers) and how screens are opened (UI manager, navigation).',
    `4. Screenshots of the Game View and Scene View of the open scene in Edit mode. Save image files only inside ${outDir.split(path.sep).join("/")}`,
    '   (never inside the project). If saving there is not possible, skip screenshots and say so.',
    '',
    'Reply in Vietnamese markdown with sections: Tổng quan, Scene, Màn hình UI (table: tên, loại, đường dẫn, ghi chú UX), Luồng UI, Ảnh chụp (absolute paths), Chưa rõ.',
    'Write "Unknown" for anything you could not read. Do not invent screens.',
  ].join('\n');
}

export class GameScanService {
  readonly bus = new EventEmitter<{ scan: [GameScan] }>();
  constructor(private readonly d: {
    home: string; queue: TaskQueue; project: () => string | null;
    /** Quick Unity MCP check before a scan (no Claude call); ok === false refuses the scan. */
    unityCheck?: () => Promise<DoctorCheck>;
  }) {
    d.queue.bus.on('task', t => this.onTask(t));
  }
  private key() { const p = this.d.project(); return p ? crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16) : null; }
  private dir() { const k = this.key(); return k ? path.join(this.d.home, 'scans', k) : null; }
  private file() { const d = this.dir(); return d ? path.join(d, 'scan.json') : null; }

  get(): GameScan {
    const f = this.file();
    const empty: GameScan = { status: 'none', taskId: null, sessionId: null, at: null, summary: null, images: [], error: null };
    if (!f || !fs.existsSync(f)) return empty;
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8')) as GameScan;
      const imgDir = path.join(this.dir()!, 'img');
      if (s.status === 'running' && s.taskId) {
        const t = this.d.queue.get(s.taskId);
        if (!t || ENDED.includes(t.status)) { if (t) this.onTask(t); else this.save({ ...s, status: 'failed', error: 'Task quét không còn' }); return this.get(); }
      }
      if (!s.startDoneAt && s.sessionId) {
        const done = this.d.queue.list({ skill: 'start', status: 'completed', limit: 50 }).find(t => t.resumeOf === s.sessionId || t.id === s.startTaskId);
        if (done) { s.startTaskId = done.id; s.startDoneAt = done.endedAt ?? new Date().toISOString(); this.save(s); return this.get(); }
      }
      s.images = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).filter(n => /\.(png|jpe?g)$/i.test(n)) : [];
      return s;
    } catch { return empty; }
  }
  /** Absolute path of a screenshot, or null when the name is not a file of the current scan. */
  image(name: string): string | null {
    const d = this.dir();
    if (!d || !/^[\w.\- ]+\.(png|jpe?g)$/i.test(name)) return null;
    const p = path.join(d, 'img', name);
    return fs.existsSync(p) ? p : null;
  }
  private save(s: GameScan) { const f = this.file(); if (!f) return; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s, null, 2)); this.bus.emit('scan', this.get()); }

  start(): GameScan {
    const d = this.dir();
    if (!d) throw new Error('Chưa chọn project');
    if (this.get().status === 'running') throw new Error('Đang quét');
    const img = path.join(d, 'img');
    fs.rmSync(img, { recursive: true, force: true });
    fs.mkdirSync(img, { recursive: true });
    const t = this.d.queue.create({ kind: 'prompt', prompt: scanPrompt(img), permissionMode: 'default' });
    const prev = this.raw();
    this.save({ status: 'running', taskId: t.id, sessionId: null, at: new Date().toISOString(), summary: null, images: [], error: null, startTaskId: prev?.startTaskId ?? null, startDoneAt: prev?.startDoneAt ?? null });
    return this.get();
  }
  /**
   * "Quét game" button: checks Unity MCP first, so a closed Unity Editor is reported at once instead of after a paid
   * Claude session. Only a definite failure (ok === false) refuses; unknown (stdio, remote) still scans.
   */
  async startChecked(): Promise<GameScan> {
    if (!this.dir()) throw new Error('Chưa chọn project');
    if (this.get().status === 'running') throw new Error('Đang quét');
    const c = this.d.unityCheck ? await this.d.unityCheck() : null;
    if (c?.ok === false) throw new Error(`Chưa quét: Unity MCP không sẵn sàng. ${c.detail}`);
    return this.start();
  }

  /** /start continuing the scan session, so it already knows the existing game. */
  runStart(): Task {
    const s = this.get();
    if (s.status !== 'ok' || !s.sessionId) throw new Error('Cần quét game thành công trước');
    const t = this.d.queue.create({ kind: 'skill', skill: 'start', args: '', resumeOf: s.sessionId });
    this.save({ ...this.raw()!, startTaskId: t.id, startDoneAt: null });
    return t;
  }
  private raw(): GameScan | null { const f = this.file(); try { return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } }
  private onTask(t: Task) {
    const s = this.raw();
    if (!s) return;
    if (s.startTaskId === t.id && ENDED.includes(t.status)) { if (t.status === 'completed') this.save({ ...s, startDoneAt: t.endedAt ?? new Date().toISOString() }); return; }
    if (s.taskId !== t.id || !ENDED.includes(t.status)) return;
    const text = t.resultText ?? '';
    const noMcp = text.includes(NO_MCP);
    this.save({
      ...s, sessionId: t.sessionId, at: t.endedAt ?? new Date().toISOString(),
      status: t.status === 'completed' && !noMcp && text.trim() ? 'ok' : 'failed',
      summary: text || null,
      error: noMcp ? 'Không kết nối được Unity MCP. Mở Unity Editor, bật MCP for Unity rồi quét lại.' : t.status !== 'completed' ? (t.error ?? t.status) : null,
    });
  }
}
