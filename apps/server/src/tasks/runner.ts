// Runs one task through the Claude Agent SDK. The queue (tasks.service) only sees the Runner interface,
// so tests can swap in a fake.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { STUDIO_PLUGIN_DIR } from '../studio-plugin';
import type { PermissionDecision, PendingInteraction, QuestionAnswer, Task } from '@ccgs/shared';

export type InteractionRequest = Omit<PendingInteraction, 'id' | 'taskId' | 'createdAt'>;
export type InteractionReply = QuestionAnswer | PermissionDecision;

export interface RunHooks {
  onSession(sessionId: string): void;
  /** Resolves when the user answers on the web; rejects when the task is stopped. */
  ask(req: InteractionRequest, signal: AbortSignal): Promise<InteractionReply>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
export interface RunOutcome { ok: boolean; sessionId: string | null; resultText: string | null; error: string | null; costUsd?: number | null }
export interface RunHandle {
  done: Promise<RunOutcome>;
  /** Graceful stop (SDK interrupt), then abort, then kill the whole process tree. */
  stop(): Promise<void>;
  /** PID of the claude process, when known. */
  pid(): number | null;
}
export type Runner = (task: Task, hooks: RunHooks) => RunHandle;

export interface SdkRunnerConfig {
  cwd: () => string;
  /** Settings file with the Studio hook (origin "studio"); merged by Claude Code with the project's own. */
  settingsFile: string;
  summarize: (tool: string, input: unknown) => string;
  /** Compact the session after a successful task (Cài đặt > compactAfter). */
  compactAfter?: () => boolean;
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
  return (task, hooks) => {
    const abort = new AbortController();
    let child: ChildProcess | null = null;
    let q: any = null;
    let sessionId: string | null = null;
    let stderrTail = '';

    const canUseTool = async (toolName: string, input: Record<string, any>, opts: any) => {
      const base = { toolUseId: opts?.toolUseID ?? null, agentInvocationId: opts?.agentID ?? null };
      if (toolName === 'AskUserQuestion') {
        const r = await hooks.ask({ ...base, kind: 'question', question: { questions: input.questions ?? [] } }, opts.signal) as QuestionAnswer;
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
      try {
        const { query } = await esmImport('@anthropic-ai/claude-agent-sdk');
        const options = {
            cwd: cfg.cwd(),
            model: task.model ?? undefined,
            permissionMode: task.permissionMode,
            ...(task.resumeOf ? { resume: task.resumeOf } : {}),
            settingSources: ['user', 'project', 'local'],
            settings: cfg.settingsFile,
            plugins: [{ type: 'local' as const, path: STUDIO_PLUGIN_DIR }],
            env: { ...process.env, CCGS_STUDIO_TASK_ID: task.id },
            abortController: abort,
            canUseTool,
            spawnClaudeCodeProcess: (o: any) => {
              child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: o.signal });
              child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-2000); });
              return child;
            },
        };
        q = query({ prompt: task.prompt, options });
        for await (const m of q) {
          if (m.session_id && m.session_id !== sessionId) { sessionId = m.session_id; hooks.onSession(m.session_id); }
          if (m.type === 'result') {
            ok = m.subtype === 'success' && !m.is_error;
            resultText = typeof m.result === 'string' ? m.result : null;
            if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
            if (!ok) error = [m.subtype, ...(Array.isArray(m.errors) ? m.errors : [])].join(': ');
          }
        }
        // Keep the result of the task itself; a failed compact only logs.
        if (ok && sessionId && cfg.compactAfter?.() && !abort.signal.aborted) {
          hooks.log('info', 'Task xong, đang /compact session để giảm context…');
          try {
            q = query({ prompt: '/compact', options: { ...options, resume: sessionId } });
            for await (const m of q) {
              if (m.session_id && m.session_id !== sessionId) { sessionId = m.session_id; hooks.onSession(m.session_id); }
              if (m.type === 'result' && (m.subtype !== 'success' || m.is_error)) hooks.log('warn', `/compact không thành công: ${m.subtype}`);
            }
            hooks.log('info', 'Đã /compact session.');
          } catch (e) { hooks.log('warn', `/compact lỗi: ${(e as Error).message}`); }
        }
      } catch (e) {
        ok = false;
        error = error ?? ((e as Error).message || String(e));
        if (stderrTail.trim()) hooks.log('error', `stderr của claude: ${stderrTail.trim()}`);
      }
      return { ok, sessionId, resultText, error, costUsd };
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
