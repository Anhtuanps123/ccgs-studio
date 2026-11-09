# Phase 0 – Báo cáo phân tích

Ngày: 2026-11-09. Môi trường kiểm chứng: Windows 11, Node 24.21.0, Claude Code **2.1.319**, `@anthropic-ai/claude-agent-sdk` **0.3.319**, project thử **D:\Meodoku** (Unity 6000.0.81f1, CCGS v1.2.0 commit 05ad7c8).

Bằng chứng nằm trong repo:

| File | Nội dung |
|---|---|
| `docs/evidence/inventory.json` | Kết quả `spikes/inventory.mjs` trên `.claude/` thật |
| `docs/evidence/hook-payloads.md` | Payload hook thật, mỗi loại một mẫu, đã che đường dẫn user và cắt chuỗi dài |
| `docs/evidence/capture-settings.json` | File `--settings` dùng để bắt event, không đụng file của CCGS |
| `spikes/capture-hook.mjs`, `spikes/sdk-spike.mjs` | Script thử nghiệm (không phải code ứng dụng) |
| `spikes/captures/*.jsonl` | Dữ liệu thô chưa che, **gitignored** |

Các kịch bản đã chạy:

| Mã | Mô tả | Kết quả |
|---|---|---|
| S1 | `claude -p`, một prompt, một tool Read | 6 event |
| S2 | 2 subagent `general-purpose` chạy song song | 16 event, có bước chồng thời gian |
| S3 | `unity-specialist` gọi tiếp subagent `Explore` (lồng 2 cấp) | 14 event, **lồng nhau chạy được** |
| SDK-ask | AskUserQuestion và yêu cầu quyền Write (bị từ chối) qua `canUseTool` | Thành công |
| SDK-resume | Resume session của SDK-ask | Model nhớ câu trả lời |
| SDK-interrupt | `q.interrupt()` khi Bash đang chạy | Session kết thúc, result `error_during_execution` |

---

## 1. Cấu trúc repo CCGS thực tế (Meodoku)

```
.claude/
  agents/        49 file .md (frontmatter YAML + thân markdown)
  skills/        110 thư mục: 74 của CCGS + 2 thư mục thật không thuộc CCGS + 34 symlink trỏ sang .agents/skills/
                 mỗi thư mục có SKILL.md (+ CONTRACT.md, references/), riêng unity-ecs-patterns không có SKILL.md
  rules/         14 file .md, frontmatter `paths:` (danh sách glob)
  hooks/         18 script bash (.sh)
  scripts/       35 script bash/awk, là helper, không phải hook
  docs/          tài liệu tham chiếu, gồm templates/ (71 file), agent-roster.md, workflow-catalog.yaml
  settings.json  hooks (8 event, 15 lệnh), permissions, statusLine (CCGS)
  settings.local.json  của người dùng, đang có permissions.allow và additionalDirectories (KHÔNG có hooks)
  statusline.sh
CLAUDE.md, project.yaml (gốc project)
```

**Phát hiện ảnh hưởng thiết kế:**

- **Skill là symlink.** Adapter phải đi theo symlink (`fs.stat`, không dùng `Dirent.isDirectory()`) và hiển thị nguồn (CCGS / local / symlink). Watcher cũng phải theo dõi thư mục đích của symlink.
- **"Số skill khớp số file" cần định nghĩa lại:** đếm thư mục có `SKILL.md` (109) và đánh dấu riêng thư mục thiếu `SKILL.md` (1).
- **Phân cấp agent không có trong frontmatter.** Nó nằm trong các bảng của `.claude/docs/agent-roster.md` (Tier 1/2/3, Engine Leads, Sub-Specialists). Tổng số hàng trong bảng là 56, nhiều hơn 49 file, nên phải đối chiếu theo tên. Agent không có trong roster thì xếp vào nhóm "Khác".
- **Workflow có định nghĩa dạng file:** `.claude/docs/workflow-catalog.yaml` gồm các phase và step, mỗi step có artifact check, `required`, `repeatable`. Như vậy T-WF-01 làm được: hiển thị phase và step, chạy step bằng skill tương ứng.

## 2. Danh sách thành phần

Chi tiết từng mục có trong `docs/evidence/inventory.json`.

