// Render pipeline tests — run with `npm test` (Node 18+, no dependencies).
//
// Snapshot tests hash the full output buffer for a fixed synthetic image +
// seeded RNG. If a change to render.js is INTENDED to alter output, review
// it in Photoshop, then regenerate with:  npm run test:update

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../render.js");

// ---------- Fixtures ----------

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Horizontal red ramp, vertical green ramp, XOR-pattern blue — every
// tone/color path gets exercised somewhere in the frame.
function makeSrc(w, h, components = 4) {
  const data = new Uint8Array(w * h * components);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * components;
      data[i] = (x * 255 / w) | 0;
      data[i + 1] = (y * 255 / h) | 0;
      data[i + 2] = ((x ^ y) * 7) & 255;
      if (components === 4) data[i + 3] = 255;
    }
  }
  return { width: w, height: h, components, data };
}

// Mirrors the panel's default-ish settings with every FX toggle off.
const BASE = {
  colorMode: "ramp", cellSize: 6, fillWidth: 0.5, jitter: 0, dropout: 0, asciiCharset: " .:-=+*#%@",
  brightness: 1, contrast: 1, gamma: 1, threshold: 0, whiteClip: 100, posterize: 0, posterizeStyle: "uniform",
  invert: false, bgColor: { r: 6, g: 10, b: 6 }, glowAmount: 0, glowSpread: 4,
  scanEnable: false, scanIntensity: 0.3, scanSpacing: 3, caEnable: false, caShift: 3,
  curveEnable: false, curveAmount: 0.4, noiseEnable: false, noiseAmount: 0.1,
  trackingEnable: false, trackingAmount: 10, vignette: 0, vignetteReach: 0.8, bezelEnable: false, bezelWidth: 5,
  rampStops: [{ pos: 0.0, color: "#031003" }, { pos: 0.4, color: "#ff3ec8" }, { pos: 1.0, color: "#81d7ff" }]
};

function render(mode, overrides = {}, seed = 1234) {
  return R.buildPhosphorBufferJS(makeSrc(97, 61), { ...BASE, ...overrides }, mode, mulberry32(seed));
}

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

// ---------- Snapshots ----------

const SNAP_FILE = path.join(__dirname, "__snapshots__", "render.json");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";
const stored = fs.existsSync(SNAP_FILE) ? JSON.parse(fs.readFileSync(SNAP_FILE, "utf8")) : {};
const fresh = {};

const SNAPSHOT_CASES = {};
for (const mode of ["bars", "dots", "blocks", "lines", "ascii"]) {
  SNAPSHOT_CASES[`${mode} ramp`] = [mode, {}];
  SNAPSHOT_CASES[`${mode} original`] = [mode, { colorMode: "original" }];
}
for (const style of ["uniform", "bayer", "diffuse", "perchannel"]) {
  SNAPSHOT_CASES[`posterize ${style}`] = ["dots", { posterize: 4, posterizeStyle: style }];
}
Object.assign(SNAPSHOT_CASES, {
  "jitter + dropout": ["blocks", { jitter: 0.5, dropout: 0.3 }],
  "tone stack": ["dots", { invert: true, gamma: 1.6, contrast: 1.4, brightness: 1.2, whiteClip: 80, threshold: 40 }],
  "fx glow": ["dots", { glowAmount: 0.6, glowSpread: 5 }],
  "fx scanlines": ["dots", { scanEnable: true }],
  "fx chromatic aberration": ["dots", { caEnable: true }],
  "fx curvature": ["dots", { curveEnable: true }],
  "fx noise": ["dots", { noiseEnable: true }],
  "fx tracking": ["dots", { trackingEnable: true }],
  "fx vignette": ["dots", { vignette: 0.7 }],
  "fx bezel": ["dots", { bezelEnable: true }],
  "fx everything": ["ascii", {
    glowAmount: 0.4, scanEnable: true, caEnable: true, curveEnable: true, noiseEnable: true,
    trackingEnable: true, vignette: 0.7, bezelEnable: true, jitter: 0.3, dropout: 0.2
  }]
});

test.describe("snapshots", () => {
  for (const [name, [mode, overrides]] of Object.entries(SNAPSHOT_CASES)) {
    test(name, () => {
      const hash = sha(render(mode, overrides));
      fresh[name] = hash;
      if (UPDATE || !(name in stored)) return;
      assert.equal(hash, stored[name], `output changed for "${name}" — if intended, run: npm run test:update`);
    });
  }
  test.after(() => {
    const missing = Object.keys(fresh).some(k => !(k in stored));
    if (UPDATE || missing) {
      fs.mkdirSync(path.dirname(SNAP_FILE), { recursive: true });
      fs.writeFileSync(SNAP_FILE, JSON.stringify(UPDATE ? fresh : { ...stored, ...fresh }, null, 2) + "\n");
    }
  });
});

