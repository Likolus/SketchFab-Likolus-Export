// Test that buildFBX now produces FBX with correct \x00\x01 name separators.
// Strategy: run the whole userscript in a vm sandbox with a fake window,
// then call window.buildFBX (the userscript attaches helpers to window).

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const scriptPath = '/home/z/my-project/sketchfab-likolus-export/SketchFabLikolusExport.user.js';
const src = fs.readFileSync(scriptPath, 'utf-8');

// Find the IIFE start
const iifeStart = src.indexOf('(function () {');
if (iifeStart < 0) { console.error('IIFE not found'); process.exit(1); }

// The IIFE body runs from the opening { to its matching }.
// But there are nested {} everywhere. We need a proper brace counter that
// skips strings, regexes, and comments. For simplicity, just take everything
// from the IIFE start to the end of file (the trailing ")()" or "();").
// The userscript ends with "})();\n" — so we just take the whole tail.
const tail = src.slice(iifeStart);

// Build a sandbox
const sandbox = {
    unsafeWindow: null, // will be set to sandbox itself below
    console: console,
    Date: Date,
    Math: Math,
    Float32Array: Float32Array,
    Float64Array: Float64Array,
    Uint8Array: Uint8Array,
    Uint16Array: Uint16Array,
    Uint32Array: Uint32Array,
    Int32Array: Int32Array,
    ArrayBuffer: ArrayBuffer,
    DataView: DataView,
    Blob: function(parts, opts) {
        this.size = parts ? parts.reduce((s, p) => s + (p.length || p.size || 0), 0) : 0;
        this.type = (opts && opts.type) || '';
        return this;
    },
    URL: { createObjectURL: () => 'blob://mock' },
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    location: { href: 'https://sketchfab.com/test' },
    setTimeout: () => 0,
    setInterval: () => 0,
    document: {
        body: { appendChild: () => {}, style: {} },
        createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {}, setAttribute: () => {}, classList: { add: () => {} } }),
        getElementById: () => null,
        addEventListener: () => {},
    },
    navigator: { userAgent: 'node-test' },
    MutationObserver: class {
        constructor(cb) { this.cb = cb; }
        observe() {}
        disconnect() {}
    },
    CustomEvent: function(name, opts) { this.type = name; this.detail = opts && opts.detail; },
    Event: function(name) { this.type = name; },
    Element: function() {},
    HTMLElement: function() {},
    FileReader: function() {},
    JSZip: function() {
        this.file = function() { return this; };
        this.generateAsync = async function() { return new sandbox.Blob(); };
    },
    saveAs: function() {},
    fetch: async function() { return { ok: false, status: 0 }; },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.unsafeWindow = sandbox;

const ctx = vm.createContext(sandbox);

// Run the IIFE. After it runs, buildFBX should be defined inside the closure
// but NOT accessible from outside. So we modify the approach: instead of
// extracting buildFBX, we inject a line at the end that exposes it.
// Find the last "})();" and replace with a hook.
const hook = '\n;globalThis.__buildFBX = (typeof buildFBX !== "undefined") ? buildFBX : null;';
const modified = tail.replace(/\}\)\(\);\s*$/, '') + hook + '\n})();\n';
// Actually simpler: strip the trailing })(); and append the hook, then re-add })()
const trimmedTail = tail.replace(/\}\)\(\);\s*$/, '');
const scriptToRun = trimmedTail + hook + '\n})();\n';

