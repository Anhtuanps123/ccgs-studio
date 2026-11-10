# Graphify Bước 0: kiểm chứng và đo mốc

Ngày: 2026-11-10. Theo `BRIEF_PHAN_TICH_GRAPHIFY.md` §9 Bước 0. Không sửa code ứng dụng; script thử nằm ở `spikes/graphify/`.

## Tóm tắt

| Mục | Kết quả |
|---|---|
| 1. Dựng đồ thị ngoài project | **Đạt**. Danh sách loại trừ của brief (A3) chưa đủ cho Meodoku, xem §2 |
| 2. `explain` 5 class C# | **Đạt**. Kế thừa, implements, method và lời gọi khớp với code |
| 3. `update` sau khi sửa 1 file | **Đạt về độ đúng**: chỉ quét lại 1 file. **Chậm**: 17–30 giây cho cả lần chạy |
| 4. Không ghi gì vào project | **Đạt**. `git status` của Meodoku không đổi sau mọi lệnh |
| 5. `graphify-mcp` trong phiên Agent SDK | **Đạt**, sau khi cài lại kèm `[mcp]` |
| 6. Đo mốc planner với 2 yêu cầu mẫu | **Chưa làm**: cần người dùng chọn yêu cầu. Đã có số đo của các lần lập kế hoạch trước, và **chúng mâu thuẫn với mục tiêu chính của brief** (§6) |

**Cần người dùng quyết trước khi làm Bước 1:** xem §7.

## 1. Cài đặt và phiên bản

- Máy đã có sẵn **graphify 0.9.103** (cài bằng `uv tool`), trong khi brief ghi 0.9.105. Mình giữ bản 0.9.103.
- Bản có sẵn **được cài không kèm `[mcp]`**, nên `graphify-mcp` chết ngay khi chạy (`ModuleNotFoundError: No module named 'mcp'`). SDK chỉ báo `CONNECTION_CLOSED`, không nói lý do.
- Đã cài lại bằng `uv tool install "graphifyy[mcp]==0.9.103" --force` (mcp 2.3.0). Studio cần kiểm tra cả việc `import mcp` thành công (A1), không chỉ kiểm tra lệnh có trên PATH.
- Python 3.14.7, uv 0.13.5.

## 2. Dựng đồ thị (mục 1)

**Lệnh đã xác nhận** (script `spikes/graphify/build.sh`):

```
GRAPHIFY_OUT=<tuyệt đối>/graphify  GRAPHIFY_BACKEND=none  GRAPHIFY_QUERY_LOG_DISABLE=1
cd <thư mục cha của OUT>        # không bao giờ chạy với cwd là project
graphify update D:/Meodoku [--no-cluster]
```

- Nơi lưu là `~/.ccgs-studio/projects/<id>/graphify`. `<id>` lấy theo cách `game-scan.ts` đang làm: sha1 của đường dẫn viết thường, cắt 16 ký tự. Với Meodoku là `91b70652a67e34da`.
- **Khác brief:** lệnh `update` trong bản 0.9.103 **không có `--exclude`**. Chỉ `extract` có tuỳ chọn này, và brief cấm dùng `extract`.
  - Cách làm được: ghi file `<GRAPHIFY_OUT>/.graphify_build.json` = `{"excludes": [...], "gitignore": true, "code_only": true}` **trước** khi chạy `update`.
  - `update` đọc và áp dụng file này (đã xác nhận trong `.graphify_build_state.json`).
  - File nằm ở thư mục output, nên **không cần `.graphifyignore` trong project**.
- graphify vẫn đọc (chỉ đọc) `.gitignore`, `.git/info/exclude` và `core.excludesFile` của project.
- **Cách kiểm "không ghi vào project":** so `git status --porcelain -uall` trước và sau mọi lệnh: không đổi. `.git/info/exclude` không bị sửa (mtime 09:06, trước khi bắt đầu). Không có `graphify-out/`, `.graphifyignore`, `~/.graphify` hay `~/.cache/graphify-queries.log`.
  - Giới hạn: Meodoku có `CLAUDE.md` và `.claude/` **chưa được track**. `git status` chỉ thấy file mới thêm, không thấy nội dung file chưa track bị sửa. Lần quét mtime toàn project để kiểm phần này chạy quá 2 phút nên đã dừng.
  - Phần này dựa vào mã nguồn: mọi đường ghi (cache, manifest, graph) đều đi qua `GRAPHIFY_OUT`.
  - Ngoại lệ duy nhất là lần sửa thử `PiggyBank.cs` có chủ đích; file đã khôi phục, sha1 khớp bản gốc.

