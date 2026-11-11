// Code map (graphify): build / update / query a code graph of the current project, stored OUTSIDE the project
// (<studio home>/projects/<projectId>/graphify). Brief graphify Phần A (A1–A8). Never writes into the project,
// never calls an LLM (GRAPHIFY_BACKEND=none, only `update` and `query`).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoctorCheck, GraphSettings, GraphStatus, Task } from '@ccgs/shared';
import {
  DEFAULT_EXCLUDES, DEFAULT_GRAPH_SETTINGS, ambiguousIds, buildConfig, excludesFor, excludesKey, graphEnv, graphMcpSession, isCodeFile,
  projectIdOf, queryArgs, staleReason, tidyQueryOutput, updateArgs,
} from './graph-core';
import type { SessionExtras } from '../tasks/runner';

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error: string | null }
export type Exec = (cmd: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;
export type McpCheck = (graphJson: string) => Promise<{ ok: boolean; detail: string }>;

const CAP = 256 * 1024;
const keepTail = (s: string) => (s.length > CAP ? s.slice(-CAP) : s);
/** Runs a command without a shell (arguments are never parsed by one). */
export const realExec: Exec = (cmd, args, o) => new Promise(resolve => {
  let out = '', err = '', timedOut = false, done = false;
  const finish = (r: Omit<ExecResult, 'stdout' | 'stderr' | 'timedOut'>) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, stdout: out, stderr: err, timedOut }); };
  let c: ReturnType<typeof spawn>;
  try { c = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, windowsHide: true }); } catch (e) { resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: (e as Error).message }); return; }
  const timer = setTimeout(() => { timedOut = true; c.kill(); }, o.timeoutMs);
  c.stdout?.on('data', d => { out = keepTail(out + d); });
  c.stderr?.on('data', d => { err = keepTail(err + d); });
  c.on('error', e => finish({ code: null, error: e.message }));
  c.on('close', code => finish({ code, error: timedOut ? `Quá ${Math.round(o.timeoutMs / 1000)} giây` : null }));
});

/** graphify-mcp answers an MCP initialize (the [mcp] extra is installed); 15 s limit. */
export const realMcpCheck: McpCheck = graphJson => new Promise(resolve => {
  let out = '', err = '', done = false;
  const finish = (ok: boolean, detail: string) => { if (done) return; done = true; clearTimeout(timer); try { c.kill(); } catch { /* gone */ } resolve({ ok, detail }); };
  const c = spawn('graphify-mcp', [graphJson], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: graphEnv(path.dirname(graphJson)) });
  const timer = setTimeout(() => finish(false, `graphify-mcp không trả lời sau 15 giây${err ? `: ${err.trim().split('\n').pop()}` : ''}`), 15_000);
  c.stdout?.on('data', d => { out += d; if (out.includes('"result"')) finish(true, 'graphify-mcp trả lời MCP initialize'); });
  c.stderr?.on('data', d => { err = keepTail(err + d); });
  c.on('error', e => finish(false, e.message));
  c.on('exit', code => finish(false, `graphify-mcp thoát (mã ${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}. Cài lại: uv tool install "graphifyy[mcp]" --force`));
  c.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ccgs-studio', version: '1' } } }) + '\n');
});

/** Saved per project in <home>/projects/<id>/graph-status.json. */
interface Saved {
  builtAt: string | null; commit: string | null; nodes: number | null; edges: number | null; durationMs: number | null;
  lastError: string | null; excludesKey: string | null; dirty: boolean; lastUpdateAt: string | null;
  /** The last full build failed. */
  buildFailed: boolean;
}
const EMPTY: Saved = { builtAt: null, commit: null, nodes: null, edges: null, durationMs: null, lastError: null, excludesKey: null, dirty: false, lastUpdateAt: null, buildFailed: false };

export interface GraphContext { status: 'used' | 'unavailable' | 'error'; text: string | null; detail: string }

