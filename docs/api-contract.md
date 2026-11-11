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
  permission?: { toolName: string; title?: string; inputSummary: string; decisionReason?: string; suggestions?: unknown[] };
  // Chỉ có ở câu hỏi: chữ Claude viết (cùng luồng: main hoặc subagent đó) từ câu hỏi trước đến câu này, tối đa 8000 ký tự cuối.
  // "" = Claude không viết gì; không có field = không biết.
  context?: string; }
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

**Chi phí task (sửa 2026-11-11).** `total_cost_usd` của SDK là tổng luỹ kế của cả session (khi resume, SDK nạp lại tổng cũ), và `/compact` chạy sau task cũng cộng vào tổng đó.
- `Task.costUsd`: chi phí riêng của task = tổng luỹ kế sau task − `sessionCostUsd` của task trước cùng session. `null` khi task resume mà không biết tổng trước đó.
- `Task.compactCostUsd` (mới, không bắt buộc): chi phí `/compact` chạy **trước** task (trên session được resume), ghi riêng, không gộp vào `costUsd`.
- `Task.sessionCostUsd` (mới, không bắt buộc): tổng luỹ kế của session sau task; làm mốc cho task resume kế tiếp.
- `Task.contextTokens` (mới, không bắt buộc): kích thước ngữ cảnh ở lượt cuối của task (input + cache + output).

**Compact lúc cần (2026-11-11).** Không còn `/compact` sau mỗi task. Ngay trước khi một task resume session, nếu `TaskDefaults.compactAfter` bật và `contextTokens` gần nhất của session ≥ `TaskDefaults.compactMinTokens` (mới, không bắt buộc, mặc định 100000, hợp lệ 10000–1000000), runner chạy `/compact` rồi mới chạy task. Không biết kích thước (task cũ) thì compact như trước. `PUT /api/settings` trả 400 khi ngưỡng sai.
- Tổng chi phí của chuỗi và `TaskStats.totalCostUsd` = Σ(`costUsd` + `compactCostUsd`). Task ghi trước ngày này vẫn giữ số luỹ kế cũ (không chuyển đổi).

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

## 6. Bản đồ code (graphify, Bước 1, 2026-11-11)

Studio gọi graphify từ ngoài project; không cài gì vào project game. Dữ liệu nằm ở `<studio home>/projects/<projectId>/graphify` (`projectId` = sha1 của đường dẫn project viết thường, 16 ký tự, như Quét game). Mọi lệnh chạy với `GRAPHIFY_OUT` trỏ tới đó, `GRAPHIFY_BACKEND=none`, `GRAPHIFY_QUERY_LOG_DISABLE=1`, cwd là thư mục cha của `GRAPHIFY_OUT`. Chỉ dùng `graphify update` và `graphify query`; không dùng `extract`.

Kiểu mới trong `packages/shared`: `GraphSettings`, `GraphProjectSettings` (`StudioSettings.graphify`), `GraphState`, `GraphStatus`, `PipelineGraphContext`, `NewPipeline.codeKeywords`, `Pipeline.codeKeywords`, `Pipeline.graph`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/graph` | `GraphStatus` của project hiện tại |
| POST | `/api/graph/build` | Dựng lại toàn bộ (có phân cụm) vào thư mục tạm rồi thay thư mục cũ. 409 khi đang dựng hoặc cập nhật; 400 khi chưa có project hay thiếu graphify |
| POST | `/api/doctor` | Thêm mục `graphify`: phiên bản và `graphify-mcp` trả lời MCP `initialize` (cần đồ thị có sẵn) |
| POST | `/api/doctor` | Thêm mục `unity-mcp`: server Unity MCP khai báo cho Claude Code (local > `.mcp.json` > user) trả lời MCP `initialize` và có Unity Editor nối vào (`mcpforunity://instances`). `ok: null` khi Editor đang nối khác tên project, khi khai báo kiểu stdio, hoặc URL không nằm trên máy. `POST /api/scan` kiểm như vậy trước, `ok: false` thì trả 400, không tạo task |
| PUT | `/api/settings` | `graphify.enabled`, `graphify.budget` (200–20000), `graphify.projects[projectId] = {excludes, includePlugins}`. Mục loại trừ là đường dẫn tương đối, không có `..`, không tuyệt đối; 400 khi sai |

WebSocket: `graph:upsert` → `GraphStatus`.

