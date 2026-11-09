# Phase 2 – Báo cáo nghiệm thu

Ngày: 2026-11-09. Project thử: `D:\Meodoku`. Claude Code 2.1.319.

## Phạm vi
T-HK-02 (cài/gỡ hook có diff + xác nhận), S-02 (Doctor), M-LS-01/02, M-AM-01/02, M-TL-01, M-TS-01, M-LG-01/02, cùng pipeline ingest → che bí mật → SQLite → projector → WebSocket.

## Kết quả nghiệm thu (chạy thật)

| Tiêu chí | Kết quả | Bằng chứng |
|---|---|---|
| Skill sinh 2 subagent từ terminal: 2 invocation, lệch ≤ 1 s so với transcript, gắn External | ĐẠT | Session `b4995850…`: Explore 4500 ms vs 5272 ms (lệch 772 ms); Explore 4478 ms vs 5171 ms (lệch 693 ms). `external: true` |
| Tắt backend, Claude Code vẫn chạy | ĐẠT | Hook exit 0, 154 ms, stdout rỗng; `claude -p` exit 0 trong 10 s |
| Chuỗi giống API key trong lệnh Bash không vào DB | ĐẠT | Session `3fb263a6…`: tool call lưu `echo test-[đã che]`; grep phần đuôi key trong `studio.db`, `-wal`, `-shm`: 0 |
| Gỡ hook trả `settings.local.json` về đúng byte | ĐẠT | `cmp` khớp; SHA-256 `a241d311…f8f3ae` trước = sau |

Test tự động: 16/16 pass (`npm test -w apps/server`).

## Lỗi tìm thấy khi nghiệm thu và đã sửa
- Hook bản cài đặt đọc `hook.json` từ `CCGS_STUDIO_HOME` hoặc `~/.ccgs-studio`. Session mở từ terminal không có biến này, nên khi home nằm ở chỗ khác thì hook lặng lẽ bỏ qua. Đã sửa: ưu tiên `hook.json` nằm cạnh script.

## Hạn chế đã biết
- Hook không có phần chữ assistant viết giữa các tool call, nên Session trực tiếp chỉ hiện phản hồi cuối của mỗi lượt. Bổ sung từ transcript để Phase 4.
- Thời lượng subagent là SubagentStart → SubagentStop, ngắn hơn thời gian tool Agent khoảng 0,7 s (chi phí khởi tạo).
- `claudeVersion` của session từ hook là `Unknown`, vì payload không có trường này.
- DB thử có session giả lập `sim-0001` và `probe-1` (dữ liệu kiểm thử, nằm trong studio-home tạm, không phải DB thật).

## Trạng thái
Hook đã được gỡ khỏi Meodoku sau nghiệm thu. Chưa commit.
