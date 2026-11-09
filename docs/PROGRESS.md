# CCGS Studio: tiến độ và việc tiếp theo

Cập nhật: 2026-11-09. Agent nhận việc: **đọc hết file này trước khi sửa code**, rồi đọc thêm `docs/brief.md` (§3 Nguyên tắc, §10 Quy tắc làm việc).

## 1. Studio là gì (tóm tắt)

Studio là web app chạy local, gồm React + Vite (`apps/web`), NestJS + SQLite (`apps/server`), kiểu dùng chung trong `packages/shared` và Claude Agent SDK. Nó giám sát và điều khiển một project dùng **CCGS** (Claude Code Game Studios: 49 agent, khoảng 100 skill trong `.claude/`).

Project đang dùng thử: **Meodoku** (Unity 6000.0.81f1), ở máy công ty nằm tại `D:\Meodoku`.

## 2. Ràng buộc bắt buộc (đừng phá)

- **Không sửa file của CCGS** trong project game: `.claude/settings.json`, `.claude/agents/`, `.claude/skills/`, `CLAUDE.md`.
  - Phần riêng của Studio đặt trong plugin `apps/server/plugin`, nạp vào phiên qua tuỳ chọn SDK `plugins`.
- Hook chỉ cài vào `.claude/settings.local.json`. Phải hiện diff và chờ người dùng xác nhận.
  - Hook luôn exit 0 và chạy dưới 1 giây.
- **Không dùng dữ liệu giả.** Thiếu thì ghi `Unknown`.
- Che bí mật trước khi lưu (`src/monitor/redact.ts`).
- Server chỉ nghe `127.0.0.1` và kiểm tra Origin.
- Khi brief mâu thuẫn với thực tế: dừng lại, báo, đề xuất phương án. Không tự lách.
- **Không commit** khi người dùng chưa bảo.
- Trả lời người dùng bằng **tiếng Việt, ngắn gọn**.

## 3. Chạy và kiểm tra

```
npm install
npm run build          # shared -> server -> web
npm test               # vitest ở apps/server, hiện 63/63 pass
npm start              # http://127.0.0.1:4310
```

- Chọn project ở màn **Project**, hoặc đặt `CCGS_PROJECT=<đường dẫn game>`.
- Cài đặt, DB và token hook nằm ở `~/.ccgs-studio/` (đổi bằng `CCGS_STUDIO_HOME`). Thư mục này **không nằm trong git**: máy mới sẽ bắt đầu với DB rỗng, phải chọn lại project và cài lại hook.
- Kiểm tra plugin: `claude plugin validate apps/server/plugin`. Lần chạy gần nhất pass nhưng có warning.

**Khi pull về máy khác:**
1. Game có thể nằm ở đường dẫn khác `D:\Meodoku`, chọn lại ở màn Project.
2. Muốn dùng Unity MCP thì phải mở Unity Editor có cài MCP for Unity. Ở máy công ty, UnityMCP được đăng ký ở **user scope** vì lỗi khoá `d:`/`D:` trong `~/.claude.json`.
3. Màn **Tổng quan → Quét game** cần Unity Editor đang mở, và phải quét xong thì mới lập kế hoạch được.

## 4. Đã xong

| Phần | Nội dung | Tài liệu |
|---|---|---|
| Phase 0–5 | Xem cấu hình, giám sát thụ động bằng hook, chạy task từ web, tính năng P1, Phoenix | `docs/phase-*-report.md` |
| Pipelines | Yêu cầu → Claude lập kế hoạch (chỉ đọc) → người dùng sửa và duyệt → chạy từng bước như task trong cùng một session. `/create-stories` tự sinh bước `/dev-story` và `/story-done` cho từng story | `src/pipelines/pipeline.service.ts`, `apps/web/src/views/Pipelines.tsx` |
| Cổng /start + rigor | Đọc `project.yaml` (`modes.rigor`). Lộ trình CCGS theo rigor nằm trong prompt planner (`ROADMAP`) | `pipeline.service.ts` |
| Quét game | Task chỉ đọc, dùng Unity MCP để liệt kê màn, popup, prefab. Bản tóm tắt được đưa vào prompt planner | `src/pipelines/game-scan.ts` |
| Plugin `studio` | Skill `studio:unity-art-context`: đọc sprite, màu, font thật qua Unity MCP rồi ghi `design/art-context/<slug>.md` | `apps/server/plugin/`, `src/studio-plugin.ts` |
| **Đầu não P1: chuẩn kế hoạch** | Có 6 mẫu kế hoạch. Server kiểm luật bằng code (thiếu bước, sai thứ tự, art trước UI, dev-story sau create-stories), tự sửa những chỗ an toàn, lỗi thì chặn "Duyệt và chạy". Người dùng sửa tay thì lỗi chỉ còn là cảnh báo | Mục 5 |

