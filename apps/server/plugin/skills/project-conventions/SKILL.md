---
name: project-conventions
description: "Reads the open Unity project through Unity MCP and writes design/conventions.md: the reference popup/screen to duplicate, how the close button is anchored, which images are 9-slice, title and button styles, fonts, canvas size, and the code pattern popups follow. Run once per project (again when the UI style changes), before UX or UI code work, so new screens match the existing ones."
argument-hint: "[folder of popups/screens, e.g. Assets/_Game/Resources/Popups]"
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, mcp__UnityMCP__execute_code, mcp__UnityMCP__manage_asset, mcp__UnityMCP__manage_prefabs, mcp__UnityMCP__find_gameobjects, mcp__UnityMCP__manage_scene, mcp__UnityMCP__manage_editor, mcp__UnityMCP__read_console, ListMcpResourcesTool, ReadMcpResourceTool
---

# Project conventions

Goal: one short file, `design/conventions.md`, that tells every later step how this
game builds its UI, measured from the real prefabs. A new popup that follows it looks
like the others: same frame, same close button spot, 9-slice where the art is 9-slice.

## Rules

- **Read-only in Unity.** No Play mode, no scene or prefab save, no asset import, move
  or delete, no component edits, no selection left changed. In `execute_code` never call
  `SaveAsPrefabAsset`, `PrefabUtility.Apply*`, `AssetDatabase.Create/Delete/Move/Import/Refresh`,
  `EditorUtility.SetDirty`, `EditorSceneManager.Save*`. Load prefabs with
  `AssetDatabase.LoadAssetAtPath` and only read them.
- **Measure, do not guess.** Every value in the file comes from a prefab you read. A value
  you could not read is `Unknown`. Never invent a prefab path, sprite or font.
- **Majority wins.** The convention is what most screens do. Screens that differ are listed
  under `Lệch chuẩn`; do not "fix" them here.
- If no `mcp__UnityMCP__*` tool works or the Editor is not connected, write the file with
  `Trạng thái: CHƯA ĐO TỪ UNITY — <lý do>` at the top, fill only the code section from
  the scripts, and stop.
- `execute_code` may compile with C# 6 (CodeDom): no local functions, no `is not`, no
  tuples; write `UnityEngine.Object` in full.

## Steps

1. **Find the screens.** Folder = `$ARGUMENTS` if given. Otherwise look for prefab folders
   whose names say popup, dialog, panel, screen or UI (`Glob **/Popups/**/*.prefab`,
   `**/UI/**/*.prefab`, or `manage_asset` search). Skip third-party folders (`Plugins`,
   `ThirdParty`, `3rd-Parties`, SDK folders). Keep the 5–20 screens that belong to the game.
2. **Measure each screen** with one `execute_code` call that loops over the prefab paths and
   returns text. Per prefab, for the main panel (the large `Image` under the root), the close
   button (name contains close, exit or `x`, or a small button in a top corner), the title
   text, and each button with a `Button`/custom button component, record:
   - path in the prefab, `anchorMin`/`anchorMax`, `anchoredPosition`, `sizeDelta`, `pivot`;
   - `Image.type`, sprite asset path, sprite `border`, `pixelsPerUnitMultiplier`;
   - children of the close button (icon sprite and size);
   - for TMP texts: font asset, `fontSize`, auto size, colour, alignment.
   Also flag every `Image` whose sprite has a non-zero border while `type` is `Simple`
   (stretched 9-slice art), and every `Mask` / `RectMask2D`.
3. **Find the pattern.** For each attribute take the value most screens share. The
   **reference screen** is the screen that matches the most majority values; give 1–2 more
   as backups. A screen that breaks a majority value goes to `Lệch chuẩn` with the value.
4. **Canvas.** Read `CanvasScaler` of the main scenes (reference resolution, match) with
   `manage_scene` / `find_gameobjects`.
5. **Code pattern.** With Grep (not the whole project: search the screens' scripts) find the
   popup base class, how a popup is loaded (Resources, Addressables, instantiate from a
   field), how it shows and hides, the shared open/close animation, and where button
   handlers are wired. Name files with line numbers.
6. **Write `design/conventions.md`** (Vietnamese, short, tables where they help) with these
   sections:
   - `Trạng thái` (đo từ Unity / chưa đo, ngày, số màn đã đo)
   - `Màn mẫu` (prefab path to duplicate for a new popup, and why; backups)
   - `Khung` (panel sprite, Image.type, size, anchors)
   - `Nút đóng` (anchor, pos, size, sprite, icon sprite and size)
   - `Tiêu đề` and `Nút chính / phụ` (sprite, Image.type, size, label font and size)
   - `Ảnh 9-slice` (rule: a sprite with a border uses `Sliced`; list the 9-slice sprites)
   - `Font và chữ`, `Canvas`
   - `Code` (base class, load, show/hide, animation, file:line)
   - `Cách làm màn mới` (5–8 bullets: duplicate the reference, keep frame and close button,
     use Sliced for bordered sprites, keep text inside its box, render and compare with
     `/studio:ui-compare` before closing the story)
   - `Lệch chuẩn` (screen, attribute, its value, the convention)
   - `Unknown`
7. Reply with a 5-line summary: reference screen, the 3 most important rules, how many
   screens deviate, the file path.
