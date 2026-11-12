import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StudioSettings } from '@ccgs/shared';
import { DEFAULT_GRAPH_SETTINGS, cleanExclude } from '../graph/graph-core';

export const DEFAULT_SETTINGS = (): StudioSettings => ({
  projectPath: process.env.CCGS_PROJECT ?? null,
  claudeCommand: 'claude',
  taskDefaults: { model: null, permissionMode: 'default', maxRuntimeMin: null, compactAfter: true },
  retention: { days: null, maxPayloadKB: 8 },
  redactPatterns: [],
  recentProjects: [],
  phoenix: { enabled: false, endpoint: 'http://127.0.0.1:6006/v1/traces' },
  autoAllow: [],
  graphify: DEFAULT_GRAPH_SETTINGS(),
  contextMode: false,
});

const TOOL_RE = /^(\*|[A-Za-z0-9_.:-]{1,128})$/;

export class BadSettings extends Error {}

/** Validates a partial update and returns the merged settings. Throws BadSettings with a readable message. */
export function mergeSettings(cur: StudioSettings, b: any): StudioSettings {
  const out: StudioSettings = structuredClone(cur);
  if (b == null || typeof b !== 'object') return out;
  if (typeof b.claudeCommand === 'string' && b.claudeCommand.trim()) out.claudeCommand = b.claudeCommand.trim();
  if (b.taskDefaults) {
    const d = b.taskDefaults;
    if ('model' in d) out.taskDefaults.model = typeof d.model === 'string' && d.model.trim() ? d.model.trim() : null;
    if ('permissionMode' in d) {
      if (!['default', 'acceptEdits', 'plan'].includes(d.permissionMode)) throw new BadSettings('permissionMode không hợp lệ');
      out.taskDefaults.permissionMode = d.permissionMode;
    }
    if ('compactAfter' in d) out.taskDefaults.compactAfter = d.compactAfter !== false;
    if ('compactMinTokens' in d) {
      const n = d.compactMinTokens === null || d.compactMinTokens === '' ? null : Number(d.compactMinTokens);
      if (n !== null && (!Number.isInteger(n) || n < 10_000 || n > 1_000_000)) throw new BadSettings('Ngưỡng /compact phải là số nguyên từ 10000 đến 1000000 token');
      out.taskDefaults.compactMinTokens = n;
    }
    if ('maxRuntimeMin' in d) {
      const n = d.maxRuntimeMin === null || d.maxRuntimeMin === '' ? null : Number(d.maxRuntimeMin);
      if (n !== null && (!Number.isFinite(n) || n < 1 || n > 24 * 60)) throw new BadSettings('Thời gian chạy tối đa phải từ 1 đến 1440 phút');
      out.taskDefaults.maxRuntimeMin = n;
    }
  }
  if (b.retention) {
    const r = b.retention;
    if ('days' in r) {
      const n = r.days === null || r.days === '' ? null : Number(r.days);
      if (n !== null && (!Number.isInteger(n) || n < 1)) throw new BadSettings('Số ngày lưu phải là số nguyên ≥ 1');
      out.retention.days = n;
    }
    if ('maxPayloadKB' in r) {
      const n = Number(r.maxPayloadKB);
      if (!Number.isFinite(n) || n < 1 || n > 1024) throw new BadSettings('Giới hạn payload phải từ 1 đến 1024 KB');
      out.retention.maxPayloadKB = n;
    }
  }
  if (Array.isArray(b.redactPatterns)) {
    const pats = b.redactPatterns.map((x: unknown) => String(x).trim()).filter(Boolean);
    for (const p of pats) {
      try { new RegExp(p, 'g'); } catch (e) { throw new BadSettings(`Regex không hợp lệ "${p}": ${(e as Error).message}`); }
      if (new RegExp(p).test('')) throw new BadSettings(`Regex "${p}" khớp chuỗi rỗng`);
    }
    out.redactPatterns = pats;
  }
  if (Array.isArray(b.autoAllow)) {
    const tools = [...new Set(b.autoAllow.map((x: unknown) => String(x).trim()).filter(Boolean))] as string[];
    for (const t of tools) if (!TOOL_RE.test(t)) throw new BadSettings(`Tên công cụ không hợp lệ: "${t}"`);
    out.autoAllow = tools;
  }
  if (b.graphify && typeof b.graphify === 'object') {
    const g = b.graphify;
    const cur = out.graphify ?? DEFAULT_GRAPH_SETTINGS();
    const next = { ...DEFAULT_GRAPH_SETTINGS(), ...cur, projects: { ...(cur.projects ?? {}) } };
    if ('enabled' in g) next.enabled = g.enabled !== false;
    if ('budget' in g) {
      const n = Number(g.budget);
      if (!Number.isInteger(n) || n < 200 || n > 20_000) throw new BadSettings('Budget truy vấn bản đồ code phải là số nguyên từ 200 đến 20000');
      next.budget = n;
    }
    if (g.projects && typeof g.projects === 'object') {
      for (const [id, v] of Object.entries(g.projects as Record<string, any>)) {
        if (!/^[0-9a-f]{16}$/.test(id)) throw new BadSettings(`Mã project không hợp lệ: "${id}"`);
        const raw: unknown[] = Array.isArray(v?.excludes) ? v.excludes : [];
        let excludes: string[];
        try { excludes = [...new Set(raw.map(x => String(x)).filter(x => x.trim()).map(cleanExclude))]; } catch (e) { throw new BadSettings((e as Error).message); }
        if (excludes.length > 200) throw new BadSettings('Tối đa 200 mục loại trừ cho một project');
        next.projects[id] = { excludes, includePlugins: !!v?.includePlugins };
      }
    }
    out.graphify = next;
  }
  if ('contextMode' in b) out.contextMode = b.contextMode === true;
  if (b.phoenix) {
    if ('enabled' in b.phoenix) out.phoenix.enabled = !!b.phoenix.enabled;
    if ('endpoint' in b.phoenix) {
      const e = String(b.phoenix.endpoint ?? '').trim();
      try { const u = new URL(e); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { throw new BadSettings('Endpoint Phoenix phải là URL http(s)'); }
      out.phoenix.endpoint = e;
    }
  }
  return out;
}

/** Studio settings live in ~/.ccgs-studio/config.json (override dir with CCGS_STUDIO_HOME). */
@Injectable()
export class SettingsService {
  readonly dir = process.env.CCGS_STUDIO_HOME ?? path.join(os.homedir(), '.ccgs-studio');
  private readonly file = path.join(this.dir, 'config.json');
  private cache: StudioSettings;
  readonly events = new EventEmitter<{ changed: [StudioSettings] }>();

  constructor() {
    const d = DEFAULT_SETTINGS();
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cache = {
        ...d, ...j,
        taskDefaults: { ...d.taskDefaults, ...(j.taskDefaults ?? {}) },
        retention: { ...d.retention, ...(j.retention ?? {}) },
        phoenix: { ...d.phoenix, ...(j.phoenix ?? {}) },
        graphify: { ...d.graphify!, ...(j.graphify ?? {}), projects: { ...(j.graphify?.projects ?? {}) } },
        redactPatterns: Array.isArray(j.redactPatterns) ? j.redactPatterns : [],
        recentProjects: Array.isArray(j.recentProjects) ? j.recentProjects : [],
        autoAllow: Array.isArray(j.autoAllow) ? j.autoAllow.filter((x: unknown) => typeof x === 'string' && TOOL_RE.test(x)) : [],
      };
    } catch {
      this.cache = d;
    }
  }

  get(): StudioSettings { return structuredClone(this.cache); }

  update(patch: Partial<StudioSettings>): StudioSettings {
    this.cache = { ...this.cache, ...structuredClone(patch) };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    this.events.emit('changed', this.get());
    return this.get();
  }
}