## 5. Đầu não (hướng chính đang làm)

**Mục tiêu:** Studio là "đầu não" lập kế hoạch và điều khiển 49 agent và skill của CCGS. Studio gọi agent **gián tiếp qua skill**, vì mỗi skill tự chọn agent chuyên môn.

**Đã cân nhắc và loại:** oh-my-claudecode, Ruflo, wshobson/agents.
- Cả ba đều không hiểu luồng CCGS.
- OMC và Ruflo thiên về tự chạy liên tục, trái với nguyên tắc "user-driven" của CCGS.
- `ruflo init` ghi vào `.claude/` và `CLAUDE.md`.
- Chỉ học ý tưởng vòng lập kế hoạch có phản biện (`/ralplan` của OMC) để làm P2.

**Luồng đích:**
1. Phân loại yêu cầu.
2. Lập kế hoạch theo mẫu.
3. Phản biện kế hoạch. *(P2)*
4. Server kiểm luật.
5. Người dùng duyệt.
6. Chạy, có điểm kiểm tra sau mỗi bước. *(P3)*

### P1: Xong (chưa chạy thử với Claude thật)

- **Mẫu:** `apps/server/plugin/plan-templates/*.yaml`, gồm `feature-ui`, `feature-logic`, `tuning`, `content`, `bugfix`, `other`.
  - Trường của mỗi bước: `skill`, `rigor`, `optional`, `repeat`, `output` (`{slug}`).
  - Các bước `repeat` đứng liền nhau tạo thành một nhóm, được xen kẽ theo từng màn.
- **Bộ kiểm luật:** `src/pipelines/plan-rules.ts`, gồm `loadTemplates`, `templatesPrompt`, `checkPlan`.
  - Planner trả thêm `type`, `slug`, `omitted[]`.
  - Kết quả kiểm tra lưu ở `Pipeline.issues` (`PlanIssue`: error / warn / info).
  - Ngoài ra lưu `planType`, `planTypeTitle`, `slug`, `omitted`, `edited` (xem `packages/shared/src/index.ts`).
- **Tự sửa** (chỉ áp dụng cho kết quả của planner, không áp dụng khi người dùng sửa tay):
  - Chèn `studio:unity-art-context` trước bước UI đầu tiên, trừ khi đã có `design/art-context/<slug>.md`.
  - Chèn `/story-done` ngay sau mỗi `/dev-story`.
- Nếu không có thư mục mẫu thì bộ kiểm tra tắt. Test cũ truyền `templates: () => []`.
- **Test:**
  - `test/plan-rules.test.ts`: 8 test, có nạp mẫu thật.
  - `test/pipelines.test.ts`: test cuối, kiểm tra luồng chặn rồi người dùng sửa tay.
- **Giao diện:** component `PlanCheck` trong `Pipelines.tsx` hiện mẫu, slug, lỗi/cảnh báo/ghi chú và các bước bị bỏ.

### P2: Việc tiếp theo, chưa làm

**Vòng phản biện:**
- Sau khi planner xong (`planDone`), tạo thêm một task kiểu `prompt`, chỉ đọc (`permissionMode: 'plan'` hoặc `default`, cấm ghi). Task này dùng agent `producer` của CCGS để soát kế hoạch dưới dạng JSON, so với:
  - `.claude/docs/workflow-catalog.yaml`,
  - các file đã có trên đĩa,
  - yêu cầu của người dùng.
- Kết quả trả về: `{"ok": bool, "issues": [{"level", "message", "stepTitle"}]}`.
- Nếu có lỗi: gửi lại planner (`resumeOf` session planner) kèm danh sách lỗi, **tối đa 2 vòng**, rồi mới chuyển sang `review`.