- **Loại trừ:** mặc định `Library/ Temp/ Logs/ obj/ Build/ Builds/ UserSettings/ *.meta *.csproj *.sln *.slnx .claude/ .agents/`, thêm `Assets/Plugins/` trừ khi `includePlugins`, rồi thêm `excludes` của project. Ghi vào `<GRAPHIFY_OUT>/.graphify_build.json` trước mỗi lần chạy (`update` 0.9.103 không có `--exclude`).
- **Trạng thái:** `missing` (chưa có đồ thị), `building`, `ready`, `stale` (HEAD khác commit lúc dựng, task đã đổi file code mà chưa cập nhật xong, danh sách loại trừ đã đổi, hoặc đồ thị có sẵn mà không do Studio dựng), `error` (lần dựng cuối lỗi). Trạng thái lưu ở `<studio home>/projects/<projectId>/graph-status.json`.
- **Tự cập nhật:** task kết thúc có `changedFiles` chứa file code (`.cs .js .ts .py …`) → `graphify update --no-cluster --force` ở nền, không chặn hàng đợi; lỗi chỉ ghi log `warn`. Không chạy hai lệnh graphify cùng lúc cho một project; yêu cầu đến khi đang chạy được gộp thành một lần chạy sau.
- **Tra sẵn cho planner:** khi tạo pipeline, từ khoá lấy từ `codeKeywords` nếu có (tách theo dấu phẩy/khoảng trắng, tối đa 8), nếu không thì tách định danh PascalCase/camelCase trong câu yêu cầu (có chữ thường đứng trước chữ hoa, ví dụ `PiggyBank`, `claimDaily`; tách cả `A.B`; tối đa 6). Không có từ khoá → `graph.status = 'skipped'`. Có từ khoá và đồ thị `ready`/`stale`, đang bật → server chạy `graphify query "<từ khoá>" --budget <budget / số từ khoá, tối thiểu 300>` cho từng từ khoá (mỗi lệnh tối đa 15 giây, cả lượt tối đa 45 giây). Mã 3 (tên trùng) → chạy lại với `--seed` là tối đa 3 node id ứng viên; mã 4 → ghi "không thấy". Kết quả được chèn vào prompt planner thành mục "Code map". Trong lúc tra, pipeline ở `planning` với `planTaskId = null` và `graph = null`.
- **MCP graphify cho mọi task (A7, brief 6.2; mở rộng 2026-11-11):** ngay trước khi **bất kỳ task nào** chạy (planner, phản biện, các bước của chuỗi, quét game, task chạy tay), server gắn `mcpServers.graphify = {type:'stdio', command:'graphify-mcp', args:[<graph.json>], env:{GRAPHIFY_OUT, GRAPHIFY_BACKEND, GRAPHIFY_QUERY_LOG_DISABLE, GRAPHIFY_NO_TIPS, PYTHONIOENCODING}, alwaysLoad:true}`.
  - Chỉ gắn khi đang bật, có graphify, đồ thị `ready`/`stale` do Studio dựng (`builtAt` có giá trị), và `graphify-mcp` không báo lỗi. Lỗi khi chuẩn bị MCP không chặn task: task chạy không có MCP.
  - `allowedTools` = 7 tool chỉ đọc (`mcp__graphify__query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`). `disallowedTools` = 3 tool PR gọi GitHub (`list_prs`, `get_pr_impact`, `triage_prs`).
  - **System prompt** `CODE_TOOLS_HINT` (SDK `systemPrompt` dạng chuỗi, cùng nhánh với mặc định là chuỗi rỗng; thêm `appendSubagentSystemPrompt` cho subagent). Nội dung: khi cần tìm hoặc hiểu code thì tra graphify trước rồi Read đúng khoảng dòng; Grep/Glob chỉ cho code vừa viết, file không phải code, hoặc tìm chuỗi; không bắt tra khi task không đụng code. Không chèn vào prompt của task. SDK ghi lại system prompt theo session: task tiếp tục một session cũ giữ system prompt lúc session bắt đầu.
  - `Task.mcp: TaskMcp | null` (cột `tasks.mcp`, JSON): `{servers: string[], note: string | null, calls: Record<string, number> | null}`. `servers` rỗng và `note` là lý do khi không gắn. `calls` đếm khi task kết thúc, từ event `PreToolUse` có `task_id` của task (kể cả subagent) và `tool_name` bắt đầu bằng `mcp__<server>__`; `null` khi đang chạy. Task chạy trước thay đổi này có `mcp = null`.
  - Task planner của pipeline đang `planning` còn ghi vào `Pipeline.graph.mcp` (`true`/`false`), `mcpDetail` (lý do) và `mcpCalls` (số lần gọi tool graphify của lần lập kế hoạch gần nhất; `null` khi đang chạy).