**Số liệu, đều là lần dựng đầu, không có cache:**

| Biến thể | Loại trừ | File nguồn | Node | Cạnh | graph.json | Thư mục out | Thời gian |
|---|---|---|---|---|---|---|---|
| A | A3 của brief | 1.239 | 15.873 | 38.829 | 26 MB | 67 MB | Unknown (script lỗi đo giờ) |
| B | A3 + `*.slnx`, `.claude/`, `.agents/` | 980 | 14.928 | 37.269 | 24 MB | 63 MB | 30,2 s |
| C | B + thư viện bên thứ ba (danh sách dưới) | 457 | 5.717 | 13.543 | 8,6 MB | 23 MB | 13,1 s |

**Vì sao A3 chưa đủ:**
- `Meodoku.slnx` không bị `*.sln` loại, nên sinh ra 137 node "project" mang tên file `.csproj` (dù bản thân các file `.csproj` đã bị loại).
- `.claude/` và `.agents/` (script .sh, .yaml, .cs của skill CCGS) thêm khoảng 766 node nhiễu.
- Thư viện bên thứ ba của Meodoku **không** nằm ở `Assets/Plugins/`.
  - Chúng nằm ở `Assets/_D2MSDK/3rd-Parties/`, `Assets/_D2MGame/3rd-Parties/`, `Assets/Spine/`, `Assets/JMO Assets/`, `Assets/AppsFlyer/`, `Assets/Firebase/`.
  - Nhóm này chiếm hơn 60% node.
  - Vẫn còn sót: `Assets/_D2MSDK/D2MServices/GoogleServices/GooglePlayPlugins/` (code Google). Truy vấn ở đồ thị C vẫn khớp node `Level` của nó.

**Đề xuất:**
- Mặc định của Studio = A3 + `*.slnx`, `.claude/`, `.agents/`.
- Danh sách thư mục bên thứ ba sửa được theo từng project trong Cài đặt (đúng ý A8). Với Meodoku nên dùng biến thể C.

## 3. `explain` 5 class (mục 2)

Đồ thị B. Đối chiếu từng dòng với code:

| Class | Kết quả | Đối chiếu |
|---|---|---|
| `CellController` | inherits `MonoBehaviour`; implements `IPointerClickHandler`, `IPointerDownHandler`, `IPointerUpHandler`, `IPointerEnterHandler` (khai báo trải trên nhiều dòng). Bị tham chiếu bởi `GameplayManager`, `TutorialManager`… | Khớp `CellController.cs:10–12` |
| `PopupProfile` | inherits `Popups` (L8); 11 method với số dòng | Khớp L8, L43 `Show`, L78 `Appear`, L117 `NextStep` |
| `DailyLoginManager` | inherits `MonoBehaviour`; hai overload `ClaimDailyLogin` L106 và L111; bị `PopupDailyLogin` tham chiếu (L10) | Khớp |
| `LeaderBoardManager` | implements `IEnhancedScrollerDelegate`; `PopupLeaderBoard` tham chiếu (L11) | Khớp |
| `PiggyBank` | Trùng tên với 2 node khác (enum `GameItemType.PiggyBank`, `FunctionUnlock.PiggyBank`), nên `explain` trả **mã 3** và liệt kê ứng viên. Dùng `path::symbol` thì được. Lời gọi duy nhất `GameplayManager.CompleteWinProgress()` → `PiggyBank.OnLevelWon()` ở `GameplayManager.cs:L2215` | Khớp với grep: đó là lời gọi duy nhất từ ngoài; `Claim()` chưa được gọi ở đâu |

- `affected "…PiggyBank.cs::PiggyBank"` trả về `CompleteWinProgress` và `TryCompleteLevel`: đúng chuỗi gọi.
- Mã thoát đã xác nhận: 0 có kết quả, **3 mơ hồ**, **4 không tìm thấy**. Áp dụng cho `query`, `explain`, `path`.

## 4. `update` tăng dần (mục 3)

Sửa thử `Assets/_D2MGame/Scripts/PiggyBank/PiggyBank.cs`:
- Sao lưu file vào scratchpad, thêm một class tạm, chạy `update`.
- Khôi phục từ bản sao lưu (sha1 khớp bản gốc), rồi chạy `update` lại.

