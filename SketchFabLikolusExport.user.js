// ==UserScript==
// @name         SketchFab Likolus Export
// @namespace    https://github.com/Likolus
// @version      1.5.2
// @description  Export Sketchfab models to OBJ (static) or FBX (binary 7.4.0 - Maya/Blender/3ds-Max native, static mesh + materials + textures). Maya/Blender-ready: geometry, UVs, normals, PBR textures - nothing lost. Improved fork of SUR.
// @author       Likolus
// @match        https://sketchfab.com/*
// @include      /^https?://(www\.)?sketchfab\.com/.*$/
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.1.5/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/1.3.8/FileSaver.js
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      media.sketchfab.com
// @connect      sketchfab.com
// @connect      *
// @homepageURL  https://github.com/Likolus/SketchFab-Likolus-Export
// @supportURL   https://github.com/Likolus/SketchFab-Likolus-Export/issues
// @updateURL    https://raw.githubusercontent.com/Likolus/SketchFab-Likolus-Export/main/SketchFabLikolusExport.user.js
// @downloadURL  https://raw.githubusercontent.com/Likolus/SketchFab-Likolus-Export/main/SketchFabLikolusExport.user.js
// ==/UserScript==

/* =====================================================================
 *  SketchFab Likolus Export  -  v1.5.2
 *  -------------------------------------------------------------------
 *  Goal: export a Sketchfab model exactly as it looks in the viewer,
 *  as OBJ + MTL + textures  OR  binary FBX 7.4.0, so that opening in
 *  Maya / Blender loses nothing - geometry, UVs, normals, PBR textures
 *  and their paths all survive. Materials are correctly assigned per
 *  geometry group via the bound GL texture captured at draw time.
 *
 *  v1.5.0 CHANGE (per user request): rigging / skinning / animation
 *  support has been REMOVED entirely. Only static-mesh OBJ and FBX
 *  export paths remain. This dramatically simplifies the code, removes
 *  a long tail of fragile probes into Sketchfab's minified viewer, and
 *  gives rock-solid static-mesh exports (which is what most users need).
 *
 *  v1.5.1 CHANGE: self-healing viewer patch. The #1 recurring bug was
 *  "the 3D viewport doesn't finish loading" - caused by Sketchfab
 *  updating their minified viewer so our regex injection points went
 *  stale and the re-injected (corrupted) viewer died on init. Patching
 *  is now non-fatal: (a) only cancel the original script if >=1 regex
 *  matched AND the patched source still parses (new Function check);
 *  (b) per-URL sessionStorage counter - if a patched load fails to
 *  produce a WebGL canvas within 20s, reload; next load skips patching
 *  so the viewer runs unmodified (viewport always renders); (c) use
 *  ?lkxforcepatch=1 to re-enable patching after an auto-disable.
 *
 *  v1.5.2 CHANGE: fix "window.drawhookimg is not a function" runtime
 *  crash. Root cause: the hooks (drawhookimg / drawhookcanvas / attachbody)
 *  were assigned to the Tampermonkey SANDBOX window, not the real page
 *  window, so the injected (page-context) viewer couldn't see them. The
 *  `window = unsafeWindow` rebind silently no-ops in strict mode. Now an
 *  explicit `pageWin` handle (=== unsafeWindow) is used for every global
 *  the page script must reach: the three hooks, the WebGL prototype hooks
 *  (texImage2D), lkxPatchInfo and lkxDownload.
 *
 *  Improved fork of SUR (Sketchfab Universal Ripper).
 * ===================================================================== */

