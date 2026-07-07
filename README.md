# SketchFab Likolus Export

A Tampermonkey userscript that exports Sketchfab 3D models to **OBJ** (static) or **FBX** (binary 7.4.0 — Maya/Blender/3ds-Max native, static mesh). Maya/Blender-ready: geometry, UVs, normals, PBR materials and textures — nothing lost.

Improved fork of SUR (Sketchfab Ultimate Ripper).

> **v1.5.1 — self-healing viewer patch.** Fixes the recurring *"the 3D viewport doesn't finish loading"* bug. When Sketchfab re-minifies their viewer and our regex injection points go stale, patching now degrades gracefully instead of killing the viewport: the original viewer runs unmodified (export falls back to WebGL-metadata capture). A 20s watchdog auto-reloads once if a patched load fails, then disables patching for that model. Use `?lkxforcepatch=1` to retry patching. See changelog below.

> **v1.5.0 — major simplification.** Rigging, skinning and animation support has been **removed entirely**. Only the static-mesh OBJ and FBX export paths remain. The rig/anim probing code was a long tail of fragile guesses against Sketchfab's minified viewer; dropping it gives rock-solid static exports, which is what most users actually need. (If you need rig/anim, pin v1.4.9.)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox).
2. Open the raw userscript URL: [`SketchFabLikolusExport.user.js`](./SketchFabLikolusExport.user.js).
3. Click **Install** in the Tampermonkey dialog.
4. Visit any Sketchfab model page (e.g. `https://sketchfab.com/3d-models/...`).
5. Wait for the model to fully load, then click **EXPORT & DOWNLOAD** in the bottom-right panel.

## Features

- **OBJ + MTL** export (static meshes, groups preserved)
- **FBX binary 7.4.0** export (Maya/Blender/3ds-Max native, static mesh + materials + textures)
- **Z-up baking** (v1.4.8+): vertex/normal data is rotated +90° X so the model stands upright in Blender and Maya (Z-up). `UpAxis=2` declared in FBX GlobalSettings. Applies to both OBJ and FBX.
- **Settings persistence** (v1.4.9+): format, scale, flipUV, forceZUp, texturesOnly are saved to localStorage and restored across sessions.
- **Texture fetch**: downloads original-resolution textures (PNG/JPG) when available, falls back to canvas readPixels for DRM-protected textures.
- **Maya compatibility**: FBX includes `PrimaryVisibility`, `Casts Shadows`, `Receive Shadows`, `RotationOrder`, `TimeMode`, `CustomFrameRate`.

## UI

The export panel appears in the bottom-right corner of any Sketchfab model page:

- **Geometries / Textures** — live counts of captured objects
- **Format** — OBJ+MTL (static) or FBX (Maya/Blender native, binary)
- **Scale** — unit scale multiplier
- **Flip UV V** — flip texture V coordinate (1-v)
- **Textures only** — export only textures (skip mesh data)
- **Force Z-up** — bake +90° X rotation so model is Z-up (default ON)
- **EXPORT & DOWNLOAD** — start the export
- **RESET** — restore default settings

## Changelog

### v1.5.1
- **Fixed the recurring "3D viewport doesn't finish loading" bug.** Root cause: Sketchfab periodically re-minifies their viewer bundle, so the regex injection points (`renderInto`, `drawArrays`, `getResourceImage`, `drawGeometry`) go stale; re-injecting a silently-corrupted viewer then killed the 3D scene on init.
- Patching is now **non-fatal** with three guards:
  1. The original viewer script is only cancelled if **≥1 regex matched AND the patched source still parses** (`new Function(js)` syntax check). If zero patches matched (viewer updated) or the patched JS has a syntax error, the **original runs unmodified** → viewport always loads.
  2. A **20s watchdog** polls for a WebGL canvas / `window.scene` after injecting. If the viewer never bootstraps, the page reloads once; a **per-model `sessionStorage` counter** then makes the next load skip patching entirely so the model renders (export falls back to `texImage2D` metadata + readPixels + URL fetch).
  3. `?lkxforcepatch=1` clears the counter to re-enable patching after an auto-disable.
- **Fixed a double-injection bug**: the old `onbeforescriptexecute` re-scanned `e.target.childNodes` on every mutation and could re-inject the viewer multiple times. It now processes only the specific `e.script` node that was added.
- `window.lkxPatchInfo` exposes `{attempted, patches, attempt, ok}` for live diagnostics.

### v1.5.0
- **Removed** all rigging, skinning and animation code: `captureRigFromGeometry`, `captureAnimations`, `parseAnimation`, `registerBone`, `registerAncestors`, `buildGLTF`, plus all the `quatToEulerXYZDeg` / `rotQuatZUp` / `rotMatPostRT` / `invertMat4` / `decomposeMat4` / `getTRS` helpers that only existed to support skin/anim.
- **Removed** glTF export path (it only existed as a rig/anim carrier).
- **Removed** the `?lkxdiag=1` diagnostic mode, the UI diag checkbox, the Ctrl+Shift+D hotkey and the `_lkxdiag.json` dump — they existed solely to probe Sketchfab's minified viewer for skin/joint/skeleton/animation field names.
- **Removed** the "Bones" / "Anims" live counters and the "Rig + Anim" checkbox from the UI.
- **Removed** the `Deformer`/`Skin`/`Cluster` FBX objects, the `AnimationStack`/`AnimationLayer`/`AnimationCurveNode`/`AnimationCurve` FBX objects, and all their connections. The FBX now carries only `Geometry` + `Model` + `Material` + `Video` + `Texture`.
- The FBX `Takes` section is now a minimal empty block (just `Current: ""`).
- Kept all the static-mesh export logic intact: OBJ+MTL writer, FBX binary 7.4.0 writer, material/texture linking, WebGL texture capture, Z-up vertex+normal baking, settings persistence, RESET button.
- Net code reduction: ~1060 lines removed (2588 → 1528).

### v1.4.9
- Settings persistence (format/scale/flipUV/forceZUp/texturesOnly) + RESET button.
- Maya FBX compatibility (Primary Visibility / Casts Shadows / Receive Shadows / RotationOrder).
- FBX GlobalSettings: TimeMode, CustomFrameRate (24 fps), TimeSpanStart/Stop.
- Fixed mojibake in source comments and UI strings.

### v1.4.8
- Z-up axis fix: `forceZUp` defaults TRUE, `UpAxis=2` (was invalid `UpAxis=3` in v1.4.7).
- Z-up vertex + normal baking added to OBJ export path.
- `?lkxdiag=1` diagnostic mode made live (re-evaluated at every call site).

### v1.4.7
- Added Z-up baking helpers (had bugs — fixed in v1.4.8).

### v1.4.6
- Added `?lkxdiag=1` diagnostic mode (was broken — fixed in v1.4.8).

### v1.4.5
- Initial public release.

## License

MIT — see [LICENSE](./LICENSE).

## Issues

Report bugs at [GitHub Issues](https://github.com/Likolus/SketchFab-Likolus-Export/issues).
