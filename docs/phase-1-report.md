# Phase 1 – Báo cáo (Xem cấu hình)

## Tính năng đã xong

| Mã | Trạng thái | Ghi chú |
|---|---|---|
| T-PJ-01 | Xong | `PUT /api/project`: 6 mục kiểm tra; project không hợp lệ thì giữ nguyên project cũ |
| T-DB-01 (cấu hình) | Xong | Phiên bản Claude Code, project hợp lệ, hook Studio (chưa cài), event cuối (Phase 2) |
| T-DB-02 | Xong | 49 agents, 109 skills (+1 thiếu SKILL.md), 14 rules, 15 hooks CCGS, 71 templates, 8 workflows |
| T-AG-01/02 | Xong | Nhóm theo cấp đọc từ `agent-roster.md` (giữ thứ tự roster), tìm kiếm, frontmatter, nội dung |
| T-SK-01/02 | Xong | Nguồn CCGS/Local/Symlink, tham số, allowed-tools, agent liên quan (ghi rõ là suy ra) |
| T-HK-01 | Xong | Tách hook CCGS / Studio (nhận diện theo marker `ccgs-studio-hook`) / hook khác của user |
| S-01 | Xong | Lệnh `claude` cấu hình được, tự phát hiện phiên bản |
| Thêm | Xong | Rules, Workflows (từ `workflow-catalog.yaml`), Templates chỉ xem; theme sáng/tối; các màn Monitor là chỗ trống ghi rõ phase |

## Nghiệm thu

| Tiêu chí | Kết quả | Cách kiểm tra |
|---|---|---|
| Số agent và skill khớp file trong `.claude/` | Đạt | Test tích hợp trong `apps/server/test/parser.test.ts` chạy trên D:\Meodoku |
| Sửa file agent bằng tiến trình ngoài thì UI cập nhật < 2 giây | Đạt: **~0,4 giây** (sửa 419 ms, khôi phục 392 ms) | `spikes/watch-latency.mjs`: ghi file, chờ `config:changed`, gọi lại API, rồi khôi phục đúng từng byte |
| Repo CCGS không đổi (tiêu chí đã điều chỉnh) | Đạt | Hash của `git status --porcelain` Meodoku trước và sau giống nhau (`3d081bce…`) |
| Chặn Origin và Host lạ | Đạt | `Origin: http://evil.com` → 403, `Host: evil.com` → 403; có unit test |

Test: 7/7 pass (`npm test`). Ảnh chụp: `docs/evidence/phase-1/`.

## Lệch so với brief / còn thiếu

- **shadcn/ui chưa dùng.** CSS lấy nguyên từ bản mẫu (`apps/web/src/prototype.css`) cộng thêm Tailwind 4. Lý do: bản mẫu đã có hệ màu và component riêng. Sẽ thêm shadcn khi cần component có tương tác phức tạp (dialog, select) ở Phase 2–3.
- **Chưa có hộp chọn thư mục kiểu native**, người dùng phải gõ đường dẫn (trình duyệt không cho đọc đường dẫn thật).
- Bảng Tier 1 trong roster có 4 dòng nhưng chỉ 3 agent có file; dòng thừa bị bỏ qua.
- Mục T-PJ-02 (Git) để Phase 4 như brief.

## Chạy thử

```
cd D:\ccgs-studio
npm install
npm start                 # build rồi chạy server + web tại http://127.0.0.1:4310
# hoặc dev: npm run dev:server  và  npm run dev:web (http://127.0.0.1:5173)
```
Chọn project ở màn **Project** (hoặc đặt biến `CCGS_PROJECT=D:\Meodoku` trước khi chạy). Cài đặt lưu ở `~/.ccgs-studio/config.json`.
