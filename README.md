# SketchFab Likolus Export

A Tampermonkey UserScript that exports Sketchfab models **exactly as they look in the viewer** — as a **single, whole OBJ + MTL + textures** with correctly mapped materials, so that opening in **Maya** or **Blender** loses nothing: geometry, UVs, normals, PBR textures and their paths all survive.

The model is exported as **one combined `.obj` file** containing every part as an internal group (`o` / `usemtl`) — never split into `model_0.obj`, `model_1.obj`, `model_2.obj`… the way older rippers did. A multi-material model (e.g. an aircraft with 30+ parts) lands as one `ModelName.obj` with 30+ groups inside, plus one `ModelName.mtl` that maps every group to its PBR textures.

---

## Result

The downloaded ZIP looks like:

```
ModelName/
├── ModelName.obj          # ONE combined file: every part as an o/usemtl group
├── ModelName.mtl          # materials, all PBR maps (map_Kd/map_Bump/map_Pr/...)
├── metadata.json          # source url, author, date, sketchfab id
└── textures/
    ├── Body_albedo.jpg     # original full-res, original format
    ├── Body_normal.png
    ├── Body_roughness.jpg
    └── Metal_albedo.png
```

Open the `.obj` in Maya or Blender → the MTL loads automatically, textures resolve from the relative `textures/` path, and the model looks the same as on Sketchfab.

---

## Features

- **Single combined OBJ** — every captured geometry becomes a group (`o name` + `usemtl name`) inside one `ModelName.obj`, with continuous global vertex/uv/normal indexing across groups. No more pile of loose `model_N.obj` files.
- **Real MTL** — a proper `.mtl` is generated and referenced via `mtllib`. Each group has its own material assigned with `usemtl`, so materials actually show up in Maya/Blender.
- **Correct material → texture linking** — each material is bound to its textures by (a) capturing the currently-bound GL texture at draw time, and (b) name-prefix matching against the geometry's stateset name.
- **Full-resolution original textures** — textures are downloaded from their **original URLs** via `GM_xmlhttpRequest`, preserving full resolution, original format (`.jpg`/`.png`) and correct orientation. `readPixels` is only a fallback.
- **Complete PBR map set** — albedo, normal, roughness, metallic, specular, emissive, opacity and AO are all classified and emitted with the right MTL keys.
- **Relative texture paths** — textures live in a `textures/` subfolder and the MTL references them as `textures/...`, so paths resolve on any OS without editing.
- **GLTF export** — alternative GLTF + `.bin` output (with PBR textures) for pipelines that prefer it.
- **Progress UI** — per-stage progress bar (linking materials → fetching textures → writing OBJ/MTL → packaging) with live geometry/texture counts.

---

## PBR map support

Each captured texture is classified by name and emitted with the appropriate MTL key (Blender & Maya 2018+ extended MTL):

| Texture name keyword | MTL key |
|---|---|
| albedo / basecolor / diffuse / color | `map_Kd` |
| normal / bump | `map_Bump` + `norm` |
| roughness | `map_Pr` |
| metallic / metalness | `map_Pm` |
| specular / spec | `map_Ks` |
| emissive / emission | `map_Ke` |
| opacity / alpha / mask | `map_d` |
| occlusion / ao | `# map_ao` (no standard key) |

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox).
2. Enable **Developer Mode** in your browser's extensions page (required for userscripts in Manifest V3 Chrome).
3. Open the Tampermonkey dashboard → **Create a new script** → paste the contents of [`SketchFabLikolusExport.user.js`](./SketchFabLikolusExport.user.js) → **Ctrl+S** to save.
4. Make sure the script is **enabled** (toggle ON).

---

## Use

1. Open any Sketchfab model page (e.g. `https://sketchfab.com/3d-models/<slug>-<id>`).
2. **Wait until the model has FULLY loaded** (the script can only capture what the viewer has uploaded to the GPU — partially-loaded models give partial exports).
3. A small panel appears in the bottom-right corner: **"SketchFab Likolus Export"**.
4. Pick the format:
   - **OBJ + MTL + Textures** (default) — for Maya / Blender.
   - GLTF + .bin — alternative.
