# Cần cài gì để dùng CCGS Studio

CCGS Studio là web app chạy trên máy của bạn. Nó điều khiển Claude Code trên một project game dùng CCGS.

Phiên bản ghi trong file này là bản **đang chạy được trên máy công ty** (Windows 11, ngày 2026-11-11). Bản cũ hơn chưa được thử.

**Cách nhanh:** bấm đúp `cai-dat.cmd` ở gốc repo. Script cài Node 24.21.0 bằng winget nếu máy chưa có, chạy `npm install`, chạy Studio rồi mở màn **Hệ thống → Cài package**. Ở màn đó có nút cài Claude Code, Git, uv, graphify, VS Build Tools và nút mở terminal để đăng nhập Claude. MCP for Unity vẫn phải cài trong Unity (mục 8).

Cài xong thì vào **Cài đặt → Kiểm tra môi trường**. Mỗi mục bên dưới đều có một dòng kiểm tra ở đó.

## 1. Bắt buộc

Thiếu một trong các mục này thì Studio không chạy được, hoặc không lập được kế hoạch.

| # | Cần có | Bản đang dùng | Cách kiểm tra | Thiếu thì sao |
|---|---|---|---|---|
| 1 | **Windows** | Windows 11 | — | Chỉ Windows mới có hộp thoại chọn thư mục. Hệ khác chưa chạy thử. |
| 2 | **Node.js**, có lệnh `node` trong PATH | 24.21.0 (npm 11.19.0) | `node --version` | Không build và chạy được Studio. Hook giám sát cũng gọi lệnh `node`. |
| 3 | **Claude Code CLI** | 2.1.321 | `claude --version` | Không chạy được task nào. |
| 4 | **Đã đăng nhập Claude Code**: chạy `claude`, rồi gõ `/login` | — | `claude auth status` phải báo `loggedIn: true` | Task báo lỗi xác thực. Mọi task đều tính phí vào tài khoản này. |
| 5 | **Project game có CCGS**: có `.claude/`, `.claude/agents/`, `.claude/skills/` | Meodoku | Màn **Project** | Studio coi project là không hợp lệ. |
| 6 | **Đã chạy `/start` trong project game**: `project.yaml` có `modes.rigor` | — | Form "Yêu cầu mới" | Không tạo được kế hoạch. |
| 7 | **Unity Editor mở đúng project** | 6000.0.81f1 (Meodoku) | — | Không quét được game, nên không lập được kế hoạch. |
| 8 | **MCP for Unity**, cài trong Unity và đăng ký với Claude Code dưới tên `UnityMCP` | mcp-for-unity-server 3.4.11 | Bật ở Unity: **Window → MCP for Unity**. Sau đó xem mục "Unity MCP" trong Kiểm tra môi trường | Studio chặn lập kế hoạch cho tới khi **Tổng quan → Quét game** chạy xong. Skill `studio:unity-art-context` cũng không đọc được art thật. |

Ghi chú cho mục 8: ở máy công ty, `UnityMCP` được đăng ký ở **user scope**. Lý do là `~/.claude.json` bị lỗi khoá đường dẫn khi chữ ổ đĩa lúc viết `d:`, lúc viết `D:`.

## 2. Nên có

| Cần có | Bản đang dùng | Thiếu thì sao |
|---|---|---|
| **Git**, và project game là git repo | 2.55.0 | Studio không biết task đã đổi file nào và không xem được diff. Luật "skill ghi file mà không đổi file nào thì dừng" sẽ bị bỏ qua. |
| **Visual Studio Build Tools** (C++) | — | Chỉ cần khi `npm install` báo lỗi build `better-sqlite3`, tức là không tải được bản dựng sẵn cho bản Node đang dùng. |

## 3. Tuỳ chọn

| Cần có | Cài bằng | Dùng để |
|---|---|---|
| **graphify 0.9.103** kèm MCP (cần [uv](https://docs.astral.sh/uv/); máy công ty dùng uv 0.13.5 và Python 3.14.7) | `uv tool install "graphifyy[mcp]==0.9.103"` | Bản đồ code: Claude tra class, method, file:dòng thay vì đọc cả file. Không có thì Studio vẫn chạy như cũ. **Không cài vào project game.** Studio dựng đồ thị ở `~/.ccgs-studio/projects/<id>/graphify`. |
| **Arize Phoenix** chạy ở `http://127.0.0.1:6006` | Theo hướng dẫn của Phoenix | Gửi trace của session sang Phoenix (bật trong Cài đặt). Mặc định đang tắt. |

Nếu đã cài graphify mà Kiểm tra môi trường báo `graphify-mcp` không chạy được, hãy cài lại:
`uv tool install "graphifyy[mcp]" --force`

## 4. Cài và chạy Studio

Bấm đúp `cai-dat.cmd`, hoặc chạy tay:

```
cd D:\ccgs-studio
npm install
npm start          # build rồi chạy tại http://127.0.0.1:4310
```

Sau đó:

1. Ở màn **Project**, chọn thư mục game. Có thể đặt sẵn biến `CCGS_PROJECT=D:\Meodoku` trước khi chạy.
2. Vào **Cài đặt → Kiểm tra môi trường**. Mọi mục bắt buộc phải xanh.
3. Ở màn **Rules, Hooks, khác**, cài hook nếu muốn giám sát cả các session tự mở ở terminal. Session chạy từ Studio thì không cần hook. Hook chỉ ghi vào `.claude/settings.local.json` của game, và Studio luôn hiện diff để bạn xác nhận trước khi ghi.
4. Mở Unity Editor và bật MCP for Unity. Vào **Tổng quan → Quét game**, chờ xong rồi mới lập kế hoạch.

## 5. Lưu ý khi chuyển sang máy khác

- Studio lưu cài đặt, database và token hook ở `~/.ccgs-studio/`. Có thể đổi chỗ lưu bằng biến `CCGS_STUDIO_HOME`. Thư mục này **không nằm trong git**, nên máy mới bắt đầu với database rỗng. Bạn phải chọn lại project, cài lại hook và quét lại game.
- Server chỉ nghe ở `127.0.0.1`. Máy khác trong mạng không mở được Studio.
