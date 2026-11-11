// Code map (graphify) — pure helpers: paths, env, exclusions, keywords, staleness, query output.
// graphify runs OUTSIDE the project: GRAPHIFY_OUT under the Studio home, no LLM (GRAPHIFY_BACKEND=none), only `update` and `query`.
import crypto from 'node:crypto';
import path from 'node:path';
import type { GraphProjectSettings, GraphSettings } from '@ccgs/shared';
import type { SessionExtras } from '../tasks/runner';

/** A3 of the brief + Bước 0 decision 3. Assets/Plugins/ is added unless the project turns it back on. */
export const DEFAULT_EXCLUDES = ['Library/', 'Temp/', 'Logs/', 'obj/', 'Build/', 'Builds/', 'UserSettings/', '*.meta', '*.csproj', '*.sln', '*.slnx', '.claude/', '.agents/'];
export const PLUGINS_DIR = 'Assets/Plugins/';
export const DEFAULT_GRAPH_SETTINGS = (): GraphSettings => ({ enabled: true, budget: 2000, projects: {} });

/** Same id as the game scan: sha1 of the lower-cased absolute path, 16 hex chars. */
export const projectIdOf = (p: string) => crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 16);

export function excludesFor(ps: GraphProjectSettings | undefined): string[] {
  const base = [...DEFAULT_EXCLUDES, ...(ps?.includePlugins ? [] : [PLUGINS_DIR])];
  return [...base, ...(ps?.excludes ?? []).filter(x => !base.includes(x))];
}
/** Content of <GRAPHIFY_OUT>/.graphify_build.json, which `graphify update` re-applies (0.9.103 has no --exclude on update). */
export const buildConfig = (excludes: string[]) => JSON.stringify({ excludes, gitignore: true, code_only: true });
export const excludesKey = (excludes: string[]) => [...excludes].sort().join('\n');

export function graphEnv(out: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GRAPHIFY_OUT: out, GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1', GRAPHIFY_NO_TIPS: '1', PYTHONIOENCODING: 'utf-8' };
}
/** graphify-mcp 0.9.103 tools that only read the graph: auto-allowed in a session. */
export const GRAPH_MCP_READ_TOOLS = ['query_graph', 'get_node', 'get_neighbors', 'get_community', 'god_nodes', 'graph_stats', 'shortest_path'];
/** Its GitHub PR tools (network, outside the brief): removed from the session. */
export const GRAPH_MCP_BLOCKED_TOOLS = ['list_prs', 'get_pr_impact', 'triage_prs'];
const mcpName = (t: string) => `mcp__graphify__${t}`;

/**
 * System prompt of every task that gets the graphify MCP server (brief 6.2). Not a duty for every task: only when the
 * task has to find or understand code. Grep/Glob stay for what the graph does not hold.
 */
export const CODE_TOOLS_HINT = `Code map (graphify MCP): this session has the mcp__graphify__* tools (query_graph, get_node, get_neighbors, shortest_path, get_community), a graph of the project's code (classes, methods, calls, file:line) built by tree-sitter.
Whenever you need to find or understand code (where a feature lives, which class or method does something, who calls what, what a change affects), query the graph FIRST instead of opening scripts to read them from the top: query_graph with the names or systems involved (for a new feature, the existing systems it plugs into, not its new name), then get_node / get_neighbors for the file and line. Then Read only those line ranges (Read with offset/limit).
Use Grep or Glob only for what the graph does not answer: code just written in this session, non-code files (json, prefab, asset, config, docs), or a literal text search. Do not Grep or Glob across the whole project to locate code the graph can locate.
You do not have to query the graph when the task does not touch code. The graph can be slightly behind the files on disk; the file on disk wins.`;

/**
 * A7: what a Claude session needs to query the graph itself. alwaysLoad keeps the tools in the first prompt
 * (not deferred behind tool search); env carries only graphify's own variables (the CLI adds them to its env).
 */
export function graphMcpSession(graphJson: string): SessionExtras {
  return {
    mcpServers: { graphify: { type: 'stdio', command: 'graphify-mcp', args: [graphJson], env: graphEnv(path.dirname(graphJson), {}) as Record<string, string>, alwaysLoad: true } },
    allowedTools: GRAPH_MCP_READ_TOOLS.map(mcpName),
    disallowedTools: GRAPH_MCP_BLOCKED_TOOLS.map(mcpName),
    systemPrompt: CODE_TOOLS_HINT,
  };
}

