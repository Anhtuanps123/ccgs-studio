import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentInvocation, AgentStats, ConversationItem, DiffLine, FileActivity, IngestBody, LogEntry, Session, SessionUsage, StudioEvent,
  TaskStats, TimelineStep, ToolCall, ToolCallDetail, TranscriptItem,
} from '@ccgs/shared';
import { addUsage, emptyUsage, readTranscript, subagentTranscript } from './transcript';
import { unifiedDiff } from './diff';
import { Db, events, invocations, logs, openDb, sessions, toolcalls } from '../store/db';
import { SettingsService } from '../settings/settings.service';
import { Projector, mainId, toToolCall } from './projector';
import { redact, redactString } from './redact';

export type MonitorEvents = {
  session: [Session]; invocation: [AgentInvocation]; toolcall: [ToolCall]; event: [StudioEvent]; log: [LogEntry]; doctor: [string];
};

@Injectable()
export class MonitorService implements OnModuleDestroy {
  readonly db: Db;
  readonly bus = new EventEmitter<MonitorEvents>();
  private readonly projector: Projector;
  private seq: number;
  private logSeq: number;
  lastEventAt: string | null = null;

  constructor(settings: SettingsService) {
    this.db = openDb(process.env.CCGS_STUDIO_DB ?? path.join(settings.dir, 'studio.db'));
    this.projector = new Projector(this.db);
    const c = this.db.$client;
    this.seq = (c.prepare('SELECT COALESCE(MAX(seq),0) m FROM events').get() as any).m;
    this.logSeq = (c.prepare('SELECT COALESCE(MAX(seq),0) m FROM logs').get() as any).m;
    this.lastEventAt = (c.prepare('SELECT MAX(timestamp) t FROM events').get() as any).t ?? null;
  }

  onModuleDestroy() { this.db.$client.close(); }

  log(level: LogEntry['level'], source: LogEntry['source'], message: string, sessionId: string | null = null, timestamp = new Date().toISOString()) {
    const e: LogEntry = { id: randomUUID(), timestamp, level, source, sessionId, message: redactString(message) };
    this.db.insert(logs).values({ ...e, seq: ++this.logSeq }).run();
    this.bus.emit('log', e);
    return e;
  }

  /** Stores one hook event (already redacted) and projects it. Never throws on odd payloads. */
  ingest(body: IngestBody): StudioEvent | null {
    const raw = body?.payload;
    if (!raw || typeof raw !== 'object') return null;
    if (body.origin === 'doctor') { this.bus.emit('doctor', String((raw as any).nonce ?? '')); return null; }
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : null;
    const eventType = typeof raw.hook_event_name === 'string' ? raw.hook_event_name : null;
    if (!sessionId || !eventType) return null;

    const t = Date.parse(body.receivedAt);
    const timestamp = Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
    const payload = redact(raw) as Record<string, any>;
    const ev: StudioEvent = {
      eventId: randomUUID(), eventType, timestamp, sessionId, taskId: body.taskId ?? null,
      agentInvocationId: payload.agent_id ? String(payload.agent_id) : mainId(sessionId),
      toolName: payload.tool_name ? String(payload.tool_name) : null,
      toolUseId: payload.tool_use_id ? String(payload.tool_use_id) : null,
      payload, source: 'hook',
    };

    const ch = this.db.transaction(() => {
      this.db.insert(events).values({ ...ev, seq: ++this.seq, payload: JSON.stringify(payload) }).run();
      return this.projector.apply({ eventType, timestamp, sessionId, taskId: ev.taskId, payload });
    });
    this.lastEventAt = timestamp;
    this.bus.emit('event', ev);
    ch.sessions.forEach(s => this.bus.emit('session', s));
    ch.invocations.forEach(i => this.bus.emit('invocation', i));
    ch.toolcalls.forEach(c => this.bus.emit('toolcall', c));
    ch.logs.forEach(l => this.log(l.level, l.source, l.message, l.sessionId, l.timestamp));
    return ev;
  }

  // ---------- queries ----------

