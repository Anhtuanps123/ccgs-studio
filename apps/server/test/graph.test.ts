import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { GraphSettings, Task } from '@ccgs/shared';
import {
  DEFAULT_EXCLUDES, GRAPH_MCP_READ_TOOLS, ambiguousIds, buildConfig, cleanExclude, excludesFor, excludesKey, graphEnv, graphMcpSession, isCodeFile,
  keywordsFromInput, keywordsFromRequest, projectIdOf, queryArgs, staleReason, tidyQueryOutput, updateArgs,
} from '../src/graph/graph-core';
import { GraphService, type Exec, type ExecResult } from '../src/graph/graph.service';
import { mergeSettings, DEFAULT_SETTINGS, BadSettings } from '../src/settings/settings.service';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import { ASK_STYLE_HINT, extrasOptions, type RunHooks, type RunOptions, type RunOutcome, type Runner, type SessionExtras } from '../src/tasks/runner';
import { CODE_TOOLS_HINT, PipelineService, plannerPrompt } from '../src/pipelines/pipeline.service';

/** SDK options of a task without extras: only the Studio system prompt. */
const ONLY_ASK = { systemPrompt: ASK_STYLE_HINT, appendSubagentSystemPrompt: ASK_STYLE_HINT };

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const ok = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: '', timedOut: false, error: null });

