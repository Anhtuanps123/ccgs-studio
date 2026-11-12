import 'reflect-metadata';
import { studioSkills } from './studio-plugin';
import { Module, OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import fs from 'node:fs';
import path from 'node:path';
import { SettingsService } from './settings/settings.service';
import { CcgsAdapterService } from './ccgs/adapter.service';
import { CcgsController } from './ccgs/ccgs.controller';
import { SkillGuideService } from './ccgs/skill-guide';
import { SystemController, forgetClaudeVersion, projectInfo } from './system/system.controller';
import { SetupController } from './system/setup.controller';
import { SetupService } from './system/packages';
import { LiveGateway } from './live/live.gateway';
import { originGuard } from './security/origin';
import { MonitorService } from './monitor/monitor.service';
import { IngestController, MonitorController } from './monitor/monitor.controller';
import { HooksController } from './hooks/hooks.controller';
import { HookInstaller } from './hooks/hook-installer';
import { TaskQueue } from './tasks/task-queue';
import { TasksController } from './tasks/tasks.controller';
import { AttachmentStore } from './tasks/attachments';
import { AttachmentsController } from './tasks/attachments.controller';
import { sdkRunner } from './tasks/runner';
import { studioOutputDir } from './tasks/outputs';
import { contextModeDir } from './context-mode';
import { baseRef, takeSnapshot, taskDiffs } from './tasks/git-snapshot';
import { summarizeInput } from './monitor/projector';
import { configureRedaction } from './monitor/redact';
import { InsightsController, PhoenixExporter } from './insights/insights.controller';
import { PipelineService } from './pipelines/pipeline.service';
import { GameScanService } from './pipelines/game-scan';
import { unityMcpCheck } from './system/unity-mcp';
import { ScanController } from './pipelines/scan.controller';
import { PipelinesController } from './pipelines/pipelines.controller';
import { AlertsController } from './system/alerts.controller';
import { GraphService } from './graph/graph.service';
import { GraphController } from './graph/graph.controller';

const PORT = Number(process.env.PORT ?? 4310);

@Module({
  controllers: [CcgsController, SystemController, IngestController, MonitorController, HooksController, TasksController, InsightsController, PipelinesController, ScanController, AlertsController, GraphController, SetupController, AttachmentsController],
  providers: [
    SettingsService, CcgsAdapterService, LiveGateway, MonitorService,
    { provide: AttachmentStore, inject: [SettingsService], useFactory: (s: SettingsService) => new AttachmentStore(path.join(s.dir, 'attachments')) },
    {
      provide: HookInstaller,
      inject: [SettingsService],
      useFactory: (s: SettingsService) => new HookInstaller(s.dir, path.resolve(__dirname, '../hook/ccgs-studio-hook.mjs'), PORT),
    },
    {
      provide: TaskQueue,
      inject: [SettingsService, MonitorService, HookInstaller, AttachmentStore],
      useFactory: (s: SettingsService, m: MonitorService, h: HookInstaller, att: AttachmentStore) => {
        const project = () => { const p = s.get().projectPath; return p && projectInfo(p).valid ? p : null; };
        return new TaskQueue({
          db: m.db, project, snapshot: takeSnapshot, baseRef, diffs: taskDiffs, attachments: att, outputsDir: id => studioOutputDir(s.dir, id),
          defaults: () => s.get().taskDefaults, sessionExists: id => !!m.getSession(id),
          autoAllow: {
            has: tool => tool !== 'AskUserQuestion' && (s.get().autoAllow ?? []).some(x => x === '*' || x === tool),
            add: tool => { const cur = s.get().autoAllow ?? []; if (!cur.includes(tool)) s.update({ autoAllow: [...cur, tool] }); },
          },
          runner: sdkRunner({ cwd: () => project() ?? process.cwd(), settingsFile: h.studioSettingsFile(), summarize: (t, i) => summarizeInput(t, i, project()),
            plugins: () => { const d = s.get().contextMode ? contextModeDir() : null; return d ? [d] : []; },
            outputsDir: id => studioOutputDir(s.dir, id) }),
        });
      },
    },
    {
      provide: GameScanService,
      inject: [TaskQueue, SettingsService],
      useFactory: (q: TaskQueue, st: SettingsService) => {
        const project = () => { const p = st.get().projectPath; return p && projectInfo(p).valid ? p : null; };
        return new GameScanService({ home: st.dir, queue: q, project, unityCheck: () => unityMcpCheck(project()) });
      },
    },
    {
      provide: GraphService,
      inject: [TaskQueue, SettingsService, MonitorService],
      useFactory: (q: TaskQueue, st: SettingsService, m: MonitorService) => new GraphService({
        home: st.dir, tasks: q.bus, settings: () => st.get().graphify,
        project: () => { const p = st.get().projectPath; return p && projectInfo(p).valid ? p : null; },
        log: (lvl, msg) => m.log(lvl, 'studio', msg),
      }),
    },
    {
      provide: PipelineService,
      inject: [MonitorService, TaskQueue, CcgsAdapterService, SettingsService, GameScanService, GraphService, AttachmentStore],
      useFactory: (m: MonitorService, q: TaskQueue, a: CcgsAdapterService, st: SettingsService, gs: GameScanService, g: GraphService, att: AttachmentStore) => new PipelineService({
        db: m.db, queue: q, scan: () => gs.get(), graph: g, attachments: att,
        project: () => { const p = st.get().projectPath; return p && projectInfo(p).valid ? p : null; },
        skills: () => (a.snapshot?.skills ?? []).filter(s => s.hasSkillMd && s.userInvocable !== false)
          .map(s => ({ name: s.name, description: s.description, argumentHint: s.argumentHint })).concat(studioSkills()),
      }),
    },
    {
      provide: SetupService,
      inject: [SettingsService],
      useFactory: (st: SettingsService) => new SetupService({
        claudeCommand: () => st.get().claudeCommand,
        unityCheck: () => { const p = st.get().projectPath; return unityMcpCheck(p && projectInfo(p).valid ? p : null); },
        onInstalled: id => { if (id === 'claude') forgetClaudeVersion(); },
      }),
    },
    {
      provide: SkillGuideService,
      inject: [MonitorService, TaskQueue, CcgsAdapterService],
      useFactory: (m: MonitorService, q: TaskQueue, a: CcgsAdapterService) => new SkillGuideService({
        db: m.db, queue: q, skills: () => a.snapshot?.skills ?? null, workflows: () => a.snapshot?.workflows ?? [], root: () => a.projectRoot,
      }),
    },
    { provide: PhoenixExporter, inject: [MonitorService, SettingsService], useFactory: (m: MonitorService, s: SettingsService) => new PhoenixExporter(m, s) },
  ],
})
class AppModule implements OnModuleInit {
  constructor(
    private readonly settings: SettingsService,
    private readonly adapter: CcgsAdapterService,
    private readonly live: LiveGateway,
    private readonly monitor: MonitorService,
    private readonly installer: HookInstaller,
    private readonly tasks: TaskQueue,
    private readonly phoenix: PhoenixExporter,
    private readonly pipelines: PipelineService,
    private readonly scan: GameScanService,
    private readonly graph: GraphService,
    private readonly setup: SetupService,
  ) {}

  async onModuleInit() {
    const p = this.settings.get().projectPath;
    if (p && projectInfo(p).valid) await this.adapter.open(p);
    this.adapter.events.on('changed', kinds => this.live.emitConfigChanged(kinds));
    // Keep the installed hook client current and the token/port file in place.
    try { this.installer.ensureScript(); } catch (e) { this.monitor.log('error', 'studio', `Không chuẩn bị được hook client: ${(e as Error).message}`); }
    const b = this.monitor.bus;
    b.on('session', x => this.live.emit('session:upsert', x));
    b.on('invocation', x => this.live.emit('invocation:upsert', x));
    b.on('toolcall', x => this.live.emit('toolcall:upsert', x));
    b.on('event', x => this.live.emit('event:new', x));
    b.on('log', x => this.live.emit('log:new', x));
    b.on('cleared', x => this.live.emit('monitor:cleared', x));
    const t = this.tasks.bus;
    t.on('task', x => this.live.emit('task:upsert', x));
    t.on('removed', ids => this.live.emit('task:delete', { ids }));
    t.on('interaction', x => this.live.emit('interaction:new', x));
    t.on('resolved', x => this.live.emit('interaction:resolved', x));
    t.on('log', (lvl, msg, sid) => this.monitor.log(lvl, 'studio', msg, sid));
    this.tasks.recover();
    this.pipelines.bus.on('pipeline', x => this.live.emit('pipeline:upsert', x));
    this.pipelines.bus.on('removed', id => this.live.emit('pipeline:delete', { id }));
    this.scan.bus.on('scan', x => this.live.emit('scan:upsert', x));
    this.graph.bus.on('graph', x => this.live.emit('graph:upsert', x));
    this.setup.bus.on('job', x => {
      this.live.emit('setup:job', x);
      if (x.status === 'completed' && x.packageId === 'claude') this.live.emitConfigChanged(['hooks']); // sidebar re-reads the Claude version
      if (x.status !== 'running') this.monitor.log(x.status === 'completed' ? 'info' : 'warn', 'studio', `Cài ${x.label}: ${x.status}${x.exitCode !== null ? ` (mã ${x.exitCode})` : ''}`);
    });
    this.pipelines.bus.on('log', (lvl, msg) => this.monitor.log(lvl, 'studio', msg));
    this.pipelines.recover();

    // S-04 / S-05: redaction config and retention follow the settings.
    const applySettings = () => {
      const st = this.settings.get();
      configureRedaction({ patterns: st.redactPatterns, maxPayloadKB: st.retention.maxPayloadKB });
    };
    applySettings();
    this.settings.events.on('changed', applySettings);
    const purge = () => {
      const days = this.settings.get().retention.days;
      if (!days) return;
      try {
        const r = this.monitor.purge(days);
        if (r.sessions || r.logs) this.monitor.log('info', 'studio', `Dọn dữ liệu cũ hơn ${days} ngày: ${r.sessions} session, ${r.events} event, ${r.logs} log.`);
      } catch (e) { this.monitor.log('error', 'studio', `Dọn dữ liệu lỗi: ${(e as Error).message}`); }
    };
    purge();
    setInterval(purge, 3600_000).unref();

    // P1 spool: events written by the hook while the backend was down.
    const spool = path.join(this.settings.dir, 'spool.jsonl');
    const loadSpool = () => { try { this.monitor.ingestSpool(spool); } catch (e) { this.monitor.log('error', 'studio', `Nạp spool lỗi: ${(e as Error).message}`); } };
    loadSpool();
    setInterval(loadSpool, 30_000).unref();

    // S-06: send each finished task's session to Phoenix when enabled (hook events trail the SDK result a little).
    t.on('task', x => {
      if (!['completed', 'failed', 'cancelled'].includes(x.status) || !x.sessionId || !this.settings.get().phoenix.enabled) return;
      setTimeout(() => { void this.phoenix.exportSession(x.sessionId!); }, 3000);
    });
  }
}

/** Resolves /prototypes/... inside the project; null when outside it or missing. */
export function previewFile(project: string, rel: string): string | null {
  const root = path.resolve(project, 'prototypes');
  const f = path.resolve(root, '.' + path.posix.normalize('/' + rel.replace(/^\/+(prototypes\/)?/, '')));
  if (f !== root && !f.startsWith(root + path.sep)) return null;
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'], bodyParser: false });
  app.useBodyParser('json', { limit: '20mb' }); // PostToolUse can carry whole files
  app.use(originGuard);
  // Prototype preview: files under <project>/prototypes/ only, sandboxed (opaque origin) so their scripts cannot call /api.
  const st = app.get(SettingsService);
  app.use('/preview', (req: any, res: any) => {
    const proj = st.get().projectPath;
    const f = proj ? previewFile(proj, decodeURIComponent(req.path)) : null;
    if (!f) { res.status(404).send('Không có file prototype này'); return; }
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(f);
  });
  // Serve the built web app when present (npm start); in dev Vite proxies to us.
  const web = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(web)) {
    app.useStaticAssets(web);
    app.use((req: any, res: any, next: any) =>
      req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')
        ? res.sendFile(path.join(web, 'index.html')) : next());
  }
  const port = PORT;
  await app.listen(port, '127.0.0.1');
  console.log(`CCGS Studio server: http://127.0.0.1:${port}`);
}
bootstrap();
