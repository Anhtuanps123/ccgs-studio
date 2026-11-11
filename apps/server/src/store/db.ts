import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import fs from 'node:fs';
import path from 'node:path';

export const events = sqliteTable('events', {
  eventId: text('event_id').primaryKey(),
  seq: integer('seq').notNull(),
  eventType: text('event_type').notNull(),
  timestamp: text('timestamp').notNull(),
  sessionId: text('session_id').notNull(),
  taskId: text('task_id'),
  agentInvocationId: text('agent_invocation_id'),
  toolName: text('tool_name'),
  toolUseId: text('tool_use_id'),
  payload: text('payload').notNull(), // JSON, redacted
  source: text('source').notNull(),
}, t => [index('events_session').on(t.sessionId, t.seq)]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  taskId: text('task_id'),
  external: integer('external', { mode: 'boolean' }).notNull(),
  cwd: text('cwd'),
  transcriptPath: text('transcript_path'),
  claudeVersion: text('claude_version'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  endReason: text('end_reason'),
  lastEventAt: text('last_event_at').notNull(),
  firstPrompt: text('first_prompt'),
});

export const invocations = sqliteTable('invocations', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  parentInvocationId: text('parent_invocation_id'),
  toolUseId: text('tool_use_id'),
  agentType: text('agent_type').notNull(),
  description: text('description'),
  prompt: text('prompt'),
  output: text('output'),
  status: text('status').notNull(),
  depth: integer('depth').notNull(),
  startedAt: text('started_at'),
  endedAt: text('ended_at'),
  durationMs: integer('duration_ms'),
  transcriptPath: text('transcript_path'),
}, t => [index('inv_session').on(t.sessionId)]);

export const toolcalls = sqliteTable('toolcalls', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  invocationId: text('invocation_id').notNull(),
  toolName: text('tool_name').notNull(),
  input: text('input'), // JSON, redacted
  inputSummary: text('input_summary').notNull(),
  outputSummary: text('output_summary'),
  error: text('error'),
  status: text('status').notNull(),
  startedAt: text('started_at'),
  endedAt: text('ended_at'),
  durationMs: integer('duration_ms'),
  spawnAgentId: text('spawn_agent_id'),
}, t => [index('tc_session').on(t.sessionId)]);

export const logs = sqliteTable('logs', {
  id: text('id').primaryKey(),
  seq: integer('seq').notNull(),
  timestamp: text('timestamp').notNull(),
  level: text('level').notNull(),
  source: text('source').notNull(),
  sessionId: text('session_id'),
  message: text('message').notNull(),
}, t => [index('logs_seq').on(t.seq)]);

export const schema = { events, sessions, invocations, toolcalls, logs };
export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const DDL = `
CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, event_type TEXT NOT NULL, timestamp TEXT NOT NULL,
  session_id TEXT NOT NULL, task_id TEXT, agent_invocation_id TEXT, tool_name TEXT, tool_use_id TEXT, payload TEXT NOT NULL, source TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT, external INTEGER NOT NULL, cwd TEXT, transcript_path TEXT,
  claude_version TEXT, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT, last_event_at TEXT NOT NULL, first_prompt TEXT);
CREATE TABLE IF NOT EXISTS invocations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_invocation_id TEXT, tool_use_id TEXT,
  agent_type TEXT NOT NULL, description TEXT, prompt TEXT, output TEXT, status TEXT NOT NULL, depth INTEGER NOT NULL,
  started_at TEXT, ended_at TEXT, duration_ms INTEGER, transcript_path TEXT);
CREATE INDEX IF NOT EXISTS inv_session ON invocations(session_id);
CREATE TABLE IF NOT EXISTS toolcalls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, invocation_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  input TEXT, input_summary TEXT NOT NULL, output_summary TEXT, error TEXT, status TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  duration_ms INTEGER, spawn_agent_id TEXT);
CREATE INDEX IF NOT EXISTS tc_session ON toolcalls(session_id);
CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, timestamp TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL,
  session_id TEXT, message TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS logs_seq ON logs(seq);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, skill TEXT, args TEXT, prompt TEXT NOT NULL, model TEXT,
  permission_mode TEXT NOT NULL, status TEXT NOT NULL, position INTEGER, session_id TEXT, resume_of TEXT, created_at TEXT NOT NULL,
  started_at TEXT, ended_at TEXT, result_text TEXT, changed_files TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, position);
CREATE INDEX IF NOT EXISTS events_tooluse ON events(tool_use_id);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, event_type);
CREATE INDEX IF NOT EXISTS events_ts ON events(timestamp);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_event_at);
CREATE INDEX IF NOT EXISTS inv_type ON invocations(agent_type);
`;

/** Columns added after a table was first created (Phase 4+). */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['tasks', 'cost_usd', 'REAL'],
  ['tasks', 'base_ref', 'TEXT'],
  ['tasks', 'diffs', 'TEXT'], // JSON TaskDiff[]
  ['tasks', 'project', 'TEXT'],
  ['tasks', 'compact_cost_usd', 'REAL'],
  ['tasks', 'session_cost_usd', 'REAL'], // SDK running total of the session after this task
  ['tasks', 'context_tokens', 'INTEGER'], // context size of the task's last turn (decides /compact before a resume)
  ['tasks', 'mcp', 'TEXT'], // JSON TaskMcp: MCP servers attached to the task and their call counts
  ['tasks', 'attachments', 'TEXT'], // JSON Attachment[]: files the user attached
];

/** Opens (and creates) the Studio database. Use ':memory:' in tests. */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.exec(DDL);
  for (const [t, c, ddl] of MIGRATIONS) {
    const cols = (sqlite.prepare(`PRAGMA table_info(${t})`).all() as any[]).map(r => r.name);
    if (!cols.includes(c)) sqlite.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`);
  }
  return drizzle(sqlite, { schema }) as Db;
}