  listSessions(): (Session & { live: boolean; invocationCount: number })[] {
    const rows = this.db.select().from(sessions).orderBy(desc(sessions.lastEventAt)).limit(200).all() as Session[];
    const counts = new Map((this.db.$client.prepare("SELECT session_id s, COUNT(*) n FROM invocations WHERE agent_type <> 'main' GROUP BY session_id").all() as any[]).map(r => [r.s, r.n]));
    return rows.map(s => ({ ...s, live: !s.endedAt, invocationCount: counts.get(s.id) ?? 0 }));
  }

  getSession(id: string) { return (this.db.select().from(sessions).where(eq(sessions.id, id)).get() as Session) ?? null; }

  invocations(sid: string): AgentInvocation[] {
    return this.db.select().from(invocations).where(eq(invocations.sessionId, sid)).orderBy(asc(invocations.depth), asc(invocations.startedAt)).all() as AgentInvocation[];
  }

  toolcalls(sid: string, f: { tool?: string; agent?: string } = {}): ToolCall[] {
    const conds = [eq(toolcalls.sessionId, sid)];
    if (f.tool) conds.push(f.tool === 'MCP' ? sql`substr(${toolcalls.toolName}, 1, 5) = 'mcp__'` : eq(toolcalls.toolName, f.tool));
    if (f.agent) conds.push(eq(toolcalls.invocationId, f.agent));
    return this.db.select().from(toolcalls).where(and(...conds)).orderBy(asc(toolcalls.startedAt)).all().map(toToolCall);
  }

  events(sid: string, limit = 500): StudioEvent[] {
    return this.db.select().from(events).where(eq(events.sessionId, sid)).orderBy(asc(events.seq)).limit(limit).all()
      .map(({ seq: _s, ...e }) => ({ ...e, payload: JSON.parse(e.payload), source: e.source as StudioEvent['source'] }));
  }

  /** Prompts, final replies and main-session tool cards in order. Assistant text between tools is not in hooks. */
  conversation(sid: string): ConversationItem[] {
    const out: ConversationItem[] = [];
    const rows = this.db.select({ t: events.eventType, ts: events.timestamp, p: events.payload }).from(events)
      .where(and(eq(events.sessionId, sid), sql`${events.eventType} IN ('UserPromptSubmit','Stop')`)).orderBy(asc(events.seq)).all();
    for (const r of rows) {
      const p = JSON.parse(r.p);
      if (r.t === 'UserPromptSubmit') out.push({ kind: 'user', at: r.ts, text: String(p.prompt ?? '') });
      else if (p.last_assistant_message) out.push({ kind: 'assistant', at: r.ts, text: String(p.last_assistant_message), invocationId: mainId(sid) });
    }
    const invs = new Map(this.invocations(sid).map(i => [i.id, i]));
    for (const c of this.toolcalls(sid, { agent: mainId(sid) })) {
      out.push({ kind: 'tool', at: c.startedAt ?? c.endedAt ?? '', call: c, invocation: c.spawnAgentId ? invs.get(c.spawnAgentId) ?? null : null });
    }
    // Stable by time; a reply logged at the same instant as a tool end goes after it.
    const rank = { user: 0, tool: 1, assistant: 2 } as const;
    return out.sort((a, b) => a.at.localeCompare(b.at) || rank[a.kind] - rank[b.kind]);
  }

  timeline(sid: string): TimelineStep[] {
    const name = (i: AgentInvocation) => (i.agentType === 'main' ? 'Main session' : i.agentType);
    const invs = this.invocations(sid);
    const steps: TimelineStep[] = invs.map(i => ({
      kind: 'invocation', id: i.id, invocationId: i.id, label: `${name(i)}${i.description ? `: ${i.description}` : ''}`,
      status: i.status, startedAt: i.startedAt, endedAt: i.endedAt, durationMs: i.durationMs, input: i.prompt, output: i.output,
    }));
    for (const c of this.toolcalls(sid)) {
      if (c.spawnAgentId) continue; // shown as the invocation itself
      steps.push({
        kind: 'tool', id: c.id, invocationId: c.invocationId, label: `${c.toolName} ${c.inputSummary}`, status: c.status,
        startedAt: c.startedAt, endedAt: c.endedAt, durationMs: c.durationMs, input: c.inputSummary, output: c.error ?? c.outputSummary,
      });
    }
    return steps.sort((a, b) => (a.startedAt ?? '~').localeCompare(b.startedAt ?? '~'));
  }

