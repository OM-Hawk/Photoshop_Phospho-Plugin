// index.js — Phosphor // Scan, UXP plugin core
// Uses Photoshop's UXP `photoshop` and `imaging` modules.
// Docs: https://developer.adobe.com/photoshop/uxp/2022/ps_reference/

const { app, core, imaging } = require("photoshop");
const { executeAsModal } = core;
const { FONT_5X7, FONT_WIDTH, FONT_HEIGHT } = require("./font5x7.js");

// ---------- WASM core (optional acceleration) ----------
// UXP supports WebAssembly but not Web Workers, so this speeds up the
// per-pixel render/post-effect loops without making the panel non-
// blocking — slider drags still pause briefly during a render, just for
// less time than the pure-JS path. If the wasm/ folder isn't present or
// loading fails for any reason, wasmReady stays false and every call
// transparently falls back to the original JS implementation below.
let wasmModule = null;
let wasmReady = false;

const MODE_TO_INT = { bars: 0, dots: 1, blocks: 2, lines: 3 };

async function initWasm() {
  try {
    const mod = await import("./wasm/phosphor_core.js");
    await mod.default(); // wasm-bindgen's init function loads the .wasm binary
    wasmModule = mod;
    wasmReady = true;
    console.log("Phosphor WASM core loaded.");
  } catch (err) {
    console.warn("WASM core unavailable, using JS fallback:", err);
    wasmReady = false;
  }
}
initWasm();

// ---------- UI state ----------
let currentMode = "bars";
let rampStops = [
  { pos: 0.0, color: "#031003" },
  { pos: 1.0, color: "#5fff5a" }
];

// Cached full-res source pixels — read once per document/session, reused
// across every preview tick so we're not re-reading the whole doc on
// every debounce fire. Invalidated if the active document changes.
let cachedSrc = null;
let cachedSrcDocId = null;

// Tracks the persistent preview layer so updates overwrite it in place
// instead of stacking a new layer per slider tick.
let previewLayerId = null;

let previewDebounceTimer = null;
const PREVIEW_DEBOUNCE_MS = 300;

let bgColorHex = "#060a06";

const el = {};
[
  "cellSize", "fillWidth", "jitter", "dropout", "asciiCharset",
  "brightness", "contrast", "gamma", "threshold", "whiteClip", "posterize", "invert",
  "glowAmount", "glowSpread",
  "scanEnable", "scanIntensity", "scanSpacing",
  "caEnable", "caShift",
  "curveEnable", "curveAmount",
  "noiseEnable", "noiseAmount",
  "trackingEnable", "trackingAmount",
  "vignette", "vignetteReach",
  "bezelEnable", "bezelWidth"
].forEach(id => (el[id] = document.getElementById(id)));

const statusEl = document.getElementById("status");
const rampStopsEl = document.getElementById("rampStops");
const rampPreviewEl = document.getElementById("rampPreview");

// ---------- Section collapse ----------
document.querySelectorAll(".section-head").forEach(head => {
  head.addEventListener("click", () => head.parentElement.classList.toggle("open"));
});

// ---------- Mode buttons ----------
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset.mode;
    document.getElementById("asciiCharsetRow").style.display = currentMode === "ascii" ? "flex" : "none";
    schedulePreview();
  });
});

// ---------- Live value labels ----------
function syncLabels() {
  document.getElementById("cellSizeVal").textContent = el.cellSize.value;
  document.getElementById("fillWidthVal").textContent = el.fillWidth.value;
  document.getElementById("jitterVal").textContent = el.jitter.value;
  document.getElementById("dropoutVal").textContent = el.dropout.value;
  document.getElementById("brightnessVal").textContent = el.brightness.value;
  document.getElementById("contrastVal").textContent = el.contrast.value;
  document.getElementById("gammaVal").textContent = (+el.gamma.value / 100).toFixed(2);
  document.getElementById("thresholdVal").textContent = el.threshold.value;
  document.getElementById("whiteClipVal").textContent = el.whiteClip.value;
  document.getElementById("posterizeVal").textContent = el.posterize.value;
  document.getElementById("glowAmountVal").textContent = el.glowAmount.value;
  document.getElementById("glowSpreadVal").textContent = el.glowSpread.value;
  document.getElementById("scanIntensityVal").textContent = el.scanIntensity.value;
  document.getElementById("scanSpacingVal").textContent = el.scanSpacing.value;
  document.getElementById("caShiftVal").textContent = el.caShift.value;
  document.getElementById("curveAmountVal").textContent = el.curveAmount.value;
  document.getElementById("noiseAmountVal").textContent = el.noiseAmount.value;
  document.getElementById("trackingAmountVal").textContent = el.trackingAmount.value;
  document.getElementById("vignetteVal").textContent = el.vignette.value;
  document.getElementById("vignetteReachVal").textContent = el.vignetteReach.value;
  document.getElementById("bezelWidthVal").textContent = el.bezelWidth.value;
}
Object.values(el).forEach(input => {
  if (!input) return;
  if (input.type === "range") {
    input.addEventListener("input", () => { syncLabels(); schedulePreview(); });
  } else if (input.type === "color" || input.type === "checkbox" || input.tagName === "SELECT") {
    input.addEventListener("input", () => { schedulePreview(); });
    input.addEventListener("change", () => { schedulePreview(); });
  }
});
syncLabels();

