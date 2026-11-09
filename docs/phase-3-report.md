# Phase 3 – Báo cáo nghiệm thu

Ngày: 2026-11-09. Project thử: `D:\Meodoku`. Agent SDK 0.3.319, model `haiku`. Kế hoạch: `docs/phase-3-plan.md`.

## Tính năng đã xong
T-TC-01 (tạo task: prompt hoặc skill + tham số, model, permission mode), T-TC-02 (hàng đợi một task chạy, đổi thứ tự, huỷ task chờ), T-TC-03 (dừng task, kill cả cây tiến trình), T-TC-04 (câu hỏi và yêu cầu quyền hiện trên web), T-TC-05 (phản hồi cuối và file thay đổi), T-SK-03 (nút "Chạy skill"), T-DB-03 (thẻ "Task hiện tại" ở Tổng quan).

## Kết quả nghiệm thu (chạy thật)

| Tiêu chí | Kết quả | Bằng chứng |
|---|---|---|
| 2 task liên tiếp, task 2 chỉ chạy khi task 1 xong | ĐẠT | Lúc tạo, task 2 ở `queued`. Task 1 kết thúc 05:10:42.958, task 2 bắt đầu 05:10:42.959. Kết quả `ONE` và `TWO` |
| Claude hỏi lại → câu hỏi hiện trên web, trả lời xong chạy tiếp | ĐẠT | Câu "Pick a color" (Red/Blue), task ở `waiting`; trả lời Blue → `completed`, kết quả `COLOR=Blue` |
| Yêu cầu cấp quyền; Cho phép / Từ chối đúng tác dụng | ĐẠT | Cho phép: file được tạo, `WRITE=ok`. Từ chối: file không tồn tại, Claude nhận đúng lời nhắn từ chối |
| Dừng giữa chừng → tiến trình tắt hẳn, `cancelled` | ĐẠT | Trước khi dừng có 2 tiến trình `sleep 300`, sau khi dừng còn 0; dừng mất 4,7 s; trạng thái `cancelled` |
| Kết quả hiện phản hồi cuối và file đã đổi | ĐẠT | Task Write: `changedFiles = [{studio-probe-allow.txt, A}]`; task bị từ chối: `[]` |

Mọi session của task đều gắn `taskId` và không bị gắn nhãn External (6/6). Log không có lỗi. Các file thử đã được xoá khỏi Meodoku.
Test tự động: 26/26 pass (thêm 10 test: hàng đợi, câu hỏi/quyền, dừng, khôi phục sau khởi động lại, git snapshot, kill cây tiến trình).

## Lệch so với brief / hợp đồng
- Bỏ `queue:changed`. Thứ tự hàng đợi đi kèm `task:upsert`.
- Bỏ `applySuggestions` (tuỳ chọn "luôn cho phép") vì chưa làm.
- Thêm `Task.args`, `GET /api/tasks/current`, `GET /api/interactions`.
- SDK dùng bản Claude Code đi kèm SDK, không dùng lệnh `claude` trong Cài đặt.

## Hạn chế đã biết
- Khi Studio khởi động lại giữa lúc task đang chạy, task đó được đánh dấu `failed` vì không gắn lại được.
- "File đã thay đổi" so `git status` + hash trước và sau. Nếu người dùng sửa cùng một file trong lúc task chạy thì file đó cũng bị tính (R8).
- Đổi project khi có task đang chạy chưa bị chặn (T-PJ-03 là P2).
- Chưa chụp ảnh màn hình Task Center.

## Trạng thái
Chưa commit.
