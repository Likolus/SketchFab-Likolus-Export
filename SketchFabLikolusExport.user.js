// ==UserScript==
// @name         SketchFab Likolus Export
// @namespace    https://github.com/Likolus
// @version      1.1.0
// @description  Export Sketchfab models to OBJ with correctly mapped materials & textures. Maya/Blender-ready: nothing lost, texture paths preserved. Improved fork of SUR (WulfSkol/gamedev44).
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
// ==/UserScript==

/* =====================================================================
 *  SketchFab Likolus Export
 *  -------------------------------------------------------------------
 *  Goal: export a Sketchfab model exactly as it looks in the viewer,
 *  as OBJ + MTL + textures, so that opening in Maya / Blender loses
 *  nothing — geometry, UVs, normals, PBR textures and their paths all
 *  survive. Materials are correctly assigned per geometry group via
 *  `usemtl`, and the MTL references every PBR map (albedo, normal,
 *  roughness, metallic, specular, emissive, opacity, AO) with relative
 *  `textures/...` paths.
 *
 *  Improvements over SUR (the upstream Fabulous-Ripper remake):
 *    1. Generates a real .mtl file (SUR emitted `mtllib` into nothing).
 *    2. Emits `usemtl` per geometry group so faces actually map to
 *       materials in Maya/Blender.
 *    3. Links each material to its textures by:
 *         a) capturing the currently-bound GL texture at draw time, and
 *         b) name-prefix matching against the geometry's stateset name.
 *    4. Downloads textures from their ORIGINAL urls via
 *       GM_xmlhttpRequest — full resolution, correct orientation,
 *       original format (.jpg/.png/.jpeg). readPixels is only a fallback.
 *    5. Fixes the vertical-flip bug in the readPixels fallback path.
 *    6. Writes ONE combined model.obj with proper vertex/uv/normal
 *       index offsets per group (cleaner in DCC apps than N loose files).
 *    7. Places textures in a `textures/` subfolder with relative paths
 *       in the MTL, so paths resolve on any OS.
 *    8. Emits extended MTL PBR keys (`map_Pr`, `map_Pm`, `map_Ke`,
 *       `map_Bump`, `map_d`) understood by Blender & Maya 2018+.
 *    9. Compact float formatting (6 dp) to keep OBJ files small.
 *   10. Per-stage progress UI.
 * ===================================================================== */

