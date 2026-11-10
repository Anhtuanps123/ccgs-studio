# CCGS Studio: tiến độ và việc tiếp theo

Cập nhật: 2026-11-10. Agent nhận việc: **đọc hết file này trước khi sửa code**, rồi đọc thêm `docs/brief.md` (§3 Nguyên tắc, §10 Quy tắc làm việc).

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
npm test               # vitest ở apps/server, hiện 76/76 pass
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
| **Đầu não P2: vòng phản biện** | Sau mỗi bản kế hoạch, agent `producer` soát (chỉ đọc, session riêng). Có lỗi thì planner sửa trong session của nó, tối đa 2 lần. Ý kiến phản biện không chặn chạy | Mục 5 |
| **Đầu não P3: điểm kiểm tra + lập lại kế hoạch** | Sau mỗi bước, luật code đọc verdict, file đổi và câu hỏi cuối để quyết định chạy tiếp, tự sửa 1 lần hoặc dừng. Người dùng có thể trả lời Claude, hoặc lập lại kế hoạch cho các bước còn lại | Mục 5 |
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
6. Chạy, có điểm kiểm tra sau mỗi bước, lập lại kế hoạch khi lệch. *(P3)*

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

### P2: Xong (chưa chạy thử với Claude thật)

**Luồng:** planner xong → server kiểm luật (P1) → task phản biện `critiquing` → nếu phản biện có lỗi `error` **hoặc** server còn lỗi, và số lần sửa < `MAX_REVISIONS` (2) → gửi lại planner (`resumeOf` session planner, trạng thái `planning`) → planner xong → phản biện vòng mới → … → `review`.
- Tối đa 3 vòng phản biện, 2 lần sửa. Bản cuối vẫn được phản biện để người dùng xem ý kiến.
- **Code:** `pipeline.service.ts`, gồm `criticPrompt`, `revisePrompt`, `parseCritique`, `startCritique`, `critiqueDone`, `toReview`, `skipCritique`.
  - Task phản biện: kiểu `prompt`, session mới, `permissionMode: 'default'`, prompt cấm ghi và cấm hỏi. Nó giao việc cho subagent `producer` nếu có.
  - Trả về JSON `{"ok", "issues":[{level, message, stepTitle}]}`.
- **Kiểu (shared):**
  - `PipelineStatus` thêm `'critiquing'`.
  - `Pipeline` thêm `critic`, `critiqueTaskId`, `critiques: CritiqueRound[]`. Mỗi `CritiqueRound` có `round`, `planTaskId`, `taskId`, `ok`, `issues: CriticIssue[]`, `error`, `revised`.
  - `NewPipeline.critic` mặc định `true`. Mặc định của server đặt qua `PipelineDeps.critic`.
- **Ý kiến phản biện** lưu riêng trong `critiques`, **không** gộp vào `p.issues` và **không chặn** "Duyệt và chạy". Chỉ lỗi của server mới chặn.
- **Khi lỗi:**
  - Phản biện lỗi, không đọc được JSON, hoặc tạo task lỗi: chuyển sang `review`, lỗi ghi ở `round.error`.
  - Planner sửa hỏng: giữ bản kế hoạch trước, chuyển sang `review`.
- **Endpoint mới:** `POST /api/pipelines/:id/skip-critique`, huỷ task phản biện (hoặc task planner đang sửa) rồi chuyển sang `review`.
- `cancel()` huỷ cả task phản biện. `recover()` xử lý cả trạng thái `critiquing`.
- **Giao diện:**
  - Ô "Phản biện kế hoạch" ở form tạo chuỗi.
  - Component `Critique` hiện từng vòng.
  - Nút "Bỏ qua phản biện".
  - Chi phí tính gồm cả task phản biện và các lần planner sửa.