**Gợi ý thiết kế:**
- Thêm trạng thái `PipelineStatus` = `'critiquing'`, hoặc trường `p.round`.
- Lưu `critiqueTaskId`.
- Gộp issue của phản biện vào `p.issues` với `rule: 'critic'`, mức `warn`. Phản biện là ý kiến của LLM, không chặn chạy; chỉ server mới chặn.
- Cập nhật `onTaskEnded` để nhận ra task phản biện, và `recover()` để xử lý khi server khởi động lại.

**Giao diện:** hiện số vòng và ý kiến phản biện.

**Test:** thêm vào `test/pipelines.test.ts` với `fakeRunner`, theo mẫu test sẵn có.

### P3: Sau P2

**Điểm kiểm tra sau mỗi bước.** Trong `stepDone`, đọc `t.resultText` và `changedFiles`, rồi quyết định:
- chạy tiếp,
- chèn bước sửa (ví dụ `/story-done` báo chưa đạt),
- hoặc dừng lại hỏi người dùng.

Tất cả quyết định này cần luật rõ, đừng để LLM tự quyết hoàn toàn.

**Lập kế hoạch lại** khi kết quả lệch (ví dụ story bị chặn): gọi planner với tình hình mới, chỉ thay các bước `pending`.

## 6. Việc còn treo và chờ người dùng quyết

1. **T-AG-05 (sửa agent):** chưa làm, vì tính năng này ghi vào `.claude/agents/`, trái nguyên tắc số 2. Người dùng chọn (a) ngoại lệ có diff và xác nhận, hoặc (b) bỏ. **Chưa có câu trả lời.**
2. `docs/api-contract.md` **chưa có** endpoint `/api/pipelines/*` và `/api/scan/*` cùng kiểu `Pipeline` / `PlanIssue`. Cần bổ sung (brief §10: hợp đồng cập nhật trước, code sau).
3. Plugin `studio`, Unity MCP trong task và P1 **chưa chạy thử với Claude thật**. Phải restart server để nạp plugin và mẫu mới.
4. **Meodoku:**
   - `project.yaml` và `CLAUDE.md` vẫn ghi Godot, trong khi game là Unity. Một task `/setup-engine` đã được tạo trên máy công ty, chưa rõ kết quả (Unknown).
   - Kế hoạch piggy-bank cũ được tạo trước P1, nên chưa có bước art-context. Nên lập kế hoạch mới.
5. Hạn chế đã biết (xem `phase-4-5-report.md`):
   - Task đang chạy khi Studio khởi động lại sẽ bị đánh `failed`.
   - Phoenix không cộng token cho span loại AGENT.

## 7. Bản đồ code chính

```
apps/server/src/
  main.ts                    Nest bootstrap, nạp skill CCGS + studioSkills()
  studio-plugin.ts           STUDIO_PLUGIN_DIR, studioSkills()
  tasks/task-queue.ts        hàng đợi task (SKILL_RE cho phép plugin:skill)
  tasks/runner.ts            gọi Agent SDK (plugins: [studio])
  pipelines/pipeline.service.ts   planner prompt, parsePlan, check(), chạy bước
  pipelines/plan-rules.ts         mẫu + checkPlan
  pipelines/game-scan.ts          quét game qua Unity MCP
  monitor/, hooks/, phoenix/, insights/, settings/, security/
apps/server/plugin/
  .claude-plugin/plugin.json  plugin "studio"
  skills/unity-art-context/SKILL.md
  plan-templates/*.yaml
apps/web/src/views/Pipelines.tsx  màn lập kế hoạch + PlanCheck
packages/shared/src/index.ts      kiểu dùng chung (Pipeline, PlanIssue, ...)
```

## 8. Git

- Repo chưa có commit nào lúc viết file này. `.gitignore` bỏ qua `node_modules/`, `spikes/captures/`, `dist/`.
- `apps/server/test/monitor.test.ts` có chuỗi giống token (`sk-ant-…`, `ghp_…`). Đây là **dữ liệu giả để test redactor**, không phải bí mật thật. Nếu GitHub push protection chặn, xác nhận là false positive.
