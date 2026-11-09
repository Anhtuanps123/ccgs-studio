# CCGS Studio – Brief cho AI Development Agent

Tài liệu này là yêu cầu chính thức để xây dựng CCGS Studio. Đọc hết trước khi làm bất cứ việc gì.

Kèm theo tài liệu này là file `ccgs-studio-prototype.html`: bản mẫu giao diện đã được duyệt, chạy bằng dữ liệu giả. Đặt nó vào `docs/ui-prototype.html` trong repo và dùng làm chuẩn cho bố cục, tên màn hình, câu chữ và hành vi tương tác. Dữ liệu giả trong bản mẫu (tên agent, tên skill, số liệu) KHÔNG phải dữ liệu thật của CCGS.

---

## 1. Bối cảnh

CCGS Studio là web app chạy local, làm bảng điều khiển và màn hình giám sát cho một project dùng **Claude-Code-Game-Studios (CCGS)**. CCGS là bộ cấu hình Claude Code (agents, skills, rules, hooks, templates trong thư mục `.claude/`) mô phỏng một studio làm game nhiều agent.

Studio KHÔNG xây hệ thống agent mới. Nó chỉ:

1. Đọc và hiển thị cấu hình CCGS.
2. Khởi chạy Claude Code trên project để thực hiện task, giữ nguyên cơ chế điều phối của CCGS.
3. Thu thập event thật từ Claude Code để hiển thị hoạt động của các agent.

## 2. Phạm vi và giả định cố định

| Hạng mục | Quyết định |
|---|---|
| Người dùng | Một người, trên máy cá nhân. Không đăng nhập, không phân quyền. |
| Thực thi | Tối đa **1 task chạy tại một thời điểm**. Task khác xếp hàng đợi. Không cần git worktree. |
| Project | Một project hoạt động tại một thời điểm. |
| Mạng | Server chỉ bind `127.0.0.1`, kiểm tra header `Origin` (chống CSRF / DNS rebinding). |
| Triển khai | Chạy bằng `npm run dev` / `npm start`. Docker là tùy chọn, không bắt buộc. |
| Ngôn ngữ giao diện | Tiếng Việt, theo câu chữ trong bản mẫu. |

## 3. Nguyên tắc bắt buộc

1. **Không giả định cấu trúc CCGS.** Mọi đường dẫn, định dạng file, tên agent, cách skill gọi agent phải được kiểm tra trên repo thật ở Phase 0.
2. **Không sửa file của CCGS.** Không đụng `.claude/settings.json`, `.claude/agents/`, `.claude/skills/`… Hook giám sát được cài vào `.claude/settings.local.json` (hoặc cơ chế tương đương xác định ở Phase 0), có hộp xác nhận kèm diff.
3. **Không dữ liệu giả trong bản tích hợp.** Tab Monitor chỉ hiển thị dữ liệu từ event và transcript thật. Thiếu dữ liệu thì hiện `Unknown`, không suy đoán.
4. **Monitoring không được làm chậm hay chặn Claude Code.** Script hook luôn `exit 0`, trả về dưới 1 giây, nuốt mọi lỗi. Lưu ý: exit code 2 ở `PreToolUse` sẽ CHẶN tool, tuyệt đối không để xảy ra.
5. **Tách cấu hình và runtime.** *Agent Definition* (file `.md`, không có trạng thái) khác *Agent Invocation* (một lần agent được gọi, có trạng thái).
6. **Che bí mật trước khi lưu**, không chỉ khi hiển thị: API key, token, mật khẩu, biến môi trường nhạy cảm.
7. **Không quét lại cả repo khi có event mới.** Cấu hình chỉ đọc lại khi file trong `.claude/` thay đổi (file watcher).
8. **Làm từng phase, dừng ở cuối mỗi phase** để báo cáo và chờ duyệt. Không làm nhiều phase cùng lúc.

## 4. Kiến thức kỹ thuật cần xác minh ở Phase 0

Các điểm dưới đây là hiểu biết hiện tại về Claude Code, có thể đã thay đổi. Kiểm tra với phiên bản Claude Code đang cài và tài liệu chính thức, ghi kết quả vào báo cáo Phase 0.

