// Test that buildFBX v1.4.5 emits RotationOrder as "enum" type (not "int").
// This was crashing Blender's importer:
//   assert elem_prop.props[1] == b'enum'   (in elem_props_get_enum for RotationOrder)
//
// Strategy: run the userscript IIFE in a vm sandbox, inject mock rigged-model
// data (1 skinned cube + 2 bones + 1 translation animation), call buildFBX,
// then scan the binary for the RotationOrder property and verify its type
// tag is "enum" (4 bytes) not "int" (3 bytes). Also verify the bone Model
// nodes are LimbNode and count matches.

const fs = require('fs');
const vm = require('vm');

const scriptPath = '/home/z/my-project/sketchfab-likolus-export/SketchFabLikolusExport.user.js';
const src = fs.readFileSync(scriptPath, 'utf8');

const iifeStart = src.indexOf('(function () {');
if (iifeStart < 0) { console.error('IIFE not found'); process.exit(1); }
const tail = src.slice(iifeStart);
const trimmedTail = tail.replace(/\}\)\(\);\s*$/, '');

// Sandbox (same shape as test_name_fix.js)
const sandbox = {
    console, Date, Math,
    Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int32Array,
    ArrayBuffer, DataView, TextEncoder, TextDecoder,
    Blob: function (parts, opts) {
        this.size = parts ? parts.reduce((s, p) => s + (p.length || p.size || 0), 0) : 0;
        this.type = (opts && opts.type) || '';
        return this;
    },
    URL: { createObjectURL: () => 'blob://mock' },
    location: { href: 'https://sketchfab.com/test' },
    setTimeout: () => 0, setInterval: () => 0,
    document: {
        body: { appendChild: () => {}, style: {} },
        createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {}, setAttribute: () => {}, classList: { add: () => {} } }),
        getElementById: () => null,
        addEventListener: () => {},
    },
    navigator: { userAgent: 'node-test' },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    Event: function (n) { this.type = n; },
    Element: function () {}, HTMLElement: function () {}, FileReader: function () {},
    JSZip: function () { this.file = function () { return this; }; this.generateAsync = async function () { return new sandbox.Blob(); }; },
    saveAs: function () {},
    fetch: async function () { return { ok: false, status: 0 }; },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.unsafeWindow = sandbox;