| Loại | Số lượng | Trường đọc được |
|---|---|---|
| Agents | 49 | `name, description, tools, model, maxTurns` (49/49); `disallowedTools` (15), `memory` (17), `skills` (5), `isolation` (1) |
| Model của agent | inherit 30, sonnet 16, opus 3 | |
| Agent có tool `Agent` (gọi được subagent) | 3 | `godot-specialist`, `unity-specialist`, `unreal-specialist` |
| Skills | 110 thư mục (109 có SKILL.md) | `name, description` (109); `argument-hint, user-invocable, model` (74, nhóm CCGS); `allowed-tools` (78); `disable-model-invocation` (5) |
| Skill gọi agent bằng `subagent_type:` viết thẳng | 11 | Các skill khác (khoảng 30) mô tả việc spawn agent bằng văn xuôi |
| Rules | 14 | `paths:` (glob gồm cả Godot `src/`, Unity `Assets/`, Unreal `Source/`) |
| Hooks của CCGS | 15 lệnh / 8 event | SessionStart×2, PreToolUse×5 (Bash\|PowerShell, Write\|Edit, Read), PostToolUse×2, Notification, PreCompact, Stop, SubagentStart, SubagentStop×2 |
| Templates | 71 | `.claude/docs/templates/**` (.md/.yaml/.json) |
| Workflows | 1 catalog | `workflow-catalog.yaml` |

## 3. Cơ chế agent và cách giao việc

- **Main session là "điều phối viên".** Khi người dùng gõ `/skill`, nội dung `SKILL.md` được nạp vào main session (`skill: /dev-story` có `allowed-tools: … Agent, AskUserQuestion …` và `model: sonnet`). Main session tự gọi tool `Agent` với `subagent_type` là tên agent.
- **Đã kiểm chứng:** tool tên là **`Agent`** (không phải `Task`); input là `{description, prompt, subagent_type, run_in_background}` (mẫu ở PreToolUse:Agent).
- **Subagent lồng nhau ĐƯỢC hỗ trợ (S3).** `unity-specialist` gọi `Explore`; `meta.json` của subagent con ghi `spawnDepth: 2` và `parentAgentId`. Giả định trong bản mẫu ("cây chỉ sâu một cấp") **sai**, nên M-AM-03 phải hiển thị cây nhiều cấp.
- Agent có thể chạy nền (`run_in_background`). Trường hợp này kết quả về sau qua `task_notification`; chưa kiểm chứng sâu, ghi vào rủi ro R6.
- Hook của CCGS (`log-agent.sh`, `log-agent-stop.sh`) đã ghi log agent vào `production/session-logs/`. Studio không dùng nguồn này mà tự bắt event, để không phụ thuộc định dạng log nội bộ của CCGS.

## 4. Payload hook thật và khả năng gắn tool call với subagent

Mẫu đầy đủ: `docs/evidence/hook-payloads.md`.

**Trường chung:** `session_id, transcript_path, cwd, hook_event_name`; từ UserPromptSubmit trở đi có thêm `prompt_id, permission_mode, effort`.

| Event | Trường riêng quan trọng | Có bắn ra? |
|---|---|---|
| SessionStart | `source` (startup/resume…) | Có |
| UserPromptSubmit | `prompt` | Có |
| PreToolUse | `tool_name, tool_input, tool_use_id` | Có |
| PostToolUse | thêm `tool_response, duration_ms` | Có |
| SubagentStart | `agent_id, agent_type`, **không có `tool_use_id`** | Có |
| SubagentStop | `agent_id, agent_type, agent_transcript_path, last_assistant_message` | Có |
| PermissionRequest | `tool_name, tool_input, permission_suggestions` | Có (kể cả AskUserQuestion) |
| Stop | `last_assistant_message, stop_hook_active` | Có, **không** bắn khi bị interrupt |
| SessionEnd | `reason` | Có, cả khi bị interrupt |
| Notification, PreCompact, PostToolUseFailure, PermissionDenied, StopFailure | | Đã đăng ký nhưng không bắn trong các kịch bản headless. PreCompact có chạy trong session tương tác này (log của hook CCGS) nhưng payload chưa bắt được |

**Kết luận về câu hỏi quan trọng nhất của dự án: CÓ gắn được, kể cả khi chạy song song.**

