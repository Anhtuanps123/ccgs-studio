// Runs one task through the Claude Agent SDK. The queue (tasks.service) only sees the Runner interface,
// so tests can swap in a fake.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { STUDIO_PLUGIN_DIR } from '../studio-plugin';
import { attachmentDirs, withAttachments } from './attachments';
import type { PermissionDecision, PendingInteraction, QuestionAnswer, Task } from '@ccgs/shared';

export type InteractionRequest = Omit<PendingInteraction, 'id' | 'taskId' | 'createdAt'>;
export type InteractionReply = QuestionAnswer | PermissionDecision;

export interface RunHooks {
  onSession(sessionId: string): void;
  /** Resolves when the user answers on the web; rejects when the task is stopped. */
  ask(req: InteractionRequest, signal: AbortSignal): Promise<InteractionReply>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
/**
 * costUsd: total_cost_usd of the task's result. On a resumed session the SDK restores the session's running total,
 * so this is cumulative over the whole session, not this task alone; the queue subtracts the previous total.
 * compactTotalUsd: the same running total after the /compact that ran before the task (null when none ran / no result).
 * contextTokens: context size of the task's last main-thread turn (input + cache + output), to decide the next compact.
 */
export interface RunOutcome {
  ok: boolean; sessionId: string | null; resultText: string | null; error: string | null;
  costUsd?: number | null; compactTotalUsd?: number | null; contextTokens?: number | null;
}
/** Extra SDK options for one task (for example the graphify MCP server of a planner task). */
export interface SessionExtras {
  mcpServers?: Record<string, { type: 'stdio'; command: string; args: string[]; env?: Record<string, string>; alwaysLoad?: boolean }>;
  /** Auto-allowed without asking (still after the project's deny rules). */
  allowedTools?: string[];
  /** Removed from the session. */
  disallowedTools?: string[];
  /**
   * System prompt of the session (main thread), also appended to subagents' prompts. Without it the SDK already runs
   * a custom empty system prompt, so this only adds text. The SDK records it for the session: a resumed session keeps
   * the prompt it started with.
   */
  systemPrompt?: string;
  /** Vietnamese, for the task record only (why the MCP servers were or were not attached); not sent to the SDK. */
  note?: string;
}
/**
 * compactFirst: /compact the resumed session before the task (the queue decides from the session's last context size).
 * extras: added to the SDK options of this task only.
 */
export interface RunOptions { compactFirst?: boolean; extras?: SessionExtras | null }

/**
 * System prompt of every Studio task (main session and subagents): the user answers questions on a small card and
 * reads Claude's text in a panel above it, so drafts must come before the question and stay short.
 */
export const ASK_STYLE_HINT = `Asking the user (AskUserQuestion): the user answers on a small card in CCGS Studio; what you wrote since your previous question is shown in a panel above that card.
- Before asking the user to approve or choose about content (a draft section, a table, a plan, a file's content), write that content in full in a normal message first. Never ask about content you have not shown since your previous question.
- Write drafts for fast reading: a short heading, then bullet points with one idea per line, or a table. No long paragraphs, no run-on lists inside one sentence.
- Keep each question to one or two short sentences that point at the draft above (for example "Is the Localization section above right?"). Do not put the content itself in the question.
- Option labels: 1 to 5 words. Option descriptions: one short sentence.`;

/** SDK options from SessionExtras; empty lists are left out. ASK_STYLE_HINT always leads the system prompt. */
export function extrasOptions(x: SessionExtras | null | undefined): Record<string, unknown> {
  // A bare string takes the same SDK path as the default (custom prompt, "" when omitted).
  // appendSubagentSystemPrompt is read by SDK 0.3.319 (sent in initialize) but not in its typings yet.
  const systemPrompt = [ASK_STYLE_HINT, x?.systemPrompt].filter(Boolean).join('\n\n');
  return {
    ...(x?.mcpServers && Object.keys(x.mcpServers).length ? { mcpServers: x.mcpServers } : {}),
    ...(x?.allowedTools?.length ? { allowedTools: x.allowedTools } : {}),
    ...(x?.disallowedTools?.length ? { disallowedTools: x.disallowedTools } : {}),
    systemPrompt, appendSubagentSystemPrompt: systemPrompt,
  };
}

/** Max characters of Claude's text kept as the context of a question (the end is kept). */
export const ASK_CONTEXT_MAX = 8000;

/**
 * Tracks, per thread (main session = '', subagent = its parent tool_use id), the text Claude wrote since its last
 * AskUserQuestion, and gives each AskUserQuestion tool_use the text that came before it.
 */
export class AskContext {
  private text = new Map<string, string>();
  private byTool = new Map<string, string>();
  /** Feed every SDK message. */
  see(m: any) {
    if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) return;
    const thread = m.parent_tool_use_id ?? '';
    for (const c of m.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        const prev = this.text.get(thread);
        this.text.set(thread, ((prev ? prev + '\n\n' : '') + c.text.trim()).slice(-ASK_CONTEXT_MAX));
      } else if (c?.type === 'tool_use' && c.name === 'AskUserQuestion' && typeof c.id === 'string') {
        this.byTool.set(c.id, this.text.get(thread) ?? '');
        this.text.delete(thread);
      }
    }
  }
  /** Text before that AskUserQuestion ("" when none); undefined when the tool_use was not seen. */
  take(toolUseId: string | null | undefined): string | undefined {
    if (!toolUseId || !this.byTool.has(toolUseId)) return undefined;
    const t = this.byTool.get(toolUseId)!;
    this.byTool.delete(toolUseId);
    return t;
  }
}
export interface RunHandle {
  done: Promise<RunOutcome>;
  /** Graceful stop (SDK interrupt), then abort, then kill the whole process tree. */
  stop(): Promise<void>;
  /** PID of the claude process, when known. */
  pid(): number | null;
}
export type Runner = (task: Task, hooks: RunHooks, opts?: RunOptions) => RunHandle;