export interface GraphDeps {
  home: string;
  project: () => string | null;
  settings: () => GraphSettings | undefined;
  exec?: Exec;
  mcpCheck?: McpCheck;
  /** Task end events, to update the graph after a task changed code. */
  tasks?: EventEmitter<any>;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const QUERY_TIMEOUT = 15_000;
const CONTEXT_DEADLINE = 45_000;
const BUILD_TIMEOUT = 15 * 60_000;
const ENDED = ['completed', 'failed', 'cancelled'];
const lastLine = (r: ExecResult) => (r.error ?? (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 400)) || `mã thoát ${r.code}`;

export class GraphService {
  readonly bus = new EventEmitter<{ graph: [GraphStatus] }>();
  private readonly exec: Exec;
  private readonly mcpCheck: McpCheck;
  private chain: Promise<unknown> = Promise.resolve();
  private building: string | null = null; // projectId
  private updating: string | null = null;
  private updateQueued = new Set<string>();
  private version: { at: number; v: string | null; error: string | null } | null = null;
  private mcp = new Map<string, boolean>();
  private heads = new Map<string, { at: number; head: string | null }>();

  constructor(private readonly d: GraphDeps) {
    this.exec = d.exec ?? realExec;
    this.mcpCheck = d.mcpCheck ?? realMcpCheck;
    d.tasks?.on('task', (t: Task) => { if (ENDED.includes(t.status) && (t.changedFiles ?? []).some(f => isCodeFile(f.path))) this.scheduleUpdate(); });
  }

  settings(): GraphSettings { return { ...DEFAULT_GRAPH_SETTINGS(), ...(this.d.settings() ?? {}) }; }
  enabled(): boolean { return this.settings().enabled !== false; }

