import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { findUnityMcp, httpProbe, isLoopback, unityMcpCheck } from '../src/system/unity-mcp';
import { openDb } from '../src/store/db';
import { TaskQueue } from '../src/tasks/task-queue';
import type { Runner } from '../src/tasks/runner';
import { GameScanService } from '../src/pipelines/game-scan';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function claudeJson(j: unknown) { const f = path.join(tmp('ccgs-cj-'), '.claude.json'); fs.writeFileSync(f, JSON.stringify(j)); return f; }
const http8080 = { type: 'http', url: 'http://127.0.0.1:8080/mcp' };

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
function serve(h: http.RequestListener): Promise<string> {
  const s = http.createServer(h);
  servers.push(s);
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`)));
}
const INIT = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mcp-for-unity-server', version: '9.0.1' } } };

describe('unity mcp config', () => {
  it('follows Claude Code precedence: local > project .mcp.json > user; prefers the name UnityMCP', () => {
    const project = tmp('ccgs-game-');
    const fwd = project.replace(/\\/g, '/');
    expect(findUnityMcp(project, claudeJson({ mcpServers: { other: {}, UnityMCP: http8080 } }))).toMatchObject({ name: 'UnityMCP', scope: 'user', type: 'http', url: http8080.url });
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { 'unity-mcp': { command: 'uvx', args: [] } } }));
    expect(findUnityMcp(project, claudeJson({ mcpServers: { UnityMCP: http8080 } }))).toMatchObject({ name: 'unity-mcp', scope: 'project', type: 'stdio', command: 'uvx' });
    expect(findUnityMcp(project, claudeJson({ mcpServers: { UnityMCP: http8080 }, projects: { [fwd.toUpperCase()]: { mcpServers: { UnityMCP: { type: 'http', url: 'http://localhost:9000/mcp' } } } } })))
      .toMatchObject({ scope: 'local', url: 'http://localhost:9000/mcp' });
    expect(findUnityMcp(null, claudeJson({}))).toBeNull();
    expect(findUnityMcp(null, path.join(tmp('ccgs-none-'), 'missing.json'))).toBeNull();
    expect(isLoopback('http://127.0.0.1:8080/mcp')).toBe(true);
    expect(isLoopback('http://10.0.0.5:8080/mcp')).toBe(false);
  });

  it('doctor line: missing -> false, stdio or remote -> unknown (no call), http -> probed', async () => {
    let called = 0;
    const probe = async () => { called++; return { ok: false, detail: 'refused.' }; };
    expect(await unityMcpCheck(null, { claudeJson: claudeJson({}), probe })).toMatchObject({ id: 'unity-mcp', ok: false, detail: expect.stringMatching(/chưa khai báo/) });
    expect(await unityMcpCheck(null, { claudeJson: claudeJson({ mcpServers: { UnityMCP: { command: 'uvx' } } }), probe })).toMatchObject({ ok: null });
    expect(await unityMcpCheck(null, { claudeJson: claudeJson({ mcpServers: { UnityMCP: { type: 'http', url: 'http://10.1.2.3/mcp' } } }), probe })).toMatchObject({ ok: null });
    expect(called).toBe(0);
    const r = await unityMcpCheck(null, { claudeJson: claudeJson({ mcpServers: { UnityMCP: http8080 } }), probe });
    expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/UnityMCP, scope user: refused\. Mở Unity Editor/) });
    expect(called).toBe(1);
  });
});

describe('unity mcp http probe', () => {
  it('answers in JSON or SSE; closes the session it opened', async () => {
    let deleted = '';
    const json = await serve((req, res) => {
      if (req.method === 'DELETE') { deleted = String(req.headers['mcp-session-id']); res.end(); return; }
      res.setHeader('content-type', 'application/json'); res.setHeader('mcp-session-id', 'abc'); res.end(JSON.stringify(INIT));
    });
    expect(await httpProbe(json, 2000)).toMatchObject({ ok: true, detail: expect.stringMatching(/mcp-for-unity-server 9\.0\.1/) });
    await new Promise(r => setTimeout(r, 50));
    expect(deleted).toBe('abc');
    const sse = await serve((_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write(`event: message\ndata: ${JSON.stringify(INIT)}\n\n`); }); // stream stays open
    expect(await httpProbe(sse, 500)).toMatchObject({ ok: true, instances: undefined });
  });

  it('MCP for Unity: reads the connected Unity Editors (mcpforunity://instances), calls no tool', async () => {
    const methods: string[] = [];
    let editors: unknown[] = [{ id: 'Meodoku@39529b', name: 'Meodoku', unity_version: '6000.0.81f1' }];
    const url = await serve((req, res) => {
      let b = '';
      req.on('data', d => { b += d; });
      req.on('end', () => {
        if (req.method === 'DELETE') { res.end(); return; }
        const m = JSON.parse(b);
        methods.push(m.method);
        if (m.id === undefined) { res.statusCode = 202; res.end(); return; }
        res.setHeader('content-type', 'text/event-stream'); res.setHeader('mcp-session-id', 's1');
        const result = m.method === 'initialize' ? INIT.result
          : { contents: [{ uri: 'mcpforunity://instances', text: JSON.stringify({ success: true, instance_count: editors.length, instances: editors }) }] };
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
      });
    });
    expect(await httpProbe(url, 2000)).toMatchObject({ ok: true, instances: [{ name: 'Meodoku', unityVersion: '6000.0.81f1' }] });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'resources/read']);
    const cj = claudeJson({ mcpServers: { UnityMCP: { type: 'http', url } } });
    const game = path.join(tmp('ccgs-g-'), 'Meodoku');
    expect(await unityMcpCheck(game, { claudeJson: cj })).toMatchObject({ ok: true, detail: expect.stringMatching(/Unity Editor đang nối: Meodoku \(6000\.0\.81f1\)/) });
    expect(await unityMcpCheck(path.join(tmp('ccgs-g-'), 'HexaSort'), { claudeJson: cj })).toMatchObject({ ok: null, detail: expect.stringMatching(/Không thấy project "HexaSort"/) });
    editors = [];
    expect(await unityMcpCheck(game, { claudeJson: cj })).toMatchObject({ ok: false, detail: expect.stringMatching(/chưa có Unity Editor nào nối vào/) });
  });

  it('refused, silent and HTTP errors are failures with a readable reason', async () => {
    const closed = await serve(() => undefined);
    const silent = await serve(() => undefined); // never answers
    const s = servers[servers.length - 2]; await new Promise(r => s.close(r));
    expect(await httpProbe(closed, 2000)).toMatchObject({ ok: false, detail: expect.stringMatching(/Không kết nối được/) });
    expect(await httpProbe(silent, 200)).toMatchObject({ ok: false, detail: expect.stringMatching(/không trả lời sau 0\.2 giây/) });
    const bad = await serve((_req, res) => { res.statusCode = 404; res.end('nope'); });
    expect(await httpProbe(bad, 2000)).toMatchObject({ ok: false, detail: expect.stringMatching(/HTTP 404/) });
  });
});

describe('game scan checks Unity MCP first', () => {
  function scanSetup(ok: boolean | null) {
    const runner: Runner = () => ({ done: new Promise(() => undefined), pid: () => null, stop: async () => undefined });
    const q = new TaskQueue({ db: openDb(':memory:'), runner, project: () => 'x', snapshot: async () => new Map(), sessionExists: () => true });
    const game = tmp('ccgs-game-');
    const gs = new GameScanService({ home: tmp('ccgs-home-'), queue: q, project: () => game, unityCheck: async () => ({ id: 'unity-mcp', label: 'Unity MCP', ok, detail: 'Không kết nối được http://127.0.0.1:8080/mcp.' }) });
    return { gs, q };
  }
  it('refuses without creating a task when Unity MCP does not answer', async () => {
    const { gs, q } = scanSetup(false);
    await expect(gs.startChecked()).rejects.toThrow(/Unity MCP không sẵn sàng.*8080/);
    expect(q.list({ limit: 10 })).toHaveLength(0);
    expect(gs.get().status).toBe('none');
  });
  it('scans when it answers, or when Studio cannot tell (stdio, remote)', async () => {
    for (const ok of [true, null]) {
      const { gs, q } = scanSetup(ok);
      expect((await gs.startChecked()).status).toBe('running');
      expect(q.list({ limit: 10 })).toHaveLength(1);
    }
  });
});