| Trường hợp | Kết quả | Thời gian |
|---|---|---|
| Không có thay đổi | Không quét lại file nào | 9,5 s |
| Sửa 1 file, có phân cụm | `re-extracting 1 of 2673 scanned files`; node +2, cạnh +2 | 30,4 s |
| Khôi phục, `--no-cluster` | Quét lại 1 file; node của class tạm biến mất (`explain` trả mã 4) | 17,7 s |

- Phần lớn thời gian **không** nằm ở việc quét file, mà ở việc đọc và ghi lại `graph.json` 24 MB, phân cụm, và ghi `graph.html`.
- Lần phân cụm có cảnh báo: tên cộng đồng (community) bị đặt lại theo node trung tâm, vì không có LLM để đặt tên.
- Hệ quả cho A4:
  - Cập nhật ở nền là đúng, không được chặn hàng đợi.
  - Sau mỗi bước nên dùng `--no-cluster`, và chỉ phân cụm lại khi người dùng bấm "Dựng lại".
  - Đồ thị nhỏ hơn (biến thể C) sẽ nhanh hơn rõ rệt.

## 5. MCP trong Agent SDK (mục 5)

Script `spikes/graphify/mcp-spike.mjs`. Cấu hình phiên:
- `mcpServers: { graphify: { command: 'graphify-mcp', args: ['<graph.json>'] } }`
- `settingSources: []`, cwd trung lập, model haiku.

Kết quả:
- **Claude gọi được `query_graph`** (với `context_filter: ["call"]`) và trả đúng: `GameplayManager.CompleteWinProgress()` gọi `PiggyBank.OnLevelWon()` ở `GameplayManager.cs:L2215`.
- Tốn 3 lượt, $0,004, 11 giây.

