// Shared types and API contract (see docs/api-contract.md). Phase 1: configuration side.

export type ConfigKind = 'agents' | 'skills' | 'rules' | 'hooks' | 'templates' | 'workflows';

export interface AgentDefinition {
  name: string;
  file: string; // relative to project root
  description: string;
  model: string | null;
  tools: string[];
  disallowedTools: string[];
  maxTurns: number | null;
  tier: string | null; // from .claude/docs/agent-roster.md
  tierOrder: number | null; // position of the tier heading in the roster
  frontmatter: Record<string, unknown>;
  parseError: string | null;
}
export interface AgentDetail extends AgentDefinition { body: string; }

export type SkillOrigin = 'ccgs' | 'local' | 'symlink';
export interface Skill {
  name: string;
  dir: string;
  origin: SkillOrigin;
  linkTarget: string | null;
  hasSkillMd: boolean;
  description: string;
  argumentHint: string | null;
  model: string | null;
  allowedTools: string[];
  userInvocable: boolean | null;
  relatedAgents: { name: string; via: 'subagent_type' | 'mention' }[];
  parseError: string | null;
}
export interface SkillDetail extends Skill { body: string; file: string | null; }

export interface Rule { file: string; paths: string[]; body: string; }
export interface HookEntry {
  owner: 'ccgs' | 'studio' | 'user';
  file: string;
  event: string;
  matcher: string;
  command: string;
  timeout?: number;
}
export interface Template { path: string; }
export interface WorkflowStep { id: string; title: string; command: string | null; required: boolean; repeatable: boolean; }
export interface WorkflowPhase { id: string; label: string; steps: WorkflowStep[]; }

export interface ConfigSummary {
  agents: number;
  skills: number; // folders with SKILL.md
  skillsWithoutSkillMd: string[];
  rules: number;
  hooks: number; // CCGS hook commands
  templates: number;
  workflows: number;
  loadedAt: string;
}

export interface ProjectCheck { label: string; ok: boolean; detail?: string; }
export interface ProjectInfo { path: string | null; name: string | null; valid: boolean; checks: ProjectCheck[]; }

export interface SystemStatus {
  project: ProjectInfo;
  claude: { command: string; version: string | null; error: string | null };
  studioHooksInstalled: boolean;
  lastEventAt: string | null; // Phase 2
}

/** compactAfter: send /compact to the task's session after it succeeds, so the next resume starts small. */
export interface TaskDefaults { model: string | null; permissionMode: PermissionMode; maxRuntimeMin: number | null; compactAfter: boolean }
export interface RetentionSettings { days: number | null; maxPayloadKB: number }
export interface PhoenixSettings { enabled: boolean; endpoint: string }
export interface StudioSettings {
  projectPath: string | null; claudeCommand: string;
  /** S-03 */ taskDefaults: TaskDefaults;
  /** S-04 */ retention: RetentionSettings;
  /** S-05: extra regexes (JS syntax, applied with the g flag) */ redactPatterns: string[];
  /** T-PJ-03 */ recentProjects: string[];
  /** S-06 */ phoenix: PhoenixSettings;
}

// ---------- Phase 2: monitoring ----------

export type InvocationStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type ToolCallStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type EventSource = 'hook' | 'transcript' | 'stream' | 'studio';

export interface Session {
  id: string; taskId: string | null; external: boolean; cwd: string | null; transcriptPath: string | null;
  claudeVersion: string | null; startedAt: string; endedAt: string | null; endReason: string | null;
  lastEventAt: string; firstPrompt: string | null;
}
export interface AgentInvocation {
  id: string; // agent_id from Claude Code, 'main:<sessionId>' for the main session
  sessionId: string; parentInvocationId: string | null; toolUseId: string | null; agentType: string;
  description: string | null; prompt: string | null; output: string | null; status: InvocationStatus; depth: number;
  startedAt: string | null; endedAt: string | null; durationMs: number | null; transcriptPath: string | null;
}
export interface ToolCall {
  id: string; // tool_use_id
  sessionId: string; invocationId: string; toolName: string; inputSummary: string; outputSummary: string | null;
  error: string | null; status: ToolCallStatus; startedAt: string | null; endedAt: string | null; durationMs: number | null;
  spawnAgentId: string | null; // for Agent/Task calls: the subagent it started
}
export interface StudioEvent {
  eventId: string; eventType: string; timestamp: string; sessionId: string; taskId: string | null;
  agentInvocationId: string | null; toolName: string | null; toolUseId: string | null;
  payload: unknown; // already redacted
  source: EventSource;
}
export interface LogEntry {
  id: string; timestamp: string; level: 'info' | 'warn' | 'error'; source: 'studio' | 'claude' | 'hook';
  sessionId: string | null; message: string;
}

