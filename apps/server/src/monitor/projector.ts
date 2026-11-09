// Turns stored hook events into sessions, agent invocations and tool calls.
// Status changes only on events; whatever is still open when the session ends becomes 'unknown'.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AgentInvocation, InvocationStatus, LogEntry, Session, ToolCall } from '@ccgs/shared';
import { Db, invocations, sessions, toolcalls } from '../store/db';

export interface ProjectedEvent {
  eventType: string; timestamp: string; sessionId: string; taskId: string | null; payload: Record<string, any>;
}
export interface Changes { sessions: Session[]; invocations: AgentInvocation[]; toolcalls: ToolCall[]; logs: Omit<LogEntry, 'id'>[]; }

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const OPEN: InvocationStatus[] = ['running', 'waiting'];
export const mainId = (sid: string) => `main:${sid}`;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const asText = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));
const ms = (a: string | null, b: string | null) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null);

export function relPath(p: string, cwd: string | null): string {
  if (!cwd) return p;
  const n = (x: string) => x.replace(/\\/g, '/').toLowerCase();
  const c = n(cwd).replace(/\/$/, '') + '/';
  return n(p).startsWith(c) ? p.replace(/\\/g, '/').slice(c.length) : p;
}

export function summarizeInput(tool: string, input: any, cwd: string | null): string {
  if (!input || typeof input !== 'object') return cut(asText(input), 200);
  if (input.file_path) return relPath(String(input.file_path), cwd);
  if (input.notebook_path) return relPath(String(input.notebook_path), cwd);
  if (tool === 'Bash' || tool === 'PowerShell') return cut(String(input.command ?? ''), 200);
  if (SPAWN_TOOLS.has(tool)) return cut(`${input.subagent_type ?? 'general-purpose'}: ${input.description ?? ''}`, 200);
  if (tool === 'Skill') return cut(`${input.skill ?? ''} ${input.args ?? ''}`.trim(), 200);
  if (input.pattern) return cut(`${input.pattern}${input.path ? ` in ${relPath(String(input.path), cwd)}` : ''}`, 200);
  if (input.url) return cut(String(input.url), 200);
  if (input.query) return cut(String(input.query), 200);
  if (Array.isArray(input.questions)) return cut(input.questions.map((q: any) => q.question).join(' | '), 200);
  return cut(JSON.stringify(input), 200);
}