try {
    vm.runInContext(scriptToRun, ctx);
} catch (e) {
    console.error('Error running IIFE:', e.message);
    console.error(e.stack.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
}

const buildFBX = sandbox.__buildFBX;
if (typeof buildFBX !== 'function') {
    console.error('buildFBX not exposed. typeof:', typeof buildFBX);
    console.error('Available keys on sandbox:', Object.keys(sandbox).filter(k => typeof sandbox[k] === 'function').slice(0, 20));
    process.exit(1);
}
console.log('buildFBX exposed OK');

// Set up the captured state that buildFBX reads from closure.
// These were assigned inside the IIFE — we need to override them.
// Trick: the IIFE captured them as `var geometries`, `var materials` etc.
// We can't reassign those from outside. Instead, we need to add a hook
// INSIDE the IIFE that lets us set them. Let's use a different approach:
// patch the IIFE source to expose setters.

// Actually, easier: let's check what buildFBX looks like and whether it
// takes the data as arguments or reads from closure.
// From the source: "function buildFBX(modelName)" — takes only modelName.
// So it reads geometries/materials/textures from closure.

// We need to inject our test data. Let's re-run the IIFE with an extra
// preamble that sets up the data, then calls buildFBX.
// Strategy: run a second script in the same context that sets globals
// the IIFE will read. But the IIFE already ran. So we need to modify the
// source to expose the captured vars.

// Restart with a modified source that exposes setters
const sandbox2 = Object.assign({}, sandbox);
delete sandbox2.__buildFBX;
sandbox2.window = sandbox2;
sandbox2.globalThis = sandbox2;
const ctx2 = vm.createContext(sandbox2);

// Find the line "function buildFBX(modelName) {" and inject a hook BEFORE it
// that exposes the captured state.
// Better: append at the end of the IIFE (before the closing })()) a line
// that exposes buildFBX AND a function to set test data.
const hook2 = `
;globalThis.__lkx = {
    buildFBX: buildFBX,
    setGeometries: function(arr) { geometries = arr; },
    setTextureStore: function(obj) { textureStore = obj; },
    setTextureByCleanUrl: function(obj) { textureByCleanUrl = obj; },
    setRigBones: function(arr) { rigBones = arr; },
    setRigAnimations: function(arr) { rigAnimations = arr; },
    setRigSkinByGeoIdx: function(obj) { rigSkinByGeoIdx = obj; },
    setSettings: function(obj) { settings = obj; },
};
`;
const script2 = trimmedTail + hook2 + '\n})();\n';
try {
    vm.runInContext(script2, ctx2);
} catch (e) {
    console.error('Error running IIFE2:', e.message);
    console.error(e.stack.split('\n').slice(0, 8).join('\n'));
    process.exit(1);
}

const lkx = sandbox2.__lkx;
if (!lkx || typeof lkx.buildFBX !== 'function') {
    console.error('lkx hook failed');
    process.exit(1);
}
console.log('lkx hook OK; buildFBX =', typeof lkx.buildFBX);

// Set test data
lkx.setGeometries([{
    name: 'TestCube',
    rawName: 'TestCube',
    vertex: new Float32Array([
        -1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1,
        -1,-1, 1, 1,-1, 1, 1,1, 1, -1,1, 1
    ]),
    normal: new Float32Array([
        0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
        0,0, 1, 0,0, 1, 0,0, 1, 0,0, 1
    ]),
    uv: new Float32Array([
        0,0, 1,0, 1,1, 0,1,
        0,0, 1,0, 1,1, 0,1
    ]),
    primitives: [{ mode: 4, indices: new Uint16Array([
        0,1,2, 0,2,3,
        4,6,5, 4,7,6,
    ]) }],
    boundTexUrl: 'mock://tex/albedo.png'
}]);

lkx.setTextureStore({
    'mock://tex/albedo.png': { name: 'albedo.png', cleanUrl: 'mock://tex/albedo.png' }
});
lkx.setTextureByCleanUrl({ 'mock://tex/albedo.png': true });
lkx.setRigBones([]);
lkx.setRigAnimations([]);
lkx.setRigSkinByGeoIdx({});
lkx.setSettings({ scale: 1.0, flipUV: false, texturesOnly: false, rig: false });

// Build FBX
let result;
try {
    result = lkx.buildFBX('TestCube');
} catch (e) {
    console.error('buildFBX threw:', e.message);
    console.error(e.stack.split('\n').slice(0, 10).join('\n'));
    process.exit(1);
}
console.log('buildFBX returned. Keys:', Object.keys(result));
console.log('binary size:', result.binary ? result.binary.length : 'no binary');
console.log('meshCount:', result.meshCount);

// CRITICAL: scan binary for \x00\x01 separator (the fix)
const bin = result.binary;
const binBuf = Buffer.from(bin.buffer, bin.byteOffset, bin.length);
let sepCount = 0;
const sep = Buffer.from([0x00, 0x01]);
let idx = 0;
while (true) {
    idx = binBuf.indexOf(sep, idx);
    if (idx < 0) break;
    sepCount++;
    idx += 2;
}

// Count old-format remnants
let oldFmtCount = 0;
const oldFmts = ['Geometry::', 'Model::', 'Material::', 'Video::', 'Texture::', 'Deformer::', 'AnimStack::', 'AnimLayer::', 'AnimCurveNode::'];
for (const f of oldFmts) {
    const fb = Buffer.from(f, 'ascii');
    let i = 0;
    while (true) {
        i = binBuf.indexOf(fb, i);
        if (i < 0) break;
        oldFmtCount++;
        i += fb.length;
    }
}

console.log('\n=== CRITICAL CHECK ===');
console.log('New format (\\x00\\x01 separator) occurrences:', sepCount);
console.log('Old format (ClassName::name) remnants:', oldFmtCount);

if (sepCount > 0 && oldFmtCount === 0) {
    console.log('PASS: FBX now uses correct name separator');
    fs.writeFileSync('/home/z/my-project/sketchfab-likolus-export/_test_name_fix.fbx', binBuf);
    console.log('Test FBX written to _test_name_fix.fbx');
    // Also verify header
    console.log('FBX magic:', JSON.stringify(binBuf.slice(0, 23).toString('latin1')));
    console.log('FBX version:', binBuf.readUInt32LE(23));
} else if (oldFmtCount > 0) {
    console.log('FAIL: old format still present');
    process.exit(1);
} else {
    console.log('WARN: no separators found — buildFBX may have emitted 0 objects');
    process.exit(1);
}
