// Unity MCP check (doctor + before a game scan). Studio does not configure Unity MCP: Claude Code does
// (~/.claude.json user/local scope, or the project's .mcp.json). Read-only; never writes those files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoctorCheck } from '@ccgs/shared';

export interface UnityMcpEntry {
  name: string;
  /** Where Claude Code reads it from: local (~/.claude.json projects[path]), project (.mcp.json) or user (~/.claude.json). */
  scope: 'local' | 'project' | 'user';
  type: string;
  url: string | null;
  command: string | null;
}
export interface UnityInstance { name: string; unityVersion: string | null }
/** instances: Unity Editors connected to the server (MCP for Unity); undefined when it could not be read. */
export interface ProbeResult { ok: boolean; detail: string; instances?: UnityInstance[] }
export type McpProbe = (url: string, timeoutMs: number) => Promise<ProbeResult>;

const LABEL = 'Unity MCP (quét game, art context)';
const PROBE_MS = 3000;
const HOWTO = 'Mở Unity Editor của project, vào Window > MCP for Unity và bật server.';

const readJson = (f: string): any => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; } };
const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function pick(servers: unknown, scope: UnityMcpEntry['scope']): UnityMcpEntry | null {
  if (!servers || typeof servers !== 'object') return null;
  const names = Object.keys(servers as object).filter(k => /unity/i.test(k));
  const name = names.find(k => k === 'UnityMCP') ?? names[0];
  if (!name) return null;
  const v = (servers as any)[name] ?? {};
  const type = typeof v.type === 'string' ? v.type : v.url ? 'http' : 'stdio';
  return { name, scope, type, url: typeof v.url === 'string' ? v.url : null, command: typeof v.command === 'string' ? v.command : null };
}

/** The Unity MCP server Claude Code would load for this project (same precedence: local > project > user). */
export function findUnityMcp(project: string | null, claudeJson = path.join(os.homedir(), '.claude.json')): UnityMcpEntry | null {
  const j = readJson(claudeJson) ?? {};
  if (project) {
    const key = Object.keys(j.projects ?? {}).find(k => norm(k) === norm(project));
    const local = key ? pick(j.projects[key]?.mcpServers, 'local') : null;
    if (local) return local;
    const shared = pick(readJson(path.join(project, '.mcp.json'))?.mcpServers, 'project');
    if (shared) return shared;
  }
  return pick(j.mcpServers, 'user');
}

export const isLoopback = (url: string) => {
  try { return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
};

/** JSON-RPC messages in a reply body: plain JSON, or SSE "data:" lines. */
export function rpcMessages(text: string): any[] {
  const t = text.trim();
  const chunks = t.startsWith('{') || t.startsWith('[') ? [t] : t.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
  return chunks.flatMap(c => { try { const j = JSON.parse(c); return Array.isArray(j) ? j : [j]; } catch { return []; } });
}

/** One POST to a Streamable HTTP MCP server; reads (JSON or SSE) until the reply with this id arrives. */
async function post(url: string, body: any, sid: string | null, signal: AbortSignal): Promise<{ status: number; sid: string | null; reply: any }> {
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(body),
  });
  let text = '', reply: any = null;
  const reader = body.id !== undefined ? r.body?.getReader() : undefined;
  while (reader && text.length < 262144) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString('utf8');
    reply = rpcMessages(text).find(m => m?.id === body.id) ?? null;
    if (reply) break;
  }
  void (reader ? reader.cancel() : r.body?.cancel())?.catch(() => undefined);
  return { status: r.status, sid: r.headers.get('mcp-session-id') ?? sid, reply };
}

/**
 * MCP initialize, then (MCP for Unity) reads mcpforunity://instances: the Unity Editors connected to the server.
 * Read-only: no tool is called. Closes the session after.
 */