  logs(f: { session?: string; level?: string; source?: string; q?: string; before?: number; limit?: number; from?: string; to?: string }) {
    const conds = [];
    if (f.session) conds.push(eq(logs.sessionId, f.session));
    if (f.from) conds.push(sql`${logs.timestamp} >= ${f.from}`);
    if (f.to) conds.push(sql`${logs.timestamp} <= ${f.to}`);
    if (f.level) conds.push(eq(logs.level, f.level));
    if (f.source) conds.push(eq(logs.source, f.source));
    if (f.q) conds.push(sql`instr(lower(${logs.message}), ${f.q.toLowerCase()}) > 0`);
    if (f.before) conds.push(lt(logs.seq, f.before));
    const rows = this.db.select().from(logs).where(conds.length ? and(...conds) : undefined).orderBy(desc(logs.seq)).limit(Math.min(f.limit ?? 200, 500)).all();
    return { items: rows.map(({ seq: _s, ...l }) => l as LogEntry), next: rows.length ? rows[rows.length - 1].seq : null };
  }

  // ---------- Phase 4 ----------

  private lastResponse(toolUseId: string): { type: string; payload: any } | null {
    const r = this.db.$client.prepare(`SELECT event_type t, payload p FROM events WHERE tool_use_id = ?
      AND event_type IN ('PostToolUse','PostToolUseFailure','PermissionDenied') ORDER BY seq DESC LIMIT 1`).get(toolUseId) as any;
    return r ? { type: r.t, payload: JSON.parse(r.p) } : null;
  }