1. Mọi event phát ra **bên trong** subagent (PreToolUse, PostToolUse, kể cả PreToolUse:Agent lồng) đều có `agent_id` và `agent_type`. Event của main session thì không có hai trường này. S2 cho thấy 2 subagent chạy xen kẽ và vẫn phân biệt đúng theo `agent_id`.
2. Nối invocation với lời gọi cha: `PostToolUse(Agent).tool_response.agentId` bằng `agent_id`, và `tool_use_id` của lời gọi đó là khoá. `subagents/agent-<id>.meta.json` cũng có `toolUseId`, `parentAgentId`, `spawnDepth`.
3. Trong lúc subagent **đang chạy** (chưa có PostToolUse), SubagentStart không mang `tool_use_id`. Ghép SubagentStart với PreToolUse(Agent) đang chờ theo: cùng `session_id` + cùng tác nhân gọi (`agent_id` của event PreToolUse, rỗng là main) + `agent_type == subagent_type` + thứ tự FIFO. Khi có hai lời gọi song song cùng kiểu thì ghép tạm theo FIFO; PostToolUse hoặc `meta.json` sẽ sửa lại cho chính xác. Cách khác: đọc `meta.json` ngay khi SubagentStart đến (file có `toolUseId`), cần kiểm chứng thời điểm file được ghi ở Phase 2.
4. Thời lượng invocation lấy theo SubagentStart → SubagentStop (đồng hồ hook). `tool_response.totalDurationMs` cũng có sẵn và khớp `duration_ms` (S3: 9014 so với 9016 ms).
5. **Gắn với task:** biến `CCGS_STUDIO_TASK_ID` truyền vào tiến trình `claude` được hook kế thừa (100% event của S1–S3 và SDK đều có giá trị đúng). Session không có biến này thì gắn nhãn `External`.

**Hiệu năng hook:** script Node chạy mất 4–13 ms. Tính cả thời gian khởi động `node` thì tổng khoảng **90–110 ms mỗi event** trên máy này, dưới mức 1 giây nhưng cộng dồn vì mỗi tool call bắn 2 event. Khi một hook lỗi, Claude Code vẫn chạy tiếp (CCGS cũng có hook bash `timeout` 5–15 giây).

## 5. Transcript JSONL và nguồn token

- Main: `~/.claude/projects/<slug>/<session_id>.jsonl`, slug là `d--Meodoku` (từ `cwd`).
- Subagent: `~/.claude/projects/<slug>/<session_id>/subagents/agent-<agent_id>.jsonl` kèm `agent-<agent_id>.meta.json` (`agentType, description, toolUseId, parentAgentId, spawnDepth, finished`).
- Có nhiều loại record: `user, assistant, attachment, system, api-request*, file-history-snapshot, queue-operation, ai-title, tools-used, cost-state, last-prompt…`. Reader chỉ đọc `user` và `assistant` và **bỏ qua loại lạ**.
- Token nằm ở `assistant.message.usage` (`input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens`, …).
- **Bẫy:** một message API bị tách thành nhiều dòng `assistant` (mỗi content block một dòng) và **lặp lại cùng `usage`** (S3: 3 dòng nhưng chỉ 2 `message.id`). Phải khử trùng theo `message.id` (hoặc `requestId`) trước khi cộng, nếu không token bị đếm thừa.
- Token của subagent: đọc transcript riêng của nó. `PostToolUse(Agent).tool_response.usage/totalTokens` có thể dùng để đối chiếu.
- Luồng stream của SDK/CLI cũng có `result.usage`, `modelUsage`, `total_cost_usd` (giá niêm yết, nên ghi là "ước tính").

## 6. Agent SDK hay CLI headless

| Tiêu chí | Agent SDK (TS) | CLI `-p --output-format stream-json` |
|---|---|---|
| AskUserQuestion | **Đạt**: `canUseTool('AskUserQuestion', {questions})` → trả `{behavior:'allow', updatedInput:{questions, answers:{[question]: label}}}`. Đã thử, model nhận "Blue" | `-p` thuần không có chỗ hỏi; phải tự dựng `--permission-prompt-tool` (MCP) hoặc stdin stream-json control protocol, tức là tự làm lại việc SDK đã làm |
| Yêu cầu cấp quyền | **Đạt**: `canUseTool` nhận `toolUseID, decisionReason, suggestions, title, displayName, blockedPath`; deny xuất hiện trong `result.permission_denials` | Như trên |
| Resume | **Đạt**: `options.resume = session_id` | `--resume` |
| Dừng giữa chừng | **Đạt**: `q.interrupt()` → result `error_during_execution`, SessionEnd `reason: other`. **Lưu ý:** iterator **ném lỗi** sau đó, nên Process Manager phải bắt lỗi và đánh dấu `cancelled`. `abortController` dùng để kill hẳn | Kill tiến trình |
| Giữ hành vi CCGS | **Đạt**: `settingSources:['user','project','local']` nạp CLAUDE.md, hooks và agents của CCGS (hook SessionStart của CCGS chạy trong stream) | Đạt |
| Thêm hook của Studio cho task do Studio chạy | `settings: <path>` **gộp thêm** vào hook của project, không ghi file nào | `--settings <path>`, đã kiểm chứng gộp được |

**Chọn: Claude Agent SDK** chạy trong process NestJS. CLI headless chỉ dùng làm phương án dự phòng khi SDK lỗi.