Khác brief:
- Tool MCP là **tool trì hoãn**: Claude phải gọi `ToolSearch` trước rồi mới dùng được, mất thêm 1 lượt.
- Server có thêm `list_prs`, `triage_prs`, `get_pr_impact`, `get_community`, `god_nodes`. Studio nên chỉ cho phép các tool đọc đồ thị (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `graph_stats`, `god_nodes`, `get_community`) và **chặn nhóm `*_prs`**.
- Nếu đưa tên tool vào `allowedTools`, `canUseTool` sẽ không được gọi cho các tool đó (SDK cảnh báo `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Không sao vì đây là tool chỉ đọc, nhưng cần ghi nhận.

## 6. Đo mốc planner (mục 6) và mâu thuẫn với mục tiêu của brief

**Chưa đo được 2 yêu cầu mẫu**, vì brief ghi "do người dùng chọn".

Đã đo các lần lập kế hoạch thật trước đây trong DB Studio:
- Script `spikes/graphify/planner-cost.cjs` đếm tool từ hook event.
- Script `spikes/graphify/session-tokens.cjs` cộng token từ transcript, tách theo khoảng thời gian chạy của task.

| Task | Lượt | Tool | Token ghi cache / đọc cache / ra | `cost_usd` (Opus) |
|---|---|---|---|---|
| plan 09/11 10:05 | 4 | Grep 2, Glob 1, AskUserQuestion 1 | 49.560 / 214.699 / 2.539 | 0,49 |
| plan 09/11 10:51 | 3 | Grep 2, Glob 1, Read 1 | 32.192 / 168.876 / 2.374 | 0,34 |
| plan 10/11 02:40 | 4 | Grep 2, Glob 1, Read 1 | 73.456 / 200.441 / 3.932 | 0,71 |
| revise 10/11 03:00 | 1 | không | 41.999 / 18.383 / 3.699 | 1,81 (*) |
| critic 10/11 (3 vòng) | 19–20 | 28–38 (Grep 14–15, Glob 7–12, Read 5–11, Agent 1) | khoảng 100k / 735k–927k / 12–14k | 1,03–1,13 |

(*) Theo transcript, lần revise chỉ có khoảng 60k token cho 1 lượt, mà `cost_usd` ghi $1,81. Phần chênh lệch chưa rõ (Unknown). Có thể là chi phí `/compact` chạy sau task bị cộng vào; cần kiểm tra trong `runner.ts`.

**Mâu thuẫn:** brief §1 nói mục đích chính là giảm token do Claude "mở hàng chục file" khi lập kế hoạch, dẫn con số "28–38 lượt gọi tool". Số liệu thật cho thấy:
1. Con số 28–38 là của **vòng phản biện**, không phải planner. Phản biện đã được sửa ở phiên trước để tự soát và cấm Agent (PROGRESS.md P2, "Phản biện rẻ hơn"), nhưng **chưa đo lại**.
2. **Planner chỉ gọi khoảng 4 tool** (0–1 lần Read). Chi phí $0,34–0,71 gần như toàn bộ là **ngữ cảnh cố định**, khoảng 50–70k token mỗi lượt:
   - system prompt của Claude Code,
   - `CLAUDE.md` của CCGS và các file nó import,
   - định nghĩa tool (kể cả khoảng 50 tool của UnityMCP),
   - prompt planner khoảng 30k ký tự (gồm danh sách khoảng 100 skill).

   Graphify **không** giảm được phần này.
3. Vậy với planner, mục tiêu "giảm rõ rệt Read/Glob" ở nghiệm thu Bước 2 gần như chắc chắn **không đạt**, vì hiện tại đã gần 0. Graphify vẫn có ích ở chỗ khác:
   - **Chất lượng phân tích:** `ref` file:dòng có thật, nguyên nhân lỗi qua `affected`. Đây là phần brief mới thêm.
   - **Bước phân tích lỗi:** bước này cần lần theo code nhiều hơn, khác với planner hiện nay.
   - Có thể cả các bước `/dev-story` và `/code-review`.

## 7. Cần người dùng quyết

1. **Mục tiêu của Bước 1–2:** giữ graphify chủ yếu vì **chất lượng phân tích** (ref thật, nguyên nhân lỗi), chấp nhận chi phí planner gần như không đổi? Hay đổi mục tiêu đo sang bước phân tích lỗi và các bước `/dev-story`, nơi Claude thật sự đọc nhiều file?
   - Nếu mục tiêu vẫn là **giảm chi phí planner**, các đòn bẩy khác tác dụng hơn graphify, nhưng cần đo thêm mới biết:
     - không gắn UnityMCP cho task planner,
     - rút gọn danh sách skill,
     - dùng Sonnet.
2. **Truy vấn sẵn ở server (6.1 mục 3) với yêu cầu tiếng Việt:** `graphify query "heo đất tiết kiệm"` trả **mã 0 nhưng kết quả lạc đề** (khớp vào một test của level generator), vì tên trong code là tiếng Anh. Phương án:
   - (a) Bỏ truy vấn sẵn; để Claude tự tra qua MCP bằng tên tiếng Anh.
   - (b) Server chỉ truy vấn sẵn khi yêu cầu có định danh ASCII (ví dụ `PiggyBank`, `PopupProfile`); không có thì bỏ qua.
   - (c) Kết hợp (b) với ô "từ khoá code" không bắt buộc ở form tạo chuỗi.

   Mình đề xuất **(b) + (c)**.
3. **Danh sách loại trừ mặc định:** A3 + `*.slnx`, `.claude/`, `.agents/`. Thư viện bên thứ ba sửa theo project (Meodoku: biến thể C). Đồng ý không?
4. **2 yêu cầu mẫu cho mục 6** (1 tính năng, 1 lỗi):
   - Mỗi lần chạy planner hiện tại tốn khoảng $0,35–0,7 (Opus).
   - Cần Studio server đang chạy, Unity Editor mở và "Quét game" xong.
   - Nên tắt phản biện khi đo, để chỉ đo planner.

## 8. Tệp đã tạo

- `spikes/graphify/build.sh`: dựng hoặc cập nhật với `GRAPHIFY_OUT` và loại trừ, có đo thời gian.
- `spikes/graphify/excludes-B.json`, `excludes-C.json`.
- `spikes/graphify/stats.py`: thống kê `graph.json`.
- `spikes/graphify/mcp-spike.mjs`: graphify-mcp trong Agent SDK.
- `spikes/graphify/planner-cost.cjs`, `session-tokens.cjs`: đo mốc từ DB và transcript (chỉ đọc).
- Dữ liệu (ngoài git): `~/.ccgs-studio/projects/91b70652a67e34da/{graphify,spike-B,spike-C}`, tổng khoảng 153 MB. Có thể xoá `spike-*` sau khi chốt biến thể.