Spool: khi không kết nối được backend, hook ghi body ingest vào `<studio home>/spool.jsonl` (tối đa 50 MB). Server nạp file này lúc khởi động và mỗi 30 giây, rồi xoá.

## 7. Vai trò trong kế hoạch (2026-11-11)

Danh sách vai trò nằm ở `apps/server/plugin/plan-roles.yaml`. Mỗi vai trò có `id`, `title`, `hint` và `skills`; mỗi skill thuộc một vai trò. Nếu thiếu file hoặc file hỏng thì không có vai trò nào: form ẩn ô chọn và không lọc gì.

Kiểu mới trong `packages/shared`: `PlanRoleInfo {id, title, hint, skills}`, `NewPipeline.roles?: string[]`, `Pipeline.roles?: string[] | null`, `PlanStep.role?: string | null`.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/pipelines/roles` | `PlanRoleInfo[]` theo thứ tự trong file |
| POST | `/api/pipelines` | Thêm trường `roles` (không bắt buộc) |

- **`roles` khi tạo chuỗi:** id lạ bị bỏ, id trùng bị gộp. Nếu gửi mảng mà không còn id hợp lệ nào thì trả 400 "Chọn ít nhất một vai trò". Không gửi `roles` thì lưu `null`, nghĩa là mọi vai trò. Chọn hết vai trò cũng không lọc gì.
- **Prompt planner:** liệt kê các vai trò kèm skill, và các vai trò người dùng đã chọn. Planner chỉ lên bước cho các vai trò đó; bước trong mẫu thuộc vai trò khác thì đưa vào `omitted`. Mỗi bước trả thêm `"role"`. Prompt phản biện và lập lại kế hoạch cũng có danh sách vai trò đã chọn.
- **`PlanStep.role`:** server giữ giá trị planner hoặc người dùng đưa nếu đó là id hợp lệ. Nếu không, server lấy vai trò của skill (lúc kiểm luật và mỗi lần lưu chuỗi), nên bước story và bước sửa do Studio thêm cũng có vai trò. `PUT /api/pipelines/:id/steps` nhận `role` cho từng bước.
- **Kiểm luật (`PlanIssue.rule = 'role'`):**
  - Bước bắt buộc của mẫu thuộc vai trò không chọn thì chỉ là `info` "Bỏ /x: không chọn vai trò Y", không còn `error`.
  - Bước còn chờ thuộc vai trò không chọn thì là `warn`.
  - Studio không tự chèn `studio:unity-art-context` khi vai trò Art không được chọn.

## 8. Lập kế hoạch lại và lỗi task (2026-11-11)

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/pipelines/:id/restart-plan` | Lập kế hoạch lại từ đầu, trả `Pipeline` ở trạng thái `planning` |

- **Chỉ dùng được khi:** chuỗi đang `failed` hoặc `cancelled`, và chưa bước nào có task. Trái điều kiện thì trả 400. Nếu đã chạy bước thì dùng `/replan`.
- **Điều kiện giống lúc tạo chuỗi:** project đã chạy `/start` và đã quét game xong.
- **Giữ nguyên:** `request`, `mode`, `permissionMode`, `model`, `rigor`, `roles`, `codeKeywords`, `critic`.
- **Xoá:** kế hoạch cũ (`steps`, `summary`, `issues`, `planType`, `slug`, `omitted`, `edited`), phản biện (`critiques`), `checkpoint`, `replans`, `error`.
- **Session và bản đồ code:** task planner mới mở session mới (không resume). Bản đồ code được tra lại như khi tạo chuỗi.
- **Chi phí:** id của task planner và task phản biện cũ được dồn vào `planTasks`, nên chi phí của chuỗi vẫn tính cả chúng.

**`Task.error` khi Claude Code báo lỗi kèm `subtype: "success"`:** ví dụ hết hạn mức ("You've hit your weekly limit · resets …"). Khi đó `error` lấy câu Claude trả về (`result`). Nếu `result` rỗng thì lấy `errors`. Trước đây trường này chỉ ghi chữ `success`. Các `subtype` khác vẫn ghi `<subtype>: <errors>`.

## 9. Cài package (2026-11-11)