Hệ quả cho kiến trúc:

- Task do Studio chạy **không cần** cài hook vào `settings.local.json`: SDK truyền `settings` là file hook của Studio. Hook trong `settings.local.json` (T-HK-02) chỉ cần cho session `External` mở từ terminal.
- **Không cài cả hai cùng lúc cho một session**, nếu không event bị gửi đôi. Collector khử trùng theo (`session_id`, `hook_event_name`, `tool_use_id`|`agent_id`, timestamp) cho chắc.
- `canUseTool` còn đi kèm stream message nên có `parent_tool_use_id`. Nhờ vậy cả nội dung hội thoại của subagent cũng gắn được (S2: message có `parent_tool_use_id` = id lời gọi Agent).

## 7. Đánh giá Arize Phoenix

- Claude Code có OpenTelemetry tích hợp: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, **`OTEL_TRACES_EXPORTER`** (kèm cờ `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, tìm thấy trong bundle SDK 0.3.319). Metrics có `claude_code.token`, `claude_code.cost`, `claude_code.session`, … **Chưa kiểm chứng** trace xuất ra có đủ span cho subagent hay không, việc này để Phase 5.
- Phương án chắc chắn hơn: Studio tự dựng span từ dữ liệu đã chuẩn hoá. Session là root span; mỗi AgentInvocation là một span con (cha theo `parentAgentId`); mỗi ToolCall là span lá có `duration_ms`. Token lấy từ transcript, gửi OTLP/HTTP tới Phoenix (`:6006/v1/traces`). Dữ liệu đã có đủ.
- **Lưu ý:** bộ `ccgs-phoenix-tracing` có sẵn trong Downloads ghi thẳng vào `.claude/settings.json` của CCGS, vi phạm nguyên tắc 2 của brief. Không dùng lại cách cài đó.

## 8. Bảng ánh xạ tính năng P0 sang nguồn dữ liệu

| Mã | Nguồn | Trạng thái |
|---|---|---|
| T-DB-01 | `claude --version`; kiểm tra hook bằng settings của project; event cuối trong DB | Khả thi |
| T-DB-02 | Adapter đếm `.claude/` (theo §1) | Khả thi, đếm theo định nghĩa mới |
| T-DB-03 | Process Manager + bảng AgentInvocation | Khả thi |
| T-AG-01/02 | Frontmatter agent + `agent-roster.md` để lấy cấp | Khả thi |
| T-SK-01/02 | `SKILL.md` frontmatter (`argument-hint` là tham số); agent liên quan lấy từ `subagent_type:` và tên agent nhắc trong văn bản | Khả thi. Phần "agent liên quan" là **suy ra từ văn bản**, phải ghi rõ trên UI |
| T-SK-03 | SDK `query({prompt:'/skill args'})` | Khả thi. Cần kiểm chứng ở Phase 3 rằng slash command chạy qua SDK prompt |
| T-HK-01 | `settings.json` (CCGS) tách khỏi các mục có marker của Studio trong `settings.local.json` | Khả thi |
| T-HK-02 | Ghi `settings.local.json` (merge, backup, gỡ đúng phần đã thêm) | Khả thi |
| T-PJ-01 | Có `.claude/` + `CLAUDE.md`/`project.yaml` | Khả thi |
| T-TC-01..03 | SDK `query`, hàng đợi trong backend, `interrupt()`/abort | Khả thi |
| T-TC-04 | `canUseTool` (AskUserQuestion, quyền) | Khả thi, đã kiểm chứng |
| T-TC-05 | `result.result` + `git status --porcelain` trước và sau | Khả thi. Diff "trước và sau" bị lẫn thay đổi của người dùng nếu họ sửa song song (R8) |
| M-LS-01/02 | Hook (UserPromptSubmit, Pre/PostToolUse, Stop) + transcript/stream cho văn bản trả lời | Khả thi |
| M-AM-01/02 | SubagentStart/Stop + PostToolUse(Agent), quy tắc §4 | Khả thi. `unknown` khi có Start mà không có Stop và session đã kết thúc |
| M-TL-01 | Thời điểm Pre/Post và Start/Stop | Khả thi |
| M-TS-01 | Pre/PostToolUse + `agent_id` | Khả thi |
| M-LG-01 | Log của Studio, stderr (CLI)/lỗi SDK, lỗi hook (spool), tool lỗi | Khả thi |
| M-LG-02 | Redactor chạy trước khi ghi DB | Khả thi. Xem R3 |
| S-01/S-02 | `which claude`, `claude --version`, gửi event test vào `/ingest`, ghi thử DB | Khả thi. Kiểm tra "đã đăng nhập" dùng `claude -p` rẻ hoặc `auth status` nếu có; chốt ở Phase 2 |

Không còn mục P0 nào ở trạng thái "giả định". Ba điểm còn phải kiểm chứng tiếp (đã nêu trong bảng: slash command qua SDK, thời điểm ghi `meta.json`, cách kiểm tra đăng nhập) đều có phương án dự phòng và không chặn thiết kế.

## 9. Rủi ro và hạn chế

| # | Rủi ro | Đề xuất |
|---|---|---|
| R1 | **Workspace chưa được trust ở chế độ `-p`:** "Ignoring 3 permissions.allow entries from .claude/settings.json". CCGS chạy qua Studio sẽ hỏi quyền nhiều hơn khi chạy tương tác. Memory ghi nhận key `d:/` và `D:/` trong `~/.claude.json` từng lệch nhau | S-02 kiểm tra trust và hướng dẫn mở `claude` tương tác một lần. Không tự sửa `~/.claude.json` |
| R2 | Subagent lồng nhau làm cây nhiều cấp; bản mẫu giả định một cấp | Mô hình `parent_invocation_id` đệ quy; UI thụt lề theo `spawnDepth` |
| R3 | Payload chứa nội dung file (`tool_response.file.content`), prompt, đường dẫn; stream có `credential_expires_at`. Đường dẫn Windows có nhiều kiểu escape (`\`, `\\`, `/`) nên regex dễ sót (đã gặp khi tạo evidence) | Redactor: bộ mẫu bí mật + chuẩn hoá đường dẫn trước khi so mẫu + cắt `tool_response` theo giới hạn; test bằng payload thật |
| R4 | Mỗi event hook tốn ~100 ms vì khởi động Node; tool call dày thì cộng dồn | Hook chỉ đọc stdin rồi POST (không require nặng), timeout 500 ms. Phase 4 cân nhắc tuỳ chọn hook `async` nếu phiên bản hỗ trợ (chưa kiểm chứng) |
| R5 | Interrupt không bắn Stop/PostToolUse; tool đang chạy bị bỏ dở | SessionEnd đóng mọi invocation và tool call còn mở thành `cancelled` (task do Studio dừng) hoặc `unknown` (External) |
| R6 | Agent chạy nền (`run_in_background`) kết thúc sau Stop của lượt | Giữ invocation mở tới SubagentStop; chưa kiểm chứng, đưa vào test Phase 2 |
| R7 | Windows: kill tiến trình phải kill cả cây (bash con). Spike interrupt không để lại tiến trình mồ côi, nhưng chưa thử với lệnh chạy lâu hơn | Phase 3: abort SDK + `taskkill /T` dự phòng, có test |
| R8 | Meodoku đang có nhiều file chưa commit, nên tiêu chí "git status sạch" (Phase 1) và "file task đã đổi" không đo trực tiếp được | Snapshot `git status --porcelain` + hash trước và sau; tiêu chí Phase 1 đổi thành "không phát sinh thay đổi mới" |
| R9 | Session do Studio chạy mà `settings.local.json` cũng có hook thì event bị nhân đôi | Hook gửi kèm `source=studio-settings|local-settings`; collector khử trùng |
| R10 | Hook của CCGS là bash; thiếu Git Bash thì hook CCGS lỗi (không ảnh hưởng Studio) | S-02 cảnh báo |
| R11 | Định dạng transcript không có tài liệu chính thức và có nhiều loại record nội bộ | Reader khoan dung: chỉ đọc `user`/`assistant`/`usage`, bỏ qua loại lạ, ghi phiên bản Claude Code vào session |
| R12 | Chạy spike làm hook CCGS ghi vào `production/session-logs/` của Meodoku | Chấp nhận (đây là hành vi CCGS); khuyến nghị gitignore như đã đề xuất trước đó |

## 10. Hợp đồng API

Bản nháp: `docs/api-contract.md`.

## Đề xuất điều chỉnh brief (cần duyệt)

1. **Phase 1, tiêu chí "git status sạch"** đổi thành "không phát sinh thay đổi so với snapshot trước khi chạy" (R8).
2. **Cài hook** (T-HK-02) chỉ dành cho session External. Task do Studio chạy dùng `settings` của SDK, không ghi file.
3. **Cây agent nhiều cấp** (M-AM-03) thay cho giả định một cấp.
4. **ORM: Drizzle + better-sqlite3.** Đồng bộ, nhanh, schema là TypeScript nên dùng chung được với `packages/shared`, không cần engine nhị phân như Prisma. Cần build native trên Windows (Node 24 có prebuild).