- **Hook events:** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart` (có thể chỉ có ở bản mới), `SubagentStop`, `Stop`, `Notification`, `PreCompact`, `PermissionRequest` (nếu có). Ghi lại schema payload thật của từng event (bắt mẫu bằng một hook ghi stdin ra file).
- **Nhận diện subagent:** thường qua `PreToolUse`/`PostToolUse` của tool `Task` (hoặc `Agent` ở bản mới) với `subagent_type` và `prompt` trong input. Câu hỏi quan trọng nhất của dự án: *tool call xảy ra bên trong subagent có trường nào cho biết nó thuộc subagent nào không?* Đặc biệt khi nhiều subagent chạy song song.
- **Subagent lồng nhau:** có thể không được hỗ trợ, khi đó cây chỉ sâu một cấp (main session → subagents). Xác nhận.
- **Transcript JSONL:** đường dẫn có trong payload hook (`transcript_path`). Chứa nội dung hội thoại, `usage` token mỗi message, và có thể transcript riêng của subagent. Đây là nguồn token duy nhất đáng tin; hook không có token.
- **Cách khởi chạy:** so sánh hai phương án và chọn một:
  - **Claude Agent SDK (TypeScript):** chạy trong tiến trình backend, nhận message stream, đăng ký hook bằng code, nạp cấu hình project (setting sources). Hợp với backend Node.
  - **CLI headless:** `claude -p --output-format stream-json` (và các cờ liên quan như `--resume`, `--permission-mode`, `--settings`).
  - Tiêu chí quyết định: xử lý được câu hỏi của Claude (AskUserQuestion) và yêu cầu cấp quyền từ giao diện web không; resume session; dừng giữa chừng; giữ nguyên hành vi của CCGS.
- **Gắn event với task:** khi Studio khởi chạy Claude Code, truyền biến môi trường `CCGS_STUDIO_TASK_ID`; script hook kế thừa và gửi kèm. Session người dùng tự mở ở terminal sẽ không có biến này → gắn nhãn `External`.
- **OpenTelemetry:** Claude Code có telemetry tích hợp (`CLAUDE_CODE_ENABLE_TELEMETRY`), chủ yếu metrics và log events. Arize Phoenix cần traces, nên có thể phải tự dựng span từ event. Chỉ đánh giá, chưa làm.
- **Chi phí:** người dùng gói subscription thì cost chỉ là quy đổi. Hiển thị là "ước tính".

## 5. Công nghệ

| Lớp | Công nghệ |
|---|---|
| Frontend | React + Vite + TypeScript, Tailwind CSS + shadcn/ui |
| Backend | NestJS (TypeScript) |
| API | REST + WebSocket (Socket.IO) |
| Database | SQLite (qua Prisma hoặc Drizzle, chọn một và giải thích) |
| Hook client | Script Node nhỏ, không phụ thuộc nặng |
| Observability | Arize Phoenix (Phase 5, tùy chọn) |

Cấu trúc đề xuất (monorepo, npm/pnpm workspaces):

```
ccgs-studio/
  apps/web/            # React frontend
  apps/server/         # NestJS backend
  packages/shared/     # Kiểu dữ liệu và hợp đồng API dùng chung (DTO, event schema)
  packages/hook/       # Script ccgs-studio-hook
  docs/
    ui-prototype.html
    phase-0-report.md
    api-contract.md
```

## 6. Kiến trúc

```
Claude Code ──hook (stdin JSON)──> packages/hook ──HTTP POST 127.0.0.1──> Event Collector
     │                                   └─ backend tắt → ghi spool file, nạp lại sau
     ├─ transcript JSONL ─────────────────────────────────> Transcript Reader (token, nội dung)
     └─ stream output (SDK/CLI) ──────────────────────────> Process Manager

Event Collector → Normalizer → Redactor → SQLite → State Manager → WebSocket → Frontend
CCGS Adapter (đọc .claude/, file watcher) ──────────────> REST → Frontend (tab Tools)
```

Các module backend:

- **CCGS Adapter:** đọc và phân tích `.claude/` thành dữ liệu hiển thị. Chỉ đọc. Watch thay đổi.
- **Process Manager:** khởi chạy, dừng, resume Claude Code; quản lý hàng đợi 1 task; chuyển tiếp câu hỏi và yêu cầu quyền lên web, nhận câu trả lời gửi lại.
- **Event Collector + Normalizer:** nhận event, chuẩn hóa về một schema, gắn session/task/agent.
- **Redactor:** che bí mật theo bộ mẫu mặc định + mẫu người dùng thêm; cắt payload vượt giới hạn.
- **Agent State Manager:** suy ra trạng thái Agent Invocation chỉ từ event; không đủ dữ liệu → `unknown`.
- **WebSocket Gateway:** đẩy event và thay đổi trạng thái tới frontend.

## 7. Mô hình dữ liệu

```
Cấu hình (đọc từ .claude/, không lưu trạng thái)
  AgentDefinition, Skill, Rule, Hook, Template, Workflow