describe('graph core', () => {
  it('builds the command, env and exclusions outside the project', () => {
    const env = graphEnv('/h/projects/x/graphify', {});
    expect(env).toMatchObject({ GRAPHIFY_OUT: '/h/projects/x/graphify', GRAPHIFY_BACKEND: 'none', GRAPHIFY_QUERY_LOG_DISABLE: '1' });
    expect(updateArgs('D:/G', true)).toEqual(['update', 'D:/G']);
    expect(updateArgs('D:/G', false)).toEqual(['update', 'D:/G', '--no-cluster', '--force']);
    expect(queryArgs('PiggyBank', 'g.json', 500, ['a', 'b'])).toEqual(['query', 'PiggyBank', '--seed', 'a', '--seed', 'b', '--graph', 'g.json', '--budget', '500']);
    expect(excludesFor(undefined)).toEqual([...DEFAULT_EXCLUDES, 'Assets/Plugins/']);
    expect(excludesFor({ excludes: ['Assets/Spine/', '*.meta'], includePlugins: true })).toEqual([...DEFAULT_EXCLUDES, 'Assets/Spine/']);
    expect(JSON.parse(buildConfig(['a/']))).toEqual({ excludes: ['a/'], gitignore: true, code_only: true });
    expect(projectIdOf('D:/Meodoku')).toMatch(/^[0-9a-f]{16}$/);
    expect(projectIdOf('D:/Meodoku')).toBe(projectIdOf('d:/meodoku'));
  });

  it('validates exclusion lines', () => {
    expect(cleanExclude(' Assets\\Spine\\ ')).toBe('Assets/Spine/');
    expect(() => cleanExclude('../x')).toThrow(/\.\./);
    expect(() => cleanExclude('C:/x')).toThrow(/tương đối/);
    expect(() => cleanExclude('/x')).toThrow(/tương đối/);
  });

  it('finds PascalCase/camelCase identifiers and parses the keyword box', () => {
    expect(keywordsFromRequest('Sau khi nhận thưởng ngày 7 (DailyLoginManager, DataGameSave.ClaimDailyLogin) bảng trống; heo đất PiggyBank, claimDaily, UI, Lucky Spin')).toEqual(['DailyLoginManager', 'DataGameSave', 'ClaimDailyLogin', 'PiggyBank', 'claimDaily']);
    expect(keywordsFromRequest('Thêm giới hạn rút heo đất mỗi ngày')).toEqual([]);
    expect(keywordsFromInput(' PiggyBank, DailyLoginManager;PiggyBank  x ')).toEqual(['PiggyBank', 'DailyLoginManager', 'x']);
    expect(keywordsFromInput('')).toEqual([]);
    expect(() => keywordsFromInput('heo đất')).toThrow(/không hợp lệ/);
    expect(() => keywordsFromInput('a b c d e f g h i')).toThrow(/Tối đa/);
  });

  it('reads ambiguous ids, code files, staleness and tidies the output', () => {
    expect(ambiguousIds("Ambiguous: 'PiggyBank' matches 3 nodes\n  A.cs\n    id: a_piggy\n  B.cs\n    id: b_piggy\nRetry")).toEqual(['a_piggy', 'b_piggy']);
    expect(isCodeFile('Assets/X.cs')).toBe(true);
    expect(isCodeFile('design/a.md')).toBe(false);
    const k = excludesKey(['b', 'a']);
    expect(k).toBe(excludesKey(['a', 'b']));
    const s = { commit: 'aaaaaaaa', excludesKey: k, dirty: false };
    expect(staleReason(s, 'aaaaaaaa', k)).toBeNull();
    expect(staleReason(s, 'bbbbbbbb', k)).toMatch(/Commit/);
    expect(staleReason({ ...s, dirty: true }, 'aaaaaaaa', k)).toMatch(/Task vừa đổi/);
    expect(staleReason(s, 'aaaaaaaa', 'other')).toMatch(/loại trừ/);
    expect(staleReason({ ...s, foreign: true }, 'aaaaaaaa', k)).toMatch(/không do Studio/);
    expect(tidyQueryOutput('Graph: g\n\n[!] TRUNCATED: showing 21 of 132 nodes (~800-token budget). raise...\n\nNODE A')).toBe('Graph: g\n\n(rút gọn: 21/132 node)\n\nNODE A');
  });

  it('MCP session: read tools auto-allowed, PR tools (GitHub) removed, SDK options only when set', () => {
    const s = graphMcpSession(path.join('h', 'graphify', 'graph.json'));
    expect(s.allowedTools).toEqual(GRAPH_MCP_READ_TOOLS.map(t => `mcp__graphify__${t}`));
    expect(s.allowedTools).toContain('mcp__graphify__query_graph');
    expect(s.disallowedTools).toEqual(['mcp__graphify__list_prs', 'mcp__graphify__get_pr_impact', 'mcp__graphify__triage_prs']);
    expect(s.systemPrompt).toBe(CODE_TOOLS_HINT);
    expect(CODE_TOOLS_HINT).toMatch(/query the graph FIRST/);
    expect(CODE_TOOLS_HINT).toMatch(/do not have to query the graph when the task does not touch code/);
    const both = `${ASK_STYLE_HINT}\n\n${CODE_TOOLS_HINT}`;
    expect(extrasOptions(s)).toEqual({ mcpServers: s.mcpServers, allowedTools: s.allowedTools, disallowedTools: s.disallowedTools,
      systemPrompt: both, appendSubagentSystemPrompt: both });
    expect(extrasOptions(null)).toEqual(ONLY_ASK);
    expect(extrasOptions({ mcpServers: {}, allowedTools: [], note: 'không gắn' })).toEqual(ONLY_ASK);
  });
});

/** Fake graphify: `update` writes graph.json into GRAPHIFY_OUT; `query` answers from a table. */
function fakeGraphify(answers: Record<string, ExecResult> = {}) {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv; cwd: string }[] = [];
  let updateResult: ExecResult = ok('done');
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ args: [cmd, ...args], env: o.env, cwd: o.cwd });
    if (cmd === 'git') return ok('c0ffee0000000000000000000000000000000000\n');
    if (args[0] === '--version') return ok('graphify 0.9.103\n');
    if (args[0] === 'update') {
      if (updateResult.code === 0) fs.writeFileSync(path.join(o.env!.GRAPHIFY_OUT!, 'graph.json'), JSON.stringify({ nodes: [{}, {}, {}], links: [{}], built_at_commit: 'c0ffee0000000000000000000000000000000000' }));
      return updateResult;
    }
    if (args[0] === 'query') { const seeds = args.filter((_, i) => args[i - 1] === '--seed'); return answers[`${args[1]}${seeds.length ? '|' + seeds.join(',') : ''}`] ?? ok('', 4); }
    return ok('', 1);
  };
  return { exec, calls, failUpdate: (r: ExecResult) => { updateResult = r; } };
}