export type ConversationItem =
  | { kind: 'user'; at: string; text: string }
  | { kind: 'assistant'; at: string; text: string; invocationId: string }
  | { kind: 'tool'; at: string; call: ToolCall; invocation: AgentInvocation | null };

export interface TimelineStep {
  kind: 'invocation' | 'tool'; id: string; invocationId: string; label: string; status: InvocationStatus | ToolCallStatus;
  startedAt: string | null; endedAt: string | null; durationMs: number | null; input: string | null; output: string | null;
}

export interface HookPreview {
  action: 'install' | 'uninstall'; file: string; before: string | null; after: string | null;
  diff: { op: 'ctx' | 'add' | 'del'; line: string }[]; hash: string; changed: boolean;
}

export interface DoctorCheck { id: string; label: string; ok: boolean | null; detail: string; }

export interface IngestBody { v: 1; receivedAt: string; taskId: string | null; origin: 'studio-settings' | 'local-settings' | 'doctor'; payload: Record<string, unknown>; }

// WebSocket events (namespace /live)
export interface ServerToClient {
  'config:changed': (p: { kinds: ConfigKind[] }) => void;
  'system:status': (p: SystemStatus) => void;
  'session:upsert': (p: Session) => void;
  'invocation:upsert': (p: AgentInvocation) => void;
  'toolcall:upsert': (p: ToolCall) => void;
  'event:new': (p: StudioEvent) => void;
  'log:new': (p: LogEntry) => void;
  'task:upsert': (p: Task) => void;
  'interaction:new': (p: PendingInteraction) => void;
  'interaction:resolved': (p: { id: string }) => void;
  'pipeline:upsert': (p: Pipeline) => void;
}

// ---------- Phase 3: tasks ----------

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan';
export interface ChangedFile { path: string; change: 'A' | 'M' | 'D' | 'R' }

export interface Task {
  id: string; kind: 'prompt' | 'skill'; skill: string | null; args: string | null; prompt: string; model: string | null;
  permissionMode: PermissionMode; status: TaskStatus; position: number | null; // 1-based while queued
  sessionId: string | null; resumeOf: string | null; createdAt: string; startedAt: string | null; endedAt: string | null;
  resultText: string | null; changedFiles: ChangedFile[] | null; error: string | null;
  /** M-PF-03: total_cost_usd from the SDK result (list prices, an estimate). */ costUsd: number | null;
  /** T-TC-06: commit the diff is taken against (git stash create / HEAD); null when unknown. */ baseRef: string | null;
}
/** resumeOf: session id to continue (T-TC-07). Unset fields take the task defaults (S-03). */
export interface NewTask { kind: 'prompt' | 'skill'; skill?: string; args?: string; prompt?: string; model?: string | null; permissionMode?: PermissionMode; resumeOf?: string; }

export interface QuestionSpec { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }
export interface PendingInteraction {
  id: string; taskId: string; kind: 'question' | 'permission'; toolUseId: string | null; agentInvocationId: string | null; createdAt: string;
  question?: { questions: QuestionSpec[] };
  permission?: { toolName: string; title?: string; inputSummary: string; decisionReason?: string; blockedPath?: string };
}
/** POST /api/interactions/:id/answer. Multi-select answers are joined with ", ". */
export interface QuestionAnswer { answers: Record<string, string> }
/** POST /api/interactions/:id/decision */
export interface PermissionDecision { decision: 'allow' | 'deny'; message?: string }

/** T-DB-03 */
export interface CurrentTask { task: Task | null; activeAgents: AgentInvocation[]; queued: number; pending: number }

// ---------- Phase 4: P1 ----------

export interface TokenUsage { input: number; output: number; cacheCreation: number; cacheRead: number; messages: number }
/** M-PF-02: tokens read from transcripts, deduplicated by message.id. */
export interface SessionUsage {
  sessionId: string; total: TokenUsage;
  byAgent: { invocationId: string; agentType: string; transcriptPath: string | null; usage: TokenUsage | null; models: string[] }[];
  missing: string[]; // transcripts that could not be read
}
/** M-AM-04 */
export type TranscriptItem =
  | { kind: 'user'; at: string | null; text: string }
  | { kind: 'assistant'; at: string | null; text: string; model: string | null }
  | { kind: 'tool_use'; at: string | null; id: string; name: string; input: string }
  | { kind: 'tool_result'; at: string | null; toolUseId: string; text: string; isError: boolean };