  /** M-TS-02 / M-TS-03: full input, response, Bash exit code and Edit/Write diff. */
  toolcallDetail(id: string): ToolCallDetail | null {
    const row = this.db.select().from(toolcalls).where(eq(toolcalls.id, id)).get();
    if (!row) return null;
    const input = row.input ? JSON.parse(row.input) : null;
    const last = this.lastResponse(id);
    const response = last ? (last.payload.tool_response ?? last.payload.error ?? last.payload.reason ?? null) : null;
    const base = toToolCall(row);
    let bash: ToolCallDetail['bash'] = null;
    let file: ToolCallDetail['file'] = null;

    if (row.toolName === 'Bash' || row.toolName === 'PowerShell') {
      let exitCode: number | null = null;
      let src: 'response' | 'error' | 'inferred' | null = null;
      const r = response && typeof response === 'object' ? response as any : null;
      const fromResp = r ? [r.exitCode, r.exit_code, r.returnCode, r.code].find(v => typeof v === 'number') : undefined;
      const m = row.error ? /exit code (\d+)/i.exec(row.error) : null;
      if (typeof fromResp === 'number') { exitCode = fromResp; src = 'response'; }
      else if (m) { exitCode = Number(m[1]); src = 'error'; }
      else if (row.status === 'completed' && !r?.interrupted) { exitCode = 0; src = 'inferred'; } // non-zero exits arrive as PostToolUseFailure
      const output = r ? [r.stdout, r.stderr].filter(x => typeof x === 'string' && x.trim()).join('\n') : typeof response === 'string' ? response : '';
      bash = { command: String(input?.command ?? ''), exitCode, exitCodeSource: src, output: output || (row.error ?? '') };
    }

    const fp = input?.file_path ?? input?.notebook_path;
    if (fp && ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(row.toolName)) {
      const r = response && typeof response === 'object' ? response as any : {};
      const op: 'read' | 'create' | 'edit' | 'write' = row.toolName === 'Read' ? 'read' : row.toolName === 'Write' ? (r.type === 'create' ? 'create' : 'write') : 'edit';
      let diff: DiffLine[] | null = null;
      if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
        diff = [];
        for (const h of r.structuredPatch) {
          diff.push({ op: 'hunk', line: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
          for (const l of h.lines ?? []) {
            const c = String(l)[0];
            diff.push({ op: c === '+' ? 'add' : c === '-' ? 'del' : 'ctx', line: String(l).slice(1) });
          }
        }
      } else if (row.toolName === 'Write' && typeof input?.content === 'string') {
        diff = unifiedDiff(typeof r.originalFile === 'string' ? r.originalFile : '', input.content);
      } else if (row.toolName === 'Edit' && typeof input?.old_string === 'string') {
        diff = unifiedDiff(input.old_string, String(input.new_string ?? ''));
      } else if (row.toolName === 'MultiEdit' && Array.isArray(input?.edits)) {
        diff = input.edits.flatMap((e: any, k: number) => [{ op: 'hunk', line: `Sửa ${k + 1}` } as DiffLine, ...unifiedDiff(String(e.old_string ?? ''), String(e.new_string ?? ''))]);
      }
      const cwd = this.getSession(row.sessionId)?.cwd ?? null;
      file = { op, path: relPathOf(String(fp), cwd), diff };
    }
    return { ...base, input, response, bash, file };
  }

  /** M-TS-03 */
  files(sid: string): FileActivity[] {
    const cwd = this.getSession(sid)?.cwd ?? null;
    const rows = this.db.$client.prepare(`SELECT t.id, t.invocation_id inv, t.tool_name tool, t.input, t.status, t.started_at st, t.ended_at en,
        (SELECT json_extract(e.payload, '$.tool_response.type') FROM events e WHERE e.tool_use_id = t.id AND e.event_type = 'PostToolUse' LIMIT 1) rtype
      FROM toolcalls t WHERE t.session_id = ? AND t.tool_name IN ('Read','Write','Edit','MultiEdit','NotebookEdit') ORDER BY COALESCE(t.started_at, t.ended_at)`).all(sid) as any[];
    return rows.map(r => {
      const inp = r.input ? JSON.parse(r.input) : {};
      const op = r.tool === 'Read' ? 'read' : r.tool === 'Write' ? (r.rtype === 'create' ? 'create' : 'write') : 'edit';
      return { toolCallId: r.id, invocationId: r.inv, at: r.st ?? r.en, op, path: relPathOf(String(inp?.file_path ?? inp?.notebook_path ?? '?'), cwd), status: r.status } as FileActivity;
    });
  }

  private transcriptFor(sid: string, inv: AgentInvocation): string | null {
    const s = this.getSession(sid);
    if (inv.agentType === 'main') return s?.transcriptPath ?? inv.transcriptPath;
    return subagentTranscript(inv.id, inv.transcriptPath, s?.transcriptPath ?? null, sid);
  }

  /** M-PF-02: tokens per agent, read from transcripts (main + each subagent file). */
  usage(sid: string): SessionUsage | null {
    if (!this.getSession(sid)) return null;
    let total = emptyUsage();
    const missing: string[] = [];
    const byAgent = this.invocations(sid).map(inv => {
      const file = this.transcriptFor(sid, inv);
      const t = file ? readTranscript(file, inv.agentType === 'main' ? { sidechain: false } : {}) : null;
      if (!t) missing.push(file ?? `${inv.agentType} (${inv.id}): không có đường dẫn transcript`);
      else total = addUsage(total, t.usage);
      return { invocationId: inv.id, agentType: inv.agentType, transcriptPath: file, usage: t?.usage ?? null, models: t?.models ?? [] };
    });
    return { sessionId: sid, total, byAgent, missing };
  }

  /** M-AM-04: one agent's own conversation. */
  transcript(sid: string, invId: string): { file: string | null; items: TranscriptItem[]; truncated: boolean } | null {
    const inv = this.invocations(sid).find(i => i.id === invId);
    if (!inv) return null;
    const file = this.transcriptFor(sid, inv);
    const t = file ? readTranscript(file, inv.agentType === 'main' ? { sidechain: false } : {}) : null;
    if (!t) return { file, items: [], truncated: false };
    const max = 1500;
    return { file, items: t.items.slice(-max), truncated: t.items.length > max };
  }

  /** T-AG-04 / M-PF-04 */
  agentStats(): AgentStats[] {
    const rows = this.db.$client.prepare(`SELECT agent_type a, COUNT(*) n,
        SUM(status = 'completed') ok, SUM(status = 'failed') bad, SUM(status = 'unknown') unk,
        AVG(CASE WHEN status = 'completed' THEN duration_ms END) avg, MAX(COALESCE(started_at, ended_at)) last
      FROM invocations WHERE agent_type <> 'main' GROUP BY agent_type ORDER BY n DESC`).all() as any[];
    return rows.map(r => ({ agentType: r.a, calls: r.n, completed: r.ok ?? 0, failed: r.bad ?? 0, unknown: r.unk ?? 0, avgDurationMs: r.avg === null ? null : Math.round(r.avg), lastAt: r.last }));
  }

  /** M-PF-01 */
  taskStats(): TaskStats {
    const r = this.db.$client.prepare(`SELECT COUNT(*) n, SUM(status = 'completed') ok, SUM(status = 'failed') bad, SUM(status = 'cancelled') can,
        AVG(CASE WHEN status = 'completed' AND started_at IS NOT NULL AND ended_at IS NOT NULL
          THEN (julianday(ended_at) - julianday(started_at)) * 86400000 END) avg,
        SUM(cost_usd) cost, COUNT(cost_usd) costN
      FROM tasks WHERE status IN ('completed','failed','cancelled')`).get() as any;
    return { total: r.n, completed: r.ok ?? 0, failed: r.bad ?? 0, cancelled: r.can ?? 0, avgDurationMs: r.avg === null ? null : Math.round(r.avg), totalCostUsd: r.costN ? r.cost : null };
  }

  /** S-04: drops sessions (and their events, invocations, tool calls, logs) idle for more than `days`. */
  purge(days: number, now = Date.now()): { sessions: number; events: number; logs: number } {
    const cutoff = new Date(now - days * 86400_000).toISOString();
    const c = this.db.$client;
    return c.transaction(() => {
      const ids = (c.prepare('SELECT id FROM sessions WHERE last_event_at < ?').all(cutoff) as any[]).map(r => r.id);
      let ev = 0;
      for (const id of ids) {
        ev += c.prepare('DELETE FROM events WHERE session_id = ?').run(id).changes;
        c.prepare('DELETE FROM invocations WHERE session_id = ?').run(id);
        c.prepare('DELETE FROM toolcalls WHERE session_id = ?').run(id);
        c.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      }
      const lg = c.prepare('DELETE FROM logs WHERE timestamp < ?').run(cutoff).changes;
      return { sessions: ids.length, events: ev, logs: lg };
    })();
  }

  /** P1 spool: events the hook wrote to disk while the backend was down. Returns how many were ingested. */
  ingestSpool(file: string): number {
    if (!fs.existsSync(file)) return 0;
    const work = `${file}.${Date.now()}.loading`;
    try { fs.renameSync(file, work); } catch { return 0; }
    let n = 0, bad = 0;
    for (const line of fs.readFileSync(work, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { if (this.ingest(JSON.parse(line))) n++; } catch { bad++; }
    }
    fs.rmSync(work, { force: true });
    if (n || bad) this.log(bad ? 'warn' : 'info', 'hook', `Nạp ${n} event từ spool (lúc backend tắt)${bad ? `, bỏ ${bad} dòng hỏng` : ''}.`);
    return n;
  }
}

function relPathOf(p: string, cwd: string | null) {
  if (!cwd) return p;
  const n = (x: string) => x.replace(/\\/g, '/').toLowerCase();
  const c = n(cwd).replace(/\/$/, '') + '/';
  return n(p).startsWith(c) ? p.replace(/\\/g, '/').slice(c.length) : p;
}