export const httpProbe: McpProbe = async (url, timeoutMs) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let sid: string | null = null;
  try {
    const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ccgs-studio-doctor', version: '1' } } }, null, ctl.signal);
    sid = init.sid;
    if (init.status < 200 || init.status >= 300) return { ok: false, detail: `${url} trả HTTP ${init.status}.` };
    if (!init.reply?.result) return { ok: false, detail: `${url} không trả lời MCP initialize.` };
    const info = init.reply.result.serverInfo ?? {};
    const server = info.name ? ` (${info.name}${info.version ? ` ${info.version}` : ''})` : '';
    let instances: UnityInstance[] | undefined;
    try {
      await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, ctl.signal);
      const read = await post(url, { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'mcpforunity://instances' } }, sid, ctl.signal);
      const j = JSON.parse(read.reply?.result?.contents?.[0]?.text ?? 'null');
      if (j && Array.isArray(j.instances)) instances = j.instances.map((x: any) => ({ name: String(x?.name ?? x?.id ?? '?'), unityVersion: typeof x?.unity_version === 'string' ? x.unity_version : null }));
    } catch { /* not MCP for Unity, or an older one: the server answering is all we know */ }
    return { ok: true, detail: `${url} trả lời${server}.`, instances };
  } catch (e) {
    const err = e as any;
    const code = err?.cause?.code ?? err?.code;
    if (ctl.signal.aborted) return { ok: false, detail: `${url} không trả lời sau ${timeoutMs / 1000} giây.` };
    return { ok: false, detail: code === 'ECONNREFUSED' ? `Không kết nối được ${url} (Unity Editor chưa mở hoặc MCP for Unity chưa bật server).` : `${url}: ${err?.cause?.message ?? err?.message ?? 'lỗi'}` };
  } finally {
    clearTimeout(timer);
    if (sid) void fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sid } }).catch(() => undefined);
  }
};

/**
 * ok: true = the server answers; false = not configured or not answering; null = configured but Studio cannot check it
 * (stdio, or a URL that is not on this machine). Never throws.
 */
export async function unityMcpCheck(project: string | null, o: { claudeJson?: string; probe?: McpProbe; timeoutMs?: number } = {}): Promise<DoctorCheck> {
  let e: UnityMcpEntry | null;
  try { e = findUnityMcp(project, o.claudeJson); } catch (err) { return { id: 'unity-mcp', label: LABEL, ok: false, detail: `Không đọc được cấu hình MCP: ${(err as Error).message}` }; }
  if (!e) return { id: 'unity-mcp', label: LABEL, ok: false, detail: `Claude Code chưa khai báo server Unity MCP (ví dụ "UnityMCP") ở ~/.claude.json hay .mcp.json của project. Cài MCP for Unity trong Unity Editor rồi đăng ký server cho Claude Code.` };
  const where = `${e.name}, scope ${e.scope}`;
  if (e.type !== 'http' && e.type !== 'sse') return { id: 'unity-mcp', label: LABEL, ok: null, detail: `${where}: kiểu ${e.type}${e.command ? ` (${e.command})` : ''}, Studio chưa kiểm được. Quét game sẽ cho biết.` };
  if (!e.url) return { id: 'unity-mcp', label: LABEL, ok: false, detail: `${where}: thiếu url.` };
  if (!isLoopback(e.url)) return { id: 'unity-mcp', label: LABEL, ok: null, detail: `${where}: ${e.url} không nằm trên máy này, Studio không gọi tới.` };
  const r = await (o.probe ?? httpProbe)(e.url, o.timeoutMs ?? PROBE_MS);
  const line = (ok: boolean | null, more: string) => ({ id: 'unity-mcp', label: LABEL, ok, detail: `${where}: ${r.detail}${more ? ` ${more}` : ''}` });
  if (!r.ok) return line(false, HOWTO);
  if (!r.instances) return line(true, 'Không đọc được danh sách Unity Editor đang nối (mcpforunity://instances).');
  if (!r.instances.length) return line(false, `Server đang chạy nhưng chưa có Unity Editor nào nối vào. ${HOWTO}`);
  const list = r.instances.map(i => `${i.name}${i.unityVersion ? ` (${i.unityVersion})` : ''}`).join(', ');
  // MCP for Unity names an instance after the project folder; a different name may still be the same project.
  const want = project ? path.basename(path.resolve(project)).toLowerCase() : null;
  if (want && !r.instances.some(i => i.name.toLowerCase() === want))
    return line(null, `Unity Editor đang nối: ${list}. Không thấy project "${path.basename(path.resolve(project!))}": kiểm tra đã mở đúng project chưa.`);
  return line(true, `Unity Editor đang nối: ${list}.`);
}
