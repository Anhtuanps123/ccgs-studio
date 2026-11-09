# Phase 1 – Kế hoạch (Xem cấu hình)

Tính năng: T-PJ-01, T-DB-01 (cấu hình), T-DB-02, T-AG-01, T-AG-02, T-SK-01, T-SK-02, T-HK-01, S-01. Không đổi kiến trúc so với báo cáo Phase 0.

## Cấu trúc

```
package.json            npm workspaces
packages/shared         kiểu TS + DTO (theo api-contract.md)
apps/server             NestJS, build bằng tsc (cần decorator metadata), test bằng vitest
  src/ccgs/             parser.ts (hàm thuần), adapter.service.ts (cache + watcher), ccgs.controller.ts
  src/project/          project.service.ts (đường dẫn, kiểm tra hợp lệ, lưu ~/.ccgs-studio/config.json)
  src/system/           system.controller.ts (claude --version, trạng thái)
  src/live/             live.gateway.ts (Socket.IO, phát config:changed)
  src/security/         origin.middleware.ts (chỉ 127.0.0.1, kiểm tra Origin)
apps/web                React + Vite + TS + Tailwind; token màu lấy từ ui-prototype.html
  views: Tổng quan, Agents, Skills, Rules/Hooks/khác, Project, Cài đặt (đường dẫn); các view Monitor là chỗ trống ghi "Phase 2"
```

## Quyết định nhỏ

- Frontmatter đọc bằng thư viện `yaml`; file lỗi thì vẫn liệt kê kèm `parseError`, không làm hỏng danh sách.
- Skill đi theo symlink; `origin` = `symlink` / `ccgs` (có `CONTRACT.md` hoặc `user-invocable`) / `local`.
- Tier đọc từ bảng trong `.claude/docs/agent-roster.md`; không có thì `null`.
- Watcher: chokidar trên `.claude/` (theo symlink), debounce 300 ms, chỉ parse lại loại bị đổi, rồi phát `config:changed`.
- shadcn/ui: chỉ dùng cách đặt token và component thuần Tailwind, viết tay vài component (Button, Panel, Status) theo bản mẫu, chưa kéo cả bộ shadcn. Lý do: bản mẫu có hệ màu riêng, thêm Radix chưa cần ở phase này.

## Test và nghiệm thu

- Unit test parser với fixture nhỏ + test tích hợp chạy trên `D:\Meodoku` thật (bỏ qua nếu không có).
- Nghiệm thu: số liệu khớp `inventory.json` (49 agents, 109 skill có SKILL.md…); sửa file agent ngoài → UI đổi < 2 s; snapshot `git status --porcelain` của Meodoku trước/sau giống nhau.