function graphSetup(answers?: Record<string, ExecResult>, settings: GraphSettings = { enabled: true, budget: 2000, projects: {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-graph-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-game-'));
  const fake = fakeGraphify(answers);
  const tasks = new EventEmitter();
  const logs: string[] = [];
  const g = new GraphService({ home, project: () => project, settings: () => settings, exec: fake.exec, mcpCheck: async () => ({ ok: true, detail: 'ok' }), tasks, log: (_l, m) => logs.push(m) });
  return { g, home, project, fake, tasks, logs, settings };
}
const waitIdle = async (g: GraphService) => { for (let i = 0; i < 50; i++) { const s = await g.status(); if (s.state !== 'building' && !s.updating) return s; await tick(); } throw new Error('graph still busy'); };

describe('graph service', () => {
  it('builds outside the project (building -> ready), never in the project folder', async () => {
    const { g, home, project, fake } = graphSetup();
    expect((await g.status()).state).toBe('missing');
    const started = await g.build();
    expect(started.state).toBe('building');
    await expect(g.build()).rejects.toThrow(/Đang dựng/);
    const s = await waitIdle(g);
    expect(s).toMatchObject({ state: 'ready', nodes: 3, edges: 1, commit: 'c0ffee0000000000000000000000000000000000', mcp: true, graphify: '0.9.103' });
    const upd = fake.calls.find(c => c.args[1] === 'update')!;
    expect(upd.env!.GRAPHIFY_OUT).toBe(path.join(home, 'projects', projectIdOf(project), 'graphify.building'));
    expect(upd.cwd).toBe(path.join(home, 'projects', projectIdOf(project)));
    expect(fs.existsSync(path.join(s.dir!, 'graph.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(s.dir!, '.graphify_build.json'), 'utf8')).excludes).toContain('Assets/Plugins/');
    expect(fs.readdirSync(project)).toEqual([]); // nothing written into the project
  });

  it('a failed build is an error and keeps no half-built folder', async () => {
    const { g, home, project, fake } = graphSetup();
    fake.failUpdate({ code: 1, stdout: '', stderr: 'boom', timedOut: false, error: null });
    await g.build();
    const s = await waitIdle(g);
    expect(s.state).toBe('error');
    expect(s.lastError).toMatch(/boom/);
    expect(fs.existsSync(path.join(home, 'projects', projectIdOf(project), 'graphify.building'))).toBe(false);
  });

  it('a task that changed code updates the graph in the background (stale while dirty, coalesced)', async () => {
    const { g, fake, tasks, settings } = graphSetup();
    await g.build(); await waitIdle(g);
    const n = () => fake.calls.filter(c => c.args[1] === 'update').length;
    const before = n();
    const done = (files: string[]) => tasks.emit('task', { status: 'completed', changedFiles: files.map(p => ({ path: p, change: 'M' })) } as Partial<Task>);
    done(['design/a.md']);
    expect(n()).toBe(before);
    done(['Assets/A.cs']); done(['Assets/B.cs']); done(['Assets/C.cs']);
    const s = await waitIdle(g);
    expect(n() - before).toBeLessThanOrEqual(2);
    expect(n() - before).toBeGreaterThanOrEqual(1);
    expect(fake.calls.filter(c => c.args[1] === 'update').slice(1).every(c => c.args.includes('--no-cluster'))).toBe(true);
    expect(s.state).toBe('ready');
    expect(s.lastUpdateAt).not.toBeNull();
    settings.projects[s.projectId!] = { excludes: ['Assets/Spine/'], includePlugins: false };
    expect(await g.status()).toMatchObject({ state: 'stale', staleReason: expect.stringMatching(/loại trừ/) });
  });

  it('a failed background update leaves the graph stale and only logs', async () => {
    const { g, fake, tasks, logs } = graphSetup();
    await g.build(); await waitIdle(g);
    fake.failUpdate({ code: 2, stdout: '', stderr: 'parse error', timedOut: false, error: null });
    tasks.emit('task', { status: 'completed', changedFiles: [{ path: 'Assets/A.cs', change: 'M' }] });
    const s = await waitIdle(g);
    expect(s.state).toBe('stale');
    expect(s.lastError).toMatch(/parse error/);
    expect(logs.some(l => /Cập nhật bản đồ code lỗi/.test(l))).toBe(true);
  });

  it('pre-query: one query per keyword, ambiguous names retried with their ids, missing ones noted', async () => {
    const { g } = graphSetup({
      DailyLoginManager: ok('Graph: g | 132 nodes found\n\nNODE DailyLoginManager [src=A.cs loc=L7]'),
      PiggyBank: ok("Ambiguous: 'PiggyBank' matches 2 nodes\n  A.cs\n    id: a_pb\n  B.cs\n    id: b_pb\n", 3),
      'PiggyBank|a_pb,b_pb': ok('NODE PiggyBank [src=A.cs loc=L5]'),
    });
    expect(await g.context(['PiggyBank'])).toMatchObject({ status: 'unavailable' }); // no graph yet
    await g.build(); await waitIdle(g);
    const c = await g.context(['DailyLoginManager', 'PiggyBank', 'Nope']);
    expect(c.status).toBe('used');
    expect(c.text).toContain('### DailyLoginManager');
    expect(c.text).toContain('NODE PiggyBank [src=A.cs loc=L5]');
    expect(c.detail).toMatch(/Nope: không thấy/);
    expect(await g.context(['Nope'])).toMatchObject({ status: 'error', text: null });
  });

  it('MCP session: attached only for a graph Studio built, never when off', async () => {
    const { g, home, project, settings } = graphSetup();
    expect(await g.mcpSession()).toMatchObject({ extras: null, detail: expect.stringMatching(/chưa dùng được/) });
    const out = path.join(home, 'projects', projectIdOf(project), 'graphify');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'graph.json'), '{"nodes":[],"links":[]}');
    expect(await g.mcpSession()).toMatchObject({ extras: null, detail: expect.stringMatching(/không do Studio/) });
    await g.build(); await waitIdle(g);
    const graphJson = path.join((await g.status()).dir!, 'graph.json');
    const s = await g.mcpSession();
    expect(s.detail).toMatch(/tự tra/);
    expect(s.extras!.mcpServers!.graphify).toMatchObject({ type: 'stdio', command: 'graphify-mcp', args: [graphJson], alwaysLoad: true, env: { GRAPHIFY_OUT: path.dirname(graphJson), GRAPHIFY_QUERY_LOG_DISABLE: '1' } });
    expect(s.extras!.mcpServers!.graphify.env!.PATH).toBeUndefined(); // only graphify's own variables
    settings.enabled = false;
    expect(await g.mcpSession()).toMatchObject({ extras: null, detail: expect.stringMatching(/tắt/) });
  });

  it('a graph Studio did not build is stale and not used for the planner', async () => {
    const { g, home, project } = graphSetup({ X: ok('NODE X') });
    const out = path.join(home, 'projects', projectIdOf(project), 'graphify');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'graph.json'), '{"nodes":[],"links":[]}');
    expect((await g.status()).staleReason).toMatch(/không do Studio/);
    expect(await g.context(['X'])).toMatchObject({ status: 'unavailable' });
  });

  it('reports a missing graphify without breaking', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-graph-'));
    const g = new GraphService({ home, project: () => home, settings: () => undefined, exec: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn graphify ENOENT' }) });
    const s = await g.status();
    expect(s.graphify).toBeNull();
    expect(s.toolError).toMatch(/uv tool install/);
    await expect(g.build()).rejects.toThrow(/graphify/);
    expect((await g.doctor()).ok).toBe(false);
    expect(await g.context(['X'])).toMatchObject({ status: 'unavailable' });
  });
});

describe('graph settings', () => {
  it('validates budget and per-project exclusions', () => {
    const cur = DEFAULT_SETTINGS();
    expect(cur.graphify).toEqual({ enabled: true, budget: 2000, projects: {} });
    const id = 'abcdef0123456789';
    const s = mergeSettings(cur, { graphify: { enabled: false, budget: 1500, projects: { [id]: { excludes: ['Assets\\Spine\\', '', 'Assets/Spine/'], includePlugins: true } } } });
    expect(s.graphify).toEqual({ enabled: false, budget: 1500, projects: { [id]: { excludes: ['Assets/Spine/'], includePlugins: true } } });
    expect(() => mergeSettings(cur, { graphify: { budget: 50 } })).toThrow(BadSettings);
    expect(() => mergeSettings(cur, { graphify: { projects: { [id]: { excludes: ['../x'] } } } })).toThrow(/\.\./);
    expect(() => mergeSettings(cur, { graphify: { projects: { nope: { excludes: [] } } } })).toThrow(/Mã project/);
  });
});

describe('pipeline with the code map', () => {
  type FakeGraph = { enabled(): boolean; context(k: string[]): Promise<any>; mcpSession?(): Promise<{ extras: SessionExtras | null; detail: string }> };
  function pipelineSetup(graph?: FakeGraph) {
    const runs = new Map<string, Task>();
    const opts = new Map<string, RunOptions | undefined>();
    const runner: Runner = (task: Task, hooks: RunHooks, o?: RunOptions) => {
      runs.set(task.id, task); opts.set(task.id, o); hooks.onSession('s');
      return { done: new Promise<RunOutcome>(() => undefined), pid: () => null, stop: async () => undefined };
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-pl-'));
    fs.writeFileSync(path.join(root, 'project.yaml'), 'modes:\n  rigor: standard\n');
    const db = openDb(':memory:');
    const q = new TaskQueue({ db, runner, project: () => 'x', snapshot: async () => new Map(), sessionExists: () => true });
    const p = new PipelineService({ db, queue: q, skills: () => [], project: () => root, templates: () => [], critic: false, graph });
    return { p, q, opts };
  }

  it('every task gets the graphify MCP server and its system prompt; the planner records it on the pipeline', async () => {
    const extras = graphMcpSession('g.json');
    const { p, q, opts } = pipelineSetup({ enabled: () => true, context: async () => { throw new Error('no'); }, mcpSession: async () => ({ extras, detail: 'Claude tự tra được bản đồ code (MCP graphify).' }) });
    const pl = p.create({ request: 'Thêm giới hạn rút heo đất mỗi ngày' });
    expect(q.get(pl.planTaskId!)!.prompt).not.toContain(CODE_TOOLS_HINT); // in the system prompt, not the request
    await tick();
    expect(opts.get(pl.planTaskId!)?.extras).toMatchObject({ ...extras, systemPrompt: CODE_TOOLS_HINT, note: expect.stringMatching(/tự tra/) });
    expect(q.get(pl.planTaskId!)!.mcp).toEqual({ servers: ['graphify'], note: expect.stringMatching(/tự tra/), calls: null });
    expect(p.get(pl.id)!.graph).toMatchObject({ status: 'skipped', mcp: true, mcpDetail: expect.stringMatching(/tự tra/), mcpCalls: null });
    // A plain task (or a step) gets it too, and no pipeline changes.
    expect(await p.sessionExtras(q.create({ kind: 'prompt', prompt: 'x' }))).toMatchObject({ mcpServers: extras.mcpServers, systemPrompt: CODE_TOOLS_HINT });
  });

  it('no usable graph (or a failure): tasks still run, without MCP, and the reason is kept', async () => {
    const { p, q, opts } = pipelineSetup({ enabled: () => true, context: async () => { throw new Error('no'); }, mcpSession: async () => ({ extras: null, detail: 'Bản đồ code chưa dùng được (chưa dựng).' }) });
    const pl = p.create({ request: 'Thêm giới hạn rút heo đất mỗi ngày' });
    await tick();
    expect(opts.get(pl.planTaskId!)?.extras).toEqual({ note: expect.stringMatching(/chưa dựng/) });
    expect(extrasOptions(opts.get(pl.planTaskId!)?.extras)).toEqual(ONLY_ASK);
    expect(q.get(pl.planTaskId!)!.mcp).toEqual({ servers: [], note: expect.stringMatching(/chưa dựng/), calls: null });
    expect(p.get(pl.id)!.graph).toMatchObject({ mcp: false, mcpDetail: expect.stringMatching(/chưa dựng/) });

    const b = pipelineSetup({ enabled: () => true, context: async () => { throw new Error('no'); }, mcpSession: async () => { throw new Error('boom'); } });
    const pl2 = b.p.create({ request: 'Thêm giới hạn rút heo đất mỗi ngày' });
    await tick();
    expect(extrasOptions(b.opts.get(pl2.planTaskId!)?.extras)).toEqual(ONLY_ASK);
    expect(b.p.get(pl2.id)!.graph).toMatchObject({ mcp: false, mcpDetail: expect.stringMatching(/boom/) });

    const old = pipelineSetup({ enabled: () => true, context: async () => { throw new Error('no'); } });
    const pl3 = old.p.create({ request: 'x' });
    await tick();
    expect(old.opts.get(pl3.planTaskId!)?.extras).toBeNull();
    expect(old.q.get(pl3.planTaskId!)!.mcp).toBeNull();
  });

  it('counts the graphify calls of a task (subagents included) when it ends, and the planner count on the pipeline', async () => {
    const extras = graphMcpSession('g.json');
    const db = openDb(':memory:');
    let seq = 0;
    const ev = (taskId: string, type: string, tool: string | null) => db.$client.prepare(`INSERT INTO events (event_id, seq, event_type, timestamp, session_id, task_id,
      agent_invocation_id, tool_name, tool_use_id, payload, source) VALUES (?, ?, ?, ?, 's', ?, ?, ?, NULL, '{}', 'studio')`)
      .run(`e${++seq}`, seq, type, new Date().toISOString(), taskId, seq % 2 ? 'sub' : null, tool);
    const runner: Runner = (task: Task, hooks: RunHooks) => {
      hooks.onSession('s');
      ev(task.id, 'PreToolUse', 'mcp__graphify__query_graph');
      ev(task.id, 'PostToolUse', 'mcp__graphify__query_graph');
      ev(task.id, 'PreToolUse', 'mcp__graphify__get_node');
      ev(task.id, 'PreToolUse', 'mcp__graphify_x__y'); // another server's name prefix
      ev(task.id, 'PreToolUse', 'Grep');
      ev('other', 'PreToolUse', 'mcp__graphify__query_graph');
      return { done: Promise.resolve({ ok: true, sessionId: 's', resultText: 'không phải JSON', error: null }), pid: () => null, stop: async () => undefined };
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-pl-'));
    fs.writeFileSync(path.join(root, 'project.yaml'), 'modes:\n  rigor: standard\n');
    const q = new TaskQueue({ db, runner, project: () => 'x', snapshot: async () => new Map(), sessionExists: () => true });
    const p = new PipelineService({ db, queue: q, skills: () => [], project: () => root, templates: () => [], critic: false,
      graph: { enabled: () => true, context: async () => { throw new Error('no'); }, mcpSession: async () => ({ extras, detail: 'Claude tự tra được bản đồ code (MCP graphify).' }) } });
    const pl = p.create({ request: 'Thêm giới hạn rút heo đất mỗi ngày' });
    await tick(); await tick();
    expect(q.get(pl.planTaskId!)!.mcp).toEqual({ servers: ['graphify'], note: expect.any(String), calls: { graphify: 2 } });
    expect(p.get(pl.id)!.graph).toMatchObject({ mcp: true, mcpCalls: 2 });
  });

  it('no identifier: plans right away and records "skipped"', () => {
    const { p, q } = pipelineSetup({ enabled: () => true, context: async () => { throw new Error('should not be called'); } });
    const pl = p.create({ request: 'Thêm giới hạn rút heo đất mỗi ngày' });
    expect(pl.planTaskId).not.toBeNull();
    expect(pl.graph).toMatchObject({ status: 'skipped', keywords: [] });
    expect(q.get(pl.planTaskId!)!.prompt).not.toContain('Code map');
  });

  it('identifiers: looks them up first, then the planner prompt carries the code map', async () => {
    let asked: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { p, q } = pipelineSetup({ enabled: () => true, context: async k => { asked = k; await gate; return { status: 'used', text: 'NODE PiggyBank [src=A.cs loc=L5]', detail: 'PiggyBank: có kết quả' }; } });
    let pl = p.create({ request: 'Mỗi ngày chỉ rút PiggyBank một lần' });
    expect(pl).toMatchObject({ status: 'planning', planTaskId: null, graph: null });
    expect(asked).toEqual(['PiggyBank']);
    release(); await tick();
    pl = p.get(pl.id)!;
    expect(pl.graph).toMatchObject({ status: 'used', keywords: ['PiggyBank'], source: 'request', chars: 32 });
    expect(pl.note).toBeNull();
    const prompt = q.get(pl.planTaskId!)!.prompt;
    expect(prompt).toContain('Code map (graphify');
    expect(prompt).toContain('NODE PiggyBank [src=A.cs loc=L5]');
  });

  it('the keyword box wins over the request; a failed lookup still plans; a bad keyword is refused', async () => {
    let asked: string[] = [];
    const { p, q } = pipelineSetup({ enabled: () => true, context: async k => { asked = k; return { status: 'error', text: null, detail: 'X: lỗi' }; } });
    let pl = p.create({ request: 'Sửa PiggyBank', codeKeywords: 'DailyLoginManager, DataGameSave' });
    await tick();
    expect(asked).toEqual(['DailyLoginManager', 'DataGameSave']);
    pl = p.get(pl.id)!;
    expect(pl.codeKeywords).toEqual(['DailyLoginManager', 'DataGameSave']);
    expect(pl.graph).toMatchObject({ status: 'error', source: 'user' });
    expect(q.get(pl.planTaskId!)!.prompt).not.toContain('Code map');
    expect(() => p.create({ request: 'x', codeKeywords: 'heo đất' })).toThrow(/không hợp lệ/);
  });

  it('turned off in Settings: plans right away without a lookup', () => {
    const { p } = pipelineSetup({ enabled: () => false, context: async () => { throw new Error('no'); } });
    const pl = p.create({ request: 'Sửa PiggyBank' });
    expect(pl.graph).toMatchObject({ status: 'unavailable', keywords: ['PiggyBank'] });
    expect(pl.planTaskId).not.toBeNull();
  });

  it('cancelled during the lookup: no planner task is started', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { p } = pipelineSetup({ enabled: () => true, context: async () => { await gate; return { status: 'used', text: 'x', detail: '' }; } });
    const pl = p.create({ request: 'Sửa PiggyBank' });
    await p.cancel(pl.id);
    release(); await tick();
    expect(p.get(pl.id)).toMatchObject({ status: 'cancelled', planTaskId: null });
  });

  it('plannerPrompt only adds the section when given', () => {
    expect(plannerPrompt('r', [])).not.toContain('Code map');
    expect(plannerPrompt('r', [], null, null, null, [], { keywords: ['A'], text: 'NODE A' })).toMatch(/looked up: A[\s\S]*NODE A/);
  });
});
