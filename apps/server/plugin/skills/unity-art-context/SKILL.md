---
name: unity-art-context
description: "Reads the open Unity project through Unity MCP and writes an art-context sheet (sprites, colours, fonts, similar screens) for one feature, so UX specs, prototypes and UI code match the game's existing look. Run before /ux-design, /prototype or /dev-story of a UI story."
argument-hint: "<feature-slug> [screen names]"
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, mcp__UnityMCP__manage_asset, mcp__UnityMCP__manage_scene, mcp__UnityMCP__find_gameobjects, mcp__UnityMCP__manage_prefabs, mcp__UnityMCP__manage_ui, mcp__UnityMCP__manage_texture, mcp__UnityMCP__manage_camera, mcp__UnityMCP__manage_editor, mcp__UnityMCP__read_console, ListMcpResourcesTool, ReadMcpResourceTool
---

# Unity art context

Goal: the next design or build step for `$ARGUMENTS` reuses the game's real art
instead of placeholders. You only **read** the Unity project. The one file you write
is the sheet below.

## Rules

- Read-only in Unity: no Play mode, no scene save, no asset import/move/delete,
  no prefab or component edits, no selection left changed.
- Never invent an asset, colour or font. Anything you could not read is `Unknown`.
- If no `mcp__UnityMCP__*` tool works or the Editor is not connected, still write
  the sheet with `Trạng thái: CHƯA DÙNG ART THẬT — <lý do>` at the top and stop.
  The next steps must see this line rather than silently fall back to emoji.

## Steps

1. Slug = first word of `$ARGUMENTS` (kebab-case). Read `design/game-brief.md`,
   `design/ux/*.md` and the stories under `production/epics/<slug>/` if they exist,
   to know which screens/popups the feature needs.
2. Find the **closest existing screens** in the game (e.g. other reward/progress
   popups, the win popup, home buttons): search prefabs and scenes with Unity MCP.
   Prefer 2–4 references; list their prefab paths.
3. From those references collect, with real asset paths under `Assets/`:
   - popup frame / panel background, header ribbon, close button, primary and
     secondary buttons, progress bar (track + fill), currency icon (coin), badges;
   - fonts (TMP font asset paths) and text styles (size, colour, outline);
   - main colours as hex (from Image/TMP colours on the references);
   - 9-slice borders if set, and the canvas reference resolution;
   - open/close animation or tween used by popups, if visible in components.
4. If the Editor can take a screenshot of a reference popup, save it under
   `design/art-context/<slug>/` and list it. Otherwise say it was skipped.
5. Write `design/art-context/<slug>.md` (Vietnamese) with sections:
   `Trạng thái`, `Màn tham chiếu`, `Sprite dùng lại` (table: vai trò, đường dẫn,
   9-slice, ghi chú), `Font và chữ`, `Màu`, `Bố cục và kích thước`, `Animation`,
   `Còn thiếu` (art the feature needs that does not exist yet), `Unknown`.
6. Reply with a 5-line summary and the sheet path.

## How later steps use the sheet

- `/ux-design`: reference sprites/colours by the names in the sheet.
- `/prototype` (HTML): copy the listed sprite files into
  `prototypes/<slug>/art/` and use them with relative paths; use the hex colours
  and the closest web font. Never link into `Assets/` (the preview cannot read it).
- `/dev-story`: reuse the listed prefabs/sprites/fonts; new art only for `Còn thiếu`.
