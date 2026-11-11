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

/**
 * compactAfter (name kept for saved settings): auto /compact. Runs right BEFORE a task resumes a session whose last context
 * is at least compactMinTokens (default 100k), so sessions nobody resumes and small ones are never compacted.
 */
export interface TaskDefaults { model: string | null; permissionMode: PermissionMode; maxRuntimeMin: number | null; compactAfter: boolean; compactMinTokens?: number | null }
export interface RetentionSettings { days: number | null; maxPayloadKB: number }
export interface PhoenixSettings { enabled: boolean; endpoint: string }
export interface StudioSettings {
  projectPath: string | null; claudeCommand: string;
  /** S-03 */ taskDefaults: TaskDefaults;
  /** S-04 */ retention: RetentionSettings;
  /** S-05: extra regexes (JS syntax, applied with the g flag) */ redactPatterns: string[];
  /** T-PJ-03 */ recentProjects: string[];
  /** S-06 */ phoenix: PhoenixSettings;
  /** Tools Studio allows without asking ("Luôn cho phép"); '*' = every tool. AskUserQuestion is always asked. Claude Code deny rules still apply. */
  autoAllow: string[];
  /** Code map (graphify). Optional in saved files; the server fills the defaults. */
  graphify?: GraphSettings;
}

// ---------- Code map (graphify, run from outside the project) ----------

/** Per project, keyed by GraphStatus.projectId. */
export interface GraphProjectSettings {
  /** Extra exclusions, relative to the project root, one entry per line in the UI (for example "Assets/Spine/", "*.dll"). */
  excludes: string[];
  /** Assets/Plugins/ is excluded by default; true indexes it. */
  includePlugins: boolean;
}
export interface GraphSettings {
  /** Use the code map for Pipelines (pre-query for the planner). */
  enabled: boolean;
  /** Token budget of the pre-query (graphify query --budget), 200–20000, default 2000. */
  budget: number;
  projects: Record<string, GraphProjectSettings>;
}
export type GraphState = 'missing' | 'building' | 'ready' | 'stale' | 'error';
export interface GraphStatus {
  /** 'missing' also when no project is selected. */
  state: GraphState;
  projectId: string | null;
  /** Where the graph lives (outside the project). */
  dir: string | null;
  enabled: boolean;
  /** graphify version from `graphify --version`; null when the command is missing (error says why). */
  graphify: string | null;
  /** graphify-mcp answered an MCP initialize; null until checked (needs a graph). */
  mcp: boolean | null;
  toolError: string | null;
  builtAt: string | null;
  /** git HEAD of the project when the graph was last built or updated. */
  commit: string | null;
  nodes: number | null;
  edges: number | null;
  durationMs: number | null;
  lastError: string | null;
  /** Why the graph is stale (commit changed, code changed by a task, exclusions changed…). */
  staleReason: string | null;
  /** A background `graphify update` after a task is running. */
  updating: boolean;
  lastUpdateAt: string | null;
  /** Exclusions applied by default (before the per-project ones). */
  defaultExcludes: string[];
}
/** What the planner got from the code map (shown on the pipeline). */
export interface PipelineGraphContext {
  /** used: results went into the planner prompt; skipped: no identifier to look up; unavailable: off, no graph or no graphify; error: every lookup failed. */
  status: 'used' | 'skipped' | 'unavailable' | 'error';
  keywords: string[];
  /** Where the keywords came from. */
  source: 'user' | 'request' | null;
  /** Vietnamese, one line per keyword or the reason. */
  detail: string;
  /** Characters added to the planner prompt. */
  chars: number;
  /** The latest planner task got the graphify MCP server (Claude queries the graph itself); undefined before one started. */
  mcp?: boolean;
  /** Vietnamese: why the MCP server was or was not attached. */
  mcpDetail?: string;
  /** Calls to the graphify MCP tools in the latest finished planner task (subagents included); null/undefined when unknown. */
  mcpCalls?: number | null;
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

// ---------- Setup (cài package, 2026-11-11) ----------

export type SetupLevel = 'required' | 'recommended' | 'optional';
export interface SetupPackage {
  id: string; label: string; level: SetupLevel;
  /** Why Studio needs it. */
  why: string;
  /** null: could not tell (e.g. Unity not open). */
  installed: boolean | null;
  version: string | null;
  detail: string;
  /** Fixed command the server runs; null when Studio cannot install it (do it by hand, see detail). */
  install: { command: string; confirm: string | null; blockedBy: string | null } | null;
  /** 'login' opens a terminal running claude so the user types /login. */
  action: 'login' | null;
}
export interface SetupJob {
  id: string; packageId: string; label: string; command: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string; endedAt: string | null; exitCode: number | null;
  /** Last lines of output (capped). */
  log: string[];
}
export interface SetupState { platform: string; packages: SetupPackage[]; job: SetupJob | null; }

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
  /** A plan the user deleted. */
  'pipeline:delete': (p: { id: string }) => void;
  'graph:upsert': (p: GraphStatus) => void;
  'setup:job': (p: SetupJob) => void;
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
  /**
   * M-PF-03: cost of this task alone (list prices, an estimate). The SDK reports a running total per session, so for a
   * resumed session this is that total minus the session's total after the previous task; null when that is unknown.
   */
  costUsd: number | null;
  /** Cost of the /compact that ran before the task (on the resumed session), kept apart from costUsd; null when none ran or unknown. */
  compactCostUsd?: number | null;
  /** SDK running total of the session after this task (baseline for the next resumed task). */
  sessionCostUsd?: number | null;
  /** Context size (tokens) of the task's last main-thread turn; decides whether to /compact before the next resume. */
  contextTokens?: number | null;
  /** T-TC-06: commit the diff is taken against (git stash create / HEAD); null when unknown. */ baseRef: string | null;
  /** MCP servers Studio attached to this task (for example graphify); null for tasks run before this existed. */
  mcp?: TaskMcp | null;
}
/**
 * servers: names of the MCP servers attached (empty when none). note: Vietnamese, why (not) attached.
 * calls: tool calls per attached server, counted from the hook events when the task ended (subagents included);
 * null while it runs.
 */