- **Luôn cho phép (2026-11-10):** hộp xin quyền có thêm nút "Luôn cho phép <tool>". Studio lưu tên công cụ vào `autoAllow` trong `config.json`, cho phép luôn các hộp đang chờ của cùng công cụ, và từ đó `TaskQueue.ask` tự trả allow mà không hiện hộp nữa (có ghi log). Cài đặt > Quyền công cụ: xem/bỏ từng công cụ, hoặc tick "Tự cho phép mọi công cụ" (`'*'`). AskUserQuestion luôn hỏi. Chỉ áp cho những lần Claude Code đã định hỏi (`canUseTool`), nên luật deny và hook của project vẫn chặn trước.
- **Phản biện rẻ hơn (2026-11-10):** đo thực tế mỗi vòng phản biện khoảng $1.0–1.1 (Opus, 28–38 tool call), đắt hơn bước lập kế hoạch ($0.71). Nguyên nhân: session chính giao cho subagent `producer`, nên system prompt bị nạp 2 lần, kế hoạch bị gửi 2 lần, và session chính chỉ chép lại kết quả. Producer thì đọc nguyên SKILL.md và workflow-catalog. Sửa: `criticPrompt` tự soát theo góc nhìn producer, cấm Agent, chỉ Grep/Read từng đoạn (khoảng 10 tool call). Runner nhận `compactAfter(task)` và bỏ /compact cho task phản biện (`isCriticPrompt`), vì session đó không bao giờ được resume. Chưa đo lại với Claude thật.
- **Sửa theo phản biện (2026-11-10):** vòng tự động chỉ sửa khi có lỗi, nên cảnh báo trước đây phải sửa tay. Thêm `POST /api/pipelines/:id/revise` (`revise()`), dùng khi chuỗi đang `review` và chưa chạy bước nào. Gửi về session planner:
  - mọi ý kiến của vòng phản biện cuối, gồm cả cảnh báo;
  - cảnh báo của studio;
  - kế hoạch hiện tại, có cả phần người dùng sửa tay;
  - ghi chú của người dùng.

  Sau đó kế hoạch được phản biện lại. Việc cần người dùng quyết mà ghi chú chưa có thì planner ghi "CẦN QUYẾT: …" vào `why` của bước đó. Round được đánh `revisedBy: 'user'` và không tính vào `MAX_REVISIONS`. Giao diện có ô ghi chú và nút "Sửa theo phản biện" dưới phần phản biện.
- **Test:** 5 test trong `test/pipelines.test.ts`, mục `pipeline critic loop (P2)`. Các test cũ truyền `critic: false`.
- **Chưa thử thật:** chưa biết `producer` có trả đúng JSON không, và mất bao nhiêu token mỗi vòng (Unknown).

### P3: Xong (chưa chạy thử với Claude thật)

**Điểm kiểm tra sau mỗi bước.** Luật viết bằng code, không có LLM, nằm ở `src/pipelines/checkpoint.ts`:
- `verdictOf` lấy verdict từ dòng `Verdict:` hoặc `Recommendation:` cuối cùng, hoặc từ dòng `Story: <path> — Implemented|INCOMPLETE|BLOCKED` của `/dev-story`.
- `checkStep` quyết định `continue`, `fix` hoặc `pause`. Thứ tự luật:
  1. **Verdict xấu, sửa được, tự sửa 1 lần** (nếu `step.fixOf` đã có thì không tự sửa nữa):
     - Một skill review (`ux-review`, `design-review`, `code-review`, `story-readiness`, `architecture-review`) báo `NEEDS REVISION`, `CHANGES REQUIRED` hoặc `NEEDS WORK`: chèn một prompt "sửa theo review", rồi chạy lại review.
     - `/dev-story` báo `INCOMPLETE`: chạy lại.
     - `/story-done` báo `BLOCKED`: chèn `/dev-story` rồi `/story-done`.
     - Sửa rồi vẫn xấu: dừng, gợi ý lập lại kế hoạch.
  2. **Verdict lệch kế hoạch** (`MAJOR REVISION NEEDED`, `BLOCKED`, `REDIRECTED`, `PIVOT`, `KILL`, `FAIL`): dừng, `replan: true`.
  3. **Verdict cần người xem** (`NOT ASSESSED`, `CONCERNS`): dừng.
  4. **File output theo mẫu** (slot có `output`, không `repeat`) **không có trên đĩa:** dừng.
  5. **Verdict tốt:** chạy tiếp.
  6. **Không có verdict, Claude kết thúc bằng câu hỏi:** dừng, ghi câu hỏi vào `check.question`.
  7. **Skill ghi file** (`WRITERS`) mà không đổi file nào: dừng. Bỏ qua luật này khi permissionMode là `plan` hoặc khi `changedFiles` là null.
- **Nơi lưu kết quả:**
  - Kết quả của từng bước nằm ở `step.check`.
  - Khi chuỗi phải dừng, kết quả cũng được ghi vào `p.checkpoint`, và `start()` xoá nó đi.
  - Bước được chèn tự động có `fixOf`. `updateSteps` giữ lại `fixOf`.
- **Trả lời:** `POST /api/pipelines/:id/answer {text}` chèn một prompt step "Trả lời Claude" trước bước chờ đầu tiên rồi chạy tiếp, trong cùng session.

**Lập lại kế hoạch:** `POST /api/pipelines/:id/replan {note?}`, do người dùng bấm, không tự chạy.
- Tạo task planner `resumeOf` session làm việc (session này biết mọi chuyện đã xảy ra), dùng `replanPrompt` với: bước đã chạy kèm verdict, lý do dừng, ghi chú của người dùng, các bước còn chờ.
- Planner chỉ trả về các bước còn phải chạy.
- `planDone` luôn giữ các bước không ở trạng thái `pending`, chỉ thay phần còn chờ. Nếu lỗi thì giữ kế hoạch cũ. Sau đó vẫn đi qua kiểm luật P1 và phản biện P2.
- Giới hạn số lần sửa theo phản biện tính riêng cho mỗi lần lập lại, qua `CritiqueRound.epoch` = `p.replans`.
- `p.replanning` bằng `true` cho đến lúc `toReview`. `p.planTasks` lưu mọi task planner để tính chi phí.

