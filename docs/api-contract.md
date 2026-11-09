# API contract (cập nhật Phase 3)

> Nguồn sự thật cho kiểu là `packages/shared/src/index.ts`. Phase 2 thêm: `Session.lastEventAt`, `Session.firstPrompt`, `AgentInvocation.output`, `ToolCall.outputSummary/error/spawnAgentId`, `ConversationItem`, `TimelineStep`, `HookPreview`, `DoctorCheck`; `origin` của ingest có thêm `doctor`. Phase 3 thêm: `Task.args`, `NewTask`, `QuestionAnswer`, `PermissionDecision`, `CurrentTask` và `GET /api/tasks/current`, `GET /api/interactions`; bỏ `applySuggestions` (chưa làm) và `queue:changed` (thứ tự đi kèm `task:upsert`).

Server: `http://127.0.0.1:4310`. Mọi request phải có `Origin` là `http://127.0.0.1:<webPort>` hoặc `http://localhost:<webPort>`, trừ `/ingest` (hook không gửi Origin, nên xác thực bằng token, xem bên dưới).
Kiểu TypeScript tương ứng sẽ nằm trong `packages/shared`. Thời gian: ISO 8601 UTC. ID: chuỗi.

## 1. Kiểu dữ liệu chính

```ts
type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type InvocationStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
type EventSource = 'hook' | 'transcript' | 'stream' | 'studio';

interface AgentDefinition { name: string; file: string; description: string; model: string | null;
  tools: string[]; disallowedTools: string[]; maxTurns: number | null; tier: string | null; // từ agent-roster.md
  frontmatter: Record<string, unknown>; }
interface Skill { name: string; dir: string; origin: 'ccgs' | 'local' | 'symlink'; linkTarget: string | null;
  hasSkillMd: boolean; description: string; argumentHint: string | null; model: string | null;
  allowedTools: string[]; userInvocable: boolean | null;
  relatedAgents: { name: string; via: 'subagent_type' | 'mention' }[]; }
interface Rule { file: string; paths: string[]; }
interface HookEntry { owner: 'ccgs' | 'studio' | 'user'; file: string; event: string; matcher: string; command: string; timeout?: number; }
interface Template { path: string; }
interface WorkflowStep { id: string; phase: string; title: string; skill?: string; required: boolean; repeatable: boolean; }

interface Session { id: string; taskId: string | null; external: boolean; cwd: string; transcriptPath: string;
  claudeVersion: string | null; startedAt: string; endedAt: string | null; endReason: string | null; }
interface AgentInvocation { id: string;            // agent_id của Claude Code, 'main:<sessionId>' cho main session
  sessionId: string; parentInvocationId: string | null; toolUseId: string | null; agentType: string;
  description: string | null; prompt: string | null; status: InvocationStatus; depth: number;
  startedAt: string | null; endedAt: string | null; durationMs: number | null; transcriptPath: string | null; }
interface ToolCall { id: string /* tool_use_id */; sessionId: string; invocationId: string; toolName: string;
  inputSummary: string; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  startedAt: string | null; endedAt: string | null; durationMs: number | null; }
interface StudioEvent { eventId: string; eventType: string; timestamp: string; sessionId: string; taskId: string | null;
  agentInvocationId: string | null; parentInvocationId: string | null; toolName: string | null;
  payload: unknown /* đã che */; status: string | null; source: EventSource; }
interface Task { id: string; kind: 'prompt' | 'skill'; skill: string | null; args: string | null; prompt: string; model: string | null;
  permissionMode: 'default' | 'acceptEdits' | 'plan'; status: TaskStatus; position: number | null;
  sessionId: string | null; resumeOf: string | null; createdAt: string; startedAt: string | null; endedAt: string | null;
  resultText: string | null; changedFiles: { path: string; change: 'A' | 'M' | 'D' | 'R' }[] | null; error: string | null; }
interface PendingInteraction { id: string; taskId: string; kind: 'question' | 'permission'; toolUseId: string;
  agentInvocationId: string | null; createdAt: string;
  question?: { questions: { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }[] };
  permission?: { toolName: string; title?: string; inputSummary: string; decisionReason?: string; suggestions?: unknown[] }; }
interface LogEntry { id: string; timestamp: string; level: 'info' | 'warn' | 'error'; source: 'studio' | 'claude' | 'hook';
  sessionId: string | null; message: string; }
```

## 2. REST

