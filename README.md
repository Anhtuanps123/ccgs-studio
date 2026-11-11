# CCGS Studio

Web app chạy trên máy bạn để điều khiển Claude Code trên một project game dùng CCGS (Unity).
Bạn gõ yêu cầu, Claude lập kế hoạch, bạn sửa và duyệt, rồi Studio chạy từng bước và cho bạn theo dõi.

Studio chỉ chạy ở `http://127.0.0.1:4310`, máy khác trong mạng không mở được.

## Cài đặt (Windows)

1. Bấm đúp **`cai-dat.cmd`** ở gốc repo. Script sẽ:
   - cài Node 24.21.0 bằng winget nếu máy chưa có;
   - chạy `npm install`, rồi chạy Studio;
   - khoảng 30 giây sau, mở trình duyệt ở màn **Cài package**.
2. Ở màn **Hệ thống → Cài package**, bấm **Cài** cho từng mục còn báo "Chưa có":
   - Bắt buộc: Claude Code CLI. Sau đó bấm **Mở terminal**, gõ `/login` để đăng nhập.
   - Nên có: Git, VS Build Tools (chỉ cần khi `npm install` lỗi `better-sqlite3`).
   - Tuỳ chọn: uv, rồi graphify (bản đồ code).
3. Trong Unity: cài **MCP for Unity** và bật ở **Window → MCP for Unity**. Phần này Studio không cài thay được.
4. Vào **Cài đặt → Kiểm tra môi trường**. Mọi mục bắt buộc phải xanh.

Danh sách đầy đủ, phiên bản đang dùng và cách xử lý khi thiếu: xem [CAI-DAT.md](CAI-DAT.md).

Cài tay, không dùng script:

```
cd D:\ccgs-studio
npm install
npm start        # build rồi chạy tại http://127.0.0.1:4310
```

## Mở Studio những lần sau

```
cd D:\ccgs-studio
npm start
```

Đóng cửa sổ terminal là tắt Studio. Sau khi `git pull` code mới thì chạy lại `npm install` trước `npm start`.

## Sử dụng

**Lần đầu với một project game**

1. **Project**: chọn thư mục game. Thư mục phải có `.claude/agents/` và `.claude/skills/`.
2. Trong project game, chạy `/start` một lần, để `project.yaml` có `modes.rigor`.
3. Mở Unity đúng project, rồi vào **Tổng quan → Quét game** và chờ xong.
4. (Tuỳ chọn) **Rules, Hooks, khác**: cài hook để giám sát cả session bạn tự mở ở terminal. Studio hiện diff để bạn xác nhận trước khi ghi.

**Làm một việc**

1. **Lập kế hoạch → Yêu cầu mới**: gõ yêu cầu và tick các vai trò (Designer, UI/UX, Art, Developer, Tester).
2. Claude lập kế hoạch (chỉ đọc, chưa sửa gì). Bạn xem, sửa bước nếu cần, rồi bấm **Duyệt và chạy**.
3. **Task Center**: theo dõi từng bước. Khi Claude hỏi, thẻ câu hỏi hiện bản nháp để bạn trả lời hoặc duyệt.
4. Nếu lập kế hoạch lỗi (ví dụ hết hạn mức), bấm **Lập kế hoạch lại**.

Mọi task đều tính phí vào tài khoản Claude đang đăng nhập.

**Các màn khác**

| Màn | Dùng để |
|---|---|
| Tổng quan | Trạng thái project, quét game |
| Agents, Skills | Xem agent và skill CCGS của game |
| Session trực tiếp, Agent Monitor, Timeline | Xem Claude đang làm gì |
| Tool và file, Logs | Lệnh tool đã gọi, file đã đổi, log server |
| Hiệu suất | Chi phí, thời gian chạy |
| Cài đặt | Lệnh Claude, Phoenix, kiểm tra môi trường |

## Dữ liệu lưu ở đâu

- Cài đặt, database và token hook nằm ở `~/.ccgs-studio/`, không nằm trong git. Đổi chỗ lưu bằng biến `CCGS_STUDIO_HOME`.
- Có thể chọn sẵn project bằng biến `CCGS_PROJECT=D:\Meodoku` trước khi chạy.
- Studio không sửa file CCGS trong game. Hook chỉ ghi vào `.claude/settings.local.json`.

## Cho người phát triển

```
npm run dev:server     # server, tự reload
npm run dev:web        # web tại http://127.0.0.1:5173
npm test
```

Tài liệu: [docs/brief.md](docs/brief.md) (thiết kế), [docs/PROGRESS.md](docs/PROGRESS.md) (tiến độ, agent đọc trước), [docs/api-contract.md](docs/api-contract.md), `docs/phase-*-report.md`.