/** M-TS-02/03 */
export interface ToolCallDetail extends ToolCall {
  input: unknown; response: unknown;
  bash: { command: string; exitCode: number | null; exitCodeSource: 'response' | 'error' | 'inferred' | null; output: string } | null;
  file: { op: 'read' | 'create' | 'edit' | 'write'; path: string; diff: DiffLine[] | null } | null;
}
export interface DiffLine { op: 'ctx' | 'add' | 'del' | 'hunk'; line: string }
export interface FileActivity { toolCallId: string; invocationId: string; at: string | null; op: 'read' | 'create' | 'edit' | 'write'; path: string; status: ToolCallStatus }

/** T-TC-06 */
export interface TaskDiff { path: string; change: ChangedFile['change']; diff: string | null; note: string | null }

/** M-PF-01, T-AG-04, M-PF-04 */
export interface TaskStats { total: number; completed: number; failed: number; cancelled: number; avgDurationMs: number | null; totalCostUsd: number | null }
export interface AgentStats { agentType: string; calls: number; completed: number; failed: number; unknown: number; avgDurationMs: number | null; lastAt: string | null }

/** T-PJ-02 */
export interface GitInfo { isRepo: boolean; branch: string | null; head: string | null; ahead: number | null; behind: number | null; files: { status: string; path: string }[]; truncated: boolean; error: string | null }

/** Phoenix export result (M-PF-05) */
export interface PhoenixExport { ok: boolean; spans: number; status: number | null; error: string | null }

// ---------- Pipelines: request -> plan -> chained tasks ----------

/** auto: run every step without stopping; step: pause after each step until the user continues. */
export type PipelineMode = 'auto' | 'step';
export type PipelineStatus = 'planning' | 'review' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type PipelineStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface PlanStep {
  title: string;
  /** Skill name without "/"; null for a plain prompt step. */
  skill: string | null;
  args: string | null;
  prompt: string | null;
  why: string | null;
  /** 'stories': when this step ends, add /dev-story + /story-done for each story file it created or changed. */
  expand: 'stories' | null;
}
export interface PipelineStep extends PlanStep {
  id: string; status: PipelineStepStatus; taskId: string | null; warning: string | null; generated: boolean;
}
export interface Pipeline {
  id: string; request: string; summary: string | null; mode: PipelineMode; permissionMode: PermissionMode; model: string | null; rigor?: Rigor | null;
  status: PipelineStatus; planTaskId: string | null; sessionId: string | null; steps: PipelineStep[];
  createdAt: string; endedAt: string | null; error: string | null; note: string | null;
  /** Plan template the planner chose (plugin/plan-templates/<id>.yaml) and the feature slug. */
  planType?: string | null; planTypeTitle?: string | null; slug?: string | null;
  /** Steps of the template the planner left out, with its reason. */
  omitted?: { skill: string; why: string }[];
  /** Result of the server-side plan check. An 'error' blocks Duyệt và chạy. */
  issues?: PlanIssue[];
  /** The user changed the steps after planning (template errors become warnings). */
  edited?: boolean;
}
/** One finding of the plan check (apps/server/src/pipelines/plan-rules.ts). */
export interface PlanIssue { level: 'error' | 'warn' | 'info'; rule: string; message: string; stepId: string | null }
export type Rigor = 'minimal' | 'standard' | 'full';
export interface NewPipeline { request: string; mode?: PipelineMode; permissionMode?: PermissionMode; model?: string | null; rigor?: Rigor }
/** What /start has recorded in project.yaml. `started` is false while modes.rigor is unset. */
/** source: where "started" came from — project.yaml (modes.rigor) or a /start that finished in Studio without saving. */
export interface PipelineSetup { started: boolean; rigor: Rigor | null; stage: string | null; automation: string | null; error: string | null; source?: 'project.yaml' | 'session' | null; startedAt?: string | null }

/** Game scan through Unity MCP (Tổng quan). status ok = MCP answered and a summary exists. */
export interface GameScan {
  status: 'none' | 'running' | 'ok' | 'failed';
  taskId: string | null; sessionId: string | null; at: string | null;
  summary: string | null; images: string[]; error: string | null;
  /** /start run from this scan's session; startDoneAt set when it completed (even if it did not save project.yaml). */
  startTaskId?: string | null; startDoneAt?: string | null;
}

// ---------- Sidebar alerts ----------
/** Sidebar item ids (route without the leading slash). */
export type AlertKey = 'dashboard' | 'agents' | 'skills' | 'config' | 'projects' | 'pipelines' | 'tasks'
  | 'live' | 'agent-monitor' | 'timeline' | 'tool-activity' | 'logs' | 'performance' | 'preferences';
/** GET /api/alerts. Only items with a problem are present; reasons are Vietnamese, one per cause. */
export type NavAlerts = Partial<Record<AlertKey, { count: number; reasons: string[] }>>;
