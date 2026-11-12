---
name: ui-compare
description: "Renders a new or changed Unity UI screen next to the project's reference screen through Unity MCP, compares the real values (close button anchor, 9-slice images, frame, fonts, text overflow) and the images, and writes the evidence with a PASS / CONCERNS / FAIL verdict. Read-only in Unity. Run after a UI story or UI bug fix, before /story-done."
argument-hint: "<story path | prefab path | feature-slug> [reference prefab path]"
user-invocable: true
allowed-tools: Read, Glob, Grep, Write, Bash(git status *), Bash(git diff *), mcp__UnityMCP__execute_code, mcp__UnityMCP__manage_asset, mcp__UnityMCP__manage_prefabs, mcp__UnityMCP__manage_editor, mcp__UnityMCP__read_console, ListMcpResourcesTool, ReadMcpResourceTool
---

# UI compare

Goal: a UI change is not "done" because it compiles or because a screenshot exists. It is
done when it was rendered and checked against the screen the game already uses as its
standard. You only **look and report**. You do not fix anything.

## Rules

- **Read-only in Unity.** Load prefabs into a preview scene
  (`EditorSceneManager.NewPreviewScene`) and close it after. Never save a prefab or scene,
  never call `SaveAsPrefabAsset`, `PrefabUtility.Apply*`, `AssetDatabase` writes,
  `EditorUtility.SetDirty`. Do not enter Play mode.
- The only files you write are under `production/qa/evidence/<slug>/`: the PNG renders and
  `compare.md`.
- Do not fix what you find. Report it; the next step (or the user) fixes it.
- `execute_code` may compile with C# 6 (CodeDom): no local functions (use `System.Func` /
  `System.Action` lambdas), write `UnityEngine.Object` in full.
- No Unity MCP or no Editor connected: write `compare.md` with `Verdict: NOT ASSESSED` and
  the reason, and stop.

## Steps

1. **Target screen(s).** From the first word of `$ARGUMENTS`:
   - a `.prefab` path: that prefab;
   - a story path: the prefab paths named in the story, plus `.prefab` files in
     `git status --porcelain` / `git diff --name-only` that belong to it;
   - a slug: changed `.prefab` files whose path or name contains the slug, plus prefabs named
     in `design/ux/*<slug>*.md`.
   Slug = the story's epic folder, or the argument itself, in kebab-case. None found:
   `Verdict: NOT ASSESSED` ("không tìm thấy prefab").
2. **Reference screen.** Second argument if given; else `Màn mẫu` in `design/conventions.md`;
   else the most similar existing screen in the same folder (same frame sprite). Say which.
3. **Render both** at the game's reference resolution (from `design/conventions.md` or the
   main scene's `CanvasScaler`; 1080x1920 if unknown) with one `execute_code` call per
   prefab. Shape of the code:
   - new preview scene; a camera (`cam.scene = scene`, solid colour background,
     `targetTexture` = a `RenderTexture` of that size); a `Canvas` in
     `ScreenSpaceCamera` mode on that camera with a `CanvasScaler` (ScaleWithScreenSize, same
     reference resolution and match);
   - `PrefabUtility.InstantiatePrefab` into the scene, parent it to the canvas
     (`SetParent(canvas, false)`), set every `CanvasGroup.alpha` to 1 and activate the main
     panel if the prefab ships it hidden; empty title texts may be filled with a sample word
     so their box shows;
   - `Canvas.ForceUpdateCanvases()`, `ForceMeshUpdate()` on every TMP text, `cam.Render()`,
     `ReadPixels` into a `Texture2D`, `EncodeToPNG`, write to
     `production/qa/evidence/<slug>/compare-<prefab-name>.png` (and `ref-<name>.png`);
   - destroy the textures and `ClosePreviewScene`.
4. **Measure both** (one `execute_code` that loads each prefab and returns text):
   close button (anchors, anchoredPosition, size, sprite, icon child sprite and size); frame
   panel (`Image.type`, sprite, size); every `Image` whose sprite has a border but whose
   type is `Simple`; title and button labels (font, size, auto size,
   `TMP_Text.isTextOverflowing`); buttons (sprite, `Image.type`, size); `Mask` /
   `RectMask2D` on progress bars.
5. **Look at the images** (Read the PNGs). Check what numbers miss: overlap, clipped or
   squashed art, text out of its box, element outside the frame, unreadable contrast.
6. **Judge.**
   - `FAIL`: a convention is broken in a way players see. Examples: a bordered sprite drawn
     `Simple` (stretched), a close button anchored or placed unlike the reference, a missing
     icon, text overflowing, an element outside the frame.
   - `CONCERNS`: differences that may be intended (a taller panel, another title size) or
     that you could not check.
   - `PASS`: matches the reference except for the content the feature needs.
7. **Write `production/qa/evidence/<slug>/compare.md`** (Vietnamese): target and reference
   prefab paths, the two image paths, a table `Mục | Màn mẫu | Màn mới | Kết quả`, a list of
   problems with the exact value to change (object path, field, from → to), and the verdict.
8. Reply with the problem list (max 8 lines), the evidence path, and end with exactly one
   line: `Verdict: PASS`, `Verdict: CONCERNS` or `Verdict: FAIL` (or `Verdict: NOT ASSESSED`).