export function summarizeOutput(tool: string, r: any): string | null {
  if (r === undefined || r === null) return null;
  if (typeof r === 'string') return cut(r, 600);
  if (SPAWN_TOOLS.has(tool) && Array.isArray(r.content)) {
    return cut(r.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').trim(), 600);
  }
  if (r.file && typeof r.file === 'object') return `${r.file.numLines ?? '?'} dòng${r.file.totalLines ? ` / ${r.file.totalLines}` : ''}`;
  if ('stdout' in r || 'stderr' in r) {
    const out = [asText(r.stdout).trim(), asText(r.stderr).trim()].filter(Boolean).join('\n');
    return cut((r.interrupted ? '[bị ngắt] ' : '') + out, 600);
  }
  if (Array.isArray(r.filenames)) return `${r.numFiles ?? r.filenames.length} file`;
  return cut(JSON.stringify(r), 600);
}

export class Projector {
  constructor(private readonly db: Db) {}

  apply(ev: ProjectedEvent): Changes {
    const ch: Changes = { sessions: [], invocations: [], toolcalls: [], logs: [] };
    const touchedS = new Set<string>(), touchedI = new Set<string>(), touchedT = new Set<string>();
    const p = ev.payload;
    const sid = ev.sessionId;
    const ts = ev.timestamp;
    const log = (level: LogEntry['level'], source: LogEntry['source'], message: string) =>
      ch.logs.push({ timestamp: ts, level, source, sessionId: sid, message });

    const db = this.db;
    const getS = () => db.select().from(sessions).where(eq(sessions.id, sid)).get();
    const getI = (id: string) => db.select().from(invocations).where(eq(invocations.id, id)).get();
    const getT = (id: string) => db.select().from(toolcalls).where(eq(toolcalls.id, id)).get();
    const setI = (id: string, v: Partial<typeof invocations.$inferInsert>) => { db.update(invocations).set(v).where(eq(invocations.id, id)).run(); touchedI.add(id); };
    const setT = (id: string, v: Partial<typeof toolcalls.$inferInsert>) => { db.update(toolcalls).set(v).where(eq(toolcalls.id, id)).run(); touchedT.add(id); };
    const setS = (v: Partial<typeof sessions.$inferInsert>) => { db.update(sessions).set(v).where(eq(sessions.id, sid)).run(); touchedS.add(sid); };

    // Session + main invocation always exist after the first event.
    if (!getS()) {
      db.insert(sessions).values({
        id: sid, taskId: ev.taskId, external: !ev.taskId, cwd: p.cwd ?? null, transcriptPath: p.transcript_path ?? null,
        claudeVersion: null, startedAt: ts, endedAt: null, endReason: null, lastEventAt: ts, firstPrompt: null,
      }).run();
      db.insert(invocations).values({
        id: mainId(sid), sessionId: sid, parentInvocationId: null, toolUseId: null, agentType: 'main', description: null,
        prompt: null, output: null, status: 'running', depth: 0, startedAt: ts, endedAt: null, durationMs: null,
        transcriptPath: p.transcript_path ?? null,
      }).run();
      touchedI.add(mainId(sid));
    }
    const session = getS()!;
    setS({ lastEventAt: ts, ...(session.endedAt && ev.eventType !== 'SessionEnd' ? { endedAt: null, endReason: null } : {}) });

    // Which invocation emitted this event. Events from inside a subagent carry agent_id.
    const invId: string = p.agent_id ? String(p.agent_id) : mainId(sid);
    if (p.agent_id && !getI(invId)) {
      // Missed SubagentStart (e.g. hooks installed mid-run): start time is unknown.
      db.insert(invocations).values({
        id: invId, sessionId: sid, parentInvocationId: null, toolUseId: null, agentType: String(p.agent_type ?? 'unknown'),
        description: null, prompt: null, output: null, status: 'running', depth: 1, startedAt: null, endedAt: null,
        durationMs: null, transcriptPath: p.agent_transcript_path ?? null,
      }).run();
      touchedI.add(invId);
    }
    const resume = (id: string) => { const i = getI(id); if (i && i.status === 'waiting') setI(id, { status: 'running' }); };

    const link = (agentId: string, callId: string) => {
      const call = getT(callId);
      const inv = getI(agentId);
      if (!call || !inv) return;
      if (call.spawnAgentId === agentId && inv.toolUseId === callId) return;
      // Undo a wrong provisional match on either side, swapping partners if needed.
      const other = db.select().from(toolcalls).where(and(eq(toolcalls.sessionId, sid), eq(toolcalls.spawnAgentId, agentId))).get();
      const prevAgent = call.spawnAgentId;
      if (other && other.id !== callId) {
        setT(other.id, { spawnAgentId: prevAgent ?? null });
        if (prevAgent) this.attach(prevAgent, other.id, setI);
      }
      setT(callId, { spawnAgentId: agentId });
      this.attach(agentId, callId, setI);
    };

    switch (ev.eventType) {
      case 'SessionStart':
        setS({ cwd: p.cwd ?? session.cwd, transcriptPath: p.transcript_path ?? session.transcriptPath });
        break;

      case 'UserPromptSubmit': {
        if (!session.firstPrompt) setS({ firstPrompt: String(p.prompt ?? '').slice(0, 500) });
        const m = getI(mainId(sid))!;
        setI(m.id, { status: 'running', endedAt: null, durationMs: null, ...(m.prompt ? {} : { prompt: String(p.prompt ?? ''), description: cut(String(p.prompt ?? ''), 120) }) });
        break;
      }

      case 'PreToolUse': {
        const tool = String(p.tool_name ?? 'unknown');
        const id = String(p.tool_use_id ?? `${invId}:${ts}`);
        if (!getT(id)) {
          db.insert(toolcalls).values({
            id, sessionId: sid, invocationId: invId, toolName: tool, input: JSON.stringify(p.tool_input ?? null),
            inputSummary: summarizeInput(tool, p.tool_input, session.cwd), outputSummary: null, error: null,
            status: 'running', startedAt: ts, endedAt: null, durationMs: null, spawnAgentId: null,
          }).run();
          touchedT.add(id);
        }
        resume(invId);
        break;
      }

      case 'PermissionRequest':
        if (getI(invId)?.status === 'running') setI(invId, { status: 'waiting' });
        break;

      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied': {
        const tool = String(p.tool_name ?? 'unknown');
        const id = String(p.tool_use_id ?? '');
        let call = id ? getT(id) : undefined;
        if (!call && id) {
          // PreToolUse missed: start is unknown, but the call happened.
          db.insert(toolcalls).values({
            id, sessionId: sid, invocationId: invId, toolName: tool, input: JSON.stringify(p.tool_input ?? null),
            inputSummary: summarizeInput(tool, p.tool_input, session.cwd), outputSummary: null, error: null,
            status: 'unknown', startedAt: null, endedAt: null, durationMs: null, spawnAgentId: null,
          }).run();
          call = getT(id);
        }
        if (call) {
          const failed = ev.eventType !== 'PostToolUse';
          const error = failed ? asText(p.error ?? p.reason ?? (ev.eventType === 'PermissionDenied' ? 'Bị từ chối quyền' : 'Lỗi')) : null;
          setT(call.id, {
            status: failed ? 'failed' : 'completed', endedAt: ts,
            durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : ms(call.startedAt, ts),
            outputSummary: failed ? null : summarizeOutput(tool, p.tool_response), error: error ? cut(error, 600) : null,
          });
          if (failed) log('warn', 'claude', `${tool} ${ev.eventType === 'PermissionDenied' ? 'bị từ chối' : 'lỗi'}: ${cut(error ?? '', 300)}`);
          if (SPAWN_TOOLS.has(tool)) {
            const agentId = p.tool_response?.agentId ? String(p.tool_response.agentId) : call.spawnAgentId;
            if (agentId && getI(agentId)) {
              link(agentId, call.id);
              const inv = getI(agentId)!;
              if (failed && OPEN.includes(inv.status as InvocationStatus)) setI(agentId, { status: 'failed', endedAt: ts, durationMs: ms(inv.startedAt, ts) });
            }
          }
        }
        resume(invId);
        break;
      }

      case 'SubagentStart': {
        const agentId = String(p.agent_id ?? '');
        if (!agentId) break;
        const type = String(p.agent_type ?? 'unknown');
        const inv = getI(agentId)!;
        setI(agentId, { status: 'running', startedAt: inv.startedAt ?? ts, agentType: type });
        // Provisional link: oldest running spawn call of this type that has no subagent yet.
        const cand = db.select().from(toolcalls).where(and(
          eq(toolcalls.sessionId, sid), inArray(toolcalls.toolName, [...SPAWN_TOOLS]), eq(toolcalls.status, 'running'), isNull(toolcalls.spawnAgentId),
        )).orderBy(asc(toolcalls.startedAt)).all();
        const match = cand.find(c => (JSON.parse(c.input ?? '{}')?.subagent_type ?? 'general-purpose') === type) ?? null;
        if (match) { setT(match.id, { spawnAgentId: agentId }); this.attach(agentId, match.id, setI); }
        break;
      }

      case 'SubagentStop': {
        const agentId = String(p.agent_id ?? '');
        const inv = agentId ? getI(agentId) : undefined;
        if (inv) setI(agentId, {
          status: 'completed', endedAt: ts, durationMs: ms(inv.startedAt, ts),
          output: p.last_assistant_message ? cut(String(p.last_assistant_message), 4000) : inv.output,
          transcriptPath: p.agent_transcript_path ?? inv.transcriptPath,
        });
        break;
      }

      case 'Stop': {
        const m = getI(mainId(sid))!;
        setI(m.id, { status: 'completed', endedAt: ts, durationMs: ms(m.startedAt, ts), output: p.last_assistant_message ? cut(String(p.last_assistant_message), 4000) : m.output });
        break;
      }

      case 'StopFailure': {
        const m = getI(mainId(sid))!;
        setI(m.id, { status: 'failed', endedAt: ts, durationMs: ms(m.startedAt, ts) });
        log('error', 'claude', `Lượt chạy lỗi: ${cut(asText(p.error ?? p.error_details ?? p.message ?? 'không rõ'), 400)}`);
        break;
      }

      case 'Notification':
        log(/permission|idle/i.test(String(p.notification_type ?? '')) ? 'warn' : 'info', 'claude', cut(String(p.message ?? p.notification_type ?? 'Notification'), 400));
        break;

      case 'PreCompact':
        log('info', 'claude', `Nén context (${p.trigger ?? 'unknown'})`);
        break;

      case 'SessionEnd': {
        setS({ endedAt: ts, endReason: p.reason ? String(p.reason) : null });
        // Whatever never got its closing event: we do not know how it ended.
        for (const i of db.select().from(invocations).where(and(eq(invocations.sessionId, sid), inArray(invocations.status, OPEN))).all()) {
          if (i.id === mainId(sid)) setI(i.id, { status: 'unknown', endedAt: null, durationMs: null });
          else setI(i.id, { status: 'unknown' });
        }
        for (const t of db.select().from(toolcalls).where(and(eq(toolcalls.sessionId, sid), eq(toolcalls.status, 'running'))).all()) setT(t.id, { status: 'unknown' });
        break;
      }
    }

    for (const id of touchedS) { const r = db.select().from(sessions).where(eq(sessions.id, id)).get(); if (r) ch.sessions.push(r as Session); }
    for (const id of touchedI) { const r = getI(id); if (r) ch.invocations.push(r as AgentInvocation); }
    for (const id of touchedT) { const r = getT(id); if (r) ch.toolcalls.push(toToolCall(r)); }
    return ch;
  }

  /** Sets parent, tool_use_id, task and depth of a subagent from the call that spawned it. */
  private attach(agentId: string, callId: string, setI: (id: string, v: Partial<typeof invocations.$inferInsert>) => void) {
    const call = this.db.select().from(toolcalls).where(eq(toolcalls.id, callId)).get();
    if (!call) return;
    const parent = this.db.select().from(invocations).where(eq(invocations.id, call.invocationId)).get();
    const input = JSON.parse(call.input ?? '{}') ?? {};
    setI(agentId, {
      parentInvocationId: call.invocationId, toolUseId: callId, depth: (parent?.depth ?? 0) + 1,
      description: input.description ?? null, prompt: input.prompt ?? null,
    });
  }
}

export function toToolCall(r: typeof toolcalls.$inferSelect): ToolCall {
  const { input: _input, ...rest } = r;
  return rest as ToolCall;
}
