# Phase 2 – Kế hoạch (Monitoring thụ động)

Tính năng: T-HK-02, S-02, M-LS-01, M-LS-02, M-AM-01, M-AM-02, M-TL-01, M-TS-01, M-LG-01, M-LG-02, hành vi hệ thống P0.
Không đổi kiến trúc so với Phase 0 (SQLite qua Drizzle + better-sqlite3, đề xuất 4).

## Luồng dữ liệu

```
Claude Code ──hook (node ccgs-studio-hook.mjs)──► POST /ingest (X-Studio-Token)
   └─ che bí mật + cắt chuỗi dài ─► bảng events (bản gốc đã che)
                                 └─► projector ─► sessions / invocations / toolcalls / logs ─► Socket.IO /live
```

## Module

| File | Vai trò |
|---|---|
| `apps/server/hook/ccgs-studio-hook.mjs` | Đọc stdin, gửi `/ingest` timeout 500 ms, chốt chặn 900 ms, luôn `exit 0`, không in gì ra stdout. Khi chạy từ `settings.local.json` mà có `CCGS_STUDIO_TASK_ID` thì bỏ qua (task do Studio chạy đã có hook qua SDK, tránh trùng – Phase 3). |
| `src/store/db.ts` | Schema Drizzle, tạo bảng khi khởi động, file `~/.ccgs-studio/studio.db`. |
| `src/monitor/redact.ts` | Che bí mật (API key Anthropic/OpenAI/GitHub/AWS/Slack/Google, JWT, Bearer, private key, `password=`/`token=`…) và cắt chuỗi > 8 KB. Chạy trước khi ghi. |
| `src/monitor/projector.ts` | Hàm chiếu event → bản ghi. Trạng thái chỉ đổi theo event; `SessionEnd` mà còn đang chạy thì thành `unknown`. |
| `src/monitor/monitor.service.ts` · `ingest.controller.ts` · `monitor.controller.ts` | Ingest, truy vấn, phát WebSocket. |
| `src/hooks/hook-installer.ts` · `hooks.controller.ts` | Preview diff, cài/gỡ với `confirmHash`, sao lưu bản gốc để gỡ xong trả về đúng từng byte. |
| `src/system/doctor.ts` | S-02: claude đã cài và đăng nhập (`claude auth status`), project hợp lệ, hook gửi được event test, DB ghi được. |
| `apps/web/src/views/monitor/*` | Session trực tiếp, Agent Monitor, Timeline (danh sách), Tool và file, Logs; panel cài/gỡ hook có diff; Kiểm tra môi trường. |

## Ghép subagent

`SubagentStart` không có `tool_use_id`, nên ghép tạm với lời gọi `Agent` đang chạy sớm nhất cùng `subagent_type` chưa có chủ. `PostToolUse(Agent).tool_response.agentId` ghép chính xác và sửa lại nếu ghép tạm sai (2 subagent cùng loại chạy song song).

## Test và nghiệm thu

- Unit: redact, projector (chuỗi event thật từ `hook-payloads.md`: 1 cấp, lồng nhau, interrupt), installer (cài → gỡ trả đúng byte; file chưa tồn tại → gỡ xong file biến mất; hash sai → từ chối).
- Hook: backend tắt → `exit 0`, < 1 s, stdout rỗng.
- Thật: cài hook vào Meodoku (sau khi bạn xem diff), chạy skill gọi 2 subagent từ terminal, so thời lượng với transcript; đưa chuỗi giống API key vào Bash rồi grep DB; gỡ hook và so byte.