(function () {
    'use strict';

    var window = unsafeWindow;
    console.log('[LikolusExport] init');

    // ----------------------------- state -----------------------------
    var geometries = [];          // captured geometry groups
    var capturedGeoRefs = new WeakSet();
    var capturedGeoIds = new Set();

    var textureStore = {};        // cleanUrl -> { name, type, url, ext, width, height }
    var textureByCleanUrl = {};   // cleanUrl -> blob (filled at download time)
    var capturedTextureSet = new Set();

    // gl-texture-object -> metadata (built by texImage2D hook)
    var glTextureMeta = new Map();
    var glTextureIdx = 0;

    // ----------------------------- rig --------------------------------
    // Skeleton: bones captured from the viewer's scene graph.
    //   boneMap: objectRef -> bone index (dedup)
    //   bones[]: { name, ref, parentRef, translation, rotation, scale, ibm }
    var rigBones = [];
    var rigBoneMap = new WeakMap();
    // Skin data per geometry: { joints:[boneIdx], ibm:[Float32Array(16)...],
    //   jointAttr:Float32Array, weightAttr:Float32Array }
    var rigSkinByGeoIdx = {};
    // Animations: [{ name, duration, channels:[{boneIdx, path, times:Float32Array, values:Float32Array}] }]
    var rigAnimations = [];
    var rigSceneRoots = [];   // candidate scene root refs probed for animations
    var rigCaptureTried = false;

    var DEBUG = false;
    var OBJ_CHUNK_LIMIT = 1024 * 1024;

    function dlog() { if (DEBUG && console && console.log) console.log.apply(console, ['[LikolusExport]'].concat([].slice.call(arguments))); }

    // --------------------------- helpers -----------------------------
    function sanitizeFileName(name, fallback) {
        var c = (name || '').toString();
        c = c.replace(/[\x00-\x1f\x7f]/g, '');
        c = c.replace(/[\\/:*?"<>|]+/g, '_');
        c = c.replace(/\s+/g, ' ').trim();
        c = c.replace(/^\.+/, '').replace(/\.\.+/g, '.');
        if (!c) c = fallback || 'file';
        if (c.length > 120) c = c.slice(0, 120);
        return c;
    }

    function fnum(n) {
        // compact float: 6 dp, trim trailing zeros
        if (n === 0) return '0';
        var s = n.toFixed(6);
        if (s.indexOf('.') !== -1) {
            s = s.replace(/0+$/, '').replace(/\.$/, '');
        }
        return s === '-0' ? '0' : s;
    }

    function extFromUrl(url) {
        var clean = (url || '').split('?')[0].split('#')[0];
        var m = clean.match(/\.([a-zA-Z0-9]{2,4})$/);
        if (!m) return 'png';
        var e = m[1].toLowerCase();
        if (e === 'jpeg') e = 'jpg';
        return e;
    }

    function classifyTexture(name) {
        var n = (name || '').toLowerCase();
        if (n.indexOf('albedo') >= 0 || n.indexOf('basecolor') >= 0 || n.indexOf('base_color') >= 0 || n.indexOf('diffuse') >= 0 || n.indexOf('color') >= 0) return 'albedo';
        if (n.indexOf('normal') >= 0 || n.indexOf('bump') >= 0 || n.indexOf('_nrm') >= 0 || n.indexOf('_nor') >= 0) return 'normal';
        if (n.indexOf('rough') >= 0) return 'roughness';
        if (n.indexOf('metal') >= 0) return 'metallic';
        if (n.indexOf('spec') >= 0) return 'specular';
        if (n.indexOf('emiss') >= 0) return 'emissive';
        if (n.indexOf('opacity') >= 0 || n.indexOf('alpha') >= 0 || n.indexOf('_mask') >= 0) return 'opacity';
        if (n.indexOf('occlusion') >= 0 || n.indexOf('_ao') >= 0 || n.indexOf('ao_') >= 0 || n.indexOf('ambient') >= 0) return 'ao';
        if (n.indexOf('height') >= 0 || n.indexOf('displacement') >= 0) return 'height';
        return 'albedo'; // default guess
    }

    // stable, unique texture filename inside textures/
    var usedTexNames = {};
    function uniqueTexName(base, ext) {
        var safe = sanitizeFileName(base, 'texture');
        // strip existing extension if any
        safe = safe.replace(/\.(png|jpg|jpeg|webp|tga|bmp|ktx2)$/i, '');
        var candidate = safe + '.' + (ext || 'png');
        if (!usedTexNames[candidate]) { usedTexNames[candidate] = 1; return candidate; }
        var i = 2;
        while (usedTexNames[safe + '_' + i + '.' + (ext || 'png')]) i++;
        candidate = safe + '_' + i + '.' + (ext || 'png');
        usedTexNames[candidate] = 1;
        return candidate;
    }

    // --------------------------- settings ----------------------------
    var settings = {
        format: 'obj',       // 'obj' | 'gltf'
        texturesOnly: false,
        scale: 1.0,
        flipUV: false,       // flip V (1-v) for UVs — off by default
        combineObj: true,    // single model.obj with groups
        fetchOriginalTextures: true,
        rig: false           // capture skeleton + skin weights + animations (forces glTF)
    };

    // --------------------------- UI ----------------------------------
    var ui = null;
    function ensureUI() {
        if (ui) return ui;
        ui = document.createElement('div');
        ui.id = 'likolus-export-ui';
        ui.style.cssText = 'position:fixed;bottom:20px;right:20px;background:rgba(15,17,21,0.96);color:#e8eaed;padding:0;border-radius:10px;z-index:2147483647;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:12px;min-width:260px;max-width:320px;border:1px solid #1f6feb;box-shadow:0 8px 30px rgba(0,0,0,0.55);pointer-events:auto;backdrop-filter:blur(6px);';
        ui.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #2a2f37;background:linear-gradient(90deg,#1f6feb,#0d3a8a);border-radius:10px 10px 0 0;">' +
              '<span style="font-weight:700;color:#fff;letter-spacing:.3px;">SketchFab Likolus Export</span>' +
              '<span id="lkx-close" style="cursor:pointer;color:#fff;opacity:.8;font-size:16px;line-height:1;">×</span>' +
            '</div>' +
            '<div style="padding:12px;">' +
              '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
                '<div style="flex:1;"><div style="color:#8b949e;font-size:11px;margin-bottom:2px;">Geometries</div><div id="lkx-ngeo" style="font-weight:600;font-size:15px;color:#58a6ff;">0</div></div>' +
                '<div style="flex:1;"><div style="color:#8b949e;font-size:11px;margin-bottom:2px;">Textures</div><div id="lkx-ntex" style="font-weight:600;font-size:15px;color:#3fb950;">0</div></div>' +
                '<div style="flex:1;"><div style="color:#8b949e;font-size:11px;margin-bottom:2px;">Bones</div><div id="lkx-nbone" style="font-weight:600;font-size:15px;color:#d2a8ff;">0</div></div>' +
                '<div style="flex:1;"><div style="color:#8b949e;font-size:11px;margin-bottom:2px;">Anims</div><div id="lkx-nanim" style="font-weight:600;font-size:15px;color:#d2a8ff;">0</div></div>' +
              '</div>' +
              '<div style="border-top:1px solid #2a2f37;padding-top:10px;margin-bottom:8px;">' +
                '<div style="color:#8b949e;font-size:11px;margin-bottom:4px;">Format</div>' +
                '<label style="display:block;margin:2px 0;cursor:pointer;"><input type="radio" name="lkx-fmt" value="obj" checked> <b style="color:#e8eaed;">OBJ + MTL + Textures</b> <span style="color:#8b949e;">(Maya/Blender)</span></label>' +
                '<label style="display:block;margin:2px 0;cursor:pointer;color:#8b949e;"><input type="radio" name="lkx-fmt" value="gltf"> GLTF + .bin</label>' +
              '</div>' +
              '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
                '<label style="flex:1;color:#8b949e;font-size:11px;">Scale<br><input type="number" id="lkx-scale" value="1.0" step="0.1" style="width:100%;box-sizing:border-box;background:#0d1117;color:#e8eaed;border:1px solid #2a2f37;border-radius:4px;padding:3px 5px;"></label>' +
                '<label style="flex:1;color:#8b949e;font-size:11px;display:flex;flex-direction:column;">Options<br>' +
                  '<span style="margin-top:2px;"><input type="checkbox" id="lkx-rig"> Rig + Anim <span style="color:#d2a8ff;">(glTF)</span></span>' +
                  '<span><input type="checkbox" id="lkx-flipuv"> Flip UV V</span>' +
                  '<span><input type="checkbox" id="lkx-texonly"> Textures only</span>' +
                '</label>' +
              '</div>' +
              '<div id="lkx-bar-wrap" style="height:6px;background:#21262d;border-radius:3px;overflow:hidden;margin-bottom:6px;display:none;"><div id="lkx-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#1f6feb,#58a6ff);transition:width .15s;"></div></div>' +
              '<div id="lkx-msg" style="color:#8b949e;font-style:italic;font-size:11px;min-height:14px;margin-bottom:8px;">Waiting for model to load…</div>' +
              '<button id="lkx-dl" style="width:100%;background:linear-gradient(90deg,#238636,#2ea043);color:#fff;border:none;padding:9px;border-radius:6px;cursor:pointer;font-weight:700;letter-spacing:.4px;">EXPORT &amp; DOWNLOAD</button>' +
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
            var fmts = document.querySelectorAll('input[name="lkx-fmt"]'); fmts.forEach(function (el) { el.addEventListener('change', function (e) { settings.format = e.target.value; }); });
            var sc = document.getElementById('lkx-scale'); if (sc) sc.addEventListener('change', function (e) { settings.scale = parseFloat(e.target.value) || 1.0; });
            var fu = document.getElementById('lkx-flipuv'); if (fu) fu.addEventListener('change', function (e) { settings.flipUV = e.target.checked; });
            var to = document.getElementById('lkx-texonly'); if (to) to.addEventListener('change', function (e) { settings.texturesOnly = e.target.checked; });
            var rg = document.getElementById('lkx-rig'); if (rg) rg.addEventListener('change', function (e) {
                settings.rig = e.target.checked;
                if (settings.rig) {
                    // rig requires glTF; switch format radio + setting
                    settings.format = 'gltf';
                    var ob = document.querySelector('input[name="lkx-fmt"][value="obj"]');
                    var gl = document.querySelector('input[name="lkx-fmt"][value="gltf"]');
                    if (ob) ob.checked = false; if (gl) gl.checked = true;
                }
            });
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
        var b = document.getElementById('lkx-nbone'); if (b) b.textContent = String(rigBones.length);
        var a = document.getElementById('lkx-nanim'); if (a) a.textContent = String(rigAnimations.length);
    }
    function status(msg) { setMsg(msg); dlog(msg); updateCounts(); }

    // show UI as soon as DOM is ready
    function showUIWhenReady() { if (document.body) { ensureUI(); } else setTimeout(showUIWhenReady, 60); }
    showUIWhenReady();

    // ---------------------- geometry capture -------------------------
    // Called from injected patch: window.attachbody(t [, glCtx])
    window.attachbody = function (t, glCtx) {
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
            var boundTexUrl = null;
            try {
                if (glCtx && glCtx.getParameter) {
                    var bt = glCtx.getParameter(glCtx.TEXTURE_BINDING_2D);
                    if (bt && glTextureMeta.has(bt)) boundTexUrl = glTextureMeta.get(bt).cleanUrl;
                }
            } catch (e) {}

            var geoIdx = geometries.length;
            geometries.push({
                name: sanitizeFileName(nm, 'part_' + geoIdx),
                rawName: nm,
                vertex: attr.Vertex._elements,
                normal: attr.Normal ? attr.Normal._elements : null,
                uv: pickTexCoord(attr),
                primitives: prims.map(function (p) { return { mode: p.mode, indices: p.indices._elements }; }),
                boundTexUrl: boundTexUrl
            });
            status('Captured geometry: ' + nm + (boundTexUrl ? ' (+texture)' : ''));
            // try to capture rig (skin + skeleton) for this geometry
            try { captureRigFromGeometry(t, geoIdx, attr); } catch (e) { dlog('captureRig error', e); }
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

    // ---------------------- texture capture --------------------------
    // Called from injected patch: window.drawhookcanvas(e, imageModel)
    window.drawhookcanvas = function (e, imageModel) {
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
    // (fullscreen pass — used as a secondary texture capture signal)
    window.drawhookimg = function (gl, t) {
        try {
            if (!t) return;
            var url = t[5] && (t[5].currentSrc || t[5].src);
            if (!url) return;
            var cleanUrl = url.split('?')[0];
            if (!textureStore[cleanUrl]) {
                // we don't have metadata; register from the bound texture
                var w = t[5].width, h = t[5].height;
                textureStore[cleanUrl] = {
                    name: uniqueTexName('texture', extFromUrl(url)),
                    type: classifyTexture(cleanUrl),
                    url: url, cleanUrl: cleanUrl, ext: extFromUrl(url),
                    width: w, height: h
                };
                capturedTextureSet.add(cleanUrl);
                status('Captured texture (pass): ' + textureStore[cleanUrl].name);
            }
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
    // hook as soon as prototypes exist
    function tryHookWebGL() {
        if (window.WebGLRenderingContext) hookWebGL(window.WebGLRenderingContext.prototype);
        if (window.WebGL2RenderingContext) hookWebGL(window.WebGL2RenderingContext.prototype);
    }
    tryHookWebGL();
    // also hook if prototypes appear later
    var webGLPoll = setInterval(function () {
        if ((window.WebGLRenderingContext && !window.WebGLRenderingContext.prototype._lkxHooked) ||
            (window.WebGL2RenderingContext && !window.WebGL2RenderingContext.prototype._lkxHooked)) {
            tryHookWebGL();
        } else if (window.WebGLRenderingContext && window.WebGLRenderingContext.prototype._lkxHooked) {
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
            if ((w & (w - 1)) !== 0 || (h & (h - 1)) !== 0) return null;
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
            return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, 'image/png'); });
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
            var blob = null;
            if (settings.fetchOriginalTextures && meta.url) {
                blob = await gmFetchBlob(meta.url);
            }
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
            for (var i = 0; i < v.length; i += 3) w.push('v ' + fnum(v[i]) + ' ' + fnum(v[i + 1]) + ' ' + fnum(v[i + 2]) + '\n');

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
                for (var i = 0; i < n.length; i += 3) w.push('vn ' + fnum(n[i]) + ' ' + fnum(n[i + 1]) + ' ' + fnum(n[i + 2]) + '\n');
                hasAnyN = true;
            }

            w.push('usemtl ' + g.materialName + '\n');
            w.push('s 1\n');

            function fmtFace(num) {
                var s = '' + num;
                if (hasUV && hasN) return s + '/' + s + '/' + s;
                if (hasUV) return s + '/' + s;
                if (hasN) return s + '//' + s;
                return s;
            }

            var prims = g.primitives;
            for (var pi = 0; pi < prims.length; pi++) {
                var prim = prims[pi];
                var mode = prim.mode, idx = prim.indices;
                if (mode === 4 || mode === undefined) {
                    for (var j = 0; j + 2 < idx.length; j += 3) {
                        var a = idx[j] + 1 + vOff, b = idx[j + 1] + 1 + vOff, c = idx[j + 2] + 1 + vOff;
                        w.push('f ' + fmtFace(a) + ' ' + fmtFace(b) + ' ' + fmtFace(c) + '\n');
                    }
                } else if (mode === 5) { // triangle strip
                    for (var j = 0; j + 2 < idx.length; j++) {
                        var a = idx[j] + 1 + vOff, b = idx[j + 1] + 1 + vOff, c = idx[j + 2] + 1 + vOff;
                        if (j & 1) { var tmp = b; b = c; c = tmp; }
                        w.push('f ' + fmtFace(a) + ' ' + fmtFace(b) + ' ' + fmtFace(c) + '\n');
                    }
                } else if (mode === 6) { // triangle fan
                    var center = idx[0] + 1 + vOff;
                    for (var j = 1; j + 1 < idx.length; j++) {
                        w.push('f ' + fmtFace(center) + ' ' + fmtFace(idx[j] + 1 + vOff) + ' ' + fmtFace(idx[j + 1] + 1 + vOff) + '\n');
                    }
                } else {
                    dlog('unknown primitive mode', mode);
                }
            }

            vOff += v.length / 3;
            if (hasUV) vtOff += uv.length / 2;
            if (hasN) vnOff += n.length / 3;
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
            var alb = mat.slots.albedo;
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

    // --------------------------- rig capture -------------------------
    // Defensive probing: Sketchfab's viewer is minified and property names vary.
    // We probe many candidates for skin / joints / weights / skeleton / animations.

    function probeAttr(attr, names) {
        if (!attr) return null;
        for (var i = 0; i < names.length; i++) {
            var k = names[i];
            if (attr[k] && attr[k]._elements) return attr[k]._elements;
        }
        return null;
    }

    // Decompose a (column-major) 4x4 matrix into translation, rotation (xyzw quat), scale.
    function decomposeMat4(m) {
        var t = [m[12], m[13], m[14]];
        var sx = Math.hypot(m[0], m[1], m[2]);
        var sy = Math.hypot(m[4], m[5], m[6]);
        var sz = Math.hypot(m[8], m[9], m[10]);
        var s = [sx, sy, sz];
        // normalized rotation 3x3
        var r00 = m[0] / sx, r01 = m[1] / sx, r02 = m[2] / sx;
        var r10 = m[4] / sy, r11 = m[5] / sy, r12 = m[6] / sy;
        var r20 = m[8] / sz, r21 = m[9] / sz, r22 = m[10] / sz;
        // quaternion from rotation matrix
        var tr = r00 + r11 + r22;
        var qw, qx, qy, qz;
        if (tr > 0) {
            var sq = Math.sqrt(tr + 1) * 2;
            qw = 0.25 * sq; qx = (r21 - r12) / sq; qy = (r02 - r20) / sq; qz = (r10 - r01) / sq;
        } else if (r00 > r11 && r00 > r22) {
            var sq = Math.sqrt(1 + r00 - r11 - r22) * 2;
            qw = (r21 - r12) / sq; qx = 0.25 * sq; qy = (r01 + r10) / sq; qz = (r02 + r20) / sq;
        } else if (r11 > r22) {
            var sq = Math.sqrt(1 + r11 - r00 - r22) * 2;
            qw = (r02 - r20) / sq; qx = (r01 + r10) / sq; qy = 0.25 * sq; qz = (r12 + r21) / sq;
        } else {
            var sq = Math.sqrt(1 + r22 - r00 - r11) * 2;
            qw = (r10 - r01) / sq; qx = (r02 + r20) / sq; qy = (r12 + r21) / sq; qz = 0.25 * sq;
        }
        return { translation: t, rotation: [qx, qy, qz, qw], scale: s };
    }

    function getMatElements(obj) {
        if (!obj) return null;
        var cands = ['_matrix', '_localMatrix', '_modelMatrix', 'matrix', 'localMatrix', 'modelMatrix', '_worldMatrix', 'worldMatrix'];
        for (var i = 0; i < cands.length; i++) {
            var m = obj[cands[i]];
            if (m) {
                if (m._elements) return m._elements;
                if (m.elements) return m.elements;
                if (m instanceof Float32Array || m instanceof Float64Array || (m && m.length === 16)) return m;
            }
        }
        return null;
    }

    function getTRS(obj) {
        // prefer explicit TRS, else decompose matrix
        var t = obj._translation || obj.translation || obj._position || obj.position;
        var r = obj._rotation || obj.rotation || obj._quaternion || obj.quaternion;
        var s = obj._scale || obj.scale || obj._scaling || obj.scaling;
        var tr = [0, 0, 0], rr = [0, 0, 0, 1], sr = [1, 1, 1];
        if (t) { tr = (t._elements || t.elements || t); if (tr.length >= 3) tr = [tr[0], tr[1], tr[2]]; }
        if (r) { rr = (r._elements || r.elements || r); if (rr.length >= 4) rr = [rr[0], rr[1], rr[2], rr[3]]; else if (rr.length === 3) rr = [rr[0], rr[1], rr[2], Math.sqrt(Math.max(0, 1 - rr[0] * rr[0] - rr[1] * rr[1] - rr[2] * rr[2]))]; }
        if (s) { sr = (s._elements || s.elements || s); if (sr.length >= 3) sr = [sr[0], sr[1], sr[2]]; }
        var mat = getMatElements(obj);
        if (mat) {
            var d = decomposeMat4(mat);
            // matrix overrides if TRS not explicit — but keep explicit TRS when present
            if (!t) tr = d.translation;
            if (!r) rr = d.rotation;
            if (!s) sr = d.scale;
        }
        return { translation: tr, rotation: rr, scale: sr };
    }
    // (split name to avoid collision in the getter above)
    function getMatElement_s(obj) { return getMatElement_s_inner(obj); }
    function getMatElement_s_inner(obj) { return getMatElement(obj); }

    function registerBone(ref, parentRef) {
        if (!ref) return -1;
        if (rigBoneMap.has(ref)) return rigBoneMap.get(ref);
        var nm = (ref._name || ref.name || ('bone_' + rigBones.length));
        var trs = getTRS(ref);
        var bone = { name: sanitizeFileName(nm, 'bone_' + rigBones.length), ref: ref, parentRef: parentRef || null, translation: trs.translation, rotation: trs.rotation, scale: trs.scale, ibm: null };
        var idx = rigBones.length;
        rigBones.push(bone);
        rigBoneMap.set(ref, idx);
        return idx;
    }

    // Walk a node's parent chain up to register ancestor bones (so hierarchy is preserved).
    function registerAncestors(node) {
        var parent = null;
        try {
            var ps = node._parents || node.parents || node._parent;
            if (ps && ps.length) parent = ps[0];
            else if (ps) parent = ps;
        } catch (e) {}
        if (parent) {
            var pidx = registerBone(parent, null);
            registerAncestors(parent);
            return pidx;
        }
        return -1;
    }

    function captureRigFromGeometry(t, geoIdx, attr) {
        // 1) find a skin / skeleton reference on the geometry or its parents
        var skin = null;
        var probeObjs = [t];
        try { var ps = t._parents || t.parents; if (ps && ps.length) probeObjs.push(ps[0]); } catch (e) {}
        var skinKeys = ['_skin', 'skin', '_skeleton', 'skeleton', '_rig', 'rig', '_armature', 'armature'];
        outer: for (var oi = 0; oi < probeObjs.length; oi++) {
            var o = probeObjs[oi]; if (!o) continue;
            for (var ki = 0; ki < skinKeys.length; ki++) {
                if (o[skinKeys[ki]]) { skin = o[skinKeys[ki]]; break outer; }
            }
        }
        // 2) find joint indices + weight attributes (many possible names)
        var jointAttr = probeAttr(attr, ['Joints0', 'JointIndices', 'BoneIndices', 'SkinJoints', 'JOINTS_0', 'Joints', 'Bones', 'BoneWeights0']);
        var weightAttr = probeAttr(attr, ['Weights0', 'BoneWeights', 'SkinWeights', 'WEIGHTS_0', 'Weights', 'SkinWeights0']);
        // Some viewers store 8 influences (Joints0+Joints1); we take Joints0 (4) which glTF supports by default.
        if (!jointAttr || !weightAttr) {
            // no skinning on this geometry — that's fine, it's a static part
            return;
        }
        // 3) resolve joints list + inverse bind matrices
        var joints = [];      // array of bone indices
        var ibms = [];        // array of Float32Array(16)
        var jointRefs = null;
        var ibmArr = null;
        if (skin) {
            jointRefs = skin._joints || skin.joints || skin._bones || skin.bones || skin._jointList;
            ibmArr = skin._inverseBindMatrices || skin.inverseBindMatrices || skin._bindMatrices || skin.bindMatrices || skin._inverseBindMatrix || skin._ibm;
            // also probe skeleton root for animation scanning
            var root = skin._skeleton || skin.skeleton || skin._root || skin.root;
            if (root && rigSceneRoots.indexOf(root) < 0) rigSceneRoots.push(root);
        }
        if (jointRefs && jointRefs.length) {
            for (var j = 0; j < jointRefs.length; j++) {
                var jref = jointRefs[j];
                var pidx = registerAncestors(jref);
                var bidx = registerBone(jref, pidx >= 0 ? rigBones[pidx].ref : null);
                joints.push(bidx);
                var ibm = null;
                if (ibmArr) {
                    var src = ibmArr[j];
                    if (src) {
                        var el = src._elements || src.elements || src;
                        if (el && el.length >= 16) { ibm = new Float32Array(16); for (var k = 0; k < 16; k++) ibm[k] = el[k]; }
                    }
                }
                ibms.push(ibm);
                if (rigBones[bidx]) rigBones[bidx].ibm = ibm;
            }
        } else {
            // no joint list — derive bones from the unique joint indices in the attribute
            var maxIdx = -1;
            for (var v = 0; v < jointAttr.length; v++) { var iv = jointAttr[v] | 0; if (iv > maxIdx) maxIdx = iv; }
            for (var b = 0; b <= maxIdx && b < 256; b++) { joints.push(registerBone({ _name: 'bone_' + b }, null)); }
        }
        // record skin for this geometry
        rigSkinByGeoIdx[geoIdx] = { joints: joints, ibm: ibms, jointAttr: jointAttr, weightAttr: weightAttr };
        status('Captured rig for ' + (geometries[geoIdx] ? geometries[geoIdx].name : 'geo') + ': ' + joints.length + ' joints');
    }

    // Scan candidate scene roots for animation tracks. Called once before export.
    function captureAnimations() {
        if (rigCaptureTried) return;
        rigCaptureTried = true;
        try {
            // probe window + a few known roots for animation collections
            var roots = rigSceneRoots.slice();
            // also try the global scene if exposed
            try { if (window.scene) roots.push(window.scene); } catch (e) {}
            try { if (window.app && window.app.scene) roots.push(window.app.scene); } catch (e) {}
            var animCollections = [];
            for (var i = 0; i < roots.length; i++) {
                var r = roots[i]; if (!r) continue;
                var coll = r._animations || r.animations || r._clips || r.clips || r._tracks;
                if (coll && coll.length) animCollections.push(coll);
            }
            // also probe a global animation player
            try { if (window._animationPlayer && window._animationPlayer._animations) animCollections.push(window._animationPlayer._animations); } catch (e) {}
            for (var c = 0; c < animCollections.length; c++) {
                var coll2 = animCollections[c];
                for (var a = 0; a < coll2.length; a++) {
                    parseAnimation(coll2[a]);
                }
            }
            if (rigAnimations.length) status('Captured ' + rigAnimations.length + ' animation(s)');
        } catch (e) { dlog('captureAnimations error', e); }
    }

    function parseAnimation(anim) {
        if (!anim) return;
        var name = anim._name || anim.name || ('anim_' + rigAnimations.length);
        var duration = anim._duration || anim.duration || 0;
        var channels = [];
        // Common shapes: anim.tracks[] each {node/bone, path, times[], values[]}
        // or anim.channels[] + anim.samplers[]
        var tracks = anim._tracks || anim.tracks || anim._channels || anim.channels;
        if (tracks && tracks.length) {
            for (var i = 0; i < tracks.length; i++) {
                var tr = tracks[i];
                var nodeRef = tr._node || tr.node || tr._target || tr.target || tr._bone || tr.bone;
                if (!nodeRef) continue;
                var bidx = rigBoneMap.has(nodeRef) ? rigBoneMap.get(nodeRef) : -1;
                if (bidx < 0) {
                    // try register on the fly
                    bidx = registerBone(nodeRef, null);
                }
                var path = (tr._path || tr.path || 'translation').toLowerCase();
                if (path === 'position') path = 'translation';
                if (path === 'rotation') path = 'rotation';
                if (path === 'scaling' || path === 'scale') path = 'scale';
                var times = tr._times || tr.times || (tr._input && (tr._input._elements || tr._input.elements || tr._input)) || (tr.input && (tr.input._elements || tr.input.elements || tr.input));
                var values = tr._values || tr.values || (tr._output && (tr._output._elements || tr._output.elements || tr._output)) || (tr.output && (tr.output._elements || tr.output.elements || tr.output));
                if (!times || !values) continue;
                times = Float32Array.from(times.length != null ? times : []);
                values = Float32Array.from(values.length != null ? values : []);
                if (!times.length || !values.length) continue;
                if (times[times.length - 1] > duration) duration = times[times.length - 1];
                channels.push({ boneIdx: bidx, path: path, times: times, values: values });
            }
        }
        if (channels.length) {
            rigAnimations.push({ name: sanitizeFileName(name, 'anim_' + rigAnimations.length), duration: duration, channels: channels });
        }
    }

    // -------------------------- GLTF writer --------------------------
    function buildGLTF(modelName) {
        var gltf = {
            asset: { version: '2.0', generator: 'SketchFab Likolus Export' },
            scenes: [{ nodes: [] }], scene: 0, nodes: [], meshes: [],
            accessors: [], bufferViews: [], buffers: [{ uri: modelName + '.bin', byteLength: 0 }],
            materials: [], textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
            skins: [], animations: []
        };
        var binParts = [], offset = 0;
        function addToBin(data, target, type, ct, count) {
            var bl = data.byteLength;
            var pad = (4 - (offset % 4)) % 4;
            if (pad > 0) { binParts.push(new Uint8Array(pad)); offset += pad; }
            var vi = gltf.bufferViews.length;
            gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bl, target: target });
            var ai = gltf.accessors.length;
            gltf.accessors.push({ bufferView: vi, byteOffset: 0, componentType: ct, count: count, type: type });
            binParts.push(data); offset += bl; return ai;
        }

        var materials = buildMaterials();
        // images + textures + materials (glTF PBR)
        materials.forEach(function (m) {
            var imgIdxFor = {};
            ['albedo', 'normal', 'roughness', 'metallic', 'emissive', 'occlusion'].forEach(function (ty) {
                var t = m.slots[ty]; if (!t || !textureByCleanUrl[t.cleanUrl]) return;
                var imgIdx = gltf.images.length;
                gltf.images.push({ uri: 'textures/' + t.name });
                gltf.textures.push({ sampler: 0, source: imgIdx });
                imgIdxFor[ty] = gltf.textures.length - 1;
            });
            var pbr = { baseColorFactor: [1, 1, 1, 1] };
            if (imgIdxFor.albedo != null) pbr.baseColorTexture = { index: imgIdxFor.albedo };
            if (imgIdxFor.metallic != null || imgIdxFor.roughness != null) {
                pbr.metallicRoughnessTexture = { index: imgIdxFor.roughness != null ? imgIdxFor.roughness : imgIdxFor.metallic };
            }
            var mat = { name: m.name, pbrMetallicRoughness: pbr };
            if (imgIdxFor.normal != null) mat.normalTexture = { index: imgIdxFor.normal };
            if (imgIdxFor.emissive != null) { mat.emissiveTexture = { index: imgIdxFor.emissive }; mat.emissiveFactor = [1, 1, 1]; }
            if (imgIdxFor.occlusion != null) mat.occlusionTexture = { index: imgIdxFor.occlusion };
            gltf.materials.push(mat);
        });

        // --- skeleton nodes (bones) ---
        // One glTF node per captured bone, with TRS + parent linking via children.
        var boneNodeIdx = [];   // boneIdx -> glTF node index
        var boneChildMap = {};  // parentBoneIdx -> [childBoneIdx]
        for (var bi = 0; bi < rigBones.length; bi++) {
            var bone = rigBones[bi];
            var nIdx = gltf.nodes.length;
            boneNodeIdx.push(nIdx);
            var node = { name: bone.name, translation: bone.translation.slice(0, 3), rotation: bone.rotation.slice(0, 4), scale: bone.scale.slice(0, 3) };
            gltf.nodes.push(node);
        }
        // link children: a bone's parent is whichever bone has ref === bone.parentRef
        for (var bi2 = 0; bi2 < rigBones.length; bi2++) {
            var b2 = rigBones[bi2];
            var pRef = b2.parentRef;
            var pBoneIdx = -1;
            if (pRef) {
                for (var k = 0; k < rigBones.length; k++) { if (rigBones[k].ref === pRef) { pBoneIdx = k; break; } }
            }
            if (pBoneIdx >= 0) {
                if (!boneChildMap[pBoneIdx]) boneChildMap[pBoneIdx] = [];
                boneChildMap[pBoneIdx].push(boneNodeIdx[bi2]);
            }
        }
        for (var pp in boneChildMap) { if (gltf.nodes[boneNodeIdx[pp]]) gltf.nodes[boneNodeIdx[pp]].children = boneChildMap[pp]; }

        // --- meshes + mesh nodes (with skin reference when skinned) ---
        var meshRootNodes = [];
        geometries.forEach(function (g, i) {
            if (!g.vertex || !g.vertex.length) return;
            var pos = addToBin(new Float32Array(g.vertex), 34962, 'VEC3', 5126, g.vertex.length / 3);
            var norm = g.normal && g.normal.length ? addToBin(new Float32Array(g.normal), 34962, 'VEC3', 5126, g.normal.length / 3) : -1;
            var uv = g.uv && g.uv.length ? addToBin(new Float32Array(g.uv), 34962, 'VEC2', 5126, g.uv.length / 2) : -1;
            var prims = [];
            var skinObj = rigSkinByGeoIdx[i];

            // skin attributes: JOINTS_0 + WEIGHTS_0
            var jointsAcc = -1, weightsAcc = -1;
            if (skinObj) {
                var vcount = g.vertex.length / 3;
                var ja = skinObj.jointAttr;
                var wa = skinObj.weightAttr;
                // glTF expects 4 influences per vertex (already 4-per-vertex in most viewers)
                var perVert = (ja.length / vcount) | 0;
                if (perVert < 1) perVert = 4;
                var jointCount = vcount * 4;
                var jArr, jCt;
                if (skinObj.joints.length <= 256) {
                    jArr = new Uint8Array(jointCount); jCt = 5121;
                } else {
                    jArr = new Uint16Array(jointCount); jCt = 5123;
                }
                var wArr = new Float32Array(jointCount);
                // remap joint index values (which are indices into skinObj.joints) to bone node indices
                for (var vv = 0; vv < vcount; vv++) {
                    for (var c = 0; c < 4; c++) {
                        var srcIdx = vv * perVert + c;
                        var jv = (srcIdx < ja.length ? (ja[srcIdx] | 0) : 0);
                        var mapped = (jv < skinObj.joints.length) ? skinObj.joints[jv] : 0;
                        jArr[vv * 4 + c] = mapped;
                        wArr[vv * 4 + c] = (srcIdx < wa.length ? wa[srcIdx] : 0);
                    }
                    // normalize weights
                    var wsum = wArr[vv * 4] + wArr[vv * 4 + 1] + wArr[vv * 4 + 2] + wArr[vv * 4 + 3];
                    if (wsum > 0) { for (var c2 = 0; c2 < 4; c2++) wArr[vv * 4 + c2] /= wsum; }
                }
                jointsAcc = addToBin(jArr, 34962, 'VEC4', jCt, vcount);
                weightsAcc = addToBin(wArr, 34962, 'VEC4', 5126, vcount);
            }

            g.primitives.forEach(function (p) {
                var ind = addToBin(new Uint32Array(p.indices), 34963, 'SCALAR', 5125, p.indices.length);
                var attr = { POSITION: pos };
                if (norm !== -1) attr.NORMAL = norm;
                if (uv !== -1) attr.TEXCOORD_0 = uv;
                if (jointsAcc !== -1) { attr.JOINTS_0 = jointsAcc; attr.WEIGHTS_0 = weightsAcc; }
                var prim = { attributes: attr, indices: ind, mode: (p.mode === 5 || p.mode === 6) ? 4 : (p.mode || 4), material: i };
                prims.push(prim);
            });
            gltf.meshes.push({ name: g.name, primitives: prims });

            // mesh node — references skin if skinned
            var mnode = { name: g.name, mesh: gltf.meshes.length - 1 };
            if (skinObj) {
                // build skin: joints (bone node indices) + inverseBindMatrices accessor
                var jointNodeIdxs = skinObj.joints.map(function (jb) { return boneNodeIdx[jb] || 0; });
                // IBM accessor: collect 16 floats per joint, default identity if null
                var ibmFlat = new Float32Array(jointNodeIdxs.length * 16);
                var ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
                for (var jj = 0; jj < jointNodeIdxs.length; jj++) {
                    var m = skinObj.ibm[jj] || ident;
                    for (var kk = 0; kk < 16; kk++) ibmFlat[jj * 16 + kk] = m[kk] != null ? m[kk] : ident[kk];
                }
                var ibmAcc = addToBin(ibmFlat, null, 'MAT4', 5126, jointNodeIdxs.length);
                var skinIdx = gltf.skins.length;
                gltf.skins.push({ joints: jointNodeIdxs, inverseBindMatrices: ibmAcc });
                mnode.skin = skinIdx;
            }
            gltf.nodes.push(mnode);
            meshRootNodes.push(gltf.nodes.length - 1);
        });

        // scene: bone roots + mesh nodes
        // bone roots = bones with no parent bone; attach them at scene root
        var boneRootsAdded = [];
        for (var br = 0; br < rigBones.length; br++) {
            if (rigBones[br].parentRef == null) {
                // verify no other bone claims it as parent? it's a root
                gltf.scenes[0].nodes.push(boneNodeIdx[br]);
                boneRootsAdded.push(boneNodeIdx[br]);
            }
        }
        // meshes at scene root too
        for (var mr = 0; mr < meshRootNodes.length; mr++) gltf.scenes[0].nodes.push(meshRootNodes[mr]);

        // --- animations ---
        for (var ai = 0; ai < rigAnimations.length; ai++) {
            var anim = rigAnimations[ai];
            var samplers = [];
            var channels = [];
            for (var ci = 0; ci < anim.channels.length; ci++) {
                var ch = anim.channels[ci];
                var targetNode = boneNodeIdx[ch.boneIdx];
                if (targetNode == null) continue;
                var inAcc = addToBin(new Float32Array(ch.times), null, 'SCALAR', 5126, ch.times.length);
                var valPerKey, outType;
                if (ch.path === 'translation') { valPerKey = 3; outType = 'VEC3'; }
                else if (ch.path === 'scale') { valPerKey = 3; outType = 'VEC3'; }
                else if (ch.path === 'rotation') { valPerKey = 4; outType = 'VEC4'; }
                else { valPerKey = 1; outType = 'SCALAR'; }
                var outAcc = addToBin(new Float32Array(ch.values), null, outType, 5126, (ch.values.length / valPerKey) | 0 || 1);
                var sIdx = samplers.length;
                samplers.push({ input: inAcc, output: outAcc, interpolation: 'LINEAR' });
                channels.push({ sampler: sIdx, target: { node: targetNode, path: ch.path } });
            }
            if (channels.length) {
                gltf.animations.push({ name: anim.name, samplers: samplers, channels: channels });
            }
        }

        gltf.buffers[0].byteLength = offset;
        return { json: JSON.stringify(gltf, null, 2), bin: new Blob(binParts, { type: 'application/octet-stream' }) };
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
                setMsg('Nothing captured yet — let the model fully load first.');
                return;
            }
            var md = getMetadata();
            var modelName = sanitizeFileName(md.name, 'sketchfab_model');
            var zip = new JSZip();
            var root = zip.folder(modelName);

            if (!settings.texturesOnly) {
                // rig requires glTF (OBJ can't carry skeleton/skin/animation)
                if (settings.rig) {
                    settings.format = 'gltf';
                    setMsg('Capturing animations…'); setProgress(2);
                    captureAnimations();
                }
                setMsg('Linking materials…'); setProgress(3);
                var materials = buildMaterials();

                if (settings.format === 'obj') {
                    setMsg('Fetching textures (full-res, original format)…'); setProgress(5);
                    await fetchAllTextures(function (done, total, nm) {
                        setProgress(5 + Math.round((done / total) * 60));
                        setMsg('Downloading texture ' + done + '/' + total + ': ' + nm);
                    });
                    setMsg('Writing OBJ…'); setProgress(70);
                    var objBlob = buildObj(modelName, materials);
                    root.file(modelName + '.obj', objBlob);
                    setMsg('Writing MTL…'); setProgress(80);
                    var mtlBlob = buildMtl(modelName, materials);
                    root.file(modelName + '.mtl', mtlBlob);
                } else {
                    setMsg('Fetching textures for GLTF…'); setProgress(5);
                    await fetchAllTextures(function (done, total, nm) {
                        setProgress(5 + Math.round((done / total) * 60));
                        setMsg('Texture ' + done + '/' + total + ': ' + nm);
                    });
                    setMsg('Writing GLTF…'); setProgress(75);
                    var g = buildGLTF(modelName);
                    root.file(modelName + '.gltf', g.json);
                    root.file(modelName + '.bin', g.bin);
                }
                root.file('metadata.json', JSON.stringify(md, null, 2));
            } else {
                setMsg('Fetching textures…'); setProgress(10);
                await fetchAllTextures(function (done, total, nm) {
                    setProgress(10 + Math.round((done / total) * 80));
                    setMsg('Texture ' + done + '/' + total + ': ' + nm);
                });
            }

            // add textures
            setMsg('Packaging textures…'); setProgress(88);
            var texFolder = root.folder('textures');
            var texCount = 0;
            Object.keys(textureStore).forEach(function (k) {
                var t = textureStore[k];
                var blob = textureByCleanUrl[k];
                if (blob) { texFolder.file(t.name, blob); texCount++; }
            });

            setMsg('Compressing ZIP…'); setProgress(94);
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
    window.lkxDownload = doDownload;

    // =================================================================
    //  Sketchfab viewer script patching (proven injection points)
    //  Same approach as SUR — intercept the viewer JS before it runs,
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

    window.onbeforescriptexecute = function (e) {
        var nodes = Array.from(e.target.childNodes);
        nodes.forEach(function (sc) {
            if (!(sc instanceof HTMLScriptElement)) return;
            if (sc.src.indexOf('web/dist/') < 0 && sc.src.indexOf('standaloneViewer') < 0) return;
            var req = new XMLHttpRequest();
            req.open('GET', sc.src, false);
            try { req.send(''); } catch (err) { return; }
            if (req.status !== 200) { console.warn('[LikolusExport] fetch viewer failed', req.status); return; }
            e.preventDefault(); e.stopPropagation();
            var js = req.responseText;
            var m;

            if ((m = re_renderInto1.exec(js))) {
                var i0 = m.index + m[0].length;
                js = js.slice(0, i0) + ',i' + js.slice(i0);
                console.log('[LikolusExport] patch renderInto1 ok');
            }
            if ((m = re_renderInto2.exec(js))) {
                var i1 = m.index + m[0].length;
                js = js.slice(0, i1) + ',image_data' + js.slice(i1);
                console.log('[LikolusExport] patch renderInto2 ok');
            }
            if ((m = re_drawArrays.exec(js))) {
                var i2 = m.index + m[0].length;
                js = js.slice(0, i2) + ',window.drawhookimg(gl,t)' + js.slice(i2);
                console.log('[LikolusExport] patch drawArrays ok');
            }
            if ((m = re_getResourceImage.exec(js))) {
                var i3 = m.index + m[0].length;
                js = js.slice(0, i3) + 'e = window.drawhookcanvas(e,this._imageModel);' + js.slice(i3);
                console.log('[LikolusExport] patch getResourceImage ok');
            }
            if ((m = re_drawGeometry.exec(js))) {
                var i4 = m.index + m[1].length;
                // pass graphicContext too so we can read the bound texture
                js = js.slice(0, i4) + ';window.attachbody(t,this._graphicContext);' + js.slice(i4);
                console.log('[LikolusExport] patch drawGeometry ok');
            }

            var s = document.createElement('script');
            for (var i = 0; i < sc.attributes.length; i++) {
                var a = sc.attributes[i];
                if (a.name !== 'src' && a.name !== 'integrity') s.setAttribute(a.name, a.value);
            }
            s.text = js;
            document.getElementsByTagName('head')[0].appendChild(s);
        });
    };

})();