(function () {
    'use strict';

    // Tampermonkey: pull the real window so we can poke Sketchfab's
    // internals (window.scene etc.) that the sandbox hides.
    //
    // IMPORTANT (v1.5.2): the rebind `window = unsafeWindow` silently
    // no-ops in strict mode (window is a non-writable binding in the TM
    // sandbox). So we keep an EXPLICIT `pageWin` handle to the real page
    // window and use it for every global the page's own (injected, patched)
    // viewer script must reach: drawhookimg, drawhookcanvas, attachbody,
    // the WebGLRenderingContext.prototype texImage2D hook, lkxPatchInfo,
    // lkxDownload. Assigning these to the sandbox `window` makes them
    // invisible to page context -> "window.drawhookimg is not a function"
    // at runtime inside renderInto().
    var pageWin = window;
    try {
        if (typeof unsafeWindow !== 'undefined') {
            pageWin = unsafeWindow;
            window = unsafeWindow;   // best-effort rebind (may throw in strict mode)
        }
    } catch (e) {
        try { if (typeof unsafeWindow !== 'undefined') pageWin = unsafeWindow; } catch (e2) {}
    }

    // -----------------------------------------------------------------
    //  State
    // -----------------------------------------------------------------
    var geometries = [];          // captured geometry groups
    var capturedGeoRefs = new WeakSet();
    var capturedGeoIds = new Set();

    var textureStore = {};        // cleanUrl -> { name, type, url, ext, width, height }
    var textureByCleanUrl = {};   // cleanUrl -> blob (filled at draw time by drawhookimg)
    var capturedTextureSet = new Set();
    var texCapturePending = new Set(); // cleanUrls currently being readPixels'd (dedup)

    // WebGL texture-object -> url map (used by attachbody to resolve the
    // currently-bound texture back to a clean url at draw time).
    var glTextureMeta = new Map();
    var glTextureIdx = 0;
    var lastGLCtx = null;

    var DEBUG = false;
    var OBJ_CHUNK_LIMIT = 1024 * 1024;

    function dlog() { if (DEBUG && console && console.log) console.log.apply(console, ['[LikolusExport]'].concat([].slice.call(arguments))); }

    // -----------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------
    function sanitizeFileName(name, fallback) {
        var c = (name || '').toString().trim();
        if (!c) return fallback || 'unnamed';
        c = c.replace(/[\\/:*?"<>|]/g, '_');
        c = c.replace(/\s+/g, '_');
        c = c.replace(/_+/g, '_');
        c = c.replace(/^_+|_+$/g, '');
        if (!c) return fallback || 'unnamed';
        return c;
    }

    function fnum(n) {
        if (!isFinite(n)) n = 0;
        var s = n.toFixed(6);
        // trim trailing zeros after the decimal point, keep at least .0
        s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        return s;
    }

    function extFromUrl(url) {
        var clean = (url || '').split('?')[0].split('#')[0];
        var m = clean.match(/\.([a-zA-Z0-9]{2,4})$/);
        if (!m) return 'png';
        var e = m[1].toLowerCase();
        if (e === 'jpeg') return 'jpg';
        return e;
    }

    function classifyTexture(name) {
        var n = (name || '').toLowerCase();
        if (/base|diffuse|albedo|color|colour|_d\b|_col\b/.test(n)) return 'albedo';
        if (/normal|nrm|nor|_n\b|bump/.test(n)) return 'normal';
        if (/rough|rgh|_r\b/.test(n)) return 'roughness';
        if (/metal|mtl|metallic|_m\b/.test(n)) return 'metallic';
        if (/spec|_s\b/.test(n)) return 'specular';
        if (/emiss|emit|_e\b|glow|light/.test(n)) return 'emissive';
        if (/ao|ambient|occlusion/.test(n)) return 'occlusion';
        if (/opacity|alpha|mask/.test(n)) return 'opacity';
        if (/height|disp|displacement/.test(n)) return 'height';
        return 'albedo';
    }

    var usedTexNames = {};
    function uniqueTexName(base, ext) {
        var safe = sanitizeFileName(base, 'texture');
        var candidate = safe + '.' + (ext || 'png');
        if (!usedTexNames[candidate]) { usedTexNames[candidate] = 1; return candidate; }
        var i = 2;
        while (usedTexNames[safe + '_' + i + '.' + (ext || 'png')]) i++;
        candidate = safe + '_' + i + '.' + (ext || 'png');
        usedTexNames[candidate] = 1;
        return candidate;
    }

    function forcePngExtension(meta) {
        if (!meta) return;
        if (!/\.png$/i.test(meta.name)) {
            var base = (meta.name || 'texture').replace(/\.(png|jpg|jpeg|webp|tga|bmp|ktx2)$/i, '');
            meta.name = base + '.png';
            meta.ext = 'png';
        }
    }

    // -----------------------------------------------------------------
    //  Settings (persisted to localStorage)
    // -----------------------------------------------------------------
    // v1.5.0: rig option removed. Only OBJ / FBX / textures-only remain.
    //         forceZUp bakes a +90deg X rotation into vertices+normals so
    //         the exported model stands upright in Blender/Maya (Z-up).
    var settings = {
        format: 'obj',       // 'obj' (static) | 'fbx' (Maya/Blender native, static mesh)
        texturesOnly: false,
        scale: 1.0,
        flipUV: false,       // flip V (1-v) for UVs - off by default
        combineObj: true,    // single model.obj with groups
        fetchOriginalTextures: true,
        forceZUp: true       // bake +90deg X rotation so vertex data is genuinely Z-up
                             // (user requested: model top must always be Z in Blender/Maya)
    };
    try {
        var _saved = JSON.parse(localStorage.getItem('lkx_settings') || '{}');
        if (_saved && typeof _saved === 'object') {
            if (typeof _saved.format === 'string' && /^(obj|fbx)$/.test(_saved.format)) settings.format = _saved.format;
            if (typeof _saved.scale === 'number' && isFinite(_saved.scale) && _saved.scale > 0) settings.scale = _saved.scale;
            if (typeof _saved.flipUV === 'boolean') settings.flipUV = _saved.flipUV;
            if (typeof _saved.forceZUp === 'boolean') settings.forceZUp = _saved.forceZUp;
            if (typeof _saved.texturesOnly === 'boolean') settings.texturesOnly = _saved.texturesOnly;
        }
    } catch (e) {}
    function saveSettings() {
        try { localStorage.setItem('lkx_settings', JSON.stringify({
            format: settings.format, scale: settings.scale, flipUV: settings.flipUV,
            forceZUp: settings.forceZUp, texturesOnly: settings.texturesOnly
        })); } catch (e) {}
    }

    // -----------------------------------------------------------------
    //  UI
    // -----------------------------------------------------------------
    var ui = null;
    function ensureUI() {
        if (ui) return ui;
        ui = document.createElement('div');
        ui.id = 'likolus-export-ui';
        ui.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(15,17,21,0.96);color:#e8eaed;padding:0;border-radius:10px;z-index:2147483647;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;min-width:260px;max-width:320px;border:1px solid #1f6feb;box-shadow:0 8px 30px rgba(0,0,0,0.55);pointer-events:auto;backdrop-filter:blur(6px);';
        ui.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #2a2f37;background:linear-gradient(90deg,#1f6feb,#0d3a8a);border-radius:10px 10px 0 0;">' +
              '<span style="font-weight:700;color:#fff;letter-spacing:.3px;">SketchFab Likolus Export <span style="font-size:9px;color:#8b949e;font-weight:400;vertical-align:middle;">v1.5.2</span></span>' +
              '<span id="lkx-close" style="cursor:pointer;color:#fff;opacity:.8;font-size:16px;line-height:1;">\u00d7</span>' +
            '</div>' +
            '<div style="padding:12px;">' +
              '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
                '<div style="flex:1;"><div style="color:#8b949e;font-size:11px;margin-bottom:2px;">Geometries</div><div id="lkx-ngeo" style="font-weight:600;font-size:15px;color:#58a6ff;">0</div></div>' +
                '<div style="flex:1;"><div style="color:#8b949e;font-size:11px;margin-bottom:2px;">Textures</div><div id="lkx-ntex" style="font-weight:600;font-size:15px;color:#3fb950;">0</div></div>' +
              '</div>' +
              '<div style="border-top:1px solid #2a2f37;padding-top:10px;margin-bottom:8px;">' +
                '<div style="color:#8b949e;font-size:11px;margin-bottom:4px;">Format</div>' +
                '<label style="display:block;margin:2px 0;cursor:pointer;"><input type="radio" name="lkx-fmt" value="obj" checked> <b style="color:#e8eaed;">OBJ + MTL</b> <span style="color:#8b949e;">(static mesh)</span></label>' +
                '<label style="display:block;margin:2px 0;cursor:pointer;color:#8b949e;"><input type="radio" name="lkx-fmt" value="fbx"> <b style="color:#f0883e;">FBX</b> <span style="color:#8b949e;">(Maya/Blender native, binary)</span></label>' +
              '</div>' +
              '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
                '<label style="flex:1;color:#8b949e;font-size:11px;">Scale<br><input type="number" id="lkx-scale" value="1.0" step="0.1" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e8eaed;border:1px solid #2a2f37;border-radius:4px;padding:3px 5px;"></label>' +
                '<label style="flex:1;color:#8b949e;font-size:11px;display:flex;flex-direction:column;">Options<br>' +
                  '<span style="margin-top:2px;"><input type="checkbox" id="lkx-flipuv"> Flip UV V</span>' +
                  '<span><input type="checkbox" id="lkx-texonly"> Textures only</span>' +
                  '<span><input type="checkbox" id="lkx-zup" checked> Force Z-up <span style="color:#f0883e;">(bake)</span></span>' +
                '</label>' +
              '</div>' +
              '<div id="lkx-bar-wrap" style="height:6px;background:#21262d;border-radius:3px;overflow:hidden;margin-bottom:6px;display:none;"><div id="lkx-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#1f6feb,#58a6ff);transition:width .15s;"></div></div>' +
              '<div id="lkx-msg" style="color:#8b949e;font-style:italic;font-size:11px;min-height:14px;margin-bottom:8px;">Waiting for model to load...</div>' +
              '<div style="display:flex;gap:6px;">' +
                '<button id="lkx-dl" style="flex:1;background:linear-gradient(90deg,#238636,#2ea043);color:#fff;border:none;padding:9px;border-radius:6px;cursor:pointer;font-weight:700;letter-spacing:.4px;">EXPORT &amp; DOWNLOAD</button>' +
                '<button id="lkx-reset" title="Reset settings to defaults" style="background:#21262d;color:#8b949e;border:1px solid #2a2f37;padding:9px 10px;border-radius:6px;cursor:pointer;font-size:11px;">RESET</button>' +
              '</div>' +
            '</div>';
        function attachWhenReady() {
            if (document.body) { document.body.appendChild(ui); }
            else setTimeout(attachWhenReady, 50);
        }
        attachWhenReady();

        var dl = function () { doDownload(); };
        // bind once
        setTimeout(function () {
            var b = document.getElementById('lkx-dl'); if (b) b.addEventListener('click', dl);
            var c = document.getElementById('lkx-close'); if (c) c.addEventListener('click', function () { ui.style.display = 'none'; });
            var rs = document.getElementById('lkx-reset'); if (rs) rs.addEventListener('click', function () {
                if (!confirm('Reset all export settings to defaults?')) return;
                try { localStorage.removeItem('lkx_settings'); } catch (e2) {}
                settings.format = 'obj'; settings.scale = 1.0; settings.flipUV = false;
                settings.forceZUp = true; settings.texturesOnly = false;
                // refresh UI
                document.querySelectorAll('input[name="lkx-fmt"]').forEach(function (el) { el.checked = (el.value === 'obj'); });
                var scEl = document.getElementById('lkx-scale'); if (scEl) scEl.value = '1.0';
                var fuEl = document.getElementById('lkx-flipuv'); if (fuEl) fuEl.checked = false;
                var toEl = document.getElementById('lkx-texonly'); if (toEl) toEl.checked = false;
                var zuEl = document.getElementById('lkx-zup'); if (zuEl) zuEl.checked = true;
                setMsg('Settings reset to defaults.');
            });
            var fmts = document.querySelectorAll('input[name="lkx-fmt"]'); fmts.forEach(function (el) { el.addEventListener('change', function (e) { settings.format = e.target.value; saveSettings(); }); });
            // apply persisted settings to UI on init
            fmts.forEach(function (el) { el.checked = (el.value === settings.format); });
            var sc = document.getElementById('lkx-scale'); if (sc) { sc.value = String(settings.scale); sc.addEventListener('change', function (e) { settings.scale = parseFloat(e.target.value) || 1.0; saveSettings(); }); }
            var fu = document.getElementById('lkx-flipuv'); if (fu) { fu.checked = settings.flipUV; fu.addEventListener('change', function (e) { settings.flipUV = e.target.checked; saveSettings(); }); }
            var to = document.getElementById('lkx-texonly'); if (to) { to.checked = settings.texturesOnly; to.addEventListener('change', function (e) { settings.texturesOnly = e.target.checked; saveSettings(); }); }
            var zu = document.getElementById('lkx-zup'); if (zu) { zu.checked = settings.forceZUp; zu.addEventListener('change', function (e) { settings.forceZUp = e.target.checked; saveSettings(); }); }
        }, 50);
        return ui;
    }

    function setMsg(msg) {
        ensureUI();
        var m = document.getElementById('lkx-msg'); if (m) m.textContent = msg;
    }
    function setProgress(pct) {
        ensureUI();
        var w = document.getElementById('lkx-bar-wrap'); var b = document.getElementById('lkx-bar');
        if (pct == null) { if (w) w.style.display = 'none'; return; }
        if (w) w.style.display = 'block'; if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    function updateCounts() {
        ensureUI();
        var g = document.getElementById('lkx-ngeo'); if (g) g.textContent = String(geometries.length);
        var t = document.getElementById('lkx-ntex'); if (t) t.textContent = String(Object.keys(textureStore).length);
    }
    function status(msg) { setMsg(msg); dlog(msg); updateCounts(); }

    // show UI as soon as DOM is ready
    function showUIWhenReady() { if (document.body) { ensureUI(); } else setTimeout(showUIWhenReady, 60); }
    showUIWhenReady();

    // -----------------------------------------------------------------
    //  Geometry capture
    // -----------------------------------------------------------------
    // Called from injected patch: window.attachbody(t)
    pageWin.attachbody = function (t, glCtx) {
        try {
            if (geometries.length > 1000) return;
            if (!t) return;
            var uid = t.uid || t._uid || (t.stateset ? t.stateset._name : null) || t._name;
            if (capturedGeoRefs.has(t) || (uid && capturedGeoIds.has(uid))) return;
            // need attributes & at least one primitive with indices
            var attr = t._attributes || (t.attributes && t.attributes._attributes);
            if (!attr || !attr.Vertex || !attr.Vertex._elements) return;
            var prims = t._primitives || (t.primitives && t.primitives._elements) || t._primitivesList;
            if (!prims || !prims.length) return;

            var nm = (t.stateset && t.stateset._name) || t._name || ('part_' + geometries.length);
            if (nm === 'composer layer' || nm === 'Ground - Geometry') return;

            capturedGeoRefs.add(t);
            if (uid) capturedGeoIds.add(uid);

            // try to grab currently-bound GL texture -> link material to texture
            // (uses lastGLCtx captured by the texImage2D hook - no glCtx param needed)
            var boundTexUrl = null;
            try {
                var gl = lastGLCtx;
                if (gl && gl.getParameter) {
                    var bt = gl.getParameter(gl.TEXTURE_BINDING_2D);
                    if (bt && glTextureMeta.has(bt)) boundTexUrl = glTextureMeta.get(bt).cleanUrl;
                }
            } catch (e) {}

            var geoIdx = geometries.length;
            // Safely extract a typed/array index list from a Sketchfab primitive.
            // p.indices can be: a BufferAttribute-like { _elements }, { array },
            // the typed array itself, undefined (non-indexed geometry), etc.
            // Also normalise the draw mode and synthesize indices for non-indexed
            // geometry so the FBX/OBJ writers always receive a flat index list.
            function getIndexElements(prim) {
                var idx = null;
                if (prim.indices) {
                    idx = prim.indices._elements || prim.indices.array || prim.indices._array;
                    if (!idx && (ArrayBuffer.isView(prim.indices) || Array.isArray(prim.indices))) idx = prim.indices;
                }
                // Non-indexed geometry: synthesize 0..N-1 from the vertex count.
                // Sketchfab primitives sometimes carry .count or .verticesCount.
                if (!idx || !idx.length) {
                    var cnt = prim.count || prim.verticesCount || prim.numVertices || 0;
                    if (cnt && attr.Vertex && attr.Vertex._elements) {
                        var have = attr.Vertex._elements.length / 3;
                        if (cnt > have) cnt = have;
                        idx = new (cnt > 65535 ? Uint32Array : Uint16Array)(cnt);
                        for (var k = 0; k < cnt; k++) idx[k] = k;
                    }
                }
                return idx;
            }
            var primList = [];
            prims.forEach(function (p) {
                if (!p) return;
                var idx = getIndexElements(p);
                if (!idx || !idx.length) return; // skip empty primitive
                var mode = (typeof p.mode === 'number') ? p.mode : 4;
                // Accept triangles(4)/strip(5)/fan(6). For points(0)/lines(1/2/3)
                // treat as triangles - Sketchfab mesh parts are virtually always
                // triangle lists; mislabelled modes would otherwise drop polygons.
                if (mode !== 4 && mode !== 5 && mode !== 6) mode = 4;
                primList.push({ mode: mode, indices: idx });
            });
            if (!primList.length) {
                // No usable primitives - do not register as captured so a later
                // pass (after more data loads) can retry, and don't emit an
                // empty mesh that would be invisible in Maya/Blender.
                capturedGeoRefs.delete(t);
                if (uid) capturedGeoIds.delete(uid);
                dlog('attachbody: skipped (no usable primitives): ' + nm);
                return;
            }
            geometries.push({
                name: sanitizeFileName(nm, 'part_' + geoIdx),
                rawName: nm,
                vertex: attr.Vertex._elements,
                normal: attr.Normal ? attr.Normal._elements : null,
                uv: pickTexCoord(attr),
                primitives: primList,
                boundTexUrl: boundTexUrl
            });
            status('Captured geometry: ' + nm + (boundTexUrl ? ' (+texture)' : ''));
        } catch (e) { dlog('attachbody error', e); }
    };

    function pickTexCoord(attr) {
        if (!attr) return null;
        for (var i = 0; i < 8; i++) {
            var k = 'TexCoord' + i;
            if (attr[k] && attr[k]._elements) return attr[k]._elements;
        }
        return null;
    }

    // -----------------------------------------------------------------
    //  Texture capture
    // -----------------------------------------------------------------
    // Called from injected patch: window.drawhookcanvas(e, imageModel)
    pageWin.drawhookcanvas = function (e, imageModel) {
        try {
            if (!e) return e;
            if ((e.width === 128 && e.height === 128) || (e.width === 32 && e.height === 32) || (e.width === 64 && e.height === 64)) return e;
            if (!imageModel) return e;

            var alpha = e.options && e.options.format;
            var filename = imageModel.attributes && imageModel.attributes.name ? imageModel.attributes.name : ('texture_' + (Object.keys(textureStore).length + 1));
            var type = classifyTexture(filename);

            // pick best (largest, power-of-two) image variant
            var url_image = e.url;
            var max_size = 0;
            var obr = e;
            if (imageModel.attributes && imageModel.attributes.images) {
                imageModel.attributes.images.forEach(function (img) {
                    var alpha_ok = alpha === 'A' ? (img.options && img.options.format === alpha) : true;
                    var d = img.width; while (d % 2 === 0) d = d / 2;
                    if (img.size > max_size && alpha_ok && d === 1) { max_size = img.size; url_image = img.url; obr = img; }
                });
            }
            var cleanUrl = (url_image || '').split('?')[0];
            if (cleanUrl && !textureStore[cleanUrl]) {
                var ext = extFromUrl(url_image);
                var base = filename.replace(/\.(png|jpg|jpeg|webp|tga|bmp|ktx2)$/i, '');
                // append PBR type if not already hinted in name
                if (type !== 'albedo' || !new RegExp(type, 'i').test(base)) {
                    if (base.toLowerCase().indexOf(type) < 0) base = base + '_' + type;
                }
                textureStore[cleanUrl] = {
                    name: uniqueTexName(base, ext),
                    type: type,
                    url: url_image,
                    cleanUrl: cleanUrl,
                    ext: ext,
                    width: obr.width || 0,
                    height: obr.height || 0
                };
                capturedTextureSet.add(cleanUrl);
                status('Captured texture: ' + textureStore[cleanUrl].name);
            }
            return obr;
        } catch (err) { dlog('drawhookcanvas error', err); return e; }
    };

    // Called from injected patch: window.drawhookimg(t, image_data)
    // SUR principle: at the fullscreen drawArrays(TRIANGLES,0,6) pass the
    // source texture is bound & being rendered - readPixels NOW, while the
    // pixels are live, and stash the blob. This is the reliable capture
    // path (re-reading at export time gives broken/recycled pixels).
    // NOTE: the caller passes (t, image_data) - so `gl` here IS the caller's
    // `t` (the GL context), and `t` here IS `image_data` (t[5] = <img>).
    pageWin.drawhookimg = function (gl, t) {
        try {
            if (!gl || !t) return;
            var imgEl = t[5];
            if (!imgEl) return;
            var url = imgEl.currentSrc || imgEl.src;
            if (!url) return;
            var cleanUrl = url.split('?')[0];
            var meta = textureStore[cleanUrl];
            if (!meta) return;                                   // only textures registered by drawhookcanvas
            if (textureByCleanUrl[cleanUrl] || texCapturePending.has(cleanUrl)) return;
            var width = imgEl.width || meta.width || 0;
            var height = imgEl.height || meta.height || 0;
            if (!width || !height) return;
            var data;
            try { data = new Uint8Array(width * height * 4); } catch (e) { return; }
            try { gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data); }
            catch (e) { return; }
            texCapturePending.add(cleanUrl);
            // flip vertically so the PNG matches the original image orientation
            var half = height / 2 | 0, bpr = width * 4, tmp = new Uint8Array(bpr);
            for (var y = 0; y < half; y++) {
                var top = y * bpr, bot = (height - y - 1) * bpr;
                tmp.set(data.subarray(top, top + bpr));
                data.copyWithin(top, bot, bot + bpr);
                data.set(tmp, bot);
            }
            var canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            var ctx = canvas.getContext('2d');
            var id = ctx.createImageData(width, height);
            id.data.set(data);
            ctx.putImageData(id, 0, 0);
            canvas.toBlob(function (blob) {
                texCapturePending.delete(cleanUrl);
                if (blob) {
                    // blob is PNG-encoded (readPixels -> toBlob 'image/png');
                    // fix the filename so .jpg/.webp names don't carry PNG
                    // content (breaks Maya OBJ map_Kd which keys off ext).
                    forcePngExtension(meta);
                    textureByCleanUrl[cleanUrl] = blob;
                    status('Captured texture pixels: ' + meta.name + ' (' + width + '\u00d7' + height + ')');
                }
            }, 'image/png');
        } catch (e) { dlog('drawhookimg error', e); }
    };

    // ---------------- WebGL texture-object -> url map ----------------
    // Always hook so attachbody can resolve the bound texture.
    function hookWebGL(ctxProto) {
        if (!ctxProto || ctxProto._lkxHooked) return;
        ctxProto._lkxHooked = true;
        try {
            var origTexImage = ctxProto.texImage2D;
            ctxProto.texImage2D = function () {
                try {
                    lastGLCtx = this;   // remember the live GL context for attachbody
                    var a = arguments;
                    var tex = this.getParameter(this.TEXTURE_BINDING_2D) || this.getParameter(this.TEXTURE_BINDING_CUBE_MAP);
                    if (tex) {
                        var src = '', w = 0, h = 0;
                        if (a.length === 6) {
                            var src6 = a[5];
                            w = src6 && src6.width || 0; h = src6 && src6.height || 0;
                            src = src6 && (src6.currentSrc || src6.src) || '';
                        } else if (a.length === 9) {
                            w = a[3] || 0; h = a[4] || 0;
                        }
                        if (!glTextureMeta.has(tex)) {
                            tex._lkxId = glTextureIdx++;
                            glTextureMeta.set(tex, { cleanUrl: src ? src.split('?')[0] : '', url: src, width: w, height: h, target: a[0] });
                        } else if (src) {
                            var ex = glTextureMeta.get(tex); if (!ex.url) { ex.url = src; ex.cleanUrl = src.split('?')[0]; }
                        }
                    }
                } catch (e) {}
                return origTexImage.apply(this, arguments);
            };
        } catch (e) { dlog('hook texImage2D error', e); }
    }
    // Hook the REAL page WebGL prototypes (pageWin, not the sandbox
    // window) so the page's own GL calls go through our texImage2D hook.
    function tryHookWebGL() {
        if (pageWin.WebGLRenderingContext) hookWebGL(pageWin.WebGLRenderingContext.prototype);
        if (pageWin.WebGL2RenderingContext) hookWebGL(pageWin.WebGL2RenderingContext.prototype);
    }
    tryHookWebGL();
    // also hook if prototypes appear later
    var webGLPoll = setInterval(function () {
        if ((pageWin.WebGLRenderingContext && !pageWin.WebGLRenderingContext.prototype._lkxHooked) ||
            (pageWin.WebGL2RenderingContext && !pageWin.WebGL2RenderingContext.prototype._lkxHooked)) {
            tryHookWebGL();
        } else if (pageWin.WebGLRenderingContext && pageWin.WebGLRenderingContext.prototype._lkxHooked) {
            clearInterval(webGLPoll);
        }
    }, 500);

    // ----------------------- texture download ------------------------
    function gmFetchBlob(url) {
        return new Promise(function (resolve) {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    timeout: 60000,
                    onload: function (r) {
                        if (r.status >= 200 && r.status < 300 && r.response) resolve(r.response);
                        else resolve(null);
                    },
                    onerror: function () { resolve(null); },
                    ontimeout: function () { resolve(null); }
                });
            } catch (e) { resolve(null); }
        });
    }

    // readPixels fallback (with correct vertical flip) for textures we
    // couldn't fetch by URL.
    function readPixelsFallback(meta, gl) {
        try {
            if (!gl) return null;
            var w = meta.width, h = meta.height;
            if (!w || !h || w < 64 || h < 64) return null;
            // find a texture object matching this url
            var tex = null;
            glTextureMeta.forEach(function (m, t) { if (m.cleanUrl === meta.cleanUrl) tex = t; });
            if (!tex) return null;
            var fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); return null; }
            var pixels = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            // flip vertically so PNG matches original image orientation
            var half = h / 2 | 0, bpr = w * 4, tmp = new Uint8Array(bpr);
            for (var y = 0; y < half; y++) {
                var top = y * bpr, bot = (h - y - 1) * bpr;
                tmp.set(pixels.subarray(top, top + bpr));
                pixels.copyWithin(top, bot, bot + bpr);
                pixels.set(tmp, bot);
            }
            var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext('2d'); var id = ctx.createImageData(w, h); id.data.set(pixels); ctx.putImageData(id, 0, 0);
            return new Promise(function (res) {
                canvas.toBlob(function (b) {
                    if (b) forcePngExtension(meta);   // readPixels -> PNG, fix ext
                    res(b);
                }, 'image/png');
            });
        } catch (e) { return null; }
    }

    function findGLContext() {
        // try to locate a live WebGL context from existing canvases
        var canvases = document.querySelectorAll('canvas');
        for (var i = 0; i < canvases.length; i++) {
            var c = canvases[i];
            var gl = c.getContext && (c.getContext('webgl2') || c.getContext('webgl'));
            if (gl) return gl;
        }
        return null;
    }

    async function fetchAllTextures(onProgress) {
        var urls = Object.keys(textureStore);
        var total = urls.length, done = 0;
        var gl = findGLContext();
        for (var i = 0; i < urls.length; i++) {
            var clean = urls[i];
            var meta = textureStore[clean];
            // 1) already captured at draw time by drawhookimg (SUR principle)
            var blob = textureByCleanUrl[clean];
            // 2) enhancement: try the original URL via GM_xmlhttpRequest
            if (!blob && settings.fetchOriginalTextures && meta.url) {
                blob = await gmFetchBlob(meta.url);
            }
            // 3) last resort: attach the GL texture to a framebuffer & readPixels
            if (!blob) {
                var p = readPixelsFallback(meta, gl);
                if (p) blob = await p;
            }
            if (blob) textureByCleanUrl[clean] = blob;
            done++;
            if (onProgress) onProgress(done, total, meta.name);
        }
    }

    // ----------------------- material linking ------------------------
    // Build material list: one material per geometry. Link textures by:
    //   1) boundTexUrl captured at draw time, 2) name-prefix match.
    function buildMaterials() {
        var texByUrl = {};
        Object.keys(textureStore).forEach(function (k) { texByUrl[textureStore[k].cleanUrl] = textureStore[k]; });

        // index textures by their base name (without pbr suffix) for matching
        var texByBase = {};
        Object.keys(textureStore).forEach(function (k) {
            var t = textureStore[k];
            var base = t.name.replace(/\.(png|jpg|jpeg|webp|tga|bmp|ktx2)$/i, '').replace(/_(albedo|normal|roughness|metallic|specular|emissive|opacity|ao|height)$/i, '');
            if (!texByBase[base]) texByBase[base] = [];
            texByBase[base].push(t);
        });

        var matNameCounts = {};
        function uniqueMatName(nm) {
            var m = sanitizeFileName(nm, 'material');
            if (!matNameCounts[m]) { matNameCounts[m] = 1; return m; }
            matNameCounts[m]++; return m + '_' + matNameCounts[m];
        }

        var materials = [];
        geometries.forEach(function (g, gi) {
            var matName = uniqueMatName(g.rawName || ('mat_' + gi));
            var slots = {}; // type -> texture

            // 1) bound texture at draw time
            if (g.boundTexUrl && texByUrl[g.boundTexUrl]) {
                slots[texByUrl[g.boundTexUrl].type] = texByUrl[g.boundTexUrl];
            }

            // 2) name-prefix match: try the geometry base name and a few derivatives
            if (Object.keys(slots).length === 0) {
                var gbase = sanitizeFileName(g.rawName || '', '').toLowerCase();
                // try exact base, then "starts with"
                if (gbase && texByBase[gbase]) {
                    texByBase[gbase].forEach(function (t) { if (!slots[t.type]) slots[t.type] = t; });
                }
                if (Object.keys(slots).length === 0) {
                    // fuzzy: texture base starts with geometry base
                    Object.keys(texByBase).forEach(function (tb) {
                        if (gbase && (tb.toLowerCase() === gbase || tb.toLowerCase().indexOf(gbase) === 0 || gbase.indexOf(tb.toLowerCase()) === 0)) {
                            texByBase[tb].forEach(function (t) { if (!slots[t.type]) slots[t.type] = t; });
                        }
                    });
                }
            }

            // 3) if still nothing and this is the only/singleton geometry, assign all textures by type
            if (Object.keys(slots).length === 0 && geometries.length === 1) {
                Object.keys(textureStore).forEach(function (k) {
                    var t = textureStore[k];
                    if (!slots[t.type]) slots[t.type] = t;
                });
            }

            g.materialName = matName;
            g.materialSlots = slots;
            materials.push({ name: matName, slots: slots });
        });
        return materials;
    }

    // -------------------------- OBJ writer ---------------------------
    function createObjWriter() {
        var chunks = [], chunk = '';
        return {
            push: function (t) { if (!t) return; chunk += t; if (chunk.length >= OBJ_CHUNK_LIMIT) { chunks.push(chunk); chunk = ''; } },
            finalize: function () { if (chunk.length) { chunks.push(chunk); chunk = ''; } return new Blob(chunks, { type: 'text/plain' }); }
        };
    }

    // Z-up bake: rotate a Y-up vector (x,y,z) into Z-up (x,-z,y).
    // Used by both OBJ and FBX static-mesh writers.
    function rotVec3ZUp(x, y, z) { return [x, -z, y]; }

    function buildObj(modelName, materials) {
        var w = createObjWriter();
        w.push('# Exported by SketchFab Likolus Export\n');
        w.push('# Source: ' + window.location.href + '\n');
        w.push('# Date: ' + new Date().toISOString() + '\n');
        w.push('mtllib ' + modelName + '.mtl\n\n');

        var vOff = 0, vtOff = 0, vnOff = 0;
        var hasAnyUV = false, hasAnyN = false;

        // first pass: count & write v/vt/vn interleaved per group is messy; do two-pass: write all v, then all vt, then all vn, then faces.
        // To keep offsets simple we accumulate and write per group.
        geometries.forEach(function (g) {
            var v = g.vertex;
            if (settings.scale !== 1.0) {
                var scaled = new Float32Array(v.length);
                for (var i = 0; i < v.length; i++) scaled[i] = v[i] * settings.scale;
                v = scaled;
            }
            w.push('o ' + g.name + '\n');
            // bake Z-up rotation (x,y,z)->(x,-z,y) into OBJ vertices too,
            // so static OBJ exports also stand upright in Blender/Maya without
            // relying on the importer's up-axis setting.
            var zupObj = settings.forceZUp;
            for (var i = 0; i < v.length; i += 3) {
                var ox = v[i], oy = v[i+1], oz = v[i+2];
                if (zupObj) { var tmp = oy; oy = -oz; oz = tmp; }
                w.push('v ' + fnum(ox) + ' ' + fnum(oy) + ' ' + fnum(oz) + '\n');
            }

            var uv = g.uv;
            var hasUV = uv && uv.length >= 2;
            if (hasUV) {
                for (var i = 0; i < uv.length; i += 2) {
                    var u = uv[i], vv = uv[i + 1];
                    if (settings.flipUV) vv = 1 - vv;
                    w.push('vt ' + fnum(u) + ' ' + fnum(vv) + '\n');
                }
                hasAnyUV = true;
            }
            var n = g.normal;
            var hasN = n && n.length >= 3;
            if (hasN) {
                for (var i = 0; i < n.length; i += 3) {
                    var nx = n[i], ny = n[i+1], nz = n[i+2];
                    if (zupObj) { var tmp2 = ny; ny = -nz; nz = tmp2; }
                    w.push('vn ' + fnum(nx) + ' ' + fnum(ny) + ' ' + fnum(nz) + '\n');
                }
                hasAnyN = true;
            }

            w.push('usemtl ' + g.materialName + '\n');
            w.push('s 1\n');

            // Per-geometry attribute counts (for index validation).
            // If idx[j] >= uvCount we can't reference a UV for that vertex,
            // so we drop UV for that face (write v//vn instead of v/vt/vn).
            var vCount = v.length / 3;
            var uvCount = hasUV ? (uv.length / 2) : 0;
            var nCount = hasN ? (n.length / 3) : 0;

            // Build a face string with SEPARATE indices for v / vt / vn.
            // Each attribute gets its own global offset (vOff / vtOff / vnOff),
            // which is critical when one geometry has UV and another doesn't -
            // otherwise the UV index would inherit the vertex offset and point
            // past the end of the vt list.
            function fmtFace(vidx) {
                // vidx is the 0-based index from the primitive's index buffer.
                // Validate against each attribute's count and emit 1-based index.
                var v1 = vidx + 1 + vOff;
                var parts = [String(v1)];
                if (hasUV) {
                    if (uvCount > 0 && vidx < uvCount) {
                        parts.push(String(vidx + 1 + vtOff));
                    } else {
                        // vertex index out of UV range - emit empty vt slot
                        parts.push('');
                    }
                } else if (hasN) {
                    // no UV but has normal -> "v//vn" format
                    parts.push('');
                }
                if (hasN) {
                    if (nCount > 0 && vidx < nCount) {
                        parts.push(String(vidx + 1 + vnOff));
                    } else {
                        parts.push('');
                    }
                }
                // Join with '/'. If UV slot is empty and normal exists, we get "v//vn".
                // If only v, we get "v".
                var s = parts.join('/');
                // Cleanup: if hasUV=false and hasN=true, parts=['v','','vn'] -> "v//vn" OK
                // If hasUV=true and hasN=false, parts=['v','vt'] -> "v/vt" OK
                // If both, parts=['v','vt','vn'] -> "v/vt/vn" OK (or "v//vn" if vt empty)
                return s;
            }

            var prims = g.primitives;
            for (var pi = 0; pi < prims.length; pi++) {
                var prim = prims[pi];
                var mode = prim.mode, idx = prim.indices;
                if (mode === 4 || mode === undefined) {
                    for (var j = 0; j + 2 < idx.length; j += 3) {
                        // Bounds-check vertex indices (skip degenerate / OOB triangles)
                        if (idx[j] >= vCount || idx[j+1] >= vCount || idx[j+2] >= vCount) continue;
                        w.push('f ' + fmtFace(idx[j]) + ' ' + fmtFace(idx[j+1]) + ' ' + fmtFace(idx[j+2]) + '\n');
                    }
                } else if (mode === 5) { // triangle strip
                    for (var j = 0; j + 2 < idx.length; j++) {
                        if (idx[j] >= vCount || idx[j+1] >= vCount || idx[j+2] >= vCount) continue;
                        var a = idx[j], b = idx[j+1], c = idx[j+2];
                        if (j & 1) { var tmp = b; b = c; c = tmp; }
                        w.push('f ' + fmtFace(a) + ' ' + fmtFace(b) + ' ' + fmtFace(c) + '\n');
                    }
                } else if (mode === 6) { // triangle fan
                    if (idx[0] >= vCount) continue;
                    for (var j = 1; j + 1 < idx.length; j++) {
                        if (idx[j] >= vCount || idx[j+1] >= vCount) continue;
                        w.push('f ' + fmtFace(idx[0]) + ' ' + fmtFace(idx[j]) + ' ' + fmtFace(idx[j+1]) + '\n');
                    }
                } else {
                    dlog('unknown primitive mode', mode);
                }
            }

            vOff += vCount;
            if (hasUV) vtOff += uvCount;
            if (hasN) vnOff += nCount;
            w.push('\n');
        });

        return w.finalize();
    }

    // -------------------------- MTL writer ---------------------------
    function buildMtl(modelName, materials) {
        var lines = [];
        lines.push('# Materials for ' + modelName);
        lines.push('# Exported by SketchFab Likolus Export');
        lines.push('# All texture paths are relative (textures/...)');

        materials.forEach(function (mat) {
            lines.push('');
            lines.push('newmtl ' + mat.name);
            lines.push('Ka 1.000 1.000 1.000');
            // base reflectivity defaults
            lines.push('Kd 1.000 1.000 1.000');
            lines.push('Ks 0.000 0.000 0.000');
            lines.push('Ke 0.000 0.000 0.000');
            lines.push('Ns 8.000');          // specular shininess
            lines.push('Ni 1.000');          // optical density
            lines.push('d 1.000');           // dissolve (alpha)
            lines.push('illum 2');           // highlight+ambient
            // PBR extension keys (Blender / Maya 2018+)
            lines.push('Pr 0.500');           // roughness
            lines.push('Pm 0.000');           // metallic
            lines.push('Ps 0.000');           // sheen

            function mapRef(type, key) {
                var t = mat.slots[type];
                if (t && textureByCleanUrl[t.cleanUrl]) {
                    lines.push(key + ' textures/' + t.name);
                }
            }
            mapRef('albedo', 'map_Kd');
            mapRef('specular', 'map_Ks');
            mapRef('emissive', 'map_Ke');
            mapRef('normal', 'map_Bump');     // normal as bump (most compatible)
            mapRef('normal', 'norm');          // also norm for readers that support it
            mapRef('roughness', 'map_Pr');
            mapRef('metallic', 'map_Pm');
            mapRef('opacity', 'map_d');
            // AO has no standard key; emit as comment + disp-like hint some tools read
            var ao = mat.slots.ao;
            if (ao && textureByCleanUrl[ao.cleanUrl]) lines.push('# map_ao textures/' + ao.name);
        });

        return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    }

    // =================================================================
    //  FBX writer (binary 7.4.0 - static mesh only)
    //  -----------------------------------------------------------------
    //  Maya / Blender / 3ds Max / every online FBX viewer reliably
    //  import BINARY FBX. Blender does NOT import ASCII FBX at all.
    //  This generator emits a spec-compliant binary FBX 7400 stream
    //  carrying geometry, normals, UVs, materials and textures.
    //
    //  v1.5.0: skin deformer / cluster / animation stack / layer /
    //  curve node / curve / takes sections REMOVED. Only static mesh
    //  + material + texture objects remain.
    // =================================================================
    function buildFBX(modelName) {
        var nextId = 1000;
        function nid() { return nextId++; }

        // ---- chunked byte buffer (efficient for large typed arrays) ----
        function BBuf(){ this.chunks=[]; this.len=0; }
        BBuf.prototype.u8=function(v){ this.chunks.push(new Uint8Array([v&0xff])); this.len++; };
        BBuf.prototype.u16=function(v){ var b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,v&0xffff,true); this.chunks.push(b); this.len+=2; };
        BBuf.prototype.u32=function(v){ var b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,v>>>0,true); this.chunks.push(b); this.len+=4; };
        BBuf.prototype.i64=function(v){ var lo=v>>>0,hi=Math.floor(v/0x100000000)>>>0,b=new Uint8Array(8),dv=new DataView(b.buffer); dv.setUint32(0,lo,true); dv.setUint32(4,hi,true); this.chunks.push(b); this.len+=8; };
        BBuf.prototype.dbl=function(v){ var b=new Uint8Array(8); new DataView(b.buffer).setFloat64(0,+v,true); this.chunks.push(b); this.len+=8; };
        BBuf.prototype.flt=function(v){ var b=new Uint8Array(4); new DataView(b.buffer).setFloat32(0,+v,true); this.chunks.push(b); this.len+=4; };
        BBuf.prototype.dblArr=function(arr,count){ var a=new Float64Array(count); for(var i=0;i<count;i++)a[i]=arr[i]; var b=new Uint8Array(a.buffer); this.chunks.push(b); this.len+=b.length; };
        BBuf.prototype.i32Arr=function(arr,count){ var a=new Int32Array(count); for(var i=0;i<count;i++)a[i]=arr[i]|0; var b=new Uint8Array(a.buffer); this.chunks.push(b); this.len+=b.length; };
        BBuf.prototype.strBytes=function(s){ var n=s.length,b=new Uint8Array(n); for(var i=0;i<n;i++)b[i]=s.charCodeAt(i)&0xff; this.chunks.push(b); this.len+=n; };
        BBuf.prototype.toU8=function(){ var out=new Uint8Array(this.len),off=0; for(var i=0;i<this.chunks.length;i++){ out.set(this.chunks[i],off); off+=this.chunks[i].length; } return out; };

        // ---- node tree ----
        // node = { name, props:[{type,val/arr/count}], children:[nodes] or null }
        function propSize(p){
            var t=p.type,s=1; // type char
            if(t==='S') s+=4+p.count;
            else if(t==='Y') s+=2;
            else if(t==='C') s+=1;
            else if(t==='I') s+=4;
            else if(t==='F') s+=4;
            else if(t==='D') s+=8;
            else if(t==='L') s+=8;
            else if(t==='d') s+=12+p.count*8;
            else if(t==='i') s+=12+p.count*4;
            return s;
        }
        function nodeSize(n){
            var ps=0; for(var i=0;i<n.props.length;i++) ps+=propSize(n.props[i]);
            var h=13+n.name.length, cb=0;
            if(n.children&&n.children.length){ for(var j=0;j<n.children.length;j++) cb+=nodeSize(n.children[j]); cb+=13; }
            return h+ps+cb;
        }
        function writeProp(buf,p){
            var t=p.type; buf.u8(t.charCodeAt(0));
            if(t==='S'){ buf.u32(p.count); buf.strBytes(p.val); }
            else if(t==='Y'){ buf.u16(p.val); }
            else if(t==='C'){ buf.u8(p.val?1:0); }
            else if(t==='I'){ buf.u32(p.val); }
            else if(t==='F'){ buf.flt(p.val); }
            else if(t==='D'){ buf.dbl(p.val); }
            else if(t==='L'){ buf.i64(p.val); }
            else if(t==='d'){ buf.u32(p.count); buf.u32(0); buf.u32(p.count*8); buf.dblArr(p.arr,p.count); }
            else if(t==='i'){ buf.u32(p.count); buf.u32(0); buf.u32(p.count*4); buf.i32Arr(p.arr,p.count); }
        }
        function serializeNode(buf,n,start){
            var ps=0; for(var i=0;i<n.props.length;i++) ps+=propSize(n.props[i]);
            var nl=n.name.length, hasCh=n.children&&n.children.length, cb=0;
            if(hasCh){ for(var j=0;j<n.children.length;j++) cb+=nodeSize(n.children[j]); cb+=13; }
            var end=start+13+nl+ps+cb;
            buf.u32(end); buf.u32(n.props.length); buf.u32(ps); buf.u8(nl); buf.strBytes(n.name);
            for(var k=0;k<n.props.length;k++) writeProp(buf,n.props[k]);
            var off=start+13+nl+ps;
            if(hasCh){ for(var c=0;c<n.children.length;c++){ serializeNode(buf,n.children[c],off); off+=nodeSize(n.children[c]); } buf.u32(0); buf.u32(0); buf.u32(0); buf.u8(0); }
            return end;
        }
        // node + property helpers
        function N(name,props,children){ return {name:name,props:props||[],children:children||null}; }
        function S(v){ var s=String(v); return {type:'S',val:s,count:s.length}; }
        // FBX object name property: must be encoded as "name\x00\x01ClassName"
        // (NOT "ClassName::name"). Autodesk FBX SDK, Maya, Blender, 3ds Max all
        // parse the name by splitting on the \x00\x01 separator. Without it,
        // Blender raises ValueError and Maya silently drops the object.
        // The 3rd property (className) is also required by strict readers.
        function objName(name, className){
            var s = String(name) + '\x00\x01' + String(className);
            return { type:'S', val:s, count:s.length };
        }
        function I(v){ return {type:'I',val:v|0}; }
        function L(v){ return {type:'L',val:v}; }
        function D(v){ return {type:'D',val:+v}; }
        function dArr(arr,count){ return {type:'d',arr:arr,count:count}; }
        function iArr(arr,count){ return {type:'i',arr:arr,count:count}; }
        // Properties70 "P" node builders
        function Pint(n,v){ return N('P',[S(n),S('int'),S('Integer'),S(''),I(v)]); }
        function Pbool(n,v){ return N('P',[S(n),S('bool'),S(''),S(''),I(v?1:0)]); }
        function Penum(n,v){ return N('P',[S(n),S('enum'),S(''),S(''),I(v)]); }
        function Pdbl(n,v){ return N('P',[S(n),S('double'),S('Number'),S(''),D(v)]); }
        function Pstr(n,v){ return N('P',[S(n),S('KString'),S(''),S(''),S(v)]); }
        function Pvec(n,x,y,z){ return N('P',[S(n),S(n),S(''),S('A'),D(x),D(y),D(z)]); }
        function Ptime(n,v){ return N('P',[S(n),S('KTime'),S('Time'),S(''),L(v)]); }
        function Pcolor(n,r,g,b){ return N('P',[S(n),S('Color'),S(''),S('A'),D(r),D(g),D(b)]); }

        // ---- expand primitive indices into a flat polygon-vertex list ----
        function expandPV(g){
            var r=[];
            if(!g||!g.primitives||!g.primitives.length) return r;
            g.primitives.forEach(function(p){
                var idx=p.indices, mode=p.mode;
                if(!idx||!idx.length) return;
                // mode already normalised in attachbody, but be defensive:
                if(mode!==5&&mode!==6) mode=4;
                if(mode===4){ for(var j=0;j+2<idx.length;j+=3) r.push(idx[j],idx[j+1],idx[j+2]); }
                else if(mode===5){ for(var j=0;j+2<idx.length;j++){ var a=idx[j],b=idx[j+1],c=idx[j+2]; if(j&1){var t=b;b=c;c=t;} r.push(a,b,c); } }
                else if(mode===6){ for(var j=1;j+1<idx.length;j++) r.push(idx[0],idx[j],idx[j+1]); }
            });
            return r;
        }

        var materials = buildMaterials();

        // ---- filter to geometries that actually have vertices + polygons ----
        // A geometry with vertices but zero polygons renders NOTHING in
        // Maya/Blender/3ds Max (silent import, empty viewport) - exactly the
        // "model is invisible" symptom. Drop those entirely so the FBX only
        // contains real, drawable meshes.
        var validGeos = [];        // list of original geometry indices that are valid
        var geoStats = [];         // per-valid-geometry stats for diagnostics
        var meshGeoIds = [], meshModelIds = []; // sparse: undefined for skipped
        geometries.forEach(function (g, i) {
            var vcount = (g.vertex && g.vertex.length) ? (g.vertex.length / 3) | 0 : 0;
            var pv = expandPV(g);
            var fcount = (pv.length / 3) | 0;
            if (vcount === 0 || fcount === 0) {
                geoStats.push({ index: i, name: g && g.name, vertices: vcount, faces: fcount, skipped: true, skipReason: vcount === 0 ? 'no vertices' : 'no faces' });
                return;
            }
            // Validate indices: count triangles with ALL indices in range.
            // If ALL triangles are out-of-range, skip this geometry entirely.
            // Per-triangle filtering of the remaining bad triangles happens
            // later in the Objects loop.
            var goodTriCount = 0;
            for (var p = 0; p < pv.length; p += 3) {
                if (pv[p] < vcount && pv[p+1] < vcount && pv[p+2] < vcount) goodTriCount++;
            }
            if (goodTriCount === 0) {
                geoStats.push({ index: i, name: g.name, vertices: vcount, faces: fcount, skipped: true, skipReason: 'all indices out of range' });
                return;
            }
            validGeos.push(i);
            meshGeoIds[i] = nid();
            meshModelIds[i] = nid();
            geoStats.push({ index: i, name: g.name, vertices: vcount, faces: fcount, skipped: false });
        });
        var matIds = materials.map(function () { return nid(); });
        var videoIds = {}, texIdsByKey = {};
        materials.forEach(function (m) {
            var seen = {};
            ['albedo','normal','roughness','metallic','emissive','occlusion','specular','opacity'].forEach(function (ty) {
                var t = m.slots[ty]; if (!t || seen[t.cleanUrl]) return; seen[t.cleanUrl] = 1;
                if (!videoIds[t.cleanUrl]) videoIds[t.cleanUrl] = nid();
                texIdsByKey[m.name + '_' + ty] = nid();
            });
        });

        // v1.5.0: no Deformer/Skin/Cluster, no AnimationStack/Layer.
        var nModel = validGeos.length;
        var nGeo = validGeos.length, nMat = materials.length;
        var nVid = Object.keys(videoIds).length, nTex = Object.keys(texIdsByKey).length;
        var defCount = 1 + nModel + nGeo + nMat + nVid + nTex;

        // ---- build top-level node tree ----
        var topLevel = [];
        var d = new Date();

        // FBXHeaderExtension
        topLevel.push(N('FBXHeaderExtension', [], [
            N('FBXHeaderVersion', [I(1003)]),
            N('FBXVersion', [I(7400)]),
            N('CreationTimeStamp', [], [
                N('Version', [I(1000)]),
                N('Year', [I(d.getFullYear())]), N('Month', [I(d.getMonth()+1)]), N('Day', [I(d.getDate())]),
                N('Hour', [I(d.getHours())]), N('Minute', [I(d.getMinutes())]), N('Second', [I(d.getSeconds())]),
                N('Millisecond', [I(d.getMilliseconds())])
            ]),
            N('Creator', [S('SketchFab Likolus Export')])
        ]));

        // GlobalSettings
        // Axis convention:
        //   FBX spec: UpAxis=1 = Y-up (Maya native), UpAxis=2 = Z-up (Blender/3ds-Max native).
        //   UpAxis=3 is INVALID and silently ignored by most importers.
        //   Sketchfab renders Y-up, so the raw vertex data is Y-up.
        //
        //   forceZUp=true (default): declare UpAxis=2 (Z-up) AND bake +90 deg X
        //     rotation into vertices/normals so the data genuinely matches the
        //     Z-up declaration. Model stands upright in Blender and Maya.
        //   forceZUp=false: declare UpAxis=1 (Y-up, matches raw data). Blender
        //     auto-rotates Y-up->Z-up on import; Maya displays Y-up natively.
        var upAxisVal = settings.forceZUp ? 2 : 1;
        var origUpAxis = settings.forceZUp ? 2 : 1;
        topLevel.push(N('GlobalSettings', [], [
            N('Version', [I(1000)]),
            N('Properties70', [], [
                Pint('UpAxis',upAxisVal), Pint('UpAxisSign',1), Pint('FrontAxis',1), Pint('FrontAxisSign',1),
                Pint('CoordAxis',1), Pint('CoordAxisSign',1), Pint('OriginalUpAxis',origUpAxis),
                Pdbl('OriginalUnitScaleFactor',1), Pdbl('UnitScaleFactor',1),
                Pstr('TimeMode', 'Frames'),
                Pstr('TimeProtocol', 'Frame'),
                Pstr('SnapOnFrameMode', 'SnapOnFrame'),
                Pdbl('CustomFrameRate', 24.0),
                Ptime('TimeSpanStart', 0),
                Ptime('TimeSpanStop', 0)
            ])
        ]));

        // Definitions
        var defChildren = [
            N('Version', [I(100)]),
            N('Count', [I(defCount)]),
            N('ObjectType', [S('GlobalSettings')], [N('Count', [I(1)])])
        ];
        if (nModel) defChildren.push(N('ObjectType', [S('Model')], [N('Count', [I(nModel)])]));
        if (nGeo) defChildren.push(N('ObjectType', [S('Geometry')], [N('Count', [I(nGeo)])]));
        if (nMat) defChildren.push(N('ObjectType', [S('Material')], [N('Count', [I(nMat)])]));
        if (nVid) defChildren.push(N('ObjectType', [S('Video')], [N('Count', [I(nVid)])]));
        if (nTex) defChildren.push(N('ObjectType', [S('Texture')], [N('Count', [I(nTex)])]));
        topLevel.push(N('Definitions', [], defChildren));

        // Objects
        var objChildren = [];

        validGeos.forEach(function (gi) {
            var g = geometries[gi], i = gi;
            var pv = expandPV(g);
            if (!pv.length) return; // safety: skip if no polygons
            var sc = settings.scale;
            var vcount = (g.vertex.length / 3) | 0;

            // ---- validate + sanitize vertices (NaN/Infinity breaks Maya FBX import) ----
            var varr = new Array(g.vertex.length);
            var vbad = 0, vmin = [Infinity,Infinity,Infinity], vmax = [-Infinity,-Infinity,-Infinity];
            var zup = settings.forceZUp; // cache for hot loop
            for (var vi = 0; vi < g.vertex.length; vi += 3) {
                var vx = g.vertex[vi] * sc, vy = g.vertex[vi+1] * sc, vz = g.vertex[vi+2] * sc;
                if (!isFinite(vx)) { vx = 0; vbad++; }
                if (!isFinite(vy)) { vy = 0; vbad++; }
                if (!isFinite(vz)) { vz = 0; vbad++; }
                // Z-up bake: (x,y,z) -> (x,-z,y)
                var rx = vx, ry = zup ? -vz : vy, rz = zup ? vy : vz;
                varr[vi] = rx; varr[vi+1] = ry; varr[vi+2] = rz;
                if (rx < vmin[0]) vmin[0] = rx; if (rx > vmax[0]) vmax[0] = rx;
                if (ry < vmin[1]) vmin[1] = ry; if (ry > vmax[1]) vmax[1] = ry;
                if (rz < vmin[2]) vmin[2] = rz; if (rz > vmax[2]) vmax[2] = rz;
            }
            if (vbad) geoStats[i].vertexNaN = vbad;

            // ---- validate + sanitize polygon-vertex indices ----
            // Maya silently drops a mesh if ANY index is out of range.
            // Skip bad triangles entirely so the remaining geometry survives.
            var goodPV = [];
            for (var p = 0; p < pv.length; p += 3) {
                if (pv[p] < vcount && pv[p+1] < vcount && pv[p+2] < vcount) {
                    goodPV.push(pv[p], pv[p+1], pv[p+2]);
                }
            }
            var droppedTris = ((pv.length - goodPV.length) / 3) | 0;
            if (droppedTris > 0) geoStats[i].droppedFaces = droppedTris;
            pv = goodPV;
            var pvic = pv.length;
            var pvarr = new Array(pvic);
            for (var p2 = 0; p2 < pvic; p2 += 3) { pvarr[p2] = pv[p2]; pvarr[p2+1] = pv[p2+1]; pvarr[p2+2] = -(pv[p2+2]+1); }

            // store bounding box in stats
            geoStats[i].bbox = { min: vmin, max: vmax };

            // Sanitize geometry name for FBX (dots/spaces can confuse strict importers)
            var geoName = (g.name || ('part_' + i)).replace(/[.\s]/g, '_');

            var gKids = [ N('GeometryVersion', [I(124)]) ];
            // Vertices
            gKids.push(N('Vertices', [dArr(varr, g.vertex.length)]));
            // PolygonVertexIndex
            gKids.push(N('PolygonVertexIndex', [iArr(pvarr, pvic)]));
            // Normals (ByPolygonVertex Direct - one per polygon-vertex)
            if (g.normal && g.normal.length) {
                var nc = pv.length * 3, narr = new Array(nc);
                for (var pp = 0; pp < pv.length; pp++) {
                    var ni = pv[pp]*3;
                    var nx = g.normal[ni]||0, ny = g.normal[ni+1]||0, nz = g.normal[ni+2]||0;
                    if (!isFinite(nx)) nx = 0; if (!isFinite(ny)) ny = 0; if (!isFinite(nz)) nz = 0;
                    // Z-up bake: normals are directions, same rotation as positions
                    if (settings.forceZUp) {
                        narr[pp*3] = nx; narr[pp*3+1] = -nz; narr[pp*3+2] = ny;
                    } else {
                        narr[pp*3] = nx; narr[pp*3+1] = ny; narr[pp*3+2] = nz;
                    }
                }
                gKids.push(N('LayerElementNormal', [I(0)], [
                    N('Version', [I(101)]), N('Name', [S('')]),
                    N('MappingInformationType', [S('ByPolygonVertex')]),
                    N('ReferenceInformationType', [S('Direct')]),
                    N('Normals', [dArr(narr, nc)])
                ]));
            }
            // UVs (ByPolygonVertex IndexToDirect)
            if (g.uv && g.uv.length) {
                var uc = g.uv.length, uarr = new Array(uc);
                for (var ui = 0; ui < uc; ui += 2) {
                    var uU = g.uv[ui], vV = g.uv[ui+1];
                    if (!isFinite(uU)) uU = 0; if (!isFinite(vV)) vV = 0;
                    if (settings.flipUV) vV = 1 - vV;
                    uarr[ui] = uU; uarr[ui+1] = vV;
                }
                gKids.push(N('LayerElementUV', [I(0)], [
                    N('Version', [I(101)]), N('Name', [S('map1')]),
                    N('MappingInformationType', [S('ByPolygonVertex')]),
                    N('ReferenceInformationType', [S('IndexToDirect')]),
                    N('UV', [dArr(uarr, uc)]),
                    N('UVIndex', [iArr(pv, pv.length)])
                ]));
            }
            // Material (AllSame - one material per geometry)
            gKids.push(N('LayerElementMaterial', [I(0)], [
                N('Version', [I(101)]), N('Name', [S('')]),
                N('MappingInformationType', [S('AllSame')]),
                N('ReferenceInformationType', [S('IndexToDirect')]),
                N('Materials', [iArr([0], 1)])
            ]));
            // Layer
            var layCh = [];
            if (g.normal && g.normal.length) layCh.push(N('LayerElement', [], [N('Type', [S('LayerElementNormal')]), N('TypedIndex', [I(0)])]));
            if (g.uv && g.uv.length) layCh.push(N('LayerElement', [], [N('Type', [S('LayerElementUV')]), N('TypedIndex', [I(0)])]));
            layCh.push(N('LayerElement', [], [N('Type', [S('LayerElementMaterial')]), N('TypedIndex', [I(0)])]));
            gKids.push(N('Layer', [I(0)], layCh));

            objChildren.push(N('Geometry', [L(meshGeoIds[i]), objName(geoName, 'Geometry'), S('Mesh')], gKids));

            // Mesh Model node
            // Primary Visibility / Casts Shadows / Receive Shadows (Maya requires these
            // or it warns about missing properties; also helps 3ds Max preserve render flags).
            objChildren.push(N('Model', [L(meshModelIds[i]), objName(geoName, 'Model'), S('Mesh')], [
                N('Version', [I(232)]),
                N('Properties70', [], [
                    Pbool('RotationActive', 1), Penum('RotationOrder', 0), Penum('InheritType', 1),
                    Pvec('Lcl Translation', 0, 0, 0),
                    Pvec('Lcl Rotation', 0, 0, 0),
                    Pvec('Lcl Scaling', 1, 1, 1),
                    Pbool('PrimaryVisibility', 1),
                    Pbool('Casts Shadows', 1),
                    Pbool('Receive Shadows', 1),
                    Pdbl('Visibility', 1.0)
                ])
            ]));
        });

        // Materials
        materials.forEach(function (m, mi) {
            objChildren.push(N('Material', [L(matIds[mi]), objName(m.name, 'Material'), S('')], [
                N('Version', [I(102)]),
                N('ShadingModel', [S('phong')]),
                N('MultiLayer', [I(0)]),
                N('Properties70', [], [
                    Pstr('ShadingModel', 'phong'),
                    Pcolor('DiffuseColor', 1, 1, 1),
                    Pcolor('SpecularColor', 0.04, 0.04, 0.04),
                    Pdbl('Shininess', 8)
                ])
            ]));
        });

        // Videos (image clips)
        Object.keys(videoIds).forEach(function (cu) {
            var t = textureStore[cu]; if (!t) return;
            objChildren.push(N('Video', [L(videoIds[cu]), objName(t.name, 'Video'), S('Clip')], [
                N('Type', [S('Clip')]),
                N('Properties70', [], [ Pstr('Path', 'textures/' + t.name) ]),
                N('UseMipMap', [I(0)]),
                N('Filename', [S('textures/' + t.name)]),
                N('RelativeFilename', [S('textures/' + t.name)])
            ]));
        });

        // Textures (one per material slot)
        materials.forEach(function (m) {
            ['albedo','normal','roughness','metallic','emissive','occlusion','specular','opacity'].forEach(function (ty) {
                var t = m.slots[ty]; if (!t) return;
                var tid = texIdsByKey[m.name + '_' + ty]; if (!tid) return;
                objChildren.push(N('Texture', [L(tid), objName(t.name, 'Texture'), S('')], [
                    N('Type', [S('TextureVideoClip')]),
                    N('Version', [I(202)]),
                    N('TextureName', [objName(t.name, 'Texture')]),
                    N('Properties70', [], [ Penum('CurrentTextureBlendMode', 0) ]),
                    N('Media', [objName(t.name, 'Video')]),
                    N('FileName', [S('textures/' + t.name)]),
                    N('RelativeFilename', [S('textures/' + t.name)])
                ]));
            });
        });

        topLevel.push(N('Objects', [], objChildren));

        // ---- Connections ----
        // In FBX, an object only becomes part of the scene when connected to
        // the scene root (id 0) via C: "OO", <modelId>, 0. Without this root
        // link, Blender's importer silently skips the Model (creates nothing),
        // while lenient viewers (3dviewer.net) auto-link orphans. This was the
        // root cause of "FBX imports with 0 meshes" in Blender.
        var connChildren = [];
        validGeos.forEach(function (i) {
            connChildren.push(N('C', [S('OO'), L(meshGeoIds[i]), L(meshModelIds[i])]));
            if (matIds[i]) connChildren.push(N('C', [S('OO'), L(matIds[i]), L(meshModelIds[i])]));
            // link mesh Model to scene root so Blender creates + links the object
            connChildren.push(N('C', [S('OO'), L(meshModelIds[i]), L(0)]));
        });
        var propMap = {albedo:'DiffuseColor',normal:'NormalMap',roughness:'Roughness',metallic:'Metallic',emissive:'Emissive',occlusion:'AmbientColor',specular:'SpecularColor',opacity:'TransparentColor'};
        materials.forEach(function (m, mi) {
            ['albedo','normal','roughness','metallic','emissive','occlusion','specular','opacity'].forEach(function (ty) {
                var t = m.slots[ty]; if (!t) return;
                var tid = texIdsByKey[m.name + '_' + ty]; if (!tid) return;
                connChildren.push(N('C', [S('OP'), L(tid), L(matIds[mi]), S(propMap[ty])]));
                if (videoIds[t.cleanUrl]) connChildren.push(N('C', [S('OO'), L(videoIds[t.cleanUrl]), L(tid)]));
            });
        });
        topLevel.push(N('Connections', [], connChildren));

        // v1.5.0: Takes section is now empty (no animations). Emit a minimal
        // Current node so strict readers don't complain about a missing Takes
        // block.
        topLevel.push(N('Takes', [], [ N('Current', [S('')]) ]));

        // ---- serialize to binary ----
        var buf = new BBuf();
        // header: 23-byte magic + uint32 version
        buf.strBytes('Kaydara FBX Binary  \x00\x1A\x00');
        buf.u32(7400);
        var off = buf.len;
        for (var ti = 0; ti < topLevel.length; ti++) { serializeNode(buf, topLevel[ti], off); off += nodeSize(topLevel[ti]); }
        // null record (terminates top-level node list)
        buf.u32(0); buf.u32(0); buf.u32(0); buf.u8(0);
        // footer: 16-byte magic + uint32 version
        var fm = [0xF3,0x1C,0xA7,0xD5,0x76,0x1C,0xD5,0x47,0xB3,0x7E,0xB4,0x6E,0x8C,0x66,0x25,0xE3];
        for (var fi = 0; fi < 16; fi++) buf.u8(fm[fi]);
        buf.u32(7400);

        // compute overall bounding box + totals for diagnostics
        var totalV = 0, totalF = 0, gmin = [Infinity,Infinity,Infinity], gmax = [-Infinity,-Infinity,-Infinity];
        geoStats.forEach(function (s) {
            if (s.skipped) return;
            totalV += s.vertices; totalF += s.faces;
            if (s.bbox) {
                for (var ax = 0; ax < 3; ax++) {
                    if (s.bbox.min[ax] < gmin[ax]) gmin[ax] = s.bbox.min[ax];
                    if (s.bbox.max[ax] > gmax[ax]) gmax[ax] = s.bbox.max[ax];
                }
            }
        });
        var overallBbox = (totalV > 0) ? { min: gmin, max: gmax } : null;

        return { binary: buf.toU8(), stats: geoStats, meshCount: validGeos.length, totalVertices: totalV, totalFaces: totalF, bbox: overallBbox };
    }

    // --------------------------- metadata ----------------------------
    function getMetadata() {
        var md = { name: 'sketchfab_model', author: 'unknown', url: window.location.href, date: new Date().toISOString(), id: getModelIdFromPath() };
        var nn = document.querySelector('.model-name__label'); if (nn) md.name = nn.textContent.trim();
        var an = document.querySelector('.user-name__link'); if (an) md.author = an.textContent.trim();
        return md;
    }
    function getModelIdFromPath() {
        var parts = location.pathname.split('/');
        var slug = parts.length > 2 ? parts[2] : '';
        if (!slug) return '';
        var sp = slug.split('-');
        return sp[sp.length - 1] || '';
    }

    // --------------------------- download ----------------------------
    async function doDownload() {
        try {
            if (geometries.length === 0 && Object.keys(textureStore).length === 0) {
                setMsg('Nothing captured yet - let the model fully load first.');
                return;
            }
            var md = getMetadata();
            var modelName = sanitizeFileName(md.name, 'sketchfab_model');
            var zip = new JSZip();
            var root = zip.folder(modelName);

            if (!settings.texturesOnly) {
                setMsg('Linking materials...'); setProgress(3);
                var materials = buildMaterials();

                if (settings.format === 'obj') {
                    setMsg('Fetching textures (full-res, original format)...'); setProgress(5);
                    await fetchAllTextures(function (done, total, nm) {
                        setProgress(5 + Math.round((done / total) * 60));
                        setMsg('Downloading texture ' + done + '/' + total + ': ' + nm);
                    });
                    setMsg('Writing OBJ...'); setProgress(70);
                    var objBlob = buildObj(modelName, materials);
                    root.file(modelName + '.obj', objBlob);
                    setMsg('Writing MTL...'); setProgress(80);
                    var mtlBlob = buildMtl(modelName, materials);
                    root.file(modelName + '.mtl', mtlBlob);
                } else { // fbx
                    setMsg('Fetching textures for FBX...'); setProgress(5);
                    await fetchAllTextures(function (done, total, nm) {
                        setProgress(5 + Math.round((done / total) * 60));
                        setMsg('Texture ' + done + '/' + total + ': ' + nm);
                    });
                    setMsg('Writing FBX (binary 7.4.0 - Maya/Blender/3ds-Max native)...'); setProgress(72);
                    var fbx = buildFBX(modelName);
                    root.file(modelName + '.fbx', fbx.binary);
                    md.fbxStats = {
                        meshes: fbx.meshCount,
                        totalGeometries: geometries.length,
                        totalVertices: fbx.totalVertices,
                        totalFaces: fbx.totalFaces,
                        bbox: fbx.bbox,
                        perGeometry: fbx.stats
                    };
                    setProgress(85);
                    if (fbx.meshCount === 0) {
                        setMsg('WARNING: 0 valid meshes exported - model will be empty! Let the model fully load in the viewer before exporting.');
                    } else {
                        var skipped = geometries.length - fbx.meshCount;
                        var bb = fbx.bbox;
                        var bbStr = bb ? (' bbox: [' + bb.min.map(function(v){return v.toFixed(1);}).join(',') + ']..[' + bb.max.map(function(v){return v.toFixed(1);}).join(',') + ']') : '';
                        setMsg('FBX ready: ' + fbx.meshCount + ' mesh(es)' + (skipped ? ' (' + skipped + ' empty skipped)' : '') + ', ' + fbx.totalVertices + ' verts, ' + fbx.totalFaces + ' faces' + bbStr);
                    }
                }
                root.file('metadata.json', JSON.stringify(md, null, 2));
            } else {
                setMsg('Fetching textures...'); setProgress(10);
                await fetchAllTextures(function (done, total, nm) {
                    setProgress(10 + Math.round((done / total) * 80));
                    setMsg('Texture ' + done + '/' + total + ': ' + nm);
                });
            }

            // add textures
            setMsg('Packaging textures...'); setProgress(88);
            var texFolder = root.folder('textures');
            var texCount = 0;
            Object.keys(textureStore).forEach(function (k) {
                var t = textureStore[k];
                var blob = textureByCleanUrl[k];
                if (blob) { texFolder.file(t.name, blob); texCount++; }
            });

            setMsg('Compressing ZIP...'); setProgress(94);
            var fname = modelName + (settings.texturesOnly ? '_textures' : '');
            var content = await root.generateAsync({ type: 'blob', compression: 'STORE' });
            setProgress(100);
            setMsg('Done. ' + geometries.length + ' geometries, ' + texCount + ' textures.');
            saveAs(content, fname + '.zip');
            setTimeout(function () { setProgress(null); }, 1500);
        } catch (e) {
            dlog('download error', e);
            setMsg('Error: ' + (e && e.message ? e.message : e));
            setProgress(null);
        }
    }
    pageWin.lkxDownload = doDownload;

    // =================================================================
    //  Sketchfab viewer script patching (proven injection points)
    //  Same approach as SUR - intercept the viewer JS before it runs,
    //  regex-patch to call our hooks, then re-inject.
    // =================================================================
    var re_renderInto1 = /A\.renderInto\(n,E,R/g;
    var re_renderInto2 = /g\.renderInto=function\(e,i,r/g;
    var re_drawArrays = /t\.drawArrays\(t\.TRIANGLES,0,6\)/g;
    var re_getResourceImage = /getResourceImage:function\(e,t\){/g;
    var re_drawGeometry = /(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g;

    // before-script-execute shim (MutationObserver based)
    (function () {
        var Event = function (script, target) {
            this.script = script; this.target = target;
            this._cancel = false; this._replace = null; this._stop = false;
        };
        Event.prototype.preventDefault = function () { this._cancel = true; };
        Event.prototype.stopPropagation = function () { this._stop = true; };
        Event.prototype.replacePayload = function (p) { this._replace = p; };

        var callbacks = [];
        window.addBeforeScriptExecuteListener = function (f) { callbacks.push(f); };
        window.removeBeforeScriptExecuteListener = function (f) {
            for (var i = callbacks.length - 1; i >= 0; i--) if (callbacks[i] === f) callbacks.splice(i, 1);
        };
        var dispatch = function (script, target) {
            if (!script || script.tagName !== 'SCRIPT') return;
            var e = new Event(script, target);
            if (typeof window.onbeforescriptexecute === 'function') { try { window.onbeforescriptexecute(e); } catch (err) { console.error(err); } }
            for (var i = 0; i < callbacks.length; i++) { if (e._stop) break; try { callbacks[i](e); } catch (err) { console.error(err); } }
            if (e._cancel) { script.textContent = ''; script.remove(); }
            else if (typeof e._replace === 'string') { script.textContent = e._replace; }
        };
        var obs = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) for (var j = 0; j < muts[i].addedNodes.length; j++) dispatch(muts[i].addedNodes[j], muts[i].target);
        });
        var start = function () { obs.observe(document, { childList: true, subtree: true }); };
        if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
    })();

    // -----------------------------------------------------------------
    //  Self-healing patch safety net (v1.5.1)
    //  Sketchfab periodically re-minifies their viewer bundle. When our
    //  regex injection points go stale, re-injecting a (silently)
    //  corrupted viewer kills the 3D viewport - the "model never finishes
    //  loading" problem. These guards make patching non-fatal:
    //    (a) only cancel the original script if >=1 regex matched AND the
    //        patched source still parses (new Function syntax check);
    //    (b) per-URL sessionStorage counter: if a patched load fails to
    //        produce a WebGL canvas within 20s, reload; the next load
    //        skips patching so the viewer runs unmodified (viewport
    //        always renders, export falls back to texImage2D metadata);
    //    (c) ?lkxforcepatch=1 clears the counter to re-enable patching.
    // -----------------------------------------------------------------
    var PATCH_WATCHDOG_MS = 20000;
    function patchAttemptsKey() {
        try { return 'lkx_patch_attempts::' + location.pathname; } catch (e) { return 'lkx_patch_attempts'; }
    }
    function getPatchAttempts() {
        try { return parseInt(sessionStorage.getItem(patchAttemptsKey()) || '0', 10) || 0; } catch (e) { return 0; }
    }
    function setPatchAttempts(n) {
        try { sessionStorage.setItem(patchAttemptsKey(), String(n)); } catch (e) {}
    }
    // Allow the user to force patching back on after an auto-disable.
    try { if (/[?&]lkxforcepatch=1/.test(location.search)) { sessionStorage.removeItem(patchAttemptsKey()); } } catch (e) {}

    // Sketchfab creates a WebGL canvas very early in viewer init. If one
    // exists (with a real GL context) OR window.scene is up, the viewer
    // script ran successfully -> our patches are safe.
    function viewerBootstrapped() {
        try {
            if (pageWin.scene) return true;
            var cv = document.querySelector('canvas');
            if (cv && cv.width > 1 && cv.height > 1) {
                var gl = cv.getContext('webgl2') || cv.getContext('webgl');
                if (gl) return true;
            }
        } catch (e) {}
        return false;
    }

    window.onbeforescriptexecute = function (e) {
        // Process ONLY the specific script node that was just added.
        // (Old code re-scanned e.target.childNodes on every mutation and
        // could re-inject the viewer multiple times -> dead viewport.)
        var sc = e.script;
        if (!(sc instanceof HTMLScriptElement)) return;
        if (!sc.src) return;
        if (sc.src.indexOf('web/dist/') < 0 && sc.src.indexOf('standaloneViewer') < 0) return;

        // (b) if a previous patched load failed on this exact model, let
        //     Sketchfab's original viewer run unmodified this time.
        if (getPatchAttempts() >= 1) {
            console.log('[LikolusExport] patching skipped (previous attempt failed on this model; viewer runs unmodified). Use ?lkxforcepatch=1 to retry.');
            return;
        }

        var req = new XMLHttpRequest();
        req.open('GET', sc.src, false);
        try { req.send(''); } catch (err) { return; }
        if (req.status !== 200 || !req.responseText || req.responseText.length < 1000) {
            console.warn('[LikolusExport] fetch viewer failed', req.status);
            return;
        }
        var js = req.responseText;
        var patchesApplied = 0;
        var m;

        if ((m = re_renderInto1.exec(js))) {
            var i0 = m.index + m[0].length;
            js = js.slice(0, i0) + ',i' + js.slice(i0);
            patchesApplied++; console.log('[LikolusExport] patch renderInto1 ok');
        }
        if ((m = re_renderInto2.exec(js))) {
            var i1 = m.index + m[0].length;
            js = js.slice(0, i1) + ',image_data' + js.slice(i1);
            patchesApplied++; console.log('[LikolusExport] patch renderInto2 ok');
        }
        if ((m = re_drawArrays.exec(js))) {
            var i2 = m.index + m[0].length;
            // SUR-proven: `t` is the GL context, `image_data` is the 4th param
            // added by the renderInto2 patch. MUST use these names - `gl` is
            // NOT in scope here (older builds used `gl`, now it's `t`).
            js = js.slice(0, i2) + ',window.drawhookimg(t,image_data)' + js.slice(i2);
            patchesApplied++; console.log('[LikolusExport] patch drawArrays ok');
        }
        if ((m = re_getResourceImage.exec(js))) {
            var i3 = m.index + m[0].length;
            js = js.slice(0, i3) + 'e = window.drawhookcanvas(e,this._imageModel);' + js.slice(i3);
            patchesApplied++; console.log('[LikolusExport] patch getResourceImage ok');
        }
        if ((m = re_drawGeometry.exec(js))) {
            var i4 = m.index + m[1].length;
            // SUR-proven injection (no second arg); attachbody reads the
            // bound texture via lastGLCtx captured by the texImage2D hook
            js = js.slice(0, i4) + ';window.attachbody(t);' + js.slice(i4);
            patchesApplied++; console.log('[LikolusExport] patch drawGeometry ok');
        }

        // (a) if NO patch point matched, Sketchfab updated their viewer.
        //     Re-injecting un-modified JS would still alter load timing and
        //     risk breaking the 3D viewport, so let the ORIGINAL run untouched.
        if (patchesApplied === 0) {
            console.warn('[LikolusExport] no patch points matched (Sketchfab viewer updated?) - running original viewer unmodified. Export will be limited.');
            return;
        }

        // (a) syntax guard: if our injection produced unbalanced/invalid JS,
        //     refuse to inject and let the original run (avoids dead viewport).
        try {
            new Function(js);
        } catch (syntaxErr) {
            console.warn('[LikolusExport] patched viewer failed syntax check (' + syntaxErr.message + ') - running original unmodified.');
            return;
        }

        // At least one patch matched and parses -> cancel original, inject patched.
        e.preventDefault(); e.stopPropagation();
        setPatchAttempts(getPatchAttempts() + 1);
        pageWin.lkxPatchInfo = { attempted: true, patches: patchesApplied, attempt: getPatchAttempts() };
        console.log('[LikolusExport] injecting patched viewer (' + patchesApplied + ' patch' + (patchesApplied === 1 ? '' : 'es') + ', attempt ' + getPatchAttempts() + ')');

        var s = document.createElement('script');
        for (var i = 0; i < sc.attributes.length; i++) {
            var a = sc.attributes[i];
            if (a.name !== 'src' && a.name !== 'integrity') s.setAttribute(a.name, a.value);
        }
        s.text = js;
        (document.getElementsByTagName('head')[0] || document.documentElement).appendChild(s);

        // (b) watchdog: poll for PATCH_WATCHDOG_MS. If the viewer never
        //     bootstraps (no WebGL canvas / no window.scene) our patches
        //     broke it -> reload. The attempt counter is already bumped, so
        //     the next load skips patching and the viewport will render.
        var t0 = Date.now();
        var watchdog = setInterval(function () {
            if (viewerBootstrapped()) {
                clearInterval(watchdog);
                setPatchAttempts(0);            // success -> reset counter
                if (pageWin.lkxPatchInfo) pageWin.lkxPatchInfo.ok = true;
                console.log('[LikolusExport] viewer bootstrapped with patches - attempt counter cleared.');
                return;
            }
            if (Date.now() - t0 >= PATCH_WATCHDOG_MS) {
                clearInterval(watchdog);
                console.warn('[LikolusExport] watchdog: viewer did not bootstrap within ' + (PATCH_WATCHDOG_MS / 1000) + 's - reloading without patch.');
                try { location.reload(); } catch (e3) {}
            }
        }, 2000);
    };

})();
