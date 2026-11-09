import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import chokidar, { FSWatcher } from 'chokidar';
import type {
  AgentDetail, ConfigKind, ConfigSummary, HookEntry, Rule, SkillDetail, Template, WorkflowPhase,
} from '@ccgs/shared';
import { loadAgents, loadHooks, loadRules, loadSkills, loadTemplates, loadWorkflows } from './parser';

interface Snapshot {
  agents: AgentDetail[]; skills: SkillDetail[]; rules: Rule[]; hooks: HookEntry[];
  templates: Template[]; workflows: WorkflowPhase[]; loadedAt: string;
}

/** Map a path inside .claude/ to the config kinds it affects. */
export function kindsForPath(rel: string): ConfigKind[] {
  const p = rel.split(path.sep).join('/');
  if (p.startsWith('agents/')) return ['agents', 'skills']; // skills reference agent names
  if (p === 'docs/agent-roster.md') return ['agents'];
  if (p.startsWith('skills/')) return ['skills'];
  if (p.startsWith('rules/')) return ['rules'];
  if (p === 'settings.json' || p === 'settings.local.json') return ['hooks'];
  if (p.startsWith('docs/templates/')) return ['templates'];
  if (p === 'docs/workflow-catalog.yaml') return ['workflows'];
  return [];
}

/** Read-only cache of a project's .claude/ config. Re-parses only the kinds whose files changed. */
@Injectable()
export class CcgsAdapterService implements OnModuleDestroy {
  private readonly log = new Logger('CcgsAdapter');
  readonly events = new EventEmitter(); // 'changed' (kinds: ConfigKind[])
  private root: string | null = null;
  private snap: Snapshot | null = null;
  private watcher: FSWatcher | null = null;
  private pending = new Set<ConfigKind>();
  private timer: NodeJS.Timeout | null = null;

  async open(root: string | null): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
    this.root = root;
    this.snap = null;
    if (!root) return;
    this.snap = this.loadAll(root);
    const claudeDir = path.join(root, '.claude');
    this.watcher = chokidar.watch(claudeDir, {
      ignoreInitial: true,
      followSymlinks: true,
      ignored: (p) => /[\\/](agent-memory|worktrees|node_modules)[\\/]?/.test(p),
    });
    this.watcher.on('all', (_ev, p) => {
      for (const k of kindsForPath(path.relative(claudeDir, p))) this.pending.add(k);
      if (this.pending.size && !this.timer) this.timer = setTimeout(() => this.flush(), 300);
    });
    this.watcher.on('error', (e) => this.log.warn(`watcher: ${String(e)}`));
  }

  private flush() {
    this.timer = null;
    if (!this.root || !this.snap) return;
    const kinds = [...this.pending];
    this.pending.clear();
    const r = this.root;
    for (const k of kinds) {
      if (k === 'agents') this.snap.agents = loadAgents(r);
      if (k === 'skills') this.snap.skills = loadSkills(r, this.snap.agents.map(a => a.name));
      if (k === 'rules') this.snap.rules = loadRules(r);
      if (k === 'hooks') this.snap.hooks = loadHooks(r);
      if (k === 'templates') this.snap.templates = loadTemplates(r);
      if (k === 'workflows') this.snap.workflows = loadWorkflows(r);
    }
    this.snap.loadedAt = new Date().toISOString();
    this.events.emit('changed', kinds);
  }

  private loadAll(r: string): Snapshot {
    const agents = loadAgents(r);
    return {
      agents, skills: loadSkills(r, agents.map(a => a.name)), rules: loadRules(r), hooks: loadHooks(r),
      templates: loadTemplates(r), workflows: loadWorkflows(r), loadedAt: new Date().toISOString(),
    };
  }

  get snapshot(): Snapshot | null { return this.snap; }
  get projectRoot(): string | null { return this.root; }

  summary(): ConfigSummary | null {
    const s = this.snap;
    if (!s) return null;
    return {
      agents: s.agents.length,
      skills: s.skills.filter(k => k.hasSkillMd).length,
      skillsWithoutSkillMd: s.skills.filter(k => !k.hasSkillMd).map(k => k.dir),
      rules: s.rules.length,
      hooks: s.hooks.filter(h => h.owner === 'ccgs').length,
      templates: s.templates.length,
      workflows: s.workflows.length,
      loadedAt: s.loadedAt,
    };
  }

  async onModuleDestroy() { await this.watcher?.close(); }
}