/**
 * Error text of a failed SDK result message, null when it succeeded. Claude Code reports some failures (usage limit,
 * API errors) as subtype "success" with is_error and the reason in `result`: show that text, not the word "success".
 */
export function resultError(m: { subtype?: string; is_error?: boolean; result?: unknown; errors?: unknown }): string | null {
  if (m.subtype === 'success' && !m.is_error) return null;
  const errs = Array.isArray(m.errors) ? m.errors.map(e => String(e ?? '').trim()).filter(Boolean) : [];
  if (m.subtype === 'success' || !m.subtype) {
    const text = typeof m.result === 'string' ? m.result.trim() : '';
    return text || errs.join(': ') || 'Claude báo lỗi nhưng không ghi lý do';
  }
  return [m.subtype, ...errs].join(': ');
}

export interface SdkRunnerConfig {
  cwd: () => string;
  /** Settings file with the Studio hook (origin "studio"); merged by Claude Code with the project's own. */
  settingsFile: string;
  summarize: (tool: string, input: unknown) => string;
}

// The server is CommonJS and the SDK is ESM-only: keep a real import() through tsc.
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

export function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const STOP_GRACE_MS = 3000;

export function sdkRunner(cfg: SdkRunnerConfig): Runner {
  return (task, hooks, opts) => {
    const abort = new AbortController();
    let child: ChildProcess | null = null;
    let q: any = null;
    let sessionId: string | null = null;
    let stderrTail = '';
    const askCtx = new AskContext();

    const canUseTool = async (toolName: string, input: Record<string, any>, opts: any) => {
      const base = { toolUseId: opts?.toolUseID ?? null, agentInvocationId: opts?.agentID ?? null };
      if (toolName === 'AskUserQuestion') {
        // The assistant message with this tool_use is read before the permission request but may still sit in the
        // SDK's queue: one macrotask lets the message loop below consume it.
        await new Promise(r => setImmediate(r));
        const context = askCtx.take(base.toolUseId);
        const r = await hooks.ask({ ...base, kind: 'question', question: { questions: input.questions ?? [] }, ...(context !== undefined ? { context } : {}) }, opts.signal) as QuestionAnswer;
        return { behavior: 'allow', updatedInput: { ...input, answers: r.answers } };
      }
      const r = await hooks.ask({
        ...base, kind: 'permission',
        permission: {
          toolName, title: opts?.title, inputSummary: cfg.summarize(toolName, input),
          decisionReason: typeof opts?.decisionReason === 'string' ? opts.decisionReason : undefined, blockedPath: opts?.blockedPath,
        },
      }, opts.signal) as PermissionDecision;
      return r.decision === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: r.message?.trim() || 'Người dùng từ chối trên CCGS Studio.' };
    };

    const done = (async (): Promise<RunOutcome> => {
      let resultText: string | null = null, error: string | null = null, ok = false, costUsd: number | null = null;
      let compactTotalUsd: number | null = null, contextTokens: number | null = null;
      try {
        const { query } = await esmImport('@anthropic-ai/claude-agent-sdk');
        const options = {
            cwd: cfg.cwd(),
            model: task.model ?? undefined,
            permissionMode: task.permissionMode,
            settingSources: ['user', 'project', 'local'],
            settings: cfg.settingsFile,
            plugins: [{ type: 'local' as const, path: STUDIO_PLUGIN_DIR }],
            env: { ...process.env, CCGS_STUDIO_TASK_ID: task.id },
            abortController: abort,
            canUseTool,
            ...extrasOptions(opts?.extras),
            ...(task.attachments?.length ? { additionalDirectories: attachmentDirs(task.attachments) } : {}),
            spawnClaudeCodeProcess: (o: any) => {
              child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: o.signal });
              child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-2000); });
              return child;
            },
        };
        let resume = task.resumeOf;
        // Compact only right before a large session is resumed: never for sessions nobody resumes, never for small ones.
        // A failed compact only logs; the task then runs on the uncompacted session.
        if (resume && opts?.compactFirst) {
          hooks.log('info', 'Session lớn, đang /compact trước khi chạy task…');
          try {
            q = query({ prompt: '/compact', options: { ...options, resume } });
            for await (const m of q) {
              if (m.session_id && m.session_id !== sessionId) { sessionId = m.session_id; hooks.onSession(m.session_id); }
              if (m.type !== 'result') continue;
              if (m.subtype !== 'success' || m.is_error) hooks.log('warn', `/compact không thành công: ${resultError(m)}`);
              if (typeof m.total_cost_usd === 'number') compactTotalUsd = m.total_cost_usd;
            }
            if (sessionId) resume = sessionId;
            hooks.log('info', 'Đã /compact session (chi phí ghi riêng, không cộng vào chi phí task).');
          } catch (e) { hooks.log('warn', `/compact lỗi, chạy task trên session chưa compact: ${(e as Error).message}`); }
        }
        if (abort.signal.aborted) throw new Error('Task bị dừng');
        q = query({ prompt: withAttachments(task.prompt, task.attachments), options: { ...options, ...(resume ? { resume } : {}) } });
        for await (const m of q) {
          if (m.session_id && m.session_id !== sessionId) { sessionId = m.session_id; hooks.onSession(m.session_id); }
          askCtx.see(m);
          if (m.type === 'assistant' && !m.parent_tool_use_id && m.message?.usage) {
            const u = m.message.usage;
            contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
          }
          if (m.type === 'result') {
            ok = m.subtype === 'success' && !m.is_error;
            resultText = typeof m.result === 'string' ? m.result : null;
            if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
            if (!ok) error = resultError(m);
          }
        }
      } catch (e) {
        ok = false;
        error = error ?? ((e as Error).message || String(e));
        if (stderrTail.trim()) hooks.log('error', `stderr của claude: ${stderrTail.trim()}`);
      }
      return { ok, sessionId, resultText, error, costUsd, compactTotalUsd, contextTokens };
    })();

    const pid = () => (child as ChildProcess | null)?.pid ?? null;

    const stop = async () => {
      const settled = done.then(() => true);
      const wait = (ms: number) => Promise.race([settled, new Promise<boolean>(r => setTimeout(() => r(false), ms))]);
      try { await Promise.race([q?.interrupt(), new Promise(r => setTimeout(r, STOP_GRACE_MS))]); } catch { /* already ended */ }
      if (!(await wait(STOP_GRACE_MS))) abort.abort();
      if (!(await wait(STOP_GRACE_MS))) hooks.log('warn', 'Task không dừng sau abort, kill cả cây tiến trình.');
      // Always make sure nothing survives (bash children on Windows, R7).
      const p = pid();
      if (p && isAlive(p)) killTree(p);
    };

    return { done, stop, pid };
  };
}
