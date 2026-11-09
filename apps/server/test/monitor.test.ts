import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redact, redactString, REDACTED } from '../src/monitor/redact';
import { HookInstaller, HashMismatch, hasStudioHooks, HOOK_EVENTS } from '../src/hooks/hook-installer';

process.env.CCGS_STUDIO_DB = ':memory:';
// Imported after the env var so each service gets an in-memory DB.
const { MonitorService } = await import('../src/monitor/monitor.service');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-mon-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('redact', () => {
  it('removes common secrets before storage', () => {
    const s = 'export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf123456789xyz && curl -H "Authorization: Bearer abcdefghijklmnop1234" ghp_abcdefghijklmnopqrstuvwxyz012345 AKIAABCDEFGHIJKLMNOP';
    const r = redactString(s);
    for (const secret of ['sk-ant-api03-AbCdEf123456789xyz', 'abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwxyz012345', 'AKIAABCDEFGHIJKLMNOP']) expect(r).not.toContain(secret);
    expect(redactString('password=hunter2hunter2')).toBe(`password=${REDACTED}`);
    expect(redactString('đọc file README.md')).toBe('đọc file README.md');
  });
  it('walks objects, redacts secret-named fields and caps long strings', () => {
    const o = redact({ tool_input: { command: 'echo sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA', token: 'x1' }, big: 'a'.repeat(9000), n: 3 });
    expect(JSON.stringify(o)).not.toContain('sk-proj-AAAA');
    expect(o.tool_input.token).toBe(REDACTED);
    expect(o.big.length).toBeLessThan(8300);
    expect(o.n).toBe(3);
  });
});

// Event helpers shaped like the captured payloads in docs/evidence/hook-payloads.md.
let clock = Date.parse('2026-11-09T10:00:00.000Z');
const at = (dt = 0) => new Date((clock += dt)).toISOString();
function mk(svc: InstanceType<typeof MonitorService>, sid: string) {
  const send = (dt: number, payload: Record<string, unknown>) =>
    svc.ingest({ v: 1, receivedAt: at(dt), taskId: null, origin: 'local-settings', payload: { session_id: sid, cwd: 'd:\\Meodoku', transcript_path: 'x.jsonl', ...payload } });
  return {
    send,
    pre: (dt: number, tool: string, id: string, input: object, agent?: [string, string]) =>
      send(dt, { hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: input, ...(agent ? { agent_id: agent[0], agent_type: agent[1] } : {}) }),
    post: (dt: number, tool: string, id: string, response: object, agent?: [string, string]) =>
      send(dt, { hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: id, tool_response: response, ...(agent ? { agent_id: agent[0], agent_type: agent[1] } : {}) }),
  };
}

