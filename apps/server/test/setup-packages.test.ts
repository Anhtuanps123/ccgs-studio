import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFS, SetupError, SetupService, commandText, outputLines, type Exec } from '../src/system/packages';

const VERSIONS: Record<string, string> = { claude: '2.1.321 (Claude Code)', git: 'git version 2.55.0.windows.1', uv: 'uv 0.13.5 (46776a95d)', graphify: 'graphify 0.9.103' };

function fakeExec(missing: string[] = []): Exec {
  return async (cmd, args) => {
    const name = cmd.endsWith('vswhere.exe') ? 'vswhere' : cmd;
    if (missing.includes(name)) return { ok: false, out: '', error: `'${name}' is not recognized` };
    if (name === 'claude' && args[0] === 'auth') return { ok: true, out: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), error: null };
    if (name === 'vswhere') return { ok: true, out: '17.14.37 (July 2026)\r\n', error: null };
    return { ok: true, out: VERSIONS[name] ?? '', error: null };
  };
}

function fakeChild() {
  const c = new EventEmitter() as ChildProcess & EventEmitter;
  (c as any).stdout = new PassThrough();
  (c as any).stderr = new PassThrough();
  return c;
}

function svc(o: { missing?: string[]; platform?: string } = {}) {
  const spawned: { cmd: string; args: string[]; child: ReturnType<typeof fakeChild> }[] = [];
  const installed: string[] = [];
  const s = new SetupService({
    claudeCommand: () => 'claude',
    unityCheck: async () => ({ id: 'unity-mcp', label: 'Unity MCP', ok: null, detail: 'Unity chưa mở.' }),
    platform: o.platform ?? 'win32',
    exec: fakeExec(o.missing),
    spawn: (cmd, args) => { const child = fakeChild(); spawned.push({ cmd, args, child }); return child; },
    refreshPath: async () => {},
    onInstalled: id => installed.push(id),
  });
  return { s, spawned, installed };
}

const flush = () => new Promise(r => setTimeout(r, 10));

describe('setup packages', () => {
  it('state: versions, levels, fixed commands, graphify blocked until uv is there', async () => {
    const { s } = svc({ missing: ['uv', 'graphify'] });
    const st = await s.state();
    const by = Object.fromEntries(st.packages.map(p => [p.id, p]));
    expect(st.packages.map(p => p.id)).toEqual(DEFS.map(d => d.id));
    expect(by.node).toMatchObject({ installed: true, version: process.versions.node, install: null });
    expect(by.claude).toMatchObject({ installed: true, version: '2.1.321', level: 'required' });
    expect(by.claude.install?.command).toBe('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
    expect(by.login).toMatchObject({ installed: true, action: 'login', install: null });
    expect(by['unity-mcp']).toMatchObject({ installed: null, install: null });
    expect(by.git).toMatchObject({ installed: true, version: '2.55.0' });
    expect(by.vsbuild).toMatchObject({ installed: true, version: '17.14.37' });
    expect(by.vsbuild.install?.confirm).toMatch(/vài GB/);
    expect(by.uv).toMatchObject({ installed: false, version: null });
    expect(by.graphify.install).toMatchObject({ blockedBy: 'Cài uv trước', command: 'uv tool install --force graphifyy[mcp]==0.9.103' });
    expect(by.uv.install?.blockedBy).toBeNull();
  });

  it('not Windows: no install buttons', async () => {
    const { s } = svc({ platform: 'linux' });
    expect((await s.state()).packages.every(p => p.install === null)).toBe(true);
    await expect(s.install('git')).rejects.toThrow(/không tự cài/);
  });

  it('refuses unknown ids, things Studio cannot install, and a missing dependency', async () => {
    const { s, spawned } = svc({ missing: ['uv'] });
    await expect(s.install('rm -rf')).rejects.toMatchObject({ status: 400 });
    await expect(s.install('node')).rejects.toThrow(/không tự cài/);
    await expect(s.install('unity-mcp')).rejects.toBeInstanceOf(SetupError);
    await expect(s.install('graphify')).rejects.toThrow('Cài uv trước');
    expect(spawned).toHaveLength(0);
  });

  it('runs one install at a time, streams cleaned output, then reports success', async () => {
    const { s, spawned, installed } = svc();
    const events: string[] = [];
    s.bus.on('job', j => events.push(j.status));
    const job = await s.install('git');
    expect(job).toMatchObject({ packageId: 'git', status: 'running', command: commandText(DEFS.find(d => d.id === 'git')!.install!) });
    expect(spawned[0]).toMatchObject({ cmd: 'winget', args: expect.arrayContaining(['install', '--id', 'Git.Git']) });
    await expect(s.install('uv')).rejects.toMatchObject({ status: 409 });
    expect((await s.state()).packages.find(p => p.id === 'uv')!.install!.blockedBy).toMatch(/Đang cài/);

    spawned[0].child.stdout!.write('\x1b[32mFound Git [Git.Git]\x1b[0m\r\n  -\r  \\\r\n  ██████▒▒▒  50%\r\nSuccessfully installed\r\n');
    await flush();
    spawned[0].child.emit('close', 0);
    await flush();
    const j = s.current()!;
    expect(j.status).toBe('completed');
    expect(j.exitCode).toBe(0);
    expect(j.log).toEqual([`> ${job.command}`, 'Found Git [Git.Git]', 'Successfully installed', 'Xong.']);
    expect(installed).toEqual(['git']);
    expect(events[0]).toBe('running');
    expect(events.at(-1)).toBe('completed');
    await expect(s.install('uv')).resolves.toMatchObject({ status: 'running' }); // free again
  });

  it('non-zero exit fails; cancel marks cancelled; onInstalled only on success', async () => {
    const { s, spawned, installed } = svc();
    await s.install('uv');
    spawned[0].child.emit('close', 1);
    expect(s.current()).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(s.current()!.log.at(-1)).toMatch(/mã thoát 1/);
    expect(() => s.cancel()).toThrow(/Không có lệnh cài/);

    await s.install('claude');
    s.cancel();
    spawned[1].child.emit('close', 1);
    expect(s.current()).toMatchObject({ status: 'cancelled' });
    expect(installed).toEqual([]);
  });

  it('spawn error fails the job', async () => {
    const { s, spawned } = svc();
    await s.install('git');
    spawned[0].child.emit('error', new Error('spawn winget ENOENT'));
    expect(s.current()).toMatchObject({ status: 'failed' });
    expect(s.current()!.log).toContain('Lỗi: spawn winget ENOENT');
  });

  it('outputLines keeps the last \\r state and drops spinners', () => {
    expect(outputLines('a\r\nDownloading 10%\rDownloading 100%\n|\n/\n\n  ▒▒▒▒ 1 MB / 2 MB\nok')).toEqual(['a', 'Downloading 100%', 'ok']);
  });
});
