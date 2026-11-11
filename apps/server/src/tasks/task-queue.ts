// T-TC-01..05: task store and single-runner queue. Independent of Nest so tests can drive it directly.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Attachment, ChangedFile, NewTask, PendingInteraction, PermissionDecision, QuestionAnswer, Task, TaskDefaults, TaskDiff, TaskMcp } from '@ccgs/shared';
import type { Db } from '../store/db';
import type { InteractionReply, RunHandle, RunOutcome, Runner, SessionExtras } from './runner';
import { diffSnapshots, type Snapshot } from './git-snapshot';

export type QueueEvents = { task: [Task]; interaction: [PendingInteraction]; resolved: [{ id: string }]; log: ['info' | 'warn' | 'error', string, string | null] };

export interface QueueDeps {
  db: Db;
  runner: Runner;
  /** Project path; null blocks the queue. */
  project: () => string | null;
  snapshot: (cwd: string) => Promise<Snapshot | null>;
  /** S-03 */
  defaults?: () => TaskDefaults;
  /** T-TC-06: commit to diff against, and the diff builder. */
  baseRef?: (cwd: string) => Promise<string | null>;
  diffs?: (cwd: string, base: string | null, files: ChangedFile[], before: Snapshot | null) => Promise<TaskDiff[]>;
  /** T-TC-07: whether a session id exists (to resume). */
  sessionExists?: (id: string) => boolean;
  /** Tools allowed without asking (Settings.autoAllow, '*' = all) and how to remember one more. */
  autoAllow?: { has(tool: string): boolean; add(tool: string): void };
  /** Turns the attachment ids of a new task into files (AttachmentStore); throws on a missing one. */
  attachments?: { resolve(ids: unknown): Attachment[] };
}

const SKILL_RE = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$/i; // plugin skills: plugin:skill
const MODES = ['default', 'acceptEdits', 'plan'] as const;

export class BadTask extends Error {}

function fromRow(r: any): Task {
  return {
    id: r.id, kind: r.kind, skill: r.skill, args: r.args, prompt: r.prompt, model: r.model, permissionMode: r.permission_mode,
    status: r.status, position: r.position, sessionId: r.session_id, resumeOf: r.resume_of, createdAt: r.created_at,
    startedAt: r.started_at, endedAt: r.ended_at, resultText: r.result_text,
    changedFiles: r.changed_files ? JSON.parse(r.changed_files) as ChangedFile[] : null, error: r.error,
    costUsd: r.cost_usd ?? null, compactCostUsd: r.compact_cost_usd ?? null, sessionCostUsd: r.session_cost_usd ?? null,
    contextTokens: r.context_tokens ?? null, baseRef: r.base_ref ?? null,
    mcp: r.mcp ? JSON.parse(r.mcp) as TaskMcp : null,
    attachments: r.attachments ? JSON.parse(r.attachments) as Attachment[] : null,
  };
}

/** Default for TaskDefaults.compactMinTokens: the fixed context alone (system prompt, CLAUDE.md, tools, skills) is ~55–70k. */
export const COMPACT_MIN_TOKENS = 100_000;

/**
 * Splits the SDK's running session total into the /compact before the task and the task itself.
 * before: the session's total after the previous task (0 for a new session, null when unknown).
 * compactTotal: the running total after the /compact that ran before the task (null when none ran).
 * If the SDK did not restore the total on resume (to < from), `to` is that query alone.
 */
export function splitCost(before: number | null, total: number | null | undefined, compactTotal: number | null | undefined) {
  if (typeof total !== 'number') return { costUsd: null, compactCostUsd: null, sessionCostUsd: null };
  const delta = (from: number | null, to: number) => (from === null ? null : to >= from ? to - from : to);
  const compacted = typeof compactTotal === 'number';
  return {
    compactCostUsd: compacted ? delta(before, compactTotal) : null,
    costUsd: delta(compacted ? compactTotal : before, total),
    sessionCostUsd: total,
  };
}