5. Adjust **Scale** (try `0.01` or `0.1` if the model is huge in Unity/Blender).
6. Optionally toggle **Flip UV V** (only if textures come out upside-down — normally leave off) or **Textures only**.
7. Click **EXPORT & DOWNLOAD**.
8. Wait for the progress bar to reach 100% — a ZIP downloads automatically.

> Tip: orbit / zoom the model a little before exporting so the viewer uploads all texture mip levels to the GPU. The script also downloads textures directly from their original URLs (full-res), so even un-viewed textures are captured if their metadata was registered.

---

## How it works

The Sketchfab viewer is a minified WebGL application. The script intercepts the viewer's JS before it executes (via a `MutationObserver`-based `onbeforescriptexecute` shim) and regex-patches five known injection points:

| Patch | Purpose |
|---|---|
| `renderInto(n,E,R` → `…,i` | capture texture-pipeline variable |
| `renderInto=function(e,i,r` → `…,image_data` | thread image data |
| `drawArrays(TRIANGLES,0,6)` → `…,window.drawhookimg(gl,t)` | texture-pass capture |
| `getResourceImage:function(e,t){` → `…; e = window.drawhookcanvas(e,this._imageModel);` | texture metadata + URL capture |
| `drawGeometry(this._graphicContext,t)` → `…; window.attachbody(t,this._graphicContext);` | geometry capture + bound-texture read |

At draw time:

- **`attachbody(t, glCtx)`** records the geometry (vertices, normals, UVs, indices, primitive modes) **and** queries `glCtx.getParameter(TEXTURE_BINDING_2D)` to find the currently-bound texture, linking the geometry's material to that texture directly.
- **`drawhookcanvas(e, imageModel)`** records each texture's name, PBR type (classified by name), and **original download URL** (largest power-of-two variant).
- A global `texImage2D` hook builds a `WebGLTexture → URL` map used both for bound-texture resolution and as a readPixels fallback.

At export time:

1. `buildMaterials()` creates one material per geometry and links textures by (a) the bound texture captured at draw time, then (b) name-prefix matching against the geometry's stateset name, then (c) for single-geometry models, assigning all textures by type.
2. `fetchAllTextures()` downloads each texture from its original URL via `GM_xmlhttpRequest` (full-res, original `.jpg`/`.png`, correct orientation). If a URL fetch fails, it falls back to `readPixels` from a framebuffer (with correct vertical flip).
3. `buildObj()` writes **one** combined `.obj` with `o`/`usemtl` per group and correct per-group vertex/uv/normal index offsets — so a 30-part model is one file with 30 groups, not 30 files.
4. `buildMtl()` writes the `.mtl` with `map_Kd`/`map_Bump`/`map_Pr`/`map_Pm`/`map_Ks`/`map_Ke`/`map_d` referencing `textures/…`.
5. JSZip packages everything; FileSaver triggers the download.

---

## Notes & limitations

- The regex patches target the current Sketchfab viewer minification. If Sketchfab updates their viewer and the patches stop matching, capture silently breaks (panel shows 0 geometries). Check the browser console for `[LikolusExport] patch … ok` lines.
- Some Sketchfab models use compressed (`KTX2`) textures. The URL-download path still grabs the original source image (usually `.jpg`/`.png`); if only KTX2 is available, the readPixels fallback (PNG) is used.
- Sketchfab texture URLs are token-signed and time-limited. Export **while the model page is open** — don't leave it overnight and then click export.
- Very large models can take a while to ZIP in-browser; the progress bar reflects the current stage.

---

## Credits

Built on the Sketchfab viewer hooking technique pioneered by **Risk** / [gamedev44](https://github.com/gamedev44/Fabulous-Ripper) and [WulfSkol](https://github.com/WulfSkol/SUR-SketchfabUtilityRipper). OBJ/MTL PBR export, original-texture fetching, material linking and the combined single-file OBJ writer by **Likolus**.

## License

Provided as-is for personal use. Respect Sketchfab's Terms of Service and individual model licenses — only export models you have the right to download.