// ---------- Color ramp UI ----------
function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return {
    r: parseInt(v.substring(0, 2), 16),
    g: parseInt(v.substring(2, 4), 16),
    b: parseInt(v.substring(4, 6), 16)
  };
}
function rgbToHexStr(r, g, b) {
  return "#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

// ---------- Custom RGB color picker popover ----------
// UXP's webview renders <input type="color"> as a plain text fallback
// instead of the OS-native picker, so we build our own small popover with
// RGB sliders + a hex field and attach it to any swatch button on demand.
let activePopover = null;

function closeColorPopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
}

function openColorPicker(anchorEl, initialHex, onChange) {
  closeColorPopover();

  const popover = document.createElement("div");
  popover.className = "color-popover open";
  const rgb = hexToRgb(initialHex);

  popover.innerHTML = `
    <div class="preview-swatch" id="pickerPreview" style="background:${initialHex};"></div>
    <div class="channel-row"><span>R</span><input type="range" min="0" max="255" value="${rgb.r}" data-ch="r"><input type="number" min="0" max="255" value="${rgb.r}" data-ch="r"></div>
    <div class="channel-row"><span>G</span><input type="range" min="0" max="255" value="${rgb.g}" data-ch="g"><input type="number" min="0" max="255" value="${rgb.g}" data-ch="g"></div>
    <div class="channel-row"><span>B</span><input type="range" min="0" max="255" value="${rgb.b}" data-ch="b"><input type="number" min="0" max="255" value="${rgb.b}" data-ch="b"></div>
    <div class="hex-row"><span>#</span><input type="text" id="pickerHex" value="${initialHex.replace('#','')}" maxlength="6"></div>
    <button class="close-btn">Done</button>
  `;

  // Append to <body> and position via fixed coordinates from the anchor's
  // bounding rect — appending inside the panel's scrollable/clipped
  // sections (most have overflow:hidden) was causing the popover to get
  // visually cut off or squashed depending on where the swatch sat.
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.min(rect.left, window.innerWidth - 190)}px`;
  activePopover = popover;

  const preview = popover.querySelector("#pickerPreview");
  const hexInput = popover.querySelector("#pickerHex");
  const channelInputs = popover.querySelectorAll("[data-ch]");

  let current = { ...rgb };

  function applyChange() {
    const hex = rgbToHexStr(current.r, current.g, current.b);
    preview.style.background = hex;
    hexInput.value = hex.replace("#", "");
    onChange(hex);
  }

  channelInputs.forEach(inp => {
    inp.addEventListener("input", e => {
      const ch = e.target.dataset.ch;
      const val = Math.max(0, Math.min(255, +e.target.value || 0));
      current[ch] = val;
      // keep the paired range/number inputs in sync
      popover.querySelectorAll(`[data-ch="${ch}"]`).forEach(other => { if (other !== e.target) other.value = val; });
      applyChange();
    });
  });

  hexInput.addEventListener("input", e => {
    const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
    if (v.length === 6) {
      current = hexToRgb("#" + v);
      popover.querySelectorAll("[data-ch]").forEach(inp => { inp.value = current[inp.dataset.ch]; });
      applyChange();
    }
  });

  popover.querySelector(".close-btn").addEventListener("click", () => closeColorPopover());
}

// Click-away closes any open popover
document.addEventListener("click", e => {
  if (activePopover && !activePopover.contains(e.target) && !e.target.classList.contains("color-swatch-btn")) {
    closeColorPopover();
  }
});
function sortStops() {
  rampStops.sort((a, b) => a.pos - b.pos);
}
function getRampColor(t) {
  sortStops();
  if (rampStops.length === 0) return { r: 255, g: 255, b: 255 };
  if (t <= rampStops[0].pos) return hexToRgb(rampStops[0].color);
  if (t >= rampStops[rampStops.length - 1].pos) return hexToRgb(rampStops[rampStops.length - 1].color);
  for (let i = 0; i < rampStops.length - 1; i++) {
    const a = rampStops[i], b = rampStops[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const lt = b.pos === a.pos ? 0 : (t - a.pos) / (b.pos - a.pos);
      const ca = hexToRgb(a.color), cb = hexToRgb(b.color);
      return {
        r: ca.r + (cb.r - ca.r) * lt,
        g: ca.g + (cb.g - ca.g) * lt,
        b: ca.b + (cb.b - ca.b) * lt
      };
    }
  }
  return hexToRgb(rampStops[rampStops.length - 1].color);
}
function updateRampPreview() {
  sortStops();
  const stops = rampStops.map(s => `${s.color} ${(s.pos * 100).toFixed(0)}%`).join(", ");
  rampPreviewEl.style.background = `linear-gradient(90deg, ${stops})`;
}
function renderRampUI() {
  sortStops();
  rampStopsEl.innerHTML = "";
  rampStops.forEach((stop, i) => {
    const row = document.createElement("div");
    row.className = "ramp-stop-row";
    row.innerHTML = `
      <button class="color-swatch-btn ramp-color-btn" data-idx="${i}" style="background:${stop.color};"></button>
      <input type="range" min="0" max="100" value="${Math.round(stop.pos * 100)}" data-idx="${i}" class="ramp-pos">
      <button class="remove-stop" data-idx="${i}">✕</button>
    `;
    rampStopsEl.appendChild(row);
  });
  rampStopsEl.querySelectorAll(".ramp-color-btn").forEach(btn =>
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = +e.target.dataset.idx;
      openColorPicker(e.target, rampStops[idx].color, (newHex) => {
        rampStops[idx].color = newHex;
        e.target.style.background = newHex;
        updateRampPreview();
        schedulePreview();
      });
    })
  );
  rampStopsEl.querySelectorAll(".ramp-pos").forEach(inp =>
    inp.addEventListener("input", e => {
      rampStops[+e.target.dataset.idx].pos = +e.target.value / 100;
      updateRampPreview();
      schedulePreview();
    })
  );
  rampStopsEl.querySelectorAll(".remove-stop").forEach(btn =>
    btn.addEventListener("click", e => {
      if (rampStops.length <= 2) return;
      rampStops.splice(+e.target.dataset.idx, 1);
      renderRampUI();
      updateRampPreview();
      schedulePreview();
    })
  );
  updateRampPreview();
}
document.getElementById("addStopBtn").addEventListener("click", () => {
  rampStops.push({ pos: 0.5, color: "#ffffff" });
  renderRampUI();
  schedulePreview();
});
renderRampUI();

// ---------- Background color swatch ----------
const bgColorSwatch = document.getElementById("bgColorSwatch");
const bgColorHexLabel = document.getElementById("bgColorHexLabel");
bgColorSwatch.addEventListener("click", e => {
  e.stopPropagation();
  openColorPicker(bgColorSwatch, bgColorHex, (newHex) => {
    bgColorHex = newHex;
    bgColorSwatch.style.background = newHex;
    bgColorHexLabel.textContent = newHex.toUpperCase();
    schedulePreview();
  });
});

// ---------- Settings getter ----------
function getSettings() {
  return {
    cellSize: +el.cellSize.value,
    fillWidth: +el.fillWidth.value / 100,
    jitter: +el.jitter.value / 100,
    dropout: +el.dropout.value / 100,
    asciiCharset: el.asciiCharset.value,
    brightness: +el.brightness.value / 100,
    contrast: +el.contrast.value / 100,
    gamma: +el.gamma.value / 100,
    threshold: +el.threshold.value,
    whiteClip: +el.whiteClip.value,
    posterize: +el.posterize.value,
    invert: el.invert.checked,
    bgColor: hexToRgb(bgColorHex),
    glowAmount: +el.glowAmount.value / 100,
    glowSpread: +el.glowSpread.value,
    scanEnable: el.scanEnable.checked,
    scanIntensity: +el.scanIntensity.value / 100,
    scanSpacing: +el.scanSpacing.value,
    caEnable: el.caEnable.checked,
    caShift: +el.caShift.value,
    curveEnable: el.curveEnable.checked,
    curveAmount: +el.curveAmount.value / 100,
    noiseEnable: el.noiseEnable.checked,
    noiseAmount: +el.noiseAmount.value / 100,
    trackingEnable: el.trackingEnable.checked,
    trackingAmount: +el.trackingAmount.value,
    vignette: +el.vignette.value / 100,
    vignetteReach: +el.vignetteReach.value / 100,
    bezelEnable: el.bezelEnable.checked,
    bezelWidth: +el.bezelWidth.value
  };
}

// ---------- Core pixel pipeline ----------
// Reads the active document's pixels via imaging.getPixels, applies the
// phosphor grid effect into a fresh buffer, and either previews (not yet
// wired to a live preview surface in v1) or commits to a new layer.

// NOTE: must be called from INSIDE executeAsModal. UXP treats the whole
// read+process+write sequence as one document-mutating operation — calling
// getPixels outside modal scope throws "only allowed from inside a modal
// scope" even though it's technically just a read.
async function getActiveDocumentPixelsModal(doc) {
  const pixelData = await imaging.getPixels({
    documentID: doc.id,
    sourceBounds: {
      left: 0,
      top: 0,
      right: doc.width,
      bottom: doc.height
    }
  });

  const imageData = await pixelData.imageData.getData({ chunky: true });
  const result = {
    width: pixelData.imageData.width,
    height: pixelData.imageData.height,
    components: pixelData.imageData.components,
    data: imageData,
    docId: doc.id
  };
  pixelData.imageData.dispose();
  return result;
}

function applyTone(raw, s) {
  let v = raw * s.brightness;
  v = (v - 128) * s.contrast + 128;
  v = Math.max(0, Math.min(255, v));
  v = 255 * Math.pow(v / 255, 1 / s.gamma);
  if (s.posterize > 0) {
    const steps = s.posterize;
    v = Math.round((v / 255) * steps) / steps * 255;
  }
  const whiteClipVal = (s.whiteClip / 100) * 255;
  if (whiteClipVal < 255 && whiteClipVal > 0) v = Math.min(v, whiteClipVal) * (255 / whiteClipVal);
  v = Math.max(0, Math.min(255, v));
  if (s.invert) v = 255 - v;
  return v;
}

// Draws a single 5x7 glyph into the output buffer at (cx, cy), scaled to
// fill roughly one cell. Used by ASCII mode since UXP's raw pixel buffer
// has no text rasterizer of its own.
function drawGlyph(out, w, h, ch, cx, cy, cellSize, col, alpha) {
  const glyph = FONT_5X7[ch];
  if (!glyph) return;
  const scaleX = cellSize / FONT_WIDTH;
  const scaleY = cellSize / FONT_HEIGHT;
  for (let row = 0; row < FONT_HEIGHT; row++) {
    const bits = glyph[row];
    for (let col_ = 0; col_ < FONT_WIDTH; col_++) {
      if (!(bits & (0x10 >> col_))) continue;
      const px0 = Math.floor(cx + col_ * scaleX);
      const py0 = Math.floor(cy + row * scaleY);
      const px1 = Math.ceil(cx + (col_ + 1) * scaleX);
      const py1 = Math.ceil(cy + (row + 1) * scaleY);
      for (let py = py0; py < py1; py++) {
        if (py < 0 || py >= h) continue;
        for (let px = px0; px < px1; px++) {
          if (px < 0 || px >= w) continue;
          const oIdx = (py * w + px) * 4;
          out[oIdx + 0] = col.r * alpha + out[oIdx + 0] * (1 - alpha);
          out[oIdx + 1] = col.g * alpha + out[oIdx + 1] * (1 - alpha);
          out[oIdx + 2] = col.b * alpha + out[oIdx + 2] * (1 - alpha);
          out[oIdx + 3] = 255;
        }
      }
    }
  }
}

// Builds the output pixel buffer at the SOURCE resolution (no downscale —
// we sample a coarser grid directly from the full-res source, same logic
// as the web tool's sampleCanvas approach but done with typed arrays).
// ---------- Dispatcher: WASM when available, JS fallback otherwise ----------
// ASCII mode always uses the JS path since glyph rendering wasn't ported.
// All other modes try WASM first and silently fall back to JS on any
// error, so a WASM bug never breaks the plugin outright.
function buildPhosphorBuffer(src, s, mode) {
  if (wasmReady && mode !== "ascii" && MODE_TO_INT[mode] !== undefined) {
    try {
      return buildPhosphorBufferWASM(src, s, mode);
    } catch (err) {
      console.warn("WASM render failed, falling back to JS for this frame:", err);
      return buildPhosphorBufferJS(src, s, mode);
    }
  }
  return buildPhosphorBufferJS(src, s, mode);
}

function buildPhosphorBufferWASM(src, s, mode) {
  sortStops();
  const positions = new Float64Array(rampStops.map(st => st.pos));
  const rs = new Uint8Array(rampStops.length);
  const gs = new Uint8Array(rampStops.length);
  const bs = new Uint8Array(rampStops.length);
  rampStops.forEach((st, i) => {
    const c = hexToRgb(st.color);
    rs[i] = c.r; gs[i] = c.g; bs[i] = c.b;
  });

  const seed = Math.floor(Math.random() * 0xffffffff) || 1;

  let out = wasmModule.build_phosphor_buffer(
    src.data,
    src.width,
    src.height,
    src.components,
    s.cellSize,
    s.fillWidth,
    s.jitter,
    s.dropout,
    s.brightness,
    s.contrast,
    s.gamma,
    s.threshold,
    s.whiteClip,
    s.posterize,
    s.invert,
    s.bgColor.r,
    s.bgColor.g,
    s.bgColor.b,
    positions,
    rs,
    gs,
    bs,
    MODE_TO_INT[mode],
    seed
  );

  // Post-effects, also WASM-accelerated. Each function mutates `out` in
  // place (wasm-bindgen passes typed arrays by reference for &mut [u8]),
  // mirroring the same conditional order as the JS pipeline.
  if (s.glowAmount > 0) {
    wasmModule.apply_glow(out, src.width, src.height, s.glowSpread, s.glowAmount);
  }
  if (s.caEnable && s.caShift > 0) {
    wasmModule.apply_chromatic_aberration(out, src.width, src.height, s.caShift);
  }
  if (s.noiseEnable && s.noiseAmount > 0) {
    wasmModule.apply_noise(out, src.width, src.height, s.noiseAmount, Math.floor(Math.random() * 0xffffffff) || 1);
  }
  if (s.trackingEnable && s.trackingAmount > 0) {
    wasmModule.apply_tracking_jitter(
      out, src.width, src.height, s.trackingAmount,
      s.bgColor.r, s.bgColor.g, s.bgColor.b,
      Math.floor(Math.random() * 0xffffffff) || 1
    );
  }
  if (s.vignette > 0) {
    wasmModule.apply_vignette(out, src.width, src.height, s.vignette, s.vignetteReach);
  }
  if (s.curveEnable && s.curveAmount > 0) {
    wasmModule.apply_curvature_shading(out, src.width, src.height, s.curveAmount);
  }
  if (s.scanEnable && s.scanIntensity > 0) {
    wasmModule.apply_scanlines(out, src.width, src.height, s.scanIntensity, s.scanSpacing);
  }
  if (s.bezelEnable && s.bezelWidth > 0) {
    wasmModule.apply_bezel(out, src.width, src.height, s.bezelWidth);
  }

  return out;
}

function buildPhosphorBufferJS(src, s, mode) {
  const { width: w, height: h, data, components } = src;
  const out = new Uint8Array(w * h * 4);

  for (let i = 0; i < w * h; i++) {
    out[i * 4 + 0] = s.bgColor.r;
    out[i * 4 + 1] = s.bgColor.g;
    out[i * 4 + 2] = s.bgColor.b;
    out[i * 4 + 3] = 255;
  }

  const cellSize = s.cellSize;
  const cols = Math.max(1, Math.floor(w / cellSize));
  const rows = Math.max(1, Math.floor(h / cellSize));
  const charset = s.asciiCharset || " .:-=+*#%@";

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      if (s.dropout > 0 && Math.random() < s.dropout) continue;

      const sx = Math.min(w - 1, Math.floor(gx * cellSize + cellSize / 2));
      const sy = Math.min(h - 1, Math.floor(gy * cellSize + cellSize / 2));
      const sIdx = (sy * w + sx) * components;

      const r = data[sIdx], g = data[sIdx + 1], b = data[sIdx + 2];
      let lum = r * 0.299 + g * 0.587 + b * 0.114;
      lum = applyTone(lum, s);
      if (lum < s.threshold) continue;
      const t = lum / 255;

      const col = getRampColor(t);
      let cx = gx * cellSize;
      let cy = gy * cellSize;

      if (s.jitter > 0) {
        cx += (Math.random() - 0.5) * cellSize * s.jitter;
        cy += (Math.random() - 0.5) * cellSize * s.jitter;
      }

      const drawCellRect = (rx, ry, rw, rh, alpha) => {
        for (let py = ry; py < ry + rh; py++) {
          if (py < 0 || py >= h) continue;
          for (let px = rx; px < rx + rw; px++) {
            if (px < 0 || px >= w) continue;
            const oIdx = (py * w + px) * 4;
            out[oIdx + 0] = col.r * alpha + out[oIdx + 0] * (1 - alpha);
            out[oIdx + 1] = col.g * alpha + out[oIdx + 1] * (1 - alpha);
            out[oIdx + 2] = col.b * alpha + out[oIdx + 2] * (1 - alpha);
            out[oIdx + 3] = 255;
          }
        }
      };

      if (mode === "bars") {
        const barH = Math.round(t * cellSize);
        const barW = Math.max(1, Math.round(cellSize * s.fillWidth));
        drawCellRect(
          Math.round(cx + (cellSize - barW) / 2),
          Math.round(cy + (cellSize - barH)),
          barW,
          barH,
          t
        );
      } else if (mode === "dots") {
        const radius = (t * cellSize) / 2.2;
        const ccx = cx + cellSize / 2;
        const ccy = cy + cellSize / 2;
        for (let py = Math.floor(ccy - radius); py <= Math.ceil(ccy + radius); py++) {
          if (py < 0 || py >= h) continue;
          for (let px = Math.floor(ccx - radius); px <= Math.ceil(ccx + radius); px++) {
            if (px < 0 || px >= w) continue;
            const dx = px - ccx, dy = py - ccy;
            if (dx * dx + dy * dy <= radius * radius) {
              const oIdx = (py * w + px) * 4;
              out[oIdx + 0] = col.r;
              out[oIdx + 1] = col.g;
              out[oIdx + 2] = col.b;
              out[oIdx + 3] = 255;
            }
          }
        }
      } else if (mode === "blocks") {
        const bw = cellSize * s.fillWidth;
        const bh = cellSize * s.fillWidth;
        drawCellRect(
          Math.round(cx + (cellSize - bw) / 2),
          Math.round(cy + (cellSize - bh) / 2),
          Math.max(1, Math.round(bw)),
          Math.max(1, Math.round(bh)),
          t
        );
      } else if (mode === "lines") {
        const lineLen = t * cellSize;
        const lh = Math.max(1, cellSize * s.fillWidth * 0.3);
        drawCellRect(Math.round(cx), Math.round(cy + (cellSize - lh) / 2), Math.max(1, Math.round(lineLen)), Math.round(lh), t);
      } else if (mode === "ascii") {
        const charIdx = Math.min(charset.length - 1, Math.floor(t * charset.length));
        const ch = charset[charIdx];
        if (ch !== " ") {
          drawGlyph(out, w, h, ch, cx, cy, cellSize, col, t);
        }
      }
    }
  }

  if (s.glowAmount > 0) {
    applyGlow(out, w, h, s.glowSpread, s.glowAmount);
  }

  if (s.caEnable && s.caShift > 0) {
    applyChromaticAberration(out, w, h, s.caShift);
  }

  if (s.noiseEnable && s.noiseAmount > 0) {
    applyNoise(out, w, h, s.noiseAmount);
  }

  if (s.trackingEnable && s.trackingAmount > 0) {
    applyTrackingJitter(out, w, h, s.trackingAmount, s.bgColor);
  }

  if (s.vignette > 0) {
    applyVignette(out, w, h, s.vignette, s.vignetteReach);
  }

  if (s.curveEnable && s.curveAmount > 0) {
    applyCurvatureShading(out, w, h, s.curveAmount);
  }

  if (s.scanEnable && s.scanIntensity > 0) {
    applyScanlines(out, w, h, s.scanIntensity, s.scanSpacing);
  }

  if (s.bezelEnable && s.bezelWidth > 0) {
    applyBezel(out, w, h, s.bezelWidth);
  }

  return out;
}

function applyGlow(buf, w, h, radius, amount) {
  if (radius <= 0) return;
  const r = Math.max(1, Math.round(radius));
  const temp = new Float32Array(buf.length);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sr = 0, sg = 0, sb = 0, count = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const idx = (y * w + xx) * 4;
        sr += buf[idx]; sg += buf[idx + 1]; sb += buf[idx + 2];
        count++;
      }
      const oIdx = (y * w + x) * 4;
      temp[oIdx] = sr / count;
      temp[oIdx + 1] = sg / count;
      temp[oIdx + 2] = sb / count;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sr = 0, sg = 0, sb = 0, count = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const idx = (yy * w + x) * 4;
        sr += temp[idx]; sg += temp[idx + 1]; sb += temp[idx + 2];
        count++;
      }
      const oIdx = (y * w + x) * 4;
      const blurR = sr / count, blurG = sg / count, blurB = sb / count;
      buf[oIdx] = Math.min(255, buf[oIdx] + blurR * amount);
      buf[oIdx + 1] = Math.min(255, buf[oIdx + 1] + blurG * amount);
      buf[oIdx + 2] = Math.min(255, buf[oIdx + 2] + blurB * amount);
    }
  }
}

function applyChromaticAberration(buf, w, h, shift) {
  const snap = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const oIdx = (y * w + x) * 4;
      const leftX = Math.max(0, x - shift);
      const rightX = Math.min(w - 1, x + shift);
      const leftIdx = (y * w + leftX) * 4;
      const rightIdx = (y * w + rightX) * 4;
      buf[oIdx + 0] = Math.min(255, snap[oIdx + 0] * 0.5 + snap[leftIdx + 0] * 0.5);
      buf[oIdx + 2] = Math.min(255, snap[oIdx + 2] * 0.5 + snap[rightIdx + 2] * 0.5);
    }
  }
}

function applyNoise(buf, w, h, amount) {
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    const n = (Math.random() - 0.5) * 255 * amount;
    buf[idx + 0] = Math.max(0, Math.min(255, buf[idx + 0] + n));
    buf[idx + 1] = Math.max(0, Math.min(255, buf[idx + 1] + n));
    buf[idx + 2] = Math.max(0, Math.min(255, buf[idx + 2] + n));
  }
}

function applyTrackingJitter(buf, w, h, amount, bgColor) {
  const snap = new Uint8Array(buf);
  const bandHeight = Math.max(4, Math.floor(h / 40));
  for (let y0 = 0; y0 < h; y0 += bandHeight) {
    const shift = Math.round((Math.random() - 0.5) * amount * (Math.random() < 0.15 ? 3 : 1));
    const y1 = Math.min(h, y0 + bandHeight);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const srcX = x - shift;
        const oIdx = (y * w + x) * 4;
        if (srcX < 0 || srcX >= w) {
          buf[oIdx + 0] = bgColor.r;
          buf[oIdx + 1] = bgColor.g;
          buf[oIdx + 2] = bgColor.b;
        } else {
          const sIdx = (y * w + srcX) * 4;
          buf[oIdx + 0] = snap[sIdx + 0];
          buf[oIdx + 1] = snap[sIdx + 1];
          buf[oIdx + 2] = snap[sIdx + 2];
        }
      }
    }
  }
}

function applyVignette(buf, w, h, amount, reachFrac) {
  const cx = w / 2, cy = h / 2;
  const innerR = Math.min(w, h) * 0.2;
  const outerR = Math.max(w, h) * reachFrac;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let f = (dist - innerR) / Math.max(1, outerR - innerR);
      f = Math.max(0, Math.min(1, f));
      const darken = 1 - f * amount;
      const idx = (y * w + x) * 4;
      buf[idx + 0] *= darken;
      buf[idx + 1] *= darken;
      buf[idx + 2] *= darken;
    }
  }
}

function applyCurvatureShading(buf, w, h, amount) {
  const corners = [[0, 0], [w, 0], [0, h], [w, h]];
  const cornerR = Math.min(w, h) * 0.45;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let darken = 1;
      for (const [ccx, ccy] of corners) {
        const dx = x - ccx, dy = y - ccy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const f = Math.max(0, 1 - dist / cornerR);
        darken -= f * amount * 0.8;
      }
      darken = Math.max(0.15, darken);
      const idx = (y * w + x) * 4;
      buf[idx + 0] *= darken;
      buf[idx + 1] *= darken;
      buf[idx + 2] *= darken;
    }
  }
}

function applyScanlines(buf, w, h, intensity, spacing) {
  const lineHeight = Math.max(1, Math.round(spacing / 2));
  for (let y = 0; y < h; y += spacing) {
    for (let ly = y; ly < Math.min(h, y + lineHeight); ly++) {
      for (let x = 0; x < w; x++) {
        const idx = (ly * w + x) * 4;
        buf[idx + 0] *= (1 - intensity);
        buf[idx + 1] *= (1 - intensity);
        buf[idx + 2] *= (1 - intensity);
      }
    }
  }
}

function applyBezel(buf, w, h, width) {
  const bw = Math.max(1, Math.round(width));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < bw || x >= w - bw || y < bw || y >= h - bw) {
        const idx = (y * w + x) * 4;
        buf[idx + 0] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
      }
    }
  }
}

// ---------- Live preview ----------
// Strategy: read the doc's pixels once and cache them. Every subsequent
// preview tick reuses the cached source and only re-renders the effect
// buffer + overwrites one persistent "Phosphor Preview" layer via
// putPixels — no new layer per tick, no re-read per tick.

function schedulePreview() {
  if (!document.getElementById("livePreviewEnable").checked) return;
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    runPreview().catch(err => {
      console.error(err);
      statusEl.textContent = `Preview error: ${err.message || err}`;
    });
  }, PREVIEW_DEBOUNCE_MS);
}

async function ensureCachedSource(doc) {
  if (cachedSrc && cachedSrcDocId === doc.id) return cachedSrc;
  cachedSrc = await getActiveDocumentPixelsModal(doc);
  cachedSrcDocId = doc.id;
  return cachedSrc;
}

// Returns a {width, height, data, components} downscaled copy of src for
// fast preview mode. Simple nearest-neighbor decimation — good enough for
// a live preview, not used for final export.
function downscaleSource(src, scale) {
  if (scale >= 1) return src;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8Array(w * h * src.components);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const sIdx = (sy * src.width + sx) * src.components;
      const oIdx = (y * w + x) * src.components;
      for (let c = 0; c < src.components; c++) out[oIdx + c] = src.data[sIdx + c];
    }
  }
  return { width: w, height: h, components: src.components, data: out };
}

// Upscales an already-rendered RGBA output buffer (nearest-neighbor) back
// to full document size. Used so fast-preview writes a correctly-scaled
// result directly via putPixels — no separate layer transform needed,
// which was the source of the oversized-dots bug (stacking a render-time
// downscale with a post-hoc layer resize compounded incorrectly).
function upscaleBuffer(buf, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y / dstH) * srcH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x / dstW) * srcW));
      const sIdx = (sy * srcW + sx) * 4;
      const oIdx = (y * dstW + x) * 4;
      out[oIdx] = buf[sIdx];
      out[oIdx + 1] = buf[sIdx + 1];
      out[oIdx + 2] = buf[sIdx + 2];
      out[oIdx + 3] = buf[sIdx + 3];
    }
  }
  return out;
}

async function runPreview() {
  const doc = app.activeDocument;
  if (!doc) {
    statusEl.textContent = "No active document open.";
    return;
  }

  statusEl.textContent = "Updating preview…";

  await executeAsModal(async () => {
    const fullSrc = await ensureCachedSource(doc);
    const fast = document.getElementById("fastPreviewEnable").checked;
    const previewScale = fast ? 0.4 : 1.0;
    const renderSrc = downscaleSource(fullSrc, previewScale);

    const s = getSettings();
    // Scale cellSize down to match the downscaled canvas so the grid still
    // reads at roughly the same visual density as full-res. Also cap
    // glow spread during fast preview — blur cost scales with radius
    // regardless of buffer size, so a large glowSpread is the single
    // most expensive setting to leave uncapped in a live preview.
    const scaledSettings = {
      ...s,
      cellSize: Math.max(2, Math.round(s.cellSize * previewScale)),
      glowSpread: fast ? Math.min(s.glowSpread, 6) : s.glowSpread
    };

    let outBuffer = buildPhosphorBuffer(renderSrc, scaledSettings, currentMode);

    // Upscale the RENDERED BUFFER back to full doc size (nearest-neighbor)
    // instead of writing small + transforming the layer. This is what
    // fixes the oversized-dots bug: previously we rendered small AND
    // separately stretched the layer 2.5x, double-applying scale. Now the
    // buffer itself is the only thing that gets resized, once.
    if (previewScale < 1) {
      outBuffer = upscaleBuffer(outBuffer, renderSrc.width, renderSrc.height, fullSrc.width, fullSrc.height);
    }

    const newImageData = await imaging.createImageDataFromBuffer(outBuffer, {
      width: fullSrc.width,
      height: fullSrc.height,
      components: 4,
      colorSpace: "RGB"
    });

    let layer;
    if (previewLayerId) {
      layer = doc.layers.find(l => l.id === previewLayerId);
    }
    if (!layer) {
      layer = await doc.layers.add();
      layer.name = "Phosphor Preview";
      previewLayerId = layer.id;
    }

    await imaging.putPixels({
      documentID: doc.id,
      layerID: layer.id,
      targetBounds: { left: 0, top: 0, right: fullSrc.width, bottom: fullSrc.height },
      imageData: newImageData
    });

    newImageData.dispose();
  }, { commandName: "Update Phosphor Preview" });

  statusEl.textContent = "Preview updated.";
}

// ---------- Apply: commit the preview into a clean final layer ----------
// Renders one final FULL-RESOLUTION pass (regardless of whether fast
// preview was on), removes the temporary preview layer, and writes a
// clean named layer in its place.
async function applyEffect() {
  const doc = app.activeDocument;
  if (!doc) {
    statusEl.textContent = "Error: no active document open.";
    return;
  }

  try {
    statusEl.textContent = "Rendering full-resolution result…";

    await executeAsModal(async () => {
      const src = await ensureCachedSource(doc);
      const s = getSettings();

      const outBuffer = buildPhosphorBuffer(src, s, currentMode);

      const newImageData = await imaging.createImageDataFromBuffer(outBuffer, {
        width: src.width,
        height: src.height,
        components: 4,
        colorSpace: "RGB"
      });

      if (previewLayerId) {
        const previewLayer = doc.layers.find(l => l.id === previewLayerId);
        if (previewLayer) await previewLayer.delete();
        previewLayerId = null;
      }

      const newLayer = await doc.layers.add();
      newLayer.name = `Phosphor (${currentMode})`;

      await imaging.putPixels({
        documentID: doc.id,
        layerID: newLayer.id,
        targetBounds: { left: 0, top: 0, right: src.width, bottom: src.height },
        imageData: newImageData
      });

      newImageData.dispose();
    }, { commandName: "Apply Phosphor Effect" });

    statusEl.textContent = "Done — committed to a new layer.";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message || err}`;
  }
}

document.getElementById("applyBtn").addEventListener("click", applyEffect);

// Toggling fast-preview should immediately re-render at the new resolution
// rather than waiting for the next slider tweak.
document.getElementById("fastPreviewEnable").addEventListener("change", () => schedulePreview());

// Toggling live preview off doesn't remove the current preview layer —
// it just stops auto-updating it. Toggling back on schedules a fresh tick.
document.getElementById("livePreviewEnable").addEventListener("change", (e) => {
  if (e.target.checked) schedulePreview();
});

// Kick off an initial preview once a document is open and the panel loads,
// so you see the current default settings applied immediately rather than
// a blank canvas until the first slider move.
schedulePreview();