| Method | Path | Mô tả | Phase |
|---|---|---|---|
| GET | `/api/system` | Project hiện tại, phiên bản claude, trạng thái hook, thời điểm event cuối | 1 |
| GET/PUT | `/api/project` | Đọc / đặt đường dẫn project, trả kết quả kiểm tra hợp lệ | 1 |
| GET | `/api/config/summary` | Số lượng agents, skills, rules, hooks, templates | 1 |
| GET | `/api/agents` · `/api/agents/:name` | Danh sách / chi tiết (kèm `body` markdown) | 1 |
| GET | `/api/skills` · `/api/skills/:name` | Danh sách / chi tiết (kèm `body`) | 1 |
| GET | `/api/rules` · `/api/hooks` · `/api/templates` · `/api/workflows` | Cấu hình khác | 1 |
| GET | `/api/hooks/studio/preview?action=install\|uninstall` | Trả `{before, after, diff}` cho `settings.local.json` | 2 |
| POST | `/api/hooks/studio/install` · `/uninstall` | Body `{confirmHash}`, phải khớp hash của preview | 2 |
| POST | `/api/doctor` | Chạy kiểm tra môi trường (S-02) | 2 |
| GET | `/api/settings` · PUT | Cài đặt Studio | 1 |
| GET | `/api/sessions?external=&live=` · `/api/sessions/:id` | Danh sách / chi tiết session | 2 |
| GET | `/api/sessions/:id/conversation` | Prompt, phản hồi, tool card theo thứ tự | 2 |
| GET | `/api/sessions/:id/invocations` | Cây AgentInvocation | 2 |
| GET | `/api/sessions/:id/toolcalls?tool=&agent=` | Bảng tool call | 2 |
| GET | `/api/sessions/:id/timeline` | Các bước (invocation + tool call) theo thời gian | 2 |
| GET | `/api/logs?session=&level=&source=&q=&before=` | Log có phân trang | 2 |
| GET | `/api/sessions/:id/events` | Event gốc đã che | 2 |
| GET | `/api/tasks?status=` · POST `/api/tasks` | Danh sách / tạo task `{kind, skill?, prompt, model?, permissionMode?}` | 3 |
| PATCH | `/api/tasks/:id/position` | Đổi thứ tự trong hàng đợi `{position}` | 3 |
| GET | `/api/tasks/current` | Task đang chạy, agent đang hoạt động, số task chờ (T-DB-03) | 3 |
| GET | `/api/interactions` | Câu hỏi và yêu cầu quyền đang chờ | 3 |
| POST | `/api/tasks/:id/cancel` | Huỷ task đang chờ hoặc dừng task đang chạy | 3 |
| POST | `/api/tasks/:id/resume` | Tạo task mới tiếp session `{prompt}` | 4 |
| POST | `/api/interactions/:id/answer` | `{answers: Record<question, label \| string>}` | 3 |
| POST | `/api/interactions/:id/decision` | `{decision: 'allow' \| 'deny', message?}` | 3 |

## 3. Ingest (hook → server)

`POST /ingest` với header `X-Studio-Token: <token>` (token sinh khi cài hook, lưu cùng port trong `hook.json` ở studio home, cạnh script hook; hook đọc từ file đó, không ghi token vào settings).
Body: `{ v: 1, receivedAt, taskId: string|null, origin: 'studio-settings'|'local-settings', payload: <stdin JSON gốc> }`.
Trả `204`. Hook timeout 500 ms; lỗi thì ghi spool (P1) và vẫn `exit 0`.

## 4. WebSocket (Socket.IO, namespace `/live`)

| Event server → client | Payload |
|---|---|
| `config:changed` | `{ kinds: ('agents'\|'skills'\|'rules'\|'hooks'\|'templates'\|'workflows')[] }` |
| `session:upsert` | `Session` |
| `invocation:upsert` | `AgentInvocation` |
| `toolcall:upsert` | `ToolCall` |
| `event:new` | `StudioEvent` (đã che) |
| `log:new` | `LogEntry` |
| `task:upsert` | `Task` |
| `interaction:new` · `interaction:resolved` | `PendingInteraction` · `{ id }` |
| `system:status` | như `GET /api/system` |

Client → server: `subscribe { sessionId }`, `unsubscribe { sessionId }`. Mọi thao tác ghi đều đi qua REST.

## 5. Bổ sung Phase 4–5

Kiểu mới trong `packages/shared`: `TaskDefaults`, `RetentionSettings`, `PhoenixSettings` (trong `StudioSettings`), `Task.costUsd`, `Task.baseRef`, `NewTask.resumeOf`, `TokenUsage`, `SessionUsage`, `TranscriptItem`, `ToolCallDetail`, `DiffLine`, `FileActivity`, `TaskDiff`, `TaskStats`, `AgentStats`, `GitInfo`, `PhoenixExport`.

| Method | Path | Mô tả | Mã |
|---|---|---|---|
| GET | `/api/tasks?status&q&skill&from` | Lọc và tìm task (q tìm trong prompt, kết quả và mã task) | T-TC-08, T-SK-04 |
| GET | `/api/tasks/:id/diff` | Diff từng file task đã đổi, so với trạng thái thư mục trước task | T-TC-06 |
| POST | `/api/tasks/:id/resume` `{prompt}` | Tạo task mới tiếp tục session của task | T-TC-07 |
| GET | `/api/tasks/:id/usage` | Token của session của task | M-PF-02 |
| GET | `/api/sessions/:id/usage` | Token theo agent, đọc từ transcript | M-PF-02 |
| GET | `/api/sessions/:id/files` | Đọc / tạo / sửa file | M-TS-03 |
| GET | `/api/sessions/:id/invocations/:inv/transcript` | Hội thoại riêng của một agent | M-AM-04 |
| GET | `/api/toolcalls/:id` | Input, kết quả, exit code Bash, diff Edit/Write | M-TS-02/03 |
| GET | `/api/stats/tasks`, `/api/stats/agents` | Thống kê | M-PF-01, T-AG-04, M-PF-04 |
| GET | `/api/project/git` | Branch, ahead/behind, file chưa commit | T-PJ-02 |
| PUT | `/api/project` | Trả 409 khi còn task chạy hoặc chờ và đổi sang project khác | T-PJ-03 |
| PUT | `/api/projects/recent` `{remove}` | Bỏ một project khỏi danh sách | T-PJ-03 |
| GET | `/api/templates/content?path` | Nội dung template (chỉ đường dẫn có trong danh sách) | T-TP-01 |
| PUT | `/api/settings` | Kiểm tra và lưu S-03/S-04/S-05/S-06; 400 kèm lý do khi sai | S-03..06 |
| GET | `/api/logs?…&from&to` | Thêm lọc theo thời gian | M-LG-03 |
| POST | `/api/sessions/:id/phoenix` | Gửi trace OTLP/HTTP protobuf tới Phoenix | M-PF-05 |

Spool: khi không kết nối được backend, hook ghi body ingest vào `<studio home>/spool.jsonl` (tối đa 50 MB). Server nạp file này lúc khởi động và mỗi 30 giây, rồi xoá.