export interface TaskMcp { servers: string[]; note: string | null; calls: Record<string, number> | null }
/** resumeOf: session id to continue (T-TC-07). Unset fields take the task defaults (S-03). */
export interface NewTask { kind: 'prompt' | 'skill'; skill?: string; args?: string; prompt?: string; model?: string | null; permissionMode?: PermissionMode; resumeOf?: string; }

export interface QuestionSpec { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }
export interface PendingInteraction {
  id: string; taskId: string; kind: 'question' | 'permission'; toolUseId: string | null; agentInvocationId: string | null; createdAt: string;
  question?: { questions: QuestionSpec[] };
  permission?: { toolName: string; title?: string; inputSummary: string; decisionReason?: string; blockedPath?: string };
  /**
   * Questions only: what Claude wrote (same thread: main session or that subagent) since its previous question, so the
   * draft it asks about is shown with the card. "" when it wrote nothing; absent when unknown.
   */
  context?: string;
}
/** POST /api/interactions/:id/answer. Multi-select answers are joined with ", ". */
export interface QuestionAnswer { answers: Record<string, string> }
/** POST /api/interactions/:id/decision */
export interface PermissionDecision { decision: 'allow' | 'deny'; message?: string; /** allow and remember the tool (Settings.autoAllow) */ always?: boolean }

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
export type PipelineStatus = 'planning' | 'critiquing' | 'review' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
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
  /** Role id (plugin/plan-roles.yaml) the step belongs to; filled from the skill when the planner gives none. */
  role?: string | null;
}
/** A role the user can pick for a plan (GET /api/pipelines/roles). */
export interface PlanRoleInfo { id: string; title: string; hint: string; skills: string[] }
export interface PipelineStep extends PlanStep {
  id: string; status: PipelineStepStatus; taskId: string | null; warning: string | null; generated: boolean;
  /** Checkpoint result after the step finished (P3, rules in apps/server/src/pipelines/checkpoint.ts). */
  check?: StepCheck | null;
  /** This step was added by a checkpoint to fix the step with this id (one automatic fix per step). */
  fixOf?: string | null;
}
/** What the studio decided after a step, by rule: go on, insert fix steps, or stop for the user. */
export interface StepCheck {
  decision: 'continue' | 'fix' | 'pause';
  /** Verdict word found in the step's reply (APPROVED, NEEDS REVISION, BLOCKED…), or null. */
  verdict: string | null;
  reason: string;
  /** The result points away from the plan: suggest re-planning the remaining steps. */
  replan: boolean;
  /** Claude ended the step with a question to the user. */
  question: string | null;
}
export interface Pipeline {
  id: string; request: string; summary: string | null; mode: PipelineMode; permissionMode: PermissionMode; model: string | null; rigor?: Rigor | null;
  status: PipelineStatus; planTaskId: string | null; sessionId: string | null; steps: PipelineStep[];
  createdAt: string; endedAt: string | null; error: string | null; note: string | null;
  /** Plan template the planner chose (plugin/plan-templates/<id>.yaml) and the feature slug. */
  planType?: string | null; planTypeTitle?: string | null; slug?: string | null;
  /** Steps of the template the planner left out, with its reason. */
  omitted?: { skill: string; why: string }[];
  /** Roles the user chose for this plan (ids from plan-roles.yaml); null or missing = every role. */
  roles?: string[] | null;
  /** Result of the server-side plan check. An 'error' blocks Duyệt và chạy. */
  issues?: PlanIssue[];
  /** The user changed the steps after planning (template errors become warnings). */
  edited?: boolean;
  /** Critic loop (P2): a read-only reviewer (CCGS producer) checks each plan version; on errors the planner revises (max 2). */
  critic?: boolean;
  critiqueTaskId?: string | null;
  critiques?: CritiqueRound[];
  /** The checkpoint that paused the run (cleared when the run continues). */
  checkpoint?: (StepCheck & { stepId: string }) | null;
  /** Re-plans of the remaining steps so far; true while one is in progress (planning/critiquing). */
  replans?: number;
  replanning?: boolean;
  /** Every planner task (first plan, revisions, re-plans; plus the tasks of a plan dropped by restart-plan), for cost. planTaskId is the latest. */
  planTasks?: string[];
  /** Code identifiers the user typed in "Từ khoá mã nguồn" (empty when none). */
  codeKeywords?: string[];
  /** Code map lookup done before the first plan; null while it runs (planTaskId is null then). */
  graph?: PipelineGraphContext | null;
}
/** One finding of the plan check (apps/server/src/pipelines/plan-rules.ts). */
export interface PlanIssue { level: 'error' | 'warn' | 'info'; rule: string; message: string; stepId: string | null }
/** One finding of the critic (an LLM opinion: shown, never blocks the run). */
export interface CriticIssue { level: 'error' | 'warn'; message: string; stepTitle: string | null }
export interface CritiqueRound {
  round: number;
  /** Planner task whose plan this round reviewed. */
  planTaskId: string | null;
  taskId: string | null;
  /** null while running or when the reply could not be read. */
  ok: boolean | null;
  issues: CriticIssue[];
  error: string | null;
  /** The planner was asked to revise the plan after this round. */
  revised: boolean;
  /** Who asked for the revision: the critic loop (errors) or the user ("Sửa theo phản biện", warnings too). */
  revisedBy?: 'auto' | 'user';
  /** Pipeline.replans when this round ran: the revision limit counts per (re)plan. */
  epoch?: number;
}
export type Rigor = 'minimal' | 'standard' | 'full';
/** codeKeywords: "Từ khoá mã nguồn (không bắt buộc)", identifiers separated by commas or spaces; when set they replace the ones found in the request. */
/** roles: ids from GET /api/pipelines/roles; omitted or every id = no role filter. */
export interface NewPipeline { request: string; mode?: PipelineMode; permissionMode?: PermissionMode; model?: string | null; rigor?: Rigor; critic?: boolean; codeKeywords?: string; roles?: string[] }
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