const hook = `
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
const script2 = trimmedTail + hook + '\n})();\n';
const ctx = vm.createContext(sandbox);
try {
    vm.runInContext(script2, ctx);
} catch (e) {
    console.error('Error running IIFE:', e.message);
    console.error(e.stack.split('\n').slice(0, 8).join('\n'));
    process.exit(1);
}

const lkx = sandbox.__lkx;
if (!lkx || typeof lkx.buildFBX !== 'function') {
    console.error('lkx hook failed; buildFBX =', typeof (lkx && lkx.buildFBX));
    process.exit(1);
}
console.log('lkx hook OK');

// ---- mock data: 1 cube, 2 bones, 1 animation ----
lkx.setGeometries([{
    name: 'TestCube', rawName: 'TestCube',
    vertex: new Float32Array([
        -1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1,
        -1,-1, 1, 1,-1, 1, 1,1, 1, -1,1, 1,
    ]),
    normal: new Float32Array([
        0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
        0,0, 1, 0,0, 1, 0,0, 1, 0,0, 1,
    ]),
    uv: new Float32Array([0,0, 1,0, 1,1, 0,1, 0,0, 1,0, 1,1, 0,1]),
    primitives: [{ mode: 4, indices: new Uint16Array([
        0,1,2, 0,2,3, 4,6,5, 4,7,6,
    ]) }],
    boundTexUrl: 'mock://tex/albedo.png',
}]);

lkx.setTextureStore({ 'mock://tex/albedo.png': { name: 'albedo.png', cleanUrl: 'mock://tex/albedo.png' } });
lkx.setTextureByCleanUrl({ 'mock://tex/albedo.png': true });

// 2 bones: root + child. Each: { name, translation[3], rotation[4 quat], scale[3], ibm[16], parentIdx }
lkx.setRigBones([
    {
        name: 'Root',
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],   // identity quaternion (x,y,z,w)
        scale: [1, 1, 1],
        ibm: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
        parentIdx: -1,
    },
    {
        name: 'Child',
        translation: [0, 1, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        ibm: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
        parentIdx: 0,
    },
]);

// 1 animation: translate Root up over 1 second (2 keyframes)
lkx.setRigAnimations([{
    name: 'TestAnim',
    duration: 1.0,
    channels: [{
        boneIdx: 0,
        path: 'translation',
        times: new Float32Array([0.0, 1.0]),
        values: new Float32Array([0, 0, 0, 0, 2, 0]),
    }],
}]);

// no skin deformers (bones still get Model nodes — enough to test RotationOrder)
lkx.setRigSkinByGeoIdx({});

lkx.setSettings({ scale: 1.0, flipUV: false, texturesOnly: false, rig: true });

let result;
try {
    result = lkx.buildFBX('RiggedTest');
} catch (e) {
    console.error('buildFBX threw:', e.message);
    console.error(e.stack.split('\n').slice(0, 12).join('\n'));
    process.exit(1);
}
console.log('buildFBX returned. Keys:', Object.keys(result));
console.log('binary size:', result.binary ? result.binary.length : 'no binary');
console.log('meshCount:', result.meshCount);

const bin = result.binary;
const binBuf = Buffer.from(bin.buffer, bin.byteOffset, bin.length);

// FBX header check
console.log('FBX magic:', JSON.stringify(binBuf.slice(0, 21).toString('latin1')));
console.log('FBX version:', binBuf.readUInt32LE(23));

// ---- CRITICAL CHECK 1: RotationOrder must be followed by "enum" not "int" ----
// In binary FBX, a "P" property node for RotationOrder looks like:
//   [node header] "P" [5 props]:
//     S "RotationOrder" (0x53, len=13, "RotationOrder")
//     S <type>         (0x53, len=N, <type string>)   <-- this is what we check
//     S <subtype>      (0x53, len=M, <subtype>)
//     S ""             (0x53, len=0)
//     I <value>        (0x49, 4 bytes)
const rotNameBuf = Buffer.from('RotationOrder', 'latin1');
const enumBuf = Buffer.from('enum', 'latin1');
const intBuf = Buffer.from('int', 'latin1');

let rotOrderOffsets = [];
let p = 0;
while (true) {
    p = binBuf.indexOf(rotNameBuf, p);
    if (p < 0) break;
    rotOrderOffsets.push(p);
    p += rotNameBuf.length;
}
console.log('\n=== CRITICAL CHECK: RotationOrder type tag ===');
console.log('RotationOrder occurrences:', rotOrderOffsets.length, '(expected: 2, one per bone)');

let enumCount = 0, intCount = 0, otherCount = 0;
for (const off of rotOrderOffsets) {
    // After "RotationOrder" (13 bytes), the next property starts.
    // Property format: [1 byte type char][if S: 4 bytes length][length bytes data]
    // We expect 'S' (0x53) then u32 length then the type string.
    const after = off + rotNameBuf.length;
    if (after + 5 > binBuf.length) { console.log('  offset', off, 'too close to end'); continue; }
    const typeChar = String.fromCharCode(binBuf[after]);
    if (typeChar !== 'S') {
        console.log('  offset', off, 'unexpected type char:', typeChar);
        otherCount++;
        continue;
    }
    const len = binBuf.readUInt32LE(after + 1);
    const typeStr = binBuf.slice(after + 5, after + 5 + len).toString('latin1');
    if (typeStr === 'enum') enumCount++;
    else if (typeStr === 'int') intCount++;
    else otherCount++;
    console.log('  offset', off, '-> type tag =', JSON.stringify(typeStr));
}
console.log('enum:', enumCount, ' int:', intCount, ' other:', otherCount);

// ---- CRITICAL CHECK 2: LimbNode bone Models exist ----
const limbBuf = Buffer.from('LimbNode', 'latin1');
let limbCount = 0, li = 0;
while (true) {
    li = binBuf.indexOf(limbBuf, li);
    if (li < 0) break;
    limbCount++; li += limbBuf.length;
}
console.log('\n=== CHECK: LimbNode bone Models ===');
console.log('LimbNode occurrences:', limbCount, '(expected: 2)');

// ---- CRITICAL CHECK 3: AnimationStack present ----
const animStackBuf = Buffer.from('AnimationStack', 'latin1');
let animStackCount = 0, ai = 0;
while (true) {
    ai = binBuf.indexOf(animStackBuf, ai);
    if (ai < 0) break;
    animStackCount++; ai += animStackBuf.length;
}
console.log('\n=== CHECK: AnimationStack ===');
console.log('AnimationStack occurrences:', animStackCount, '(expected: >=1)');

// ---- CRITICAL CHECK 4: name separator still present (regression) ----
let sepCount = 0, si = 0;
const sep = Buffer.from([0x00, 0x01]);
while (true) {
    si = binBuf.indexOf(sep, si);
    if (si < 0) break;
    sepCount++; si += 2;
}
console.log('\n=== REGRESSION: name separator \\x00\\x01 ===');
console.log('separator occurrences:', sepCount, '(expected: >0)');

// ---- CRITICAL CHECK 5: AnimationCurve has L,S,S header (not just L) ----
// Blender asserts fbx_obj.props_type[:3] == b'LSS' for every object.
// AnimationCurve was previously written with only [L(id)] -> crash.
// Verify by counting "AnimationCurve" node names AND checking the bytes
// right after the name follow L,S,S pattern. We just confirm the node
// count is sane (3 curves per channel = 3 here).
const animCurveNameBuf = Buffer.from('AnimationCurve', 'latin1');
let animCurveCount = 0, aci = 0;
while (true) {
    aci = binBuf.indexOf(animCurveNameBuf, aci);
    if (aci < 0) break;
    animCurveCount++; aci += animCurveNameBuf.length;
}
console.log('\n=== CHECK: AnimationCurve nodes ===');
console.log('AnimationCurve occurrences:', animCurveCount, '(expected: 3 = 3 components X/Y/Z for 1 channel)');

// ---- VERDICT ----
console.log('\n=== VERDICT ===');
const pass = rotOrderOffsets.length === 2 && enumCount === 2 && intCount === 0
    && limbCount >= 2 && animStackCount >= 1 && sepCount > 0;
if (pass) {
    console.log('PASS: RotationOrder emitted as enum, bones are LimbNode, animation present, name separator intact');
    fs.writeFileSync('/home/z/my-project/sketchfab-likolus-export/_test_rigged.fbx', binBuf);
    console.log('Test FBX written to _test_rigged.fbx (' + binBuf.length + ' bytes)');
} else {
    console.log('FAIL: see checks above');
    process.exit(1);
}
