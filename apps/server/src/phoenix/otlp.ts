// M-PF-05 / S-06: builds an OTLP trace from Studio's normalised data and sends it to Phoenix (OTLP/HTTP protobuf).
// No OpenTelemetry dependency: the few protobuf messages needed are encoded by hand.
// Span layout (Phase 0 §7): session = root span, each agent invocation a child (parent by parentInvocationId),
// each tool call a leaf under its invocation. Attributes follow OpenInference so Phoenix shows kinds and I/O.
import { createHash } from 'node:crypto';
import type { AgentInvocation, Session, SessionUsage, ToolCall } from '@ccgs/shared';

// ---------- protobuf writer ----------
class W {
  private parts: Buffer[] = [];
  private varint(n: bigint) {
    const b: number[] = [];
    while (n > 127n) { b.push(Number(n & 127n) | 128); n >>= 7n; }
    b.push(Number(n));
    this.parts.push(Buffer.from(b));
  }
  private tag(field: number, wire: number) { this.varint(BigInt((field << 3) | wire)); }
  bytes(field: number, v: Buffer) { this.tag(field, 2); this.varint(BigInt(v.length)); this.parts.push(v); return this; }
  str(field: number, v: string) { return this.bytes(field, Buffer.from(v, 'utf8')); }
  msg(field: number, w: W) { return this.bytes(field, w.done()); }
  int(field: number, v: number | bigint) { this.tag(field, 0); this.varint(BigInt.asUintN(64, BigInt(v))); return this; }
  fixed64(field: number, v: bigint) { this.tag(field, 1); const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); return this; }
  done() { return Buffer.concat(this.parts); }
}

type AttrVal = string | number | boolean;
export interface OtSpan {
  traceId: Buffer; spanId: Buffer; parentSpanId: Buffer | null; name: string; kind: number; startNs: bigint; endNs: bigint;
  attrs: Record<string, AttrVal>; status: 0 | 1 | 2; statusMessage?: string;
}

const kv = (k: string, v: AttrVal) => {
  const any = new W();
  if (typeof v === 'string') any.str(1, v);
  else if (typeof v === 'boolean') any.int(2, v ? 1 : 0);
  else if (Number.isInteger(v)) any.int(3, v);
  else { const b = Buffer.alloc(8); b.writeDoubleLE(v); any.fixed64(4, b.readBigUInt64LE()); }
  return new W().str(1, k).msg(2, any);
};

/** ExportTraceServiceRequest with one ResourceSpans / ScopeSpans. */
export function encodeTraces(spans: OtSpan[], serviceName: string): Buffer {
  const scope = new W().msg(1, new W().str(1, 'ccgs-studio').str(2, '0.1.0'));
  for (const s of spans) {
    const sp = new W().bytes(1, s.traceId).bytes(2, s.spanId);
    if (s.parentSpanId) sp.bytes(4, s.parentSpanId);
    sp.str(5, s.name).int(6, s.kind).fixed64(7, s.startNs).fixed64(8, s.endNs);
    for (const [k, v] of Object.entries(s.attrs)) sp.msg(9, kv(k, v));
    const st = new W();
    if (s.statusMessage) st.str(2, s.statusMessage);
    st.int(3, s.status);
    sp.msg(15, st);
    scope.msg(2, sp);
  }
  const resource = new W().msg(1, kv('service.name', serviceName)).msg(1, kv('openinference.project.name', serviceName));
  const rs = new W().msg(1, resource).msg(2, scope);
  return new W().msg(1, rs).done();
}

// ---------- spans from Studio data ----------
const h = (s: string, n: number) => createHash('sha256').update(s).digest().subarray(0, n);
const ns = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;
const cut = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + '…' : s);

export function sessionSpans(s: Session, invs: AgentInvocation[], calls: ToolCall[], usage: SessionUsage | null): OtSpan[] {
  const traceId = h(`trace:${s.id}`, 16);
  const end = s.endedAt ?? s.lastEventAt;
  const rootId = h(`span:session:${s.id}`, 8);
  const spans: OtSpan[] = [{
    traceId, spanId: rootId, parentSpanId: null, name: `session ${s.id.slice(0, 8)}`, kind: 1, startNs: ns(s.startedAt), endNs: ns(end),
    attrs: {
      'openinference.span.kind': 'CHAIN', 'session.id': s.id, 'ccgs.external': s.external, ...(s.taskId ? { 'ccgs.task_id': s.taskId } : {}),
      ...(s.firstPrompt ? { 'input.value': cut(s.firstPrompt) } : {}),
    },
    status: 0,
  }];
  const tokens = new Map((usage?.byAgent ?? []).map(a => [a.invocationId, a]));
  const invSpan = new Map(invs.map(i => [i.id, h(`span:inv:${i.id}`, 8)]));
  for (const i of invs) {
    // Unknown start: the span cannot be placed; skip rather than invent a time.
    const st = i.startedAt; const en = i.endedAt ?? (i.status === 'running' || i.status === 'waiting' ? null : end);
    if (!st) continue;
    const u = tokens.get(i.id);
    spans.push({
      traceId, spanId: invSpan.get(i.id)!, parentSpanId: i.parentInvocationId ? invSpan.get(i.parentInvocationId) ?? rootId : rootId,
      name: i.agentType === 'main' ? 'main session' : i.agentType, kind: 1, startNs: ns(st), endNs: ns(en ?? new Date().toISOString()),
      attrs: {
        'openinference.span.kind': 'AGENT', 'agent.name': i.agentType, 'ccgs.status': i.status,
        ...(i.prompt ? { 'input.value': cut(i.prompt) } : {}), ...(i.output ? { 'output.value': cut(i.output) } : {}),
        ...(u?.usage ? {
          'llm.token_count.prompt': u.usage.input + u.usage.cacheCreation + u.usage.cacheRead, 'llm.token_count.completion': u.usage.output,
          'llm.token_count.total': u.usage.input + u.usage.cacheCreation + u.usage.cacheRead + u.usage.output,
          'llm.token_count.prompt_details.cache_read': u.usage.cacheRead, 'llm.token_count.prompt_details.cache_write': u.usage.cacheCreation,
        } : {}),
        ...(u?.models.length ? { 'llm.model_name': u.models.join(',') } : {}),
      },
      status: i.status === 'failed' ? 2 : i.status === 'completed' ? 1 : 0,
    });
  }
  for (const c of calls) {
    if (!c.startedAt) continue;
    spans.push({
      traceId, spanId: h(`span:tool:${c.id}`, 8), parentSpanId: invSpan.get(c.invocationId) ?? rootId, name: c.toolName, kind: 1,
      startNs: ns(c.startedAt), endNs: ns(c.endedAt ?? c.startedAt),
      attrs: {
        'openinference.span.kind': 'TOOL', 'tool.name': c.toolName, 'input.value': cut(c.inputSummary),
        ...(c.outputSummary ? { 'output.value': cut(c.outputSummary) } : {}), 'ccgs.status': c.status,
      },
      status: c.status === 'failed' ? 2 : c.status === 'completed' ? 1 : 0, statusMessage: c.error ?? undefined,
    });
  }
  return spans;
}

export async function sendTraces(endpoint: string, body: Buffer): Promise<{ status: number | null; error: string | null }> {
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-protobuf' }, body: new Uint8Array(body), signal: AbortSignal.timeout(10_000) });
    return { status: r.status, error: r.ok ? null : `HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` };
  } catch (e) { return { status: null, error: (e as Error).message }; }
}