Màn **Hệ thống → Cài package** (`/setup`). Lệnh cài cố định trong `apps/server/src/system/packages.ts`; client chỉ gửi `id`, không gửi được lệnh. Mỗi lần chỉ chạy một lệnh cài. Nút cài chỉ có trên Windows.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/setup/packages` | `SetupState {platform, packages: SetupPackage[], job: SetupJob \| null}`. Đọc lại PATH từ registry trước khi kiểm tra |
| POST | `/api/setup/packages/:id/install` | Chạy lệnh cài, trả `SetupJob` (`running`). 400: id lạ, package Studio không tự cài được, hoặc thiếu package cần trước (graphify cần uv). 409: đang cài package khác |
| POST | `/api/setup/job/cancel` | Dừng lệnh đang chạy (`taskkill /T /F`). 400 khi không có lệnh nào chạy |
| POST | `/api/setup/login` | Mở cửa sổ terminal chạy `claude` để gõ `/login` |

- **Package và lệnh:** `claude` (installer `irm https://claude.ai/install.ps1 | iex`), `git` (winget `Git.Git`), `vsbuild` (winget `Microsoft.VisualStudio.2022.BuildTools`, hỏi lại trước khi cài), `uv` (installer `astral.sh/uv/install.ps1`), `graphify` (`uv tool install --force graphifyy[mcp]==0.9.103`). `node`, `login`, `unity-mcp` chỉ kiểm tra, không cài.
- **Live:** event `setup:job` gửi cả `SetupJob` (log tối đa 400 dòng, đã bỏ mã ANSI và dòng thanh tiến độ), gửi tối đa mỗi 300 ms khi có log mới và ngay khi đổi trạng thái.
- **Sau khi cài xong:** server đọc lại PATH để lệnh mới dùng được ngay. Cài lại Claude Code thì Studio đọc lại phiên bản Claude. Thời gian tối đa mỗi lệnh 45 phút.

## 10. Tệp đính kèm (2026-11-11)

Đính kèm ảnh hoặc tệp vào **Task Center** (tạo task, tiếp tục session) và **Lập kế hoạch → Yêu cầu mới**. Web tải từng tệp lên ngay khi chọn, kéo thả hoặc Ctrl+V. Form chỉ gửi danh sách `id`.

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/attachments` `{name, data}` | `data` là tệp mã hoá base64. Trả `Attachment {id, name, size, mime, path}`. 400: loại tệp không nhận, tệp rỗng, hoặc quá 10 MB |
| GET | `/api/attachments/:id/file` | Trả tệp với `Content-Type` theo đuôi, `nosniff`, `inline`. Dùng cho ảnh thu nhỏ. 404 khi id lạ |

- **Loại tệp nhận:** png, jpg, jpeg, gif, webp, pdf, md, txt, csv, json (`ATTACH_TYPES` trong shared). Không nhận `.xlsx`, vì Claude không đọc trực tiếp được. Tối đa 10 tệp mỗi lệnh (`ATTACH_MAX_FILES`), mỗi tệp tối đa 10 MB (`ATTACH_MAX_BYTES`).
- **Chỗ lưu:** `~/.ccgs-studio/attachments/<id>/<tên>`, không ghi vào project game. Tên tệp bỏ thư mục và các ký tự Windows không cho phép, dài tối đa 120 ký tự. Tệp được giữ lại, không tự xoá theo task.
- **Body có thêm `attachments?: string[]`:** `POST /api/tasks` (`NewTask`), `POST /api/tasks/:id/resume`, `POST /api/pipelines` (`NewPipeline`). Id lạ hoặc tệp đã bị xoá thì trả 400.
- **Lưu lại:** `Task.attachments: Attachment[] | null` ở cột `tasks.attachments`. `Pipeline.attachments?: Attachment[]`.
- **Gửi cho Claude:** `prompt` lưu trong DB giữ nguyên. Runner nối thêm đoạn "Attached files: …" kèm đường dẫn từng tệp vào prompt gửi SDK, rồi thêm thư mục chứa tệp vào `additionalDirectories`. Nhờ vậy Claude mở được tệp bằng `Read` mà không phải hỏi quyền. Với task skill, đoạn này nằm sau tham số.
- **Kế hoạch:** tệp đính kèm được đưa vào task planner, task phản biện và mọi bước khi chạy. Không đưa vào lượt sửa kế hoạch (`/revise`, `/replan`), vì các lượt này resume session đã có tệp.
- **Web:** `@ccgs/shared` giờ có hằng số chạy lúc runtime. Vì vậy `vite.config.ts` trỏ alias `@ccgs/shared` sang `packages/shared/src/index.ts`; bản dist CommonJS chỉ dành cho server.