// ---------- Behavior ----------

test("same seed gives identical output; different seed differs when randomness is on", () => {
  const o = { noiseEnable: true, jitter: 0.4 };
  assert.deepEqual(render("dots", o, 7), render("dots", o, 7));
  assert.notDeepEqual(render("dots", o, 7), render("dots", o, 8));
});

test("output is RGBA at source resolution for 3- and 4-channel sources", () => {
  for (const comps of [3, 4]) {
    const out = R.buildPhosphorBufferJS(makeSrc(20, 10, comps), BASE, "dots", mulberry32(1));
    assert.equal(out.length, 20 * 10 * 4);
    for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
  }
});

test("ramp: sorts unordered stops, interpolates, clamps ends", () => {
  const ramp = R.prepareRamp([{ pos: 1, color: "#ffffff" }, { pos: 0, color: "#000000" }]);
  assert.deepEqual(R.getRampColor(ramp, 0.5), { r: 127.5, g: 127.5, b: 127.5 });
  assert.deepEqual(R.getRampColor(ramp, -1), { r: 0, g: 0, b: 0 });
  assert.deepEqual(R.getRampColor(ramp, 2), { r: 255, g: 255, b: 255 });
  assert.deepEqual(R.getRampColor([], 0.5), { r: 255, g: 255, b: 255 });
});

test("ramp: returned colors are fresh objects (per-channel posterize mutates them)", () => {
  const ramp = R.prepareRamp([{ pos: 0, color: "#102030" }]);
  const c = R.getRampColor(ramp, 0);
  c.r = 0;
  assert.equal(R.getRampColor(ramp, 0).r, 0x10);
});

test("hex <-> rgb round trip and clamping", () => {
  assert.deepEqual(R.hexToRgb("#81d7ff"), { r: 0x81, g: 0xd7, b: 0xff });
  assert.equal(R.rgbToHexStr(0x81, 0xd7, 0xff), "#81d7ff");
  assert.equal(R.rgbToHexStr(-5, 300, 12.6), "#00ff0d");
});

test("applyTone is identity at neutral settings and inverts when asked", () => {
  const s = { brightness: 1, contrast: 1, gamma: 1, whiteClip: 100, invert: false };
  for (const v of [0, 1, 64, 128, 200, 255]) assert.ok(Math.abs(R.applyTone(v, s) - v) < 1e-9);
  assert.ok(Math.abs(R.applyTone(200, { ...s, invert: true }) - 55) < 1e-9);
});

test("uniform posterize produces at most steps+1 distinct levels", () => {
  const s = { posterize: 3, posterizeStyle: "uniform" };
  const levels = new Set();
  for (let v = 0; v <= 255; v++) levels.add(R.applyPosterize(v, s, 0, 0, { carry: 0 }));
  assert.ok(levels.size <= 4, `got ${levels.size} levels`);
});

// Regression: CA shipped twice with a green cast — red/blue were averaged
// with (or sampled past) dark background while green stayed untouched, so
// sparse bright marks went green as shift increased.
test("chromatic aberration does not green-shift a white mark", () => {
  const w = 40, h = 3;
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 18; x < 20; x++) buf.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 4);
  }
  for (const shift of [1, 4, 12]) {
    const b = new Uint8Array(buf);
    R.applyChromaticAberration(b, w, h, shift);
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < b.length; i += 4) { sr += b[i]; sg += b[i + 1]; sb += b[i + 2]; }
    assert.ok(sr >= sg && sb >= sg, `shift ${shift}: r=${sr} g=${sg} b=${sb}`);
    // The mark itself stays pure white.
    const i = (1 * w + 18) * 4;
    assert.deepEqual([...b.slice(i, i + 3)], [255, 255, 255]);
  }
});

test("bezel blacks out exactly the border", () => {
  const w = 10, h = 8, buf = new Uint8Array(w * h * 4).fill(200);
  R.applyBezel(buf, w, h, 2);
  const px = (x, y) => buf[(y * w + x) * 4];
  assert.equal(px(0, 0), 0);
  assert.equal(px(1, 4), 0);
  assert.equal(px(2, 2), 200);
  assert.equal(px(7, 5), 200);
  assert.equal(px(8, 5), 0);
});

test("fast-preview downscale/upscale round trip preserves dimensions", () => {
  const src = makeSrc(101, 57);
  const small = R.downscaleSource(src, 0.4);
  assert.equal(small.width, 40);
  assert.equal(small.height, 23);
  assert.equal(R.downscaleSource(src, 1), src);
  const big = R.upscaleBuffer(small.data, small.width, small.height, src.width, src.height);
  assert.equal(big.length, src.width * src.height * 4);
});
