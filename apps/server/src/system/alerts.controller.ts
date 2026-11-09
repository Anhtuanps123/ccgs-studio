import { Controller, Get, Query } from '@nestjs/common';
import type { AlertKey, NavAlerts } from '@ccgs/shared';
import { SettingsService } from '../settings/settings.service';
import { CcgsAdapterService } from '../ccgs/adapter.service';
import { MonitorService } from '../monitor/monitor.service';
import { TaskQueue } from '../tasks/task-queue';
import { PipelineService } from '../pipelines/pipeline.service';
import { GameScanService } from '../pipelines/game-scan';
import { projectInfo } from './system.controller';

/** Keys whose count is "new since the user last opened that page" (history), not current state. */
export const SINCE_KEYS: AlertKey[] = ['tasks', 'pipelines', 'agent-monitor', 'tool-activity', 'logs'];
const DAY = 24 * 3600_000;

/** ISO time from the query, or the last 24h when missing/invalid. */
export function sinceOf(v: unknown, now = Date.now()): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return new Date(Number.isFinite(t) ? t : now - DAY).toISOString();
}

const add = (a: NavAlerts, k: AlertKey, n: number, why: string) => {
  if (n <= 0) return;
  const cur = a[k] ?? { count: 0, reasons: [] };
  a[k] = { count: cur.count + n, reasons: [...cur.reasons, `${n} ${why}`] };
};

/** GET /api/alerts?tasks=ISO&logs=ISO… — counts per sidebar item; read-only. */
@Controller('api')
export class AlertsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly adapter: CcgsAdapterService,
    private readonly monitor: MonitorService,
    private readonly tasks: TaskQueue,
    private readonly pipelines: PipelineService,
    private readonly scan: GameScanService,
  ) {}

  @Get('alerts') alerts(@Query() q: Record<string, string>): NavAlerts {
    const a: NavAlerts = {};
    const since = Object.fromEntries(SINCE_KEYS.map(k => [k, sinceOf(q[k])])) as Record<AlertKey, string>;
    const c = this.monitor.db.$client;
    const n = (sql: string, ...p: unknown[]) => Number((c.prepare(sql).get(...p) as any)?.n ?? 0);

    const proj = projectInfo(this.settings.get().projectPath);
    add(a, 'projects', proj.path ? proj.checks.filter(x => !x.ok).length : 1, proj.path ? 'kiểm tra project không đạt' : 'chưa chọn project');

    const snap = this.adapter.snapshot;
    if (snap) {
      add(a, 'agents', snap.agents.filter(x => x.parseError).length, 'agent lỗi frontmatter');
      add(a, 'skills', snap.skills.filter(x => x.parseError).length, 'skill lỗi frontmatter');
      add(a, 'skills', snap.skills.filter(x => !x.hasSkillMd).length, 'thư mục skill thiếu SKILL.md');
      add(a, 'config', snap.hooks.some(h => h.owner === 'studio') ? 0 : 1, 'hook Studio chưa cài (Monitor không nhận sự kiện)');
    }

    const scan = this.scan.get().status;
    if (scan === 'failed') add(a, 'dashboard', 1, 'lần quét game thất bại');
    if (scan === 'none') add(a, 'dashboard', 1, 'chưa quét game (Bước 0)');
    if (proj.valid && !this.pipelines.setup().started) add(a, 'dashboard', 1, '/start chưa chạy');

    const asks = this.tasks.interactions();
    add(a, 'tasks', asks.filter(x => x.kind === 'question').length, 'câu hỏi đang chờ trả lời');
    add(a, 'tasks', asks.filter(x => x.kind === 'permission').length, 'yêu cầu quyền đang chờ');
    add(a, 'tasks', n(`SELECT COUNT(*) n FROM tasks WHERE status = 'failed' AND ended_at > ?`, since.tasks), 'task thất bại mới');

    const pls = this.pipelines.list(200);
    add(a, 'pipelines', pls.filter(p => p.status === 'review').length, 'kế hoạch chờ duyệt');
    add(a, 'pipelines', pls.filter(p => p.status === 'paused').length, 'kế hoạch đang dừng chờ bạn');
    add(a, 'pipelines', pls.filter(p => p.status === 'failed' && (p.endedAt ?? '') > since.pipelines).length, 'kế hoạch thất bại mới');

    add(a, 'agent-monitor', n(`SELECT COUNT(*) n FROM invocations WHERE status = 'failed' AND ended_at > ?`, since['agent-monitor']), 'agent chạy lỗi mới');
    add(a, 'tool-activity', n(`SELECT COUNT(*) n FROM toolcalls WHERE status = 'failed' AND ended_at > ?`, since['tool-activity']), 'tool call lỗi mới');
    add(a, 'logs', n(`SELECT COUNT(*) n FROM logs WHERE level = 'error' AND timestamp > ?`, since.logs), 'log lỗi mới');
    return a;
  }
}