  private paths(project: string) {
    const id = projectIdOf(project);
    const base = path.join(this.d.home, 'projects', id);
    return { id, base, out: path.join(base, 'graphify'), tmp: path.join(base, 'graphify.building'), graph: path.join(base, 'graphify', 'graph.json'), status: path.join(base, 'graph-status.json') };
  }
  private load(project: string): Saved {
    try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(this.paths(project).status, 'utf8')) }; } catch { return { ...EMPTY }; }
  }
  private hasSaved(project: string) { return fs.existsSync(this.paths(project).status); }
  private save(project: string, s: Saved) {
    const f = this.paths(project).status;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
  }
  private log(level: 'info' | 'warn' | 'error', msg: string) { this.d.log?.(level, msg); }
  private emit() { void this.status().then(s => this.bus.emit('graph', s)).catch(() => { /* status never throws on purpose */ }); }
  /** Serialises every graphify command (one at a time; reads must not see a half-written graph.json). */
  private run<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private excludes(project: string) { return excludesFor(this.settings().projects?.[projectIdOf(project)]); }

  async graphifyVersion(): Promise<{ v: string | null; error: string | null }> {
    if (this.version && Date.now() - this.version.at < 10 * 60_000) return this.version;
    const r = await this.exec('graphify', ['--version'], { cwd: os.tmpdir(), timeoutMs: 15_000 }); // cwd must exist or spawn reports ENOENT
    const v = r.code === 0 ? (r.stdout.trim().split(/\s+/).pop() ?? null) : null;
    this.version = { at: Date.now(), v, error: v ? null : `Không chạy được graphify (${lastLine(r)}). Cài: uv tool install "graphifyy[mcp]"` };
    return this.version;
  }
  private async head(project: string): Promise<string | null> {
    const c = this.heads.get(project);
    if (c && Date.now() - c.at < 5000) return c.head;
    const r = await this.exec('git', ['rev-parse', 'HEAD'], { cwd: project, timeoutMs: 10_000 });
    const head = r.code === 0 ? r.stdout.trim() || null : null;
    this.heads.set(project, { at: Date.now(), head });
    return head;
  }

  async status(): Promise<GraphStatus> {
    const project = this.d.project();
    const ver = await this.graphifyVersion();
    const base: GraphStatus = {
      state: 'missing', projectId: null, dir: null, enabled: this.enabled(), graphify: ver.v, mcp: null, toolError: ver.error,
      builtAt: null, commit: null, nodes: null, edges: null, durationMs: null, lastError: null, staleReason: null,
      updating: false, lastUpdateAt: null, defaultExcludes: DEFAULT_EXCLUDES,
    };
    if (!project) return base;
    const p = this.paths(project);
    const s = this.load(project);
    const mcp = this.mcp.get(p.id);
    const st: GraphStatus = {
      ...base, projectId: p.id, dir: p.out, mcp: mcp ?? null,
      toolError: ver.error ?? (mcp === false ? 'graphify-mcp không chạy được. Cài lại: uv tool install "graphifyy[mcp]" --force' : null),
      builtAt: s.builtAt, commit: s.commit, nodes: s.nodes, edges: s.edges, durationMs: s.durationMs, lastError: s.lastError,
      updating: this.updating === p.id || this.updateQueued.has(p.id), lastUpdateAt: s.lastUpdateAt,
    };
    if (this.building === p.id) return { ...st, state: 'building' };
    if (s.buildFailed) return { ...st, state: 'error' };
    if (!fs.existsSync(p.graph)) return st;
    const reason = staleReason({ ...s, foreign: !this.hasSaved(project) }, await this.head(project), excludesKey(this.excludes(project)));
    return { ...st, state: reason ? 'stale' : 'ready', staleReason: reason };
  }

  /** Full rebuild (with clustering) into a temporary folder, then swap it in. Returns once started. */
  async build(): Promise<GraphStatus> {
    const project = this.d.project();
    if (!project) throw new GraphError('Chưa chọn project', 400);
    const p = this.paths(project);
    if (this.building === p.id || this.updating === p.id) throw new GraphError('Đang dựng hoặc cập nhật bản đồ code', 409);
    const ver = await this.graphifyVersion();
    if (!ver.v) throw new GraphError(ver.error ?? 'Chưa cài graphify', 400);
    this.building = p.id;
    this.emit();
    void this.run(() => this.doBuild(project)).finally(() => { this.building = null; this.emit(); });
    return this.status();
  }

  private async doBuild(project: string) {
    const p = this.paths(project);
    const excludes = this.excludes(project);
    const s = this.load(project);
    const t0 = Date.now();
    try {
      fs.rmSync(p.tmp, { recursive: true, force: true });
      fs.mkdirSync(p.tmp, { recursive: true });
      fs.writeFileSync(path.join(p.tmp, '.graphify_build.json'), buildConfig(excludes));
      const r = await this.exec('graphify', updateArgs(project, true), { cwd: p.base, env: graphEnv(p.tmp), timeoutMs: BUILD_TIMEOUT });
      if (r.code !== 0 || !fs.existsSync(path.join(p.tmp, 'graph.json'))) throw new Error(`graphify update lỗi: ${lastLine(r)}`);
      const g = readGraph(path.join(p.tmp, 'graph.json'));
      fs.rmSync(p.out, { recursive: true, force: true });
      fs.renameSync(p.tmp, p.out);
      const durationMs = Date.now() - t0;
      this.save(project, { ...EMPTY, builtAt: new Date().toISOString(), commit: g.commit ?? await this.head(project), nodes: g.nodes, edges: g.edges, durationMs, excludesKey: excludesKey(excludes) });
      this.heads.delete(project);
      this.log('info', `Đã dựng bản đồ code: ${g.nodes} node, ${g.edges} cạnh, ${(durationMs / 1000).toFixed(1)} s.`);
      const m = await this.mcpCheck(p.graph);
      this.mcp.set(p.id, m.ok);
      if (!m.ok) this.log('warn', `graphify-mcp: ${m.detail}`);
    } catch (e) {
      fs.rmSync(p.tmp, { recursive: true, force: true });
      this.save(project, { ...s, lastError: (e as Error).message, buildFailed: true });
      this.log('error', `Dựng bản đồ code lỗi: ${(e as Error).message}`);
    }
  }

  /** After a task changed code: incremental update in the background (coalesced, never blocks the queue). */
  scheduleUpdate() {
    const project = this.d.project();
    if (!project) return;
    const p = this.paths(project);
    if (!fs.existsSync(p.graph) || !this.hasSaved(project)) return; // nothing Studio built to update
    this.save(project, { ...this.load(project), dirty: true });
    if (this.updateQueued.has(p.id)) { this.emit(); return; }
    this.updateQueued.add(p.id);
    this.emit();
    void this.run(async () => {
      this.updateQueued.delete(p.id);
      this.updating = p.id;
      this.emit();
      try { await this.doUpdate(project); } finally { this.updating = null; this.emit(); }
    });
  }

  private async doUpdate(project: string) {
    const p = this.paths(project);
    const t0 = Date.now();
    const r = await this.exec('graphify', updateArgs(project, false), { cwd: p.base, env: graphEnv(p.out), timeoutMs: BUILD_TIMEOUT });
    const s = this.load(project);
    if (r.code !== 0) {
      this.save(project, { ...s, lastError: `Cập nhật lỗi: ${lastLine(r)}` });
      this.log('warn', `Cập nhật bản đồ code lỗi: ${lastLine(r)}`);
      return;
    }
    this.heads.delete(project);
    let g: ReturnType<typeof readGraph> | null = null;
    try { g = readGraph(p.graph); } catch { /* counts stay */ }
    this.save(project, { ...s, dirty: false, lastError: null, lastUpdateAt: new Date().toISOString(), commit: g?.commit ?? await this.head(project) ?? s.commit, nodes: g?.nodes ?? s.nodes, edges: g?.edges ?? s.edges });
    this.log('info', `Đã cập nhật bản đồ code sau task (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
  }

  /** A6: one `graphify query`, 15 s limit. Exit codes: 0 answer, 3 ambiguous, 4 not found. */
  async queryGraph(question: string, budget: number, seeds: string[] = []): Promise<ExecResult> {
    const project = this.d.project();
    if (!project) return { code: null, stdout: '', stderr: '', timedOut: false, error: 'Chưa chọn project' };
    const p = this.paths(project);
    return this.run(() => this.exec('graphify', queryArgs(question, p.graph, budget, seeds), { cwd: p.base, env: graphEnv(p.out), timeoutMs: QUERY_TIMEOUT }));
  }

  /** Pre-query for the planner (brief 6.1 mục 3): one query per keyword, ambiguous names retried with their node ids. */
  async context(keywords: string[]): Promise<GraphContext> {
    if (!this.enabled()) return { status: 'unavailable', text: null, detail: 'Bản đồ code đang tắt trong Cài đặt.' };
    const st = await this.status();
    if (!st.graphify) return { status: 'unavailable', text: null, detail: st.toolError ?? 'Chưa cài graphify.' };
    if (st.state !== 'ready' && st.state !== 'stale') return { status: 'unavailable', text: null, detail: `Bản đồ code chưa dùng được (${STATE_VI[st.state]}).` };
    if (!st.builtAt) return { status: 'unavailable', text: null, detail: 'Đồ thị có sẵn không do Studio dựng (không rõ danh sách loại trừ). Bấm "Dựng lại" ở Tổng quan.' };
    const budget = this.settings().budget;
    const each = Math.max(300, Math.floor(budget / keywords.length));
    const until = Date.now() + CONTEXT_DEADLINE;
    const parts: string[] = [], notes: string[] = [];
    for (const kw of keywords) {
      if (Date.now() > until) { notes.push(`${kw}: bỏ qua (quá ${CONTEXT_DEADLINE / 1000} giây cho cả lượt tra)`); continue; }
      let r = await this.queryGraph(kw, each);
      if (r.code === 3) {
        const ids = ambiguousIds(r.stdout + '\n' + r.stderr);
        if (ids.length) r = await this.queryGraph(kw, each, ids);
      }
      if (r.code === 0 && r.stdout.trim()) { parts.push(`### ${kw}\n${tidyQueryOutput(r.stdout)}`); notes.push(`${kw}: có kết quả`); }
      else if (r.code === 4) notes.push(`${kw}: không thấy trong đồ thị`);
      else notes.push(`${kw}: lỗi (${lastLine(r)})`);
    }
    const stale = st.state === 'stale' ? ` Đồ thị cũ: ${st.staleReason ?? ''}`.trimEnd() : '';
    if (!parts.length) return { status: 'error', text: null, detail: notes.join('; ') + stale };
    const max = budget * 6;
    let text = parts.join('\n\n');
    if (text.length > max) text = text.slice(0, max - 1) + '…';
    return { status: 'used', text, detail: notes.join('; ') + stale };
  }

  /**
   * A7: the graphify MCP server for a Claude session (planner tasks; brief 6.2), with the reason when it is not attached.
   * Same conditions as the pre-query; a graph Studio did not build is not used. mcp === null (not checked yet) still attaches.
   */
  async mcpSession(): Promise<{ extras: SessionExtras | null; detail: string }> {
    const no = (detail: string) => ({ extras: null, detail });
    if (!this.enabled()) return no('Bản đồ code đang tắt trong Cài đặt.');
    const st = await this.status();
    if (!st.graphify) return no(st.toolError ?? 'Chưa cài graphify.');
    if (!st.dir || (st.state !== 'ready' && st.state !== 'stale')) return no(`Bản đồ code chưa dùng được (${STATE_VI[st.state]}).`);
    if (!st.builtAt) return no('Đồ thị có sẵn không do Studio dựng. Bấm "Dựng lại" ở Tổng quan.');
    if (st.mcp === false) return no(st.toolError ?? 'graphify-mcp không chạy được.');
    return { extras: graphMcpSession(path.join(st.dir, 'graph.json')), detail: `Claude tự tra được bản đồ code (MCP graphify${st.state === 'stale' ? ', đồ thị hơi cũ' : ''}).` };
  }

  /** S-02 line for graphify (optional tool). */
  async doctor(): Promise<DoctorCheck> {
    const label = 'graphify (bản đồ code, không bắt buộc)';
    this.version = null;
    const ver = await this.graphifyVersion();
    if (!ver.v) return { id: 'graphify', label, ok: false, detail: ver.error ?? 'Chưa cài' };
    const project = this.d.project();
    const graph = project ? this.paths(project).graph : null;
    if (!graph || !fs.existsSync(graph)) return { id: 'graphify', label, ok: true, detail: `graphify ${ver.v}. Chưa có đồ thị nên chưa thử graphify-mcp.` };
    const m = await this.mcpCheck(graph);
    this.mcp.set(this.paths(project!).id, m.ok);
    this.emit();
    return { id: 'graphify', label, ok: m.ok, detail: `graphify ${ver.v}. ${m.detail}` };
  }
}

export class GraphError extends Error { constructor(msg: string, readonly status: 400 | 409) { super(msg); } }

const STATE_VI: Record<GraphStatus['state'], string> = { missing: 'chưa dựng', building: 'đang dựng', ready: 'sẵn sàng', stale: 'cũ', error: 'lần dựng cuối lỗi' };

function readGraph(file: string): { nodes: number; edges: number; commit: string | null } {
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { nodes: Array.isArray(g.nodes) ? g.nodes.length : 0, edges: Array.isArray(g.links) ? g.links.length : Array.isArray(g.edges) ? g.edges.length : 0, commit: typeof g.built_at_commit === 'string' ? g.built_at_commit : null };
}
