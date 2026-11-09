# Phase 4 + 5: báo cáo nghiệm thu

Ngày: 2026-11-09. Project thử: `D:\Meodoku`, Agent SDK 0.3.319, model `haiku`. Người dùng yêu cầu làm liền các phase còn lại và nghiệm thu một lần.

## Tính năng đã xong

**Phase 4 (P1)**

| Nhóm | Mã tính năng |
|---|---|
| Tổng quan, agent, skill | T-DB-04 (hoạt động gần đây), T-AG-04 (thống kê agent), T-SK-04 (lịch sử chạy skill) |
| Rules, workflows | T-RU-01 (đã có từ Phase 1), T-WF-01/02 (mỗi bước workflow mở Task Center với skill tương ứng) |
| Project | T-PJ-02 (Git) |
| Task | T-TC-06 (diff), T-TC-07 (chạy tiếp session), T-TC-08 (tìm kiếm và lọc lịch sử) |
| Agent Monitor | M-AM-03 (cây cha–con, đã có từ Phase 2), M-AM-04 (transcript subagent) |
| Timeline | M-TL-02 (làn agent dạng Gantt) |
| Tool và file | M-TS-02 (Bash: lệnh, exit code, output), M-TS-03 (hoạt động file kèm diff), M-TS-04 (skill và MCP) |
| Log | M-LG-03 (lọc theo session và thời gian) |
| Hiệu suất | M-PF-01 (thống kê task), M-PF-02 (token theo task và agent) |
| Cài đặt | S-03 (mặc định task, thời gian chạy tối đa), S-04 (thời hạn lưu, giới hạn payload), S-05 (regex che bí mật) |
| Hành vi hệ thống | Spool khi backend tắt |

**Phase 5 (P2 và hoàn thiện):**
- T-TP-01: xem và sao chép template.
- T-PJ-03: nhiều project; chặn đổi project khi còn task chạy hoặc chờ.
- M-PF-03: chi phí ước tính, lấy từ `total_cost_usd` của SDK.
- M-PF-04: so sánh agent.
- M-PF-05 và S-06: gửi trace lên Phoenix.
- S-07: giao diện sáng/tối (đã có từ trước).
- Khôi phục sau lỗi: dùng SQLite WAL và spool.

## Kết quả nghiệm thu (chạy thật)

| Tiêu chí | Kết quả | Bằng chứng |
|---|---|---|
| **P4:** tổng token của một task khớp tổng `usage` trong transcript | ĐẠT | Task gọi 1 subagent. Studio và script đếm độc lập (đọc 2 file transcript, khử trùng theo `message.id`) ra cùng một kết quả: input 8, output 532, cache ghi 85.830, cache đọc 159.736 |
| **P4:** mỗi tính năng P1 có test | ĐẠT | 45/45 test pass. File `test/phase4.test.ts` có 19 test mới, mỗi khối một mã tính năng |
| T-TC-06: diff | ĐẠT | File task tạo hiện đúng `+one`. Test có kiểm tra rằng phần người dùng tự sửa trước khi task chạy không bị tính cho task |
| T-TC-07: chạy tiếp session | ĐẠT | Task mới dùng cùng session. Hỏi lại "đã ghi gì vào file" thì Claude trả lời đúng `one` |
| **P5:** session 2 giờ với hơn 5.000 event, giao diện vẫn mượt | ĐẠT (xem ghi chú) | Thử trên server riêng (cổng 4311, DB tạm) với 5.282 event, 60 subagent, 2.580 tool call trải trong 2 giờ. Các API phản hồi trong 1 đến 27 ms (toolcalls 741 KB mất 27 ms). Trang Timeline (60 làn), Agent Monitor và Tool vẽ xong trong khoảng 1,5 đến 1,9 s với Chrome headless, tính cả thời gian mở trình duyệt. Ảnh ở `docs/evidence/phase-5/load-*.png` |
| **P5:** Studio khởi động lại giữa chừng không mất dữ liệu | ĐẠT | Kill server (`taskkill /F`) sau khi nhận một nửa số event. Trong lúc server tắt, hook vẫn thoát 0 và ghi event vào spool. Khởi động lại rồi gửi tiếp: lưu đủ 5.282/5.282 event, đủ 60/60 agent ở trạng thái completed |
| Phoenix | ĐẠT | Gửi lên Phoenix 21.0.0 chạy local: HTTP 200, project "Meodoku" có 1 trace gồm 5 span, đúng cha–con và đúng loại span (chain, agent, tool) |

Ảnh chụp giao diện nằm ở `docs/evidence/phase-5/` (performance, tasks, project, preferences, dashboard).

Dọn dẹp sau khi thử:
- File thử trong Meodoku đã xoá.
- DB tải thử và dữ liệu Phoenix chỉ nằm trong scratchpad, không nằm trong project.

## Lệch so với brief hoặc mâu thuẫn

1. **T-AG-05 (sửa agent) chưa làm.** Tính năng này ghi vào `.claude/agents/`, trái với nguyên tắc số 2 của brief ("không sửa file của CCGS"). Theo quy tắc làm việc, mình dừng ở đây và chờ bạn quyết. Có hai cách:
   - (a) Cho phép ngoại lệ: ghi file sau khi hiện diff và bạn xác nhận, cùng cơ chế với cài hook.
   - (b) Bỏ tính năng này.
2. **Diff (T-TC-06) cần ghi object vào `.git`.** Để có bản trước của file, Studio chạy `git stash create`. Lệnh này tạo một commit lơ lửng trong `.git/objects`; không đổi ref, index, work tree hay danh sách stash, và `git gc` sẽ dọn sau. Ngoài ra:
   - Nếu file chưa được git theo dõi trước khi task chạy, chỉ có nội dung hiện tại để xem.
   - Ở lần chạy thử, `production/session-logs/agent-audit.log` cũng nằm trong danh sách file đã đổi. File này do hook của chính CCGS ghi, đây là hạn chế R8 đã biết.
3. **Token trong Phoenix.** Phoenix chỉ cộng token cho span loại LLM. Studio gắn token vào span loại AGENT, nên cột tổng token của Phoenix hiện 0, dù thuộc tính vẫn có trong span.
4. **M-LG-03 không lọc được theo agent.** Log không ghi agent nào sinh ra nó, nên chỉ lọc theo session, mức, nguồn, thời gian và nội dung.
5. **Exit code Bash.** Hook không gửi exit code. Studio lấy số này từ thông báo lỗi ("Exit code N"). Nếu lệnh thành công, Studio suy ra 0 và ghi rõ đây là suy ra.
6. **Chạy workflow (T-WF-02).** CCGS không có lệnh chạy cả chuỗi. Mỗi bước là một nút chạy skill riêng.
7. **Thời gian chạy tối đa (S-03) mặc định là không giới hạn.** Quá giới hạn thì task bị dừng và đánh dấu `failed`.

## Hạn chế còn lại

- Danh sách tool call hiện tối đa 1.000 dòng, danh sách Timeline 500 bước (có nút "Hiện thêm"). Gantt vẽ tất cả.
- Chưa đo khung hình trên trình duyệt thật. Kết luận "mượt" dựa vào thời gian API và thời gian vẽ trang trong Chrome headless.
- Task đang chạy khi Studio khởi động lại vẫn bị đánh `failed` (giống Phase 3).

## Trạng thái

Chưa commit. Phase 2, 3, 4 và 5 đều chưa commit.