Runtime (lưu SQLite)
  Project 1─n Task 1─1 Session 1─n AgentInvocation 1─n ToolCall
  Session 1─n Event (event thô, tham chiếu tùy chọn tới invocation / tool call)
  Session External: task_id = null
```

Trạng thái:

- Task: `queued | running | waiting | completed | failed | cancelled`
- AgentInvocation: `running | waiting | completed | failed | cancelled | unknown` (không có `idle`)

Event chuẩn hóa tối thiểu: `event_id, event_type, timestamp, session_id, task_id?, agent_invocation_id?, parent_invocation_id?, tool_name?, payload (đã che), status, source (hook|transcript|stream|studio)`.

Hợp đồng REST và WebSocket viết trong `docs/api-contract.md` và kiểu TypeScript trong `packages/shared` TRƯỚC khi code frontend.

## 8. Danh sách tính năng

Ưu tiên: **P0** bắt buộc cho MVP, **P1** ngay sau MVP, **P2** để sau. Mã tính năng dùng trong commit message và báo cáo.

### 8.1 Tab Tools

| Mã | Tính năng | Mô tả | Ưu tiên |
|---|---|---|---|
| T-DB-01 | Trạng thái hệ thống | Project, phiên bản Claude Code, hook đã cài chưa, backend có nhận event không | P0 |
| T-DB-02 | Thống kê cấu hình | Số agents, skills, rules, hooks, templates | P0 |
| T-DB-03 | Task hiện tại | Task đang chạy, các agent đang hoạt động, hàng đợi | P0 |
| T-DB-04 | Hoạt động gần đây | Các task gần nhất với trạng thái, thời lượng | P1 |
| T-AG-01 | Danh sách agent | Tên, mô tả, model, tools; tìm kiếm, nhóm theo cấp nếu repo có | P0 |
| T-AG-02 | Chi tiết agent | Frontmatter, nội dung markdown, đường dẫn file | P0 |
| T-AG-04 | Thống kê agent | Số lần gọi, tỉ lệ thành công, thời lượng TB (từ runtime) | P1 |
| T-AG-05 | Sửa agent | Editor + diff + xác nhận | P2 |
| T-SK-01 | Danh sách skill | Tên, mô tả, tham số | P0 |
| T-SK-02 | Chi tiết skill | Nội dung SKILL.md, agent liên quan | P0 |
| T-SK-03 | Chạy skill | Nhập tham số, thêm task vào hàng đợi | P0 |
| T-SK-04 | Lịch sử skill | Các lần chạy của skill | P1 |
| T-HK-01 | Xem hooks | Hook CCGS và hook Studio hiển thị tách riêng | P0 |
| T-HK-02 | Cài / gỡ hook | Ghi `settings.local.json`, hiện diff, xác nhận | P0 |
| T-RU-01 | Xem rules | Danh sách, phạm vi đường dẫn, nội dung | P1 |
| T-WF-01/02 | Workflows | Xem và chạy, nếu CCGS định nghĩa dạng file | P1 |
| T-TP-01 | Templates | Danh sách, xem, sao chép | P2 |
| T-PJ-01 | Chọn project | Đường dẫn, kiểm tra `.claude/` hợp lệ | P0 |
| T-PJ-02 | Git | Branch, file chưa commit | P1 |
| T-PJ-03 | Nhiều project | Lưu danh sách, chuyển project khi không có task chạy | P2 |
| T-TC-01 | Tạo task | Prompt hoặc skill + tham số; model; permission mode | P0 |
| T-TC-02 | Hàng đợi | 1 chạy, còn lại chờ; đổi thứ tự; huỷ task chờ | P0 |
| T-TC-03 | Dừng task | Ngắt tiến trình, trạng thái `cancelled` | P0 |
| T-TC-04 | Trả lời và phê duyệt | Hiện câu hỏi của Claude và yêu cầu quyền trên web, gửi trả lời | P0 |
| T-TC-05 | Kết quả task | Phản hồi cuối, danh sách file thay đổi | P0 |
| T-TC-06 | Diff | Git diff file task đã sửa | P1 |
| T-TC-07 | Tiếp tục session | Resume với prompt mới | P1 |
| T-TC-08 | Lịch sử task | Lọc, tìm kiếm | P1 |

### 8.2 Tab Monitor

| Mã | Tính năng | Mô tả | Ưu tiên |
|---|---|---|---|
| M-LS-01 | Session trực tiếp | Prompt, phản hồi, tool call dạng thẻ thu gọn, realtime | P0 |
| M-LS-02 | Chọn session | Session đang chạy hoặc đã kết thúc; nhãn `External` | P0 |
| M-AM-01 | Danh sách invocation | Agent, được gọi bởi, nhiệm vụ giao, trạng thái, bắt đầu, thời lượng | P0 |
| M-AM-02 | Trạng thái | Chỉ từ event; `unknown` khi thiếu dữ liệu | P0 |
| M-AM-03 | Cha – con | Main session và subagent | P1 |
| M-AM-04 | Transcript subagent | Xem hội thoại riêng của subagent | P1 |
| M-TL-01 | Timeline danh sách | Các bước theo thời gian, xem input/output/duration/status | P0 |
| M-TL-02 | Timeline làn agent | Dạng Gantt, mỗi agent một làn, thấy bước song song | P1 |
| M-TS-01 | Bảng tool call | Thời gian, agent, tool, input tóm tắt, trạng thái, thời lượng; lọc | P0 |
| M-TS-02 | Lệnh Bash | Lệnh, exit code, output rút gọn | P1 |
| M-TS-03 | Hoạt động file | Đọc / tạo / sửa, diff cho Edit/Write | P1 |
| M-TS-04 | Skill và MCP | Skill kích hoạt, MCP server/tool được gọi | P1 |
| M-LG-01 | Log hợp nhất | Studio, Claude Code stderr, lỗi hook, tool lỗi, cảnh báo | P0 |
| M-LG-02 | Che bí mật | Trước khi lưu | P0 |
| M-LG-03 | Lọc log | Session, agent, mức, nguồn, thời gian, full-text | P1 |
| M-PF-01 | Thống kê task | Tổng, thành công/thất bại, thời lượng | P1 |
| M-PF-02 | Token | Input/output/cache theo task và agent, từ transcript | P1 |
| M-PF-03 | Chi phí | Chỉ khi có số liệu; ghi "ước tính" | P2 |
| M-PF-04 | Hiệu suất agent | So sánh giữa các agent | P2 |
| M-PF-05 | Phoenix | Xuất trace qua OpenTelemetry | P2 |

### 8.3 Cài đặt và hành vi hệ thống

| Mã | Tính năng | Mô tả | Ưu tiên |
|---|---|---|---|
| S-01 | Đường dẫn | Project, lệnh `claude`, tự phát hiện phiên bản | P0 |
| S-02 | Kiểm tra môi trường | claude đã cài và đăng nhập, project hợp lệ, hook gửi được event test, DB ghi được | P0 |
| S-03 | Mặc định task | Model, permission mode, thời gian chạy tối đa | P1 |
| S-04 | Lưu trữ | Xóa session cũ hơn N ngày, giới hạn payload | P1 |
| S-05 | Mẫu che bí mật | Regex do người dùng thêm | P1 |
| S-06 | Phoenix | Bật/tắt, endpoint | P2 |
| S-07 | Giao diện | Sáng / tối | P2 |

Hành vi bắt buộc (P0):

- Hook luôn `exit 0`, timeout gửi ≤ 500 ms, tổng thời gian < 1 giây.
- Backend tắt → hook im lặng, Claude Code chạy bình thường.
- Khởi động lại app không mất lịch sử.
- Cấu hình chỉ đọc lại khi file thay đổi.

Hành vi nên có (P1): backend tắt → hook ghi event vào spool file, backend nạp lại khi bật.

### 8.4 Ngoài phạm vi

Nhiều người dùng, đăng nhập, chạy task song song, git worktree, triển khai cloud, sửa logic điều phối CCGS, tạo/xóa agent hay skill qua giao diện, giao diện mobile riêng.

## 9. Các phase và tiêu chí nghiệm thu

Thứ tự đã điều chỉnh so với đặc tả gốc: monitoring thụ động làm TRƯỚC thực thi từ web, vì nó kiểm chứng sớm các giả định về hook mà không cần Process Manager.

### Phase 0 – Phân tích (KHÔNG viết code ứng dụng)

Được phép viết script thử nghiệm nhỏ (ví dụ hook ghi payload ra file) để bắt dữ liệu thật.

Sản phẩm: `docs/phase-0-report.md` gồm:

1. Cấu trúc repo CCGS thực tế (cây thư mục, định dạng từng loại file, số lượng).
2. Danh sách thành phần: agents (tên, cấp, model, tools), skills, rules, hooks có sẵn, templates, workflows (nếu có).
3. Cơ chế agent và cách giao việc: skill gọi agent thế nào, main session đóng vai gì, có lồng nhau không.
4. Payload thật của từng hook event (mẫu đã che bí mật) và kết luận về khả năng gắn tool call với subagent.
5. Cấu trúc transcript JSONL, nơi lấy token.
6. So sánh Agent SDK và CLI headless, chọn phương án, đặc biệt cách xử lý AskUserQuestion và cấp quyền.
7. Đánh giá Phoenix: dữ liệu nào có, cần làm gì để có trace.
8. Bảng ánh xạ: mỗi tính năng P0 lấy dữ liệu từ đâu. Tính năng nào không khả thi thì ghi rõ và đề xuất thay thế.
9. Rủi ro và hạn chế.
10. Bản `api-contract.md` nháp.

**Nghiệm thu:** mọi mục có bằng chứng (đường dẫn file, mẫu payload). Không còn mục "giả định" nào chưa kiểm chứng trong bảng ánh xạ P0. Dừng và chờ duyệt.

### Phase 1 – Xem cấu hình

Tính năng: T-PJ-01, T-DB-01 (phần cấu hình), T-DB-02, T-AG-01, T-AG-02, T-SK-01, T-SK-02, T-HK-01, S-01. Dựng khung frontend (sidebar, topbar, routing, theme) theo bản mẫu.

**Nghiệm thu:**

- Chọn project CCGS thật; số agent và skill trên Dashboard khớp số file trong `.claude/`.
- Sửa một file agent bằng editor ngoài → giao diện cập nhật trong 2 giây không cần tải lại.
- Repo CCGS không có thay đổi nào (`git status` sạch).

### Phase 2 – Monitoring thụ động

Tính năng: T-HK-02, S-02, M-LS-01, M-LS-02, M-AM-01, M-AM-02, M-TL-01, M-TS-01, M-LG-01, M-LG-02, các hành vi hệ thống P0.

**Nghiệm thu:**

- Chạy một skill gọi 2 subagent từ terminal → Monitor hiện đúng 2 invocation, thời lượng lệch < 1 giây so với transcript, session gắn nhãn `External`.
- Tắt backend rồi chạy Claude Code → không lỗi, không chậm đi đáng kể.
- Đưa chuỗi giống API key vào một lệnh Bash → database không chứa chuỗi đó.
- Gỡ hook → `settings.local.json` trở về như trước khi cài.

### Phase 3 – Thực thi từ web

Tính năng: T-DB-03, T-SK-03, T-TC-01 đến T-TC-05.

**Nghiệm thu:**

- Tạo 2 task liên tiếp; task thứ hai chỉ bắt đầu khi task đầu kết thúc.
- Một skill hỏi lại người dùng → câu hỏi hiện trên web, trả lời xong task chạy tiếp tới khi hoàn thành.
- Yêu cầu cấp quyền hiện trên web; Cho phép / Từ chối có tác dụng đúng.
- Dừng task giữa chừng → tiến trình bị tắt hẳn, trạng thái `cancelled`.
- Kết quả task hiện phản hồi cuối và danh sách file đã thay đổi.

### Phase 4 – Tính năng P1

Timeline Gantt, token, thống kê, diff, resume, lọc log, transcript subagent, cài đặt P1, spool file.

**Nghiệm thu:** tổng token của một task khớp tổng `usage` trong transcript; mỗi tính năng P1 có test.

### Phase 5 – Phoenix và hoàn thiện

Tính năng P2, tích hợp Phoenix tùy chọn, tối ưu hiệu năng, khôi phục sau lỗi.

**Nghiệm thu:** session 2 giờ với > 5.000 event, giao diện vẫn mượt; Studio khởi động lại giữa chừng không mất dữ liệu.

## 10. Quy tắc làm việc

- Đầu mỗi phase: viết kế hoạch ngắn (file, module, test) và chờ duyệt nếu có thay đổi kiến trúc.
- Cuối mỗi phase: báo cáo tính năng đã xong theo mã, cách kiểm tra, những gì còn thiếu hoặc lệch so với brief.
- Hợp đồng API và kiểu dùng chung cập nhật trước, code sau.
- Mỗi module backend có unit test; Normalizer và Redactor có test với payload thật bắt được ở Phase 0.
- Commit nhỏ, message có mã tính năng (ví dụ `feat(T-TC-02): hàng đợi task`).
- Khi brief mâu thuẫn với thực tế của CCGS hay Claude Code, KHÔNG tự xoay xở: dừng lại, nêu mâu thuẫn và đề xuất phương án.
- Giao diện bám theo `docs/ui-prototype.html`. Được phép điều chỉnh khi dữ liệu thật khác bản mẫu, nhưng ghi lại lý do.

## 11. Nhiệm vụ đầu tiên

Thực hiện **Phase 0**. Không viết code ứng dụng. Trả về `docs/phase-0-report.md` theo mục 9, rồi dừng chờ duyệt.
