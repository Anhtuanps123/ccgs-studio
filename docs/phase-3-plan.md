# Phase 3 – Kế hoạch: Thực thi từ web

Phạm vi: T-DB-03, T-SK-03, T-TC-01 đến T-TC-05. Kiến trúc giữ như Phase 0 đã duyệt (Agent SDK chạy trong NestJS), không có thay đổi mới.

## Server

| File | Việc |
|---|---|
| `src/tasks/task-runner.ts` | Chạy một task bằng SDK `query()`. `settingSources: user/project/local` để giữ hành vi CCGS. `settings` trỏ file hook của Studio (`studio-settings.json` trong studio home, origin `studio`), `env.CCGS_STUDIO_TASK_ID`. Tự spawn tiến trình `claude` (`spawnClaudeCodeProcess`) để biết PID. Bắt `canUseTool` thành `PendingInteraction`, chờ trả lời từ web. |
| `src/tasks/tasks.service.ts` | Bảng `tasks` trong SQLite. Hàng đợi chỉ chạy 1 task, còn lại `queued` theo `position`. Đổi thứ tự, huỷ task chờ. Dừng task đang chạy: `interrupt()`, sau đó abort, cuối cùng `taskkill /T /F` cây tiến trình (R7). Trạng thái `cancelled`. |
| `src/tasks/git-snapshot.ts` | `git status --porcelain` cùng hash nội dung, lấy trước và sau task. File thay đổi là phần khác nhau giữa hai lần (R8). |
| `src/tasks/tasks.controller.ts` | `GET/POST /api/tasks`, `PATCH /api/tasks/:id/position`, `POST /api/tasks/:id/cancel`, `GET /api/interactions`, `POST /api/interactions/:id/answer`. |
| WebSocket | `task:upsert`, `interaction:new`, `interaction:resolved`. |

Khi Studio khởi động lại, task đang `running` hoặc `waiting` chuyển thành `failed` với lỗi "Studio khởi động lại giữa chừng". Task `queued` vẫn chạy tiếp.

## Web

- **Task Center** (`/tasks`): form tạo task (prompt hoặc skill + tham số, model, permission mode), task đang chạy, hộp câu hỏi và hộp cấp quyền, hàng đợi (lên/xuống/huỷ), kết quả (phản hồi cuối, file thay đổi), danh sách task đã xong.
- **Skills**: nút "Chạy skill" mở Task Center điền sẵn skill (T-SK-03).
- **Tổng quan**: thẻ "Task hiện tại": task đang chạy, agent đang hoạt động, số task chờ (T-DB-03).

## Test

- Hàng đợi: chỉ 1 chạy, thứ tự, đổi vị trí, huỷ, dừng (runner giả lập, không gọi API).
- Git snapshot: phát hiện file mới, sửa, xoá trong repo tạm; không tính file đã bẩn sẵn nếu nội dung không đổi.
- Nghiệm thu thật trên Meodoku theo 5 tiêu chí của brief, dùng model `haiku`.