describe('projector', () => {
  let svc: InstanceType<typeof MonitorService>;
  beforeEach(() => { svc = new MonitorService({ dir: tmp } as any); });

  it('builds 2 subagent invocations from a skill run, fixing a wrong provisional link', () => {
    const s = mk(svc, 's2');
    s.send(0, { hook_event_name: 'SessionStart', source: 'startup' });
    s.send(100, { hook_event_name: 'UserPromptSubmit', prompt: '/review-all' });
    s.pre(1000, 'Agent', 'tu_A', { subagent_type: 'qa-tester', description: 'Check A', prompt: 'do A' });
    s.pre(10, 'Agent', 'tu_B', { subagent_type: 'qa-tester', description: 'Check B', prompt: 'do B' });
    // B's subagent starts first: provisional match pairs it with tu_A (oldest), PostToolUse corrects it.
    s.send(50, { hook_event_name: 'SubagentStart', agent_id: 'agB', agent_type: 'qa-tester' });
    s.send(30, { hook_event_name: 'SubagentStart', agent_id: 'agA', agent_type: 'qa-tester' });
    s.pre(200, 'Read', 'tu_r1', { file_path: 'd:\\Meodoku\\project.yaml' }, ['agA', 'qa-tester']);
    s.post(20, 'Read', 'tu_r1', { file: { numLines: 28, totalLines: 28 } }, ['agA', 'qa-tester']);
    s.send(3000, { hook_event_name: 'SubagentStop', agent_id: 'agB', agent_type: 'qa-tester', last_assistant_message: 'B ok' });
    s.post(5, 'Agent', 'tu_B', { status: 'completed', agentId: 'agB', content: [{ type: 'text', text: 'B ok' }] });
    s.send(2000, { hook_event_name: 'SubagentStop', agent_id: 'agA', agent_type: 'qa-tester', last_assistant_message: 'A ok' });
    s.post(5, 'Agent', 'tu_A', { status: 'completed', agentId: 'agA', content: [{ type: 'text', text: 'A ok' }] });
    s.send(500, { hook_event_name: 'Stop', last_assistant_message: 'Done' });

    const inv = svc.invocations('s2');
    const sub = inv.filter(i => i.agentType !== 'main');
    expect(sub).toHaveLength(2);
    const A = sub.find(i => i.id === 'agA')!, B = sub.find(i => i.id === 'agB')!;
    expect(A).toMatchObject({ toolUseId: 'tu_A', description: 'Check A', status: 'completed', parentInvocationId: 'main:s2', depth: 1, output: 'A ok', durationMs: 5225 });
    expect(B).toMatchObject({ toolUseId: 'tu_B', description: 'Check B', status: 'completed', durationMs: 3250 });
    expect(svc.getSession('s2')).toMatchObject({ external: true, firstPrompt: '/review-all' });
    const read = svc.toolcalls('s2').find(c => c.id === 'tu_r1')!;
    expect(read).toMatchObject({ invocationId: 'agA', inputSummary: 'project.yaml', status: 'completed', outputSummary: '28 dòng / 28' });

    const conv = svc.conversation('s2');
    expect(conv.map(c => c.kind)).toEqual(['user', 'tool', 'tool', 'assistant']);
    expect(svc.timeline('s2').filter(t => t.kind === 'invocation')).toHaveLength(3);
  });

  it('handles nested subagents, waiting on permission, failures and interrupt', () => {
    const s = mk(svc, 's3');
    s.send(0, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    s.pre(10, 'Agent', 'tu_1', { subagent_type: 'unity-specialist', description: 'outer' });
    s.send(10, { hook_event_name: 'SubagentStart', agent_id: 'outer', agent_type: 'unity-specialist' });
    s.pre(10, 'Agent', 'tu_2', { subagent_type: 'unity-ui-specialist', description: 'inner' }, ['outer', 'unity-specialist']);
    s.send(10, { hook_event_name: 'SubagentStart', agent_id: 'inner', agent_type: 'unity-ui-specialist' });
    s.pre(10, 'Write', 'tu_w', { file_path: 'a.txt' }, ['inner', 'unity-ui-specialist']);
    s.send(10, { hook_event_name: 'PermissionRequest', tool_name: 'Write', agent_id: 'inner', agent_type: 'unity-ui-specialist' });
    expect(svc.invocations('s3').find(i => i.id === 'inner')!.status).toBe('waiting');
    s.send(10, { hook_event_name: 'PostToolUseFailure', tool_name: 'Write', tool_use_id: 'tu_w', error: 'disk full', agent_id: 'inner', agent_type: 'unity-ui-specialist' });
    expect(svc.invocations('s3').find(i => i.id === 'inner')).toMatchObject({ status: 'running', depth: 2, parentInvocationId: 'outer' });
    expect(svc.toolcalls('s3').find(c => c.id === 'tu_w')).toMatchObject({ status: 'failed', error: 'disk full' });
    // Interrupt: no Stop / PostToolUse, only SessionEnd.
    s.send(10, { hook_event_name: 'SessionEnd', reason: 'other' });
    const inv = svc.invocations('s3');
    expect(inv.every(i => i.status === 'unknown')).toBe(true);
    expect(svc.toolcalls('s3').filter(c => c.status === 'running')).toHaveLength(0);
    expect(svc.logs({ session: 's3' }).items.some(l => l.level === 'warn' && l.message.includes('disk full'))).toBe(true);
  });

  it('stores redacted payloads only', () => {
    const s = mk(svc, 's4');
    s.pre(0, 'Bash', 'tu_b', { command: 'curl -H "x-api-key: sk-ant-api03-SECRETSECRETSECRET" https://api.anthropic.com' });
    const dump = JSON.stringify(svc.db.$client.prepare('SELECT * FROM events').all()) + JSON.stringify(svc.db.$client.prepare('SELECT * FROM toolcalls').all());
    expect(dump).not.toContain('SECRETSECRETSECRET');
  });
});

describe('hook installer', () => {
  const home = path.join(tmp, 'home');
  const script = path.resolve(__dirname, '../hook/ccgs-studio-hook.mjs');
  const inst = new HookInstaller(home, script, 4310);
  const proj = (name: string) => { const p = path.join(tmp, name); fs.mkdirSync(path.join(p, '.claude'), { recursive: true }); return p; };

  it('install then uninstall restores the exact original bytes', () => {
    const p = proj('p1');
    const f = path.join(p, '.claude', 'settings.local.json');
    const original = '{\r\n    "permissions": { "allow": ["Bash(ls:*)"] },\r\n    "hooks": { "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "echo hi" } ] } ] }\r\n}';
    fs.writeFileSync(f, original);
    const pv = inst.preview(p, 'install');
    expect(pv.diff.some(d => d.op === 'add')).toBe(true);
    expect(() => inst.apply(p, 'install', 'wrong')).toThrow(HashMismatch);
    inst.apply(p, 'install', pv.hash);
    const json = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(hasStudioHooks(json)).toBe(true);
    expect(Object.keys(json.hooks)).toHaveLength(HOOK_EVENTS.length);
    expect(json.hooks.Stop[0].hooks[0].command).toBe('echo hi'); // user hook kept, ours appended
    const un = inst.preview(p, 'uninstall');
    inst.apply(p, 'uninstall', un.hash);
    expect(fs.readFileSync(f, 'utf8')).toBe(original);
  });

  it('removes the file again when it did not exist before', () => {
    const p = proj('p2');
    const f = path.join(p, '.claude', 'settings.local.json');
    inst.apply(p, 'install', inst.preview(p, 'install').hash);
    expect(fs.existsSync(f)).toBe(true);
    inst.apply(p, 'uninstall', inst.preview(p, 'uninstall').hash);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('keeps user edits made after install', () => {
    const p = proj('p3');
    const f = path.join(p, '.claude', 'settings.local.json');
    inst.apply(p, 'install', inst.preview(p, 'install').hash);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.permissions = { allow: ['Read'] };
    fs.writeFileSync(f, JSON.stringify(j));
    inst.apply(p, 'uninstall', inst.preview(p, 'uninstall').hash);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ permissions: { allow: ['Read'] } });
  });
});

describe('hook client', () => {
  it('exits 0 quickly with empty stdout when the backend is down', () => {
    const home = path.join(tmp, 'hc');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'hook.json'), JSON.stringify({ token: 't', port: 4999 })); // nothing listens there
    const script = path.resolve(__dirname, '../hook/ccgs-studio-hook.mjs');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [script, 'local'], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'x' }), env: { ...process.env, CCGS_STUDIO_HOME: home }, timeout: 5000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