interface Pending { it: PendingInteraction; resolve: (r: InteractionReply) => void; reject: (e: Error) => void }

export class TaskQueue {
  readonly bus = new EventEmitter<QueueEvents>();
  private current: { task: Task; handle: RunHandle | null; stopping: boolean; timedOut: string | null } | null = null;
  private pending = new Map<string, Pending>();
  private pumping = false;
  /** Decides extra SDK options (MCP servers, system prompt) per task right before it starts; set by PipelineService. */
  private extrasFor: ((task: Task) => Promise<SessionExtras | null>) | null = null;

  constructor(private readonly d: QueueDeps) {}

  setSessionExtras(fn: (task: Task) => Promise<SessionExtras | null>) { this.extrasFor = fn; }

  private get sql() { return this.d.db.$client; }

  get(id: string): Task | null {
    const r = this.sql.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return r ? fromRow(r) : null;
  }

  list(f: { status?: string; q?: string; skill?: string; from?: string; limit?: number } = {}): Task[] {
    const where: string[] = [], args: unknown[] = [];
    if (f.status) { where.push(`status IN (${f.status.split(',').map(() => '?').join(',')})`); args.push(...f.status.split(',')); }
    if (f.q) { const q = f.q.toLowerCase(); where.push("(instr(lower(prompt), ?) > 0 OR instr(lower(COALESCE(result_text, '')), ?) > 0 OR id LIKE ?)"); args.push(q, q, f.q + '%'); }
    if (f.skill) { where.push('skill = ?'); args.push(f.skill.replace(/^\//, '')); }
    if (f.from) { where.push('created_at >= ?'); args.push(f.from); }
    const rows = this.sql.prepare(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'waiting' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, position, created_at DESC LIMIT ?`)
      .all(...args, Math.min(f.limit ?? 200, 500));
    return rows.map(fromRow);
  }

  running(): Task | null { return this.current ? this.get(this.current.task.id) : null; }
  interactions(): PendingInteraction[] { return [...this.pending.values()].map(p => p.it); }
  queuedCount(): number { return (this.sql.prepare("SELECT COUNT(*) n FROM tasks WHERE status = 'queued'").get() as any).n; }
  /** T-PJ-03: anything running or waiting in the queue. */
  busy(): boolean { return !!this.current || this.queuedCount() > 0; }

  /** T-TC-06 */
  diffs(id: string): TaskDiff[] | null {
    const r = this.sql.prepare('SELECT diffs FROM tasks WHERE id = ?').get(id) as any;
    return r?.diffs ? JSON.parse(r.diffs) : null;
  }

  private save(t: Task) {
    this.sql.prepare(`INSERT INTO tasks (id, kind, skill, args, prompt, model, permission_mode, status, position, session_id, resume_of,
        created_at, started_at, ended_at, result_text, changed_files, error, cost_usd, compact_cost_usd, session_cost_usd, context_tokens, base_ref, mcp, attachments)
      VALUES (@id, @kind, @skill, @args, @prompt, @model, @permissionMode, @status, @position, @sessionId, @resumeOf,
        @createdAt, @startedAt, @endedAt, @resultText, @changedFiles, @error, @costUsd, @compactCostUsd, @sessionCostUsd, @contextTokens, @baseRef, @mcp, @attachments)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, position = excluded.position, session_id = excluded.session_id,
        started_at = excluded.started_at, ended_at = excluded.ended_at, result_text = excluded.result_text,
        changed_files = excluded.changed_files, error = excluded.error, cost_usd = excluded.cost_usd,
        compact_cost_usd = excluded.compact_cost_usd, session_cost_usd = excluded.session_cost_usd,
        context_tokens = excluded.context_tokens, base_ref = excluded.base_ref, mcp = excluded.mcp`)
      .run({ ...t, costUsd: t.costUsd ?? null, compactCostUsd: t.compactCostUsd ?? null, sessionCostUsd: t.sessionCostUsd ?? null,
        contextTokens: t.contextTokens ?? null, baseRef: t.baseRef ?? null, mcp: t.mcp ? JSON.stringify(t.mcp) : null,
        attachments: t.attachments?.length ? JSON.stringify(t.attachments) : null, changedFiles: t.changedFiles ? JSON.stringify(t.changedFiles) : null });
    this.bus.emit('task', t);
    return t;
  }

  private update(id: string, patch: Partial<Task>): Task {
    const t = this.get(id);
    if (!t) throw new BadTask('Không có task này');
    return this.save({ ...t, ...patch });
  }

  /**
   * Calls to the tools of each MCP server attached to the task, from the hook events (PreToolUse carries the task id,
   * subagents included). The hook posts each event before the tool runs, so all are in when the SDK result arrives.
   */
  private mcpCalls(id: string): Partial<Task> {
    const m = this.get(id)?.mcp;
    if (!m?.servers.length) return {};
    const n = this.sql.prepare(`SELECT COUNT(*) n FROM events WHERE task_id = ? AND event_type = 'PreToolUse' AND substr(tool_name, 1, ?) = ?`);
    const calls = Object.fromEntries(m.servers.map(s => { const p = `mcp__${s}__`; return [s, (n.get(id, p.length, p) as any).n as number]; }));
    return { mcp: { ...m, calls } };
  }

  /** SDK running total of a session after its latest finished task that reported one. */
  private sessionTotal(sessionId: string): number | null {
    const r = this.sql.prepare(`SELECT session_cost_usd c FROM tasks WHERE session_id = ? AND session_cost_usd IS NOT NULL
      AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`).get(sessionId) as any;
    return r?.c ?? null;
  }

  /**
   * Whether to /compact a session before resuming it: auto-compact on (Cài đặt) and its last known context is at least
   * compactMinTokens. Unknown size (older tasks, or a session not run by Studio) compacts, as before.
   */
  private compactFirst(task: Task): boolean {
    const def = this.d.defaults?.();
    if (!task.resumeOf || !def?.compactAfter) return false;
    const r = this.sql.prepare(`SELECT context_tokens n FROM tasks WHERE session_id = ? AND context_tokens IS NOT NULL
      AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`).get(task.resumeOf) as any;
    return r?.n == null || r.n >= (def.compactMinTokens ?? COMPACT_MIN_TOKENS);
  }

  /** Re-numbers queued tasks 1..n in the given order and emits the ones that moved. */
  private renumber(order: string[]) {
    order.forEach((id, i) => {
      const t = this.get(id);
      if (t && t.position !== i + 1) this.save({ ...t, position: i + 1 });
    });
  }
  private queuedIds(): string[] {
    return (this.sql.prepare("SELECT id FROM tasks WHERE status = 'queued' ORDER BY position, created_at").all() as any[]).map(r => r.id);
  }

  /** Tasks left running by a previous Studio process cannot be reattached. */
  recover() {
    for (const r of this.sql.prepare("SELECT * FROM tasks WHERE status IN ('running','waiting')").all()) {
      this.save({ ...fromRow(r), status: 'failed', endedAt: new Date().toISOString(), error: 'Studio khởi động lại khi task đang chạy.' });
    }
    this.renumber(this.queuedIds());
    void this.pump();
  }

  create(input: NewTask): Task {
    const kind = input?.kind === 'skill' ? 'skill' : input?.kind === 'prompt' ? 'prompt' : null;
    if (!kind) throw new BadTask('kind phải là prompt hoặc skill');
    const def: TaskDefaults = this.d.defaults?.() ?? { model: null, permissionMode: 'default', maxRuntimeMin: null, compactAfter: false };
    const mode = input.permissionMode ?? def.permissionMode;
    if (!MODES.includes(mode)) throw new BadTask('permissionMode không hợp lệ');
    let prompt: string, skill: string | null = null, args: string | null = null;
    if (kind === 'skill') {
      skill = String(input.skill ?? '').replace(/^\//, '').trim();
      if (!SKILL_RE.test(skill)) throw new BadTask('Tên skill không hợp lệ');
      args = String(input.args ?? '').trim() || null;
      prompt = `/${skill}${args ? ' ' + args : ''}`;
    } else {
      prompt = String(input.prompt ?? '').trim();
      if (!prompt) throw new BadTask('Prompt trống');
    }
    const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : input.model === undefined ? def.model : null;
    let resumeOf: string | null = null;
    if (input.resumeOf !== undefined && input.resumeOf !== null && input.resumeOf !== '') {
      resumeOf = String(input.resumeOf);
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(resumeOf)) throw new BadTask('Session để tiếp tục không hợp lệ');
      if (this.d.sessionExists && !this.d.sessionExists(resumeOf)) throw new BadTask('Không có session này để tiếp tục');
    }
    let attachments: Attachment[] | null = null;
    if (input.attachments !== undefined && input.attachments !== null) {
      if (!this.d.attachments) throw new BadTask('Studio chưa bật tệp đính kèm');
      try { attachments = this.d.attachments.resolve(input.attachments); } catch (e) { throw new BadTask((e as Error).message); }
      if (!attachments.length) attachments = null;
    }
    const t: Task = {
      id: randomUUID(), kind, skill, args, prompt, model, permissionMode: mode, status: 'queued',
      position: this.queuedIds().length + 1, sessionId: null, resumeOf, createdAt: new Date().toISOString(),
      startedAt: null, endedAt: null, resultText: null, changedFiles: null, error: null, costUsd: null, baseRef: null, attachments,
    };
    this.save(t);
    void this.pump();
    return t;
  }

  /** T-TC-07: continue a finished task's session with a new prompt. */
  resume(id: string, prompt: string, attachments?: string[]): Task {
    const t = this.get(id);
    if (!t) throw new BadTask('Không có task này');
    if (!t.sessionId) throw new BadTask('Task này chưa có session để tiếp tục');
    if (!['completed', 'failed', 'cancelled'].includes(t.status)) throw new BadTask('Chỉ tiếp tục được task đã kết thúc');
    return this.create({ kind: 'prompt', prompt, resumeOf: t.sessionId, model: t.model, permissionMode: t.permissionMode, ...(attachments ? { attachments } : {}) });
  }

  /** Moves a queued task to 1-based `position`. */
  move(id: string, position: number) {
    const t = this.get(id);
    if (!t || t.status !== 'queued') throw new BadTask('Chỉ đổi thứ tự được task đang chờ');
    const ids = this.queuedIds().filter(x => x !== id);
    const at = Math.max(0, Math.min(ids.length, Math.floor(Number(position) || 1) - 1));
    ids.splice(at, 0, id);
    this.renumber(ids);
    return this.get(id)!;
  }

  async cancel(id: string): Promise<Task> {
    const t = this.get(id);
    if (!t) throw new BadTask('Không có task này');
    if (t.status === 'queued') {
      const r = this.update(id, { status: 'cancelled', position: null, endedAt: new Date().toISOString() });
      this.renumber(this.queuedIds());
      return r;
    }
    if (this.current?.task.id === id && !this.current.stopping) {
      this.current.stopping = true;
      this.bus.emit('log', 'info', `Dừng task ${id.slice(0, 8)} theo yêu cầu.`, t.sessionId);
      for (const [pid, p] of this.pending) if (p.it.taskId === id) this.drop(pid, new Error('Task bị dừng'));
      await this.current.handle?.stop();
      return this.get(id)!;
    }
    throw new BadTask('Task đã kết thúc');
  }

  answer(interactionId: string, reply: QuestionAnswer | PermissionDecision) {
    const p = this.pending.get(interactionId);
    if (!p) throw new BadTask('Câu hỏi này không còn chờ trả lời');
    if (p.it.kind === 'question') {
      const a = (reply as QuestionAnswer)?.answers;
      if (!a || typeof a !== 'object') throw new BadTask('Thiếu answers');
      const qs = p.it.question?.questions ?? [];
      for (const q of qs) if (typeof a[q.question] !== 'string' || !a[q.question].trim()) throw new BadTask(`Chưa trả lời: ${q.question}`);
      this.pending.delete(interactionId);
      p.resolve({ answers: Object.fromEntries(qs.map(q => [q.question, a[q.question]])) });
    } else {
      const d = (reply as PermissionDecision)?.decision;
      if (d !== 'allow' && d !== 'deny') throw new BadTask('decision phải là allow hoặc deny');
      this.pending.delete(interactionId);
      p.resolve({ decision: d, message: (reply as PermissionDecision).message });
      const tool = p.it.permission?.toolName;
      if (d === 'allow' && (reply as PermissionDecision).always && tool && this.d.autoAllow) {
        this.d.autoAllow.add(tool);
        this.bus.emit('log', 'info', `Từ giờ tự cho phép ${tool} (Cài đặt > Quyền).`, null);
        // Other prompts for the same tool that are already waiting.
        for (const [id, o] of [...this.pending]) if (o.it.kind === 'permission' && o.it.permission?.toolName === tool) {
          this.pending.delete(id);
          o.resolve({ decision: 'allow' });
          this.bus.emit('resolved', { id });
          if (o.it.taskId !== p.it.taskId) this.syncWaiting(o.it.taskId);
        }
      }
    }
    this.bus.emit('resolved', { id: interactionId });
    this.syncWaiting(p.it.taskId);
  }

  private drop(id: string, e: Error) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(e);
    this.bus.emit('resolved', { id });
  }

  private syncWaiting(taskId: string) {
    if (this.current?.task.id !== taskId) return;
    const t = this.get(taskId);
    if (!t || (t.status !== 'running' && t.status !== 'waiting')) return;
    const want = [...this.pending.values()].some(p => p.it.taskId === taskId) ? 'waiting' : 'running';
    if (t.status !== want) this.save({ ...t, status: want });
  }

  /** Starts the next queued task if nothing runs. */
  async pump() {
    if (this.current || this.pumping) return;
    const cwd = this.d.project();
    if (!cwd) return;
    const next = this.queuedIds()[0];
    if (!next) return;
    this.pumping = true;
    let task: Task;
    try {
      task = this.update(next, { status: 'running', position: null, startedAt: new Date().toISOString() });
      this.current = { task, handle: null, stopping: false, timedOut: null };
      this.renumber(this.queuedIds());
    } finally { this.pumping = false; }

    const before = await this.d.snapshot(cwd).catch(() => null);
    const base = before && this.d.baseRef ? await this.d.baseRef(cwd).catch(() => null) : null;
    if (base) task = this.update(task.id, { baseRef: base });
    const id = task.id;
    const compactFirst = this.compactFirst(task);
    let extras: SessionExtras | null = null;
    if (this.extrasFor) {
      // A failure here never blocks the task: it runs without the extras.
      try { extras = await this.extrasFor(task); }
      catch (e) { this.bus.emit('log', 'warn', `Không chuẩn bị được MCP cho task: ${(e as Error).message}`, task.sessionId ?? null); }
      const servers = Object.keys(extras?.mcpServers ?? {});
      if (servers.length) this.bus.emit('log', 'info', `Gắn MCP cho task: ${servers.join(', ')}`, task.sessionId ?? null);
      if (servers.length || extras?.note) task = this.update(id, { mcp: { servers, note: extras?.note ?? null, calls: null } });
    }
    const handle = this.d.runner(task, {
      onSession: sid => { this.update(id, { sessionId: sid }); },
      log: (lvl, msg) => this.bus.emit('log', lvl, msg, this.get(id)?.sessionId ?? null),
      ask: (req, signal) => new Promise((resolve, reject) => {
        if (this.current?.stopping) return reject(new Error('Task bị dừng'));
        if (req.kind === 'permission' && req.permission && this.d.autoAllow?.has(req.permission.toolName)) {
          this.bus.emit('log', 'info', `Tự cho phép ${req.permission.toolName}: ${req.permission.inputSummary.slice(0, 160)}`, this.get(id)?.sessionId ?? null);
          return resolve({ decision: 'allow' });
        }
        const it: PendingInteraction = { ...req, id: randomUUID(), taskId: id, createdAt: new Date().toISOString() };
        this.pending.set(it.id, { it, resolve, reject });
        signal?.addEventListener('abort', () => { this.drop(it.id, new Error('Claude huỷ yêu cầu')); this.syncWaiting(id); }, { once: true });
        this.bus.emit('interaction', it);
        this.syncWaiting(id);
      }),
    }, { compactFirst, extras });
    this.current.handle = handle;
    if (this.current.stopping) void handle.stop(); // cancelled during snapshot
    const maxMin = this.d.defaults?.().maxRuntimeMin ?? null;
    const cur = this.current;
    const limit = maxMin ? setTimeout(() => {
      if (cur.stopping) return;
      cur.stopping = true;
      cur.timedOut = `Vượt thời gian chạy tối đa (${maxMin} phút), Studio đã dừng task.`;
      this.bus.emit('log', 'warn', `Task ${id.slice(0, 8)}: ${cur.timedOut}`, this.get(id)?.sessionId ?? null);
      for (const [pid, p] of this.pending) if (p.it.taskId === id) this.drop(pid, new Error('Task quá thời gian'));
      void handle.stop();
    }, maxMin * 60_000) : null;

    const out: RunOutcome = await handle.done.catch(e => ({ ok: false, sessionId: null, resultText: null, error: String((e as Error)?.message ?? e), costUsd: null }));
    if (limit) clearTimeout(limit);
    for (const [pid, p] of this.pending) if (p.it.taskId === id) this.drop(pid, new Error('Task đã kết thúc'));
    let changedFiles: ChangedFile[] | null = null;
    const after = before ? await this.d.snapshot(cwd).catch(() => null) : null;
    if (before && after) changedFiles = diffSnapshots(before, after);
    if (changedFiles?.length && this.d.diffs) {
      const d = await this.d.diffs(cwd, base, changedFiles, before).catch(() => null);
      if (d) this.sql.prepare('UPDATE tasks SET diffs = ? WHERE id = ?').run(JSON.stringify(d), id);
    }
    const { stopping: stopped, timedOut } = this.current;
    const resumed = this.get(id)?.resumeOf ?? null;
    const cost = splitCost(resumed ? this.sessionTotal(resumed) : 0, out.costUsd, out.compactTotalUsd);
    if (resumed && cost.costUsd === null && typeof out.costUsd === 'number') {
      this.bus.emit('log', 'warn', `Task ${id.slice(0, 8)}: không biết chi phí luỹ kế trước đó của session, nên chi phí riêng của task là Unknown (SDK báo luỹ kế $${out.costUsd.toFixed(4)}).`, out.sessionId ?? null);
    }
    this.update(id, {
      status: timedOut ? 'failed' : stopped ? 'cancelled' : out.ok ? 'completed' : 'failed',
      endedAt: new Date().toISOString(), resultText: out.resultText, changedFiles, ...cost, contextTokens: out.contextTokens ?? null,
      error: timedOut ?? (stopped ? null : out.error), sessionId: out.sessionId ?? this.get(id)?.sessionId ?? null,
      ...this.mcpCalls(id),
    });
    this.current = null;
    void this.pump();
  }
}