export const updateArgs = (project: string, full: boolean) => ['update', project, ...(full ? [] : ['--no-cluster', '--force'])];
export const queryArgs = (q: string, graph: string, budget: number, seeds: string[] = []) =>
  ['query', q, ...seeds.flatMap(s => ['--seed', s]), '--graph', graph, '--budget', String(budget)];

/** Validates one exclusion line: relative, no "..", no drive letter. Returns the cleaned entry or throws a Vietnamese message. */
export function cleanExclude(raw: string): string {
  const s = raw.trim().replace(/\\/g, '/');
  if (!s) throw new Error('Mục loại trừ trống');
  if (s.length > 200) throw new Error(`Mục loại trừ quá dài: "${s.slice(0, 40)}…"`);
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) throw new Error(`Mục loại trừ phải là đường dẫn tương đối: "${s}"`);
  if (s.split('/').includes('..')) throw new Error(`Mục loại trừ không được chứa "..": "${s}"`);
  if (/[\0\n\r"]/.test(s)) throw new Error(`Mục loại trừ có ký tự không hợp lệ: "${s}"`);
  return s;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** PascalCase / camelCase: a lower-case letter or digit followed by an upper-case one (PiggyBank, claimDaily). */
const isMixed = (w: string) => IDENT.test(w) && /[a-z0-9][A-Z]/.test(w) && /[a-z]/.test(w);
export const MAX_REQUEST_KEYWORDS = 6;
export const MAX_USER_KEYWORDS = 8;

/** Identifiers found in the request text ("A.B" gives A and B). */
export function keywordsFromRequest(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    for (const w of m[0].split('.')) if (isMixed(w) && !out.includes(w)) out.push(w);
  }
  return out.slice(0, MAX_REQUEST_KEYWORDS);
}
/** The "Từ khoá mã nguồn" box: identifiers separated by commas, semicolons or spaces. Throws on an entry that is not an identifier. */
export function keywordsFromInput(raw: string | undefined | null): string[] {
  if (!raw || !raw.trim()) return [];
  const out: string[] = [];
  for (const w of raw.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(w) || w.length > 80) throw new Error(`Từ khoá mã nguồn không hợp lệ: "${w.slice(0, 40)}" (chỉ chữ, số, _ và .)`);
    if (!out.includes(w)) out.push(w);
  }
  if (out.length > MAX_USER_KEYWORDS) throw new Error(`Tối đa ${MAX_USER_KEYWORDS} từ khoá mã nguồn`);
  return out;
}

/** Candidate node ids listed by an ambiguous query/explain (exit code 3). */
export const ambiguousIds = (out: string, max = 3) => [...out.matchAll(/^\s*id:\s*(\S+)\s*$/gm)].map(m => m[1]).slice(0, max);

/** Code files trigger a background update after a task. */
const CODE_EXT = new Set(['.cs', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.java', '.kt', '.go', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.lua', '.gd', '.swift', '.shader', '.hlsl', '.cginc']);
export const isCodeFile = (p: string) => CODE_EXT.has(path.extname(p).toLowerCase());

/** Why the graph is stale, or null when it is current. */
export function staleReason(s: { commit: string | null; excludesKey: string | null; dirty: boolean; foreign?: boolean }, head: string | null, curExcludesKey: string): string | null {
  if (s.foreign) return 'Đồ thị có sẵn nhưng không do Studio dựng (không rõ danh sách loại trừ). Bấm "Dựng lại".';
  if (s.dirty) return 'Task vừa đổi file code, đồ thị chưa cập nhật xong.';
  if (s.excludesKey !== null && s.excludesKey !== curExcludesKey) return 'Danh sách loại trừ đã đổi. Bấm "Dựng lại" để áp dụng.';
  if (head && s.commit && head !== s.commit) return `Commit hiện tại (${head.slice(0, 7)}) khác lúc dựng (${s.commit.slice(0, 7)}).`;
  return null;
}

/** Drops the CLI's hint about raising the budget (it talks to a human); keeps a short note that the result was cut. */
export function tidyQueryOutput(out: string): string {
  return out.replace(/^\[!\] TRUNCATED: showing (\d+) of (\d+) nodes.*$/m, '(rút gọn: $1/$2 node)').replace(/\n{3,}/g, '\n\n').trim();
}