**Giao diện:**
- Hộp "Điểm kiểm tra" hiện verdict, lý do và ô trả lời câu hỏi.
- Mục "Lập lại kế hoạch" có ô ghi chú.
- Mỗi bước hiện kết quả điểm kiểm tra, và tag "điểm kiểm tra thêm" cho bước được chèn tự động.

**Test:**
- `test/checkpoint.test.ts`: 5 test.
- `test/pipelines.test.ts`, mục `pipeline checkpoints and re-plan (P3)`: 3 test.
- Test chạy đủ chuỗi cũ nay giả lập file thay đổi cho `/quick-design` và `/dev-story`, vì luật 7.

**Chưa biết khi chạy thật:**
- Cách Claude trình bày verdict ngoài thực tế có khớp regex không.
- Skill CCGS hay hỏi "May I write…?" bằng chữ thường; khi đó chuỗi sẽ dừng ở luật 6, chạy tiếp được hay không thì phải thử mới biết.
- Có thể cần thêm token hoặc skill vào `WRITERS` / `REVIEWS`.

### Hướng tiếp theo (gợi ý, chưa làm)

- Chạy thử thật P1, P2 và P3 với kế hoạch piggy-bank, rồi chỉnh luật theo log thật.
- Có thể cho phép tự lập lại kế hoạch (không cần bấm) ở chế độ "Tự chạy hết", có giới hạn số lần. Hiện tại cố ý để người dùng bấm, theo nguyên tắc "user-driven" của CCGS.

### Graphify: phân tích → duyệt → chạy (brief `BRIEF_PHAN_TICH_GRAPHIFY.md`, người dùng gửi 2026-11-10)

- **Bước 0 xong** (2026-11-10). Báo cáo: `docs/graphify-phase-0-report.md`. Script thử: `spikes/graphify/`. **Chưa sửa code ứng dụng.**
  - Cách dựng ngoài project: `GRAPHIFY_OUT` = `~/.ccgs-studio/projects/<id>/graphify`, `GRAPHIFY_BACKEND=none`, `graphify update <project>`. Danh sách loại trừ ghi vào `<out>/.graphify_build.json`, vì `update` bản 0.9.103 không có `--exclude`. Đã xác nhận `git status` của Meodoku không đổi.
  - graphify 0.9.103 đã được cài lại kèm `[mcp]`; bản trước thiếu, nên `graphify-mcp` chết ngay khi chạy. Claude gọi được `query_graph` qua `mcpServers` của SDK.
- **Đang chờ người dùng quyết (báo cáo §7):**
  - Mục tiêu đo: planner thật ra chỉ gọi khoảng 4 tool, chi phí nằm ở ngữ cảnh cố định; con số 28–38 tool là của vòng phản biện.
  - Cách truy vấn sẵn với yêu cầu tiếng Việt: truy vấn bằng tiếng Việt cho kết quả lạc đề.
  - Danh sách loại trừ mặc định.
  - 2 yêu cầu mẫu để đo mốc.
- **Bước 1–3: chưa làm.** Làm lần lượt, dừng sau mỗi bước.

## 6. Việc còn treo và chờ người dùng quyết

1. **T-AG-05 (sửa agent):** chưa làm, vì tính năng này ghi vào `.claude/agents/`, trái nguyên tắc số 2. Người dùng chọn (a) ngoại lệ có diff và xác nhận, hoặc (b) bỏ. **Chưa có câu trả lời.**
2. `docs/api-contract.md` **chưa có** endpoint `/api/pipelines/*` (gồm `skip-critique`, `replan`, `answer`) và `/api/scan/*`, cùng kiểu `Pipeline` / `PlanIssue` / `CritiqueRound` / `StepCheck`. Cần bổ sung (brief §10: hợp đồng cập nhật trước, code sau).
3. Plugin `studio`, Unity MCP trong task, P1, P2 và P3 **chưa chạy thử với Claude thật**. Phải restart server để nạp plugin và mẫu mới.
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

- Đã push lên `origin/main` (https://github.com/Anhtuanps123/ccgs-studio). Commit đầu: `b7b474a` (phase 0–5, pipelines, P1). P2 và P3 chưa commit. `.gitignore` bỏ qua `node_modules/`, `spikes/captures/`, `dist/`.
- `apps/server/test/monitor.test.ts` có chuỗi giống token (`sk-ant-…`, `ghp_…`). Đây là **dữ liệu giả để test redactor**, không phải bí mật thật. Nếu GitHub push protection chặn, xác nhận là false positive.
