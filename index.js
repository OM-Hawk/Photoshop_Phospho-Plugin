// index.js — Phosphor // Scan, UXP plugin core
// Uses Photoshop's UXP `photoshop` and `imaging` modules.
// Docs: https://developer.adobe.com/photoshop/uxp/2022/ps_reference/

const { app, core, imaging, action } = require("photoshop");
const { executeAsModal } = core;

// ---------- Auto-refresh on external document changes ----------
// When true, the notification listener below ignores events — set while
// WE are the ones making changes (writing the preview layer, applying,
// deleting, etc.) so our own operations don't trigger a redundant
// self-referential refresh loop.
let suppressAutoRefresh = false;

// Wraps executeAsModal with the suppression flag so any of OUR OWN
// document-mutating operations don't re-trigger the auto-refresh listener.
async function suppressedModal(fn, options) {
  suppressAutoRefresh = true;
  try {
    return await executeAsModal(fn, options);
  } finally {
    // Notifications can arrive slightly after the batchPlay call resolves,
    // so hold suppression a beat longer before re-enabling.
    setTimeout(() => { suppressAutoRefresh = false; }, 150);
  }
}
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
    await mod.default();
    wasmModule = mod;
    wasmReady = true;
    console.log("Phosphor WASM core loaded.");
  } catch (err) {
    console.warn("WASM core unavailable, using JS fallback:", err.message || err);
    wasmReady = false;
  }
}
initWasm();

// ---------- UI state ----------
let currentMode = "dots";
let rampStops = [
  { pos: 0.0, color: "#031003" },
  { pos: 1.0, color: "#81d7ff" }
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

// ---------- Tab switching ----------
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// ---------- Render mode buttons ----------
// Scoped to [data-mode] specifically so they don't collide with the
// Color Source buttons below, which share the .mode-btn class but use
// [data-colormode] instead.
document.querySelectorAll(".mode-btn[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn[data-mode]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset.mode;
    document.getElementById("asciiCharsetRow").style.display = currentMode === "ascii" ? "flex" : "none";
    schedulePreview();
  });
});

// ---------- Color source mode buttons (Ramp / Original) ----------
let colorMode = "original";
document.querySelectorAll(".mode-btn[data-colormode]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn[data-colormode]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    colorMode = btn.dataset.colormode;
    document.getElementById("rampEditor").style.display = colorMode === "ramp" ? "block" : "none";
    document.getElementById("originalColorNote").style.display = colorMode === "original" ? "block" : "none";
    schedulePreview();
  });
});

// ---------- Posterize style buttons (Uniform / Bayer / Diffuse / Per-Channel) ----------
let posterizeStyle = "uniform";
document.querySelectorAll(".mode-btn[data-posterizestyle]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn[data-posterizestyle]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    posterizeStyle = btn.dataset.posterizestyle;
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
  } else if (input.type === "color" || input.tagName === "SELECT") {
    input.addEventListener("input", () => { schedulePreview(); });
    input.addEventListener("change", () => { schedulePreview(); });
  }
});
syncLabels();

// ---------- Double-click-to-reset on the value labels ----------
// Two earlier attempts at putting this on the slider itself (native
// "dblclick", then manual mousedown-timing) both failed to fire — this
// UXP webview's native range slider appears to capture/consume pointer
// events in a way our JS never sees, the same class of problem we hit
// with color inputs and checkbox toggles needing to become plain
// div/button elements. Rather than keep fighting the slider, the reset
// target is the plain <span> value label next to it instead — a normal
// text element with no native-widget event handling to fight.
Object.values(el).forEach(input => {
  if (!input || input.type !== "range") return;
  const valLabel = document.getElementById(input.id + "Val");
  if (!valLabel) return;
  // Read the raw HTML `value` attribute directly via getAttribute rather
  // than the `.defaultValue` DOM property — that property came back
  // unreliable in this webview (resetting sliders to 0/min instead of
  // their real default), the same class of native-property quirk we've
  // hit elsewhere. getAttribute reads the static markup directly and is
  // captured once here at setup time, before any interaction could touch it.
  const defaultVal = input.getAttribute("value");
  valLabel.style.cursor = "pointer";
  valLabel.title = "Double-click to reset to default";
  valLabel.addEventListener("dblclick", () => {
    input.value = defaultVal;
    syncLabels();
    schedulePreview();
  });
});

// ---------- Enable/disable toggle buttons ----------
// These were checkboxes originally; converted to plain buttons (same
// pattern as Live Preview / Fast Mode) since the checkbox+label switch
// component kept causing rendering issues in UXP's webview. Each click
// flips the .active class, which getSettings() reads directly.
["invert", "scanEnable", "caEnable", "curveEnable", "noiseEnable", "trackingEnable", "bezelEnable"].forEach(id => {
  const btn = el[id];
  if (!btn) return;
  btn.addEventListener("click", () => {
    const nowActive = btn.classList.toggle("active");
    btn.textContent = nowActive ? "On" : "Off";
    schedulePreview();
  });
});

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

// ---------- Native Photoshop color picker (primary) ----------
// Photoshop exposes its actual "Color Picker" dialog via the showColorPicker
// batchPlay command, operating on the foreground color swatch. We stash the
// user's real foreground color, set it to our starting value, show the
// dialog, read back whatever they picked, then restore their original
// foreground color so we don't clobber it. If anything here throws, we
// fall back to the custom popover below instead of leaving the button dead.
async function openNativeColorPicker(initialHex) {
  const startColor = hexToRgb(initialHex);
  const fg = app.foregroundColor;
  const originalRgb = { r: fg.rgb.red, g: fg.rgb.green, b: fg.rgb.blue };

  // These change the foreground color swatch, not the document — but the
  // notification listener doesn't distinguish, so suppress it here too or
  // opening a color picker would trigger a pointless preview re-render.
  suppressAutoRefresh = true;

  const setForeground = async (r, g, b) => {
    await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "color", _property: "foregroundColor" }],
      to: { _obj: "RGBColor", red: r, grain: g, blue: b }
    }], { synchronousExecution: true });
  };

  try {
    await setForeground(startColor.r, startColor.g, startColor.b);

    await action.batchPlay([{
      _obj: "showColorPicker",
      _target: [{ _ref: "color", _property: "foregroundColor" }],
      dontRecord: true,
      forceNotify: true
    }], { synchronousExecution: false });

    const pickedFg = app.foregroundColor;
    const resultHex = rgbToHexStr(
      Math.round(pickedFg.rgb.red),
      Math.round(pickedFg.rgb.green),
      Math.round(pickedFg.rgb.blue)
    );

    await setForeground(originalRgb.r, originalRgb.g, originalRgb.b);

    return resultHex;
  } finally {
    setTimeout(() => { suppressAutoRefresh = false; }, 150);
  }
}

// Dispatcher used by both call sites: try the native Photoshop dialog
// first, fall back to the custom popover automatically on any failure.
function openColorPicker(anchorEl, initialHex, onChange) {
  openNativeColorPicker(initialHex)
    .then(resultHex => onChange(resultHex))
    .catch(err => {
      console.warn("Native color picker failed, using fallback popover:", err.message || err);
      openColorPickerFallback(anchorEl, initialHex, onChange);
    });
}

// ---------- Custom RGB color picker popover (fallback) ----------
// Used automatically if the native picker above throws for any reason —
// keeps color editing working even if the native call fails in this
// UXP/Photoshop version.
let activePopover = null;

function closeColorPopover() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
}

function openColorPickerFallback(anchorEl, initialHex, onChange) {
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
      <div class="color-swatch-btn ramp-color-btn" data-idx="${i}" style="background:${stop.color};"></div>
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
      // Only floor is 1 stop — a ramp needs at least one color to sample
      // from. Previously this silently no-op'd at 2 stops with no visual
      // feedback, which read as "remove doesn't work" — now removal works
      // all the way down to a single stop; Add Color Stop rebuilds from there.
      if (rampStops.length <= 1) return;
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

// ---------- Preset swatches ----------
// These were present in the HTML but never wired up — clicking them did
// nothing. Each preset replaces the whole ramp with a curated set of stops.
const rampPresets = {
  green:   [{ pos: 0.0, color: "#031003" }, { pos: 1.0, color: "#5fff5a" }],
  amber:   [{ pos: 0.0, color: "#1a0e00" }, { pos: 1.0, color: "#ffb238" }],
  cyan:    [{ pos: 0.0, color: "#001014" }, { pos: 1.0, color: "#33f0ff" }],
  magenta: [{ pos: 0.0, color: "#140010" }, { pos: 1.0, color: "#ff3ec8" }],
  white:   [{ pos: 0.0, color: "#0a0a0a" }, { pos: 1.0, color: "#ffffff" }],
  vapor:   [{ pos: 0.0, color: "#0c0420" }, { pos: 0.5, color: "#ff3ec8" }, { pos: 1.0, color: "#33f0ff" }],
  thermal: [{ pos: 0.0, color: "#000020" }, { pos: 0.3, color: "#7f00ff" }, { pos: 0.55, color: "#ff0040" }, { pos: 0.8, color: "#ff9900" }, { pos: 1.0, color: "#ffff00" }]
};

function rampPresetSet(name) {
  const preset = rampPresets[name];
  if (!preset) return;
  rampStops = preset.map(s => ({ ...s }));
  renderRampUI();
  schedulePreview();
}

document.querySelectorAll(".swatch[data-preset]").forEach(sw => {
  sw.addEventListener("click", () => rampPresetSet(sw.dataset.preset));
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
    colorMode: colorMode,
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
    posterizeStyle: posterizeStyle,
    invert: el.invert.classList.contains("active"),
    bgColor: hexToRgb(bgColorHex),
    glowAmount: +el.glowAmount.value / 100,
    glowSpread: +el.glowSpread.value,
    scanEnable: el.scanEnable.classList.contains("active"),
    scanIntensity: +el.scanIntensity.value / 100,
    scanSpacing: +el.scanSpacing.value,
    caEnable: el.caEnable.classList.contains("active"),
    caShift: +el.caShift.value,
    curveEnable: el.curveEnable.classList.contains("active"),
    curveAmount: +el.curveAmount.value / 100,
    noiseEnable: el.noiseEnable.classList.contains("active"),
    noiseAmount: +el.noiseAmount.value / 100,
    trackingEnable: el.trackingEnable.classList.contains("active"),
    trackingAmount: +el.trackingAmount.value,
    vignette: +el.vignette.value / 100,
    vignetteReach: +el.vignetteReach.value / 100,
    bezelEnable: el.bezelEnable.classList.contains("active"),
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
    // No targetColorProfile — let Photoshop return data in the document's
    // own color profile. We capture that profile string and pass it back
    // through createImageDataFromBuffer so the two always match.
  });

  const imageData = await pixelData.imageData.getData({ chunky: true });
  const result = {
    width: pixelData.imageData.width,
    height: pixelData.imageData.height,
    components: pixelData.imageData.components,
    colorProfile: pixelData.imageData.colorProfile || "",
    colorSpace: pixelData.imageData.colorSpace || "RGB",
    data: imageData,
    docId: doc.id
  };
  pixelData.imageData.dispose();
  return result;
}

// Posterize is handled separately from the rest of tone mapping now,
// since some styles (ordered/Bayer, error-diffusion) need grid position
// or carried state across cells that doesn't fit a stateless per-value
// function. applyTone no longer quantizes at all — see applyPosterize
// and the per-channel step in the main render loop.
function applyTone(raw, s) {
  let v = raw * s.brightness;
  v = (v - 128) * s.contrast + 128;
  v = Math.max(0, Math.min(255, v));
  v = 255 * Math.pow(v / 255, 1 / s.gamma);
  const whiteClipVal = (s.whiteClip / 100) * 255;
  if (whiteClipVal < 255 && whiteClipVal > 0) v = Math.min(v, whiteClipVal) * (255 / whiteClipVal);
  v = Math.max(0, Math.min(255, v));
  if (s.invert) v = 255 - v;
  return v;
}

function quantizeToSteps(v, steps) {
  return Math.round((v / 255) * steps) / steps * 255;
}

// Standard 4x4 Bayer ordered-dither threshold matrix, values 0-15.
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
];

// Applies the selected posterize style to a single luminance value.
// "perchannel" is intentionally a no-op here — luminance stays continuous
// and the actual quantization happens on the resolved color's R/G/B after
// color lookup, in the main render loop.
function applyPosterize(v, s, gx, gy, diffusionState) {
  if (s.posterize <= 0 || s.posterizeStyle === "perchannel") return v;
  const steps = s.posterize;
  const stepSize = 255 / steps;

  if (s.posterizeStyle === "bayer") {
    const threshold = (BAYER_4X4[gy % 4][gx % 4] / 16 - 0.5) * stepSize;
    return quantizeToSteps(Math.max(0, Math.min(255, v + threshold)), steps);
  }

  if (s.posterizeStyle === "diffuse") {
    // Simplified 1D error diffusion: carries quantization error to the
    // next cell in the same row (resets each row), rather than the full
    // 2D Floyd-Steinberg spread to neighboring rows too — a reasonable
    // simplification given cells are processed independently rather than
    // as a continuous pixel buffer.
    const adjusted = Math.max(0, Math.min(255, v + diffusionState.carry));
    const quantized = quantizeToSteps(adjusted, steps);
    diffusionState.carry = adjusted - quantized;
    return quantized;
  }

  // "uniform" (default) — flat quantization, no positional variation.
  return quantizeToSteps(v, steps);
}

// Draws a single 5x7 glyph into the output buffer at (cx, cy), scaled to
// fill roughly one cell. Used by ASCII mode since UXP's raw pixel buffer
// has no text rasterizer of its own.
// fillScale (0-1, typically fillWidth) shrinks the glyph within its cell,
// keeping it centered — same "how much of the cell does the mark fill"
// behavior fillWidth has in every other render mode.
function drawGlyph(out, w, h, ch, cx, cy, cellSize, col, alpha, fillScale) {
  const glyph = FONT_5X7[ch];
  if (!glyph) return;
  const scale = fillScale !== undefined ? Math.max(0.15, fillScale * 2) : 1;
  const glyphSize = cellSize * Math.min(1, scale);
  const offset = (cellSize - glyphSize) / 2;
  cx += offset;
  cy += offset;
  const scaleX = glyphSize / FONT_WIDTH;
  const scaleY = glyphSize / FONT_HEIGHT;
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
    // Error-diffusion carry resets at the start of each row — quantization
    // error only propagates left-to-right within a row, not down to the
    // next one.
    const diffusionState = { carry: 0 };

    for (let gx = 0; gx < cols; gx++) {
      if (s.dropout > 0 && Math.random() < s.dropout) continue;

      const sx = Math.min(w - 1, Math.floor(gx * cellSize + cellSize / 2));
      const sy = Math.min(h - 1, Math.floor(gy * cellSize + cellSize / 2));
      const sIdx = (sy * w + sx) * components;

      const r = data[sIdx], g = data[sIdx + 1], b = data[sIdx + 2];
      let lum = r * 0.299 + g * 0.587 + b * 0.114;
      lum = applyTone(lum, s);
      lum = applyPosterize(lum, s, gx, gy, diffusionState);
      if (lum < s.threshold) continue;
      const t = lum / 255;

      // Original mode samples the source pixel's actual color directly
      // instead of mapping luminance through the ramp — luminance (t)
      // still drives shape/size/alpha, only the hue source changes.
      const col = s.colorMode === "original"
        ? { r, g, b }
        : getRampColor(t);

      // Per-channel posterize quantizes the resolved color's R/G/B
      // independently instead of the luminance value — this is the one
      // style that operates after color lookup rather than before it,
      // producing colorful banding rather than value-only banding.
      if (s.posterizeStyle === "perchannel" && s.posterize > 0) {
        col.r = quantizeToSteps(col.r, s.posterize);
        col.g = quantizeToSteps(col.g, s.posterize);
        col.b = quantizeToSteps(col.b, s.posterize);
      }

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
        // fillWidth scales max dot size — at the default 50 this reproduces
        // the original fixed look exactly (0.5 * 2 = 1), and the slider now
        // has real range from 0 (no dots) up to 2x that size.
        const radius = (t * cellSize * s.fillWidth * 2) / 2.2;
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
          drawGlyph(out, w, h, ch, cx, cy, cellSize, col, t, s.fillWidth);
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

// Shifts the red channel left and blue channel right by `shift` pixels,
// leaving green as the anchor channel (standard RGB-split CA look).
// IMPORTANT: this REPLACES each channel with the shifted sample rather
// than averaging it with the original — averaging with a mostly-dark
// background (as in most of these renders) drags red/blue toward black
// much faster than the untouched green channel, producing an overall
// green cast as shift increases. Replacing avoids that entirely.
// Our renders are sparse — bright marks on mostly-black background, not
// continuous-tone photos. A single shifted SAMPLE (the "correct" way to do
// CA on a photo) frequently misses isolated content entirely once shift
// exceeds the mark's own size, dropping red/blue to background-black while
// green (never shifted) stays lit — producing an increasing green cast as
// shift grows. Instead we search a WINDOW along the shift direction and
// take the brightest value found, so a nearby bright mark still shows up
// in the fringe rather than being missed.
function applyChromaticAberration(buf, w, h, shift) {
  if (shift <= 0) return;
  const snap = new Uint8Array(buf);
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      const oIdx = (rowOffset + x) * 4;
      let maxR = 0;
      let maxB = 0;
      for (let k = 0; k <= shift; k++) {
        const lx = x - k < 0 ? 0 : x - k;
        const rx = x + k >= w ? w - 1 : x + k;
        const lIdx = (rowOffset + lx) * 4;
        const rIdx = (rowOffset + rx) * 4;
        if (snap[lIdx] > maxR) maxR = snap[lIdx];
        if (snap[rIdx + 2] > maxB) maxB = snap[rIdx + 2];
      }
      buf[oIdx + 0] = maxR;
      buf[oIdx + 2] = maxB;
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
  if (!document.getElementById("livePreviewEnable").classList.contains("active")) return;
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    runPreview().catch(err => {
      console.error(err);
      statusEl.textContent = `Preview error: ${err.message || err}`;
    });
  }, PREVIEW_DEBOUNCE_MS);
}

// Unlocks a layer via batchPlay. If the layer is the document's Background
// layer, Photoshop keeps it locked even after this call (Background layers
// are locked by design and must be explicitly converted to a normal layer
// first) — the caller should treat a still-locked layer after this as a
// hard failure and fall back to creating a new layer instead.
// doc.layers.find() only searches the TOP-LEVEL layers collection — if
// the preview layer ever ends up nested inside a group (which can happen
// depending on what layer was active/selected at creation time), a plain
// .find() silently returns nothing even though the layer still exists on
// canvas. This searches the full layer tree, including nested groups.
function findLayerById(layers, id) {
  for (const layer of layers) {
    if (layer.id === id) return layer;
    if (layer.layers && layer.layers.length) {
      const found = findLayerById(layer.layers, id);
      if (found) return found;
    }
  }
  return null;
}

const PREVIEW_LAYER_NAME = "Phosphor Preview";

// previewLayerId only lives in memory for the current plugin session —
// reloading the plugin (or Photoshop restarting) wipes it, even though
// the actual layer is still sitting in the document. Falling back to a
// name-based search lets a reloaded plugin find and reuse that same
// layer instead of creating a new one and orphaning the old one.
function findPreviewLayerByName(layers) {
  for (const layer of layers) {
    if (layer.name === PREVIEW_LAYER_NAME) return layer;
    if (layer.layers && layer.layers.length) {
      const found = findPreviewLayerByName(layer.layers);
      if (found) return found;
    }
  }
  return null;
}

// Resolves the preview layer for the given document: tries the
// remembered ID first (fast path, works within a single session), then
// falls back to searching by name (recovers after a plugin reload). If
// found via name, adopts its ID into previewLayerId so subsequent calls
// this session use the fast path.
function resolvePreviewLayer(doc) {
  if (previewLayerId) {
    const byId = findLayerById(doc.layers, previewLayerId);
    if (byId) return byId;
  }
  const byName = findPreviewLayerByName(doc.layers);
  if (byName) {
    previewLayerId = byName.id;
    return byName;
  }
  return null;
}

async function unlockLayer(layer) {
  await action.batchPlay([{
    _obj: "applyLocking",
    _target: [{ _ref: "layer", _id: layer.id }],
    layerLocking: {
      _obj: "layerLocking",
      protectAll: false,
      protectComposite: false,
      protectPosition: false,
      protectTransparency: false
    }
  }], { synchronousExecution: true });
}

async function ensureCachedSource(doc) {
  // If the doc changed, fully invalidate — cached pixels from a different
  // document must never be used, and the preview layer ID is also stale.
  if (cachedSrcDocId !== null && cachedSrcDocId !== doc.id) {
    cachedSrc = null;
    cachedSrcDocId = null;
    previewLayerId = null;
    console.log("Document changed — cache invalidated.");
  }
  if (cachedSrc) return cachedSrc;

  // getActiveDocumentPixelsModal reads the full document COMPOSITE — every
  // visible layer flattened together. If our own "Phosphor Preview" layer
  // is currently visible (from a prior live-preview session), a fresh read
  // would sample the photo WITH our already-rendered effect baked on top,
  // feeding the render back into itself. Hide it for the read, then
  // restore its visibility afterward — the caller will either overwrite
  // its pixels (preview) or delete it (apply) right after anyway, but
  // restoring keeps the canvas visually correct if something errors out
  // in between.
  let hiddenPreviewLayer = null;
  const existing = resolvePreviewLayer(doc);
  if (existing && existing.visible) {
    existing.visible = false;
    hiddenPreviewLayer = existing;
  }

  try {
    cachedSrc = await getActiveDocumentPixelsModal(doc);
    cachedSrcDocId = doc.id;
  } finally {
    if (hiddenPreviewLayer) hiddenPreviewLayer.visible = true;
  }

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

// This plugin's whole pipeline (JS + WASM) assumes 8-bit data (Uint8Array,
// 0-255 range). 16-bit and 32-bit documents return pixel data in different
// ranges/types from Photoshop's imaging API, which we don't handle — and
// writing our 8-bit buffer into a higher-bit-depth document via putPixels
// can leave Photoshop in a defensive state (observed: newly created layers
// coming back locked). Catch this upfront with a clear message instead of
// letting it fail silently into a locked layer. This mirrors a documented
// limitation in comparable commercial plugins (e.g. DitherTone Pro's own
// FAQ instructs users to convert to 8-bit RGB first).
function checkBitDepth(doc) {
  // Confirmed via console logging: doc.bitsPerChannel returns the string
  // "bitDepth8" for 8-bit documents (not "eight" or the number 8, both of
  // which were wrong earlier guesses). Other known values follow the same
  // pattern: "bitDepth16", "bitDepth32".
  if (doc.bitsPerChannel && doc.bitsPerChannel !== "bitDepth8") {
    return "This document is not 8-bit. Go to Image > Mode > 8 Bits/Channel, then try again.";
  }
  return null;
}

async function runPreview() {
  const doc = app.activeDocument;
  if (!doc) {
    statusEl.textContent = "No active document open.";
    return;
  }
  const bitDepthError = checkBitDepth(doc);
  if (bitDepthError) {
    statusEl.textContent = bitDepthError;
    return;
  }

  statusEl.textContent = "Updating preview…";

  await suppressedModal(async () => {
    const fullSrc = await ensureCachedSource(doc);
    const fast = document.getElementById("fastPreviewEnable").classList.contains("active");
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
      colorSpace: fullSrc.colorSpace || "RGB",
      colorProfile: fullSrc.colorProfile || undefined
    });

    let layer = resolvePreviewLayer(doc);
    if (!layer) {
      layer = await doc.layers.add();
      layer.name = PREVIEW_LAYER_NAME;
      previewLayerId = layer.id;
    }

    // Defensive unlock: a previous run that errored mid-write (or a race
    // between overlapping preview updates) can leave this layer locked,
    // which then silently fails every subsequent putPixels. If it's
    // locked, try to unlock it; if that's not possible (e.g. it somehow
    // became the document's Background layer, which is always locked),
    // abandon it and create a fresh preview layer instead.
    if (layer.locked) {
      try {
        await unlockLayer(layer);
      } catch (unlockErr) {
        console.warn("Could not unlock preview layer, creating a new one:", unlockErr);
        layer = await doc.layers.add();
        layer.name = PREVIEW_LAYER_NAME;
        previewLayerId = layer.id;
      }
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
  const bitDepthError = checkBitDepth(doc);
  if (bitDepthError) {
    statusEl.textContent = bitDepthError;
    return;
  }

  try {
    statusEl.textContent = "Rendering full-resolution result…";

    await suppressedModal(async () => {
      // Always re-read when applying — don't trust the cache for the
      // final commit, since the user may have edited the document since
      // the last preview. Also forces a re-read if the doc changed.
      cachedSrc = null;
      const src = await ensureCachedSource(doc);
      const s = getSettings();

      const outBuffer = buildPhosphorBuffer(src, s, currentMode);

      const newImageData = await imaging.createImageDataFromBuffer(outBuffer, {
        width: src.width,
        height: src.height,
        components: 4,
        colorSpace: src.colorSpace || "RGB",
        colorProfile: src.colorProfile || undefined
      });

      // Remove preview layer if one exists for this document — resolved
      // by name too, in case the plugin reloaded since it was created.
      const previewLayer = resolvePreviewLayer(doc);
      if (previewLayer) {
        if (previewLayer.locked) {
          try { await unlockLayer(previewLayer); } catch (e) { /* fall through, delete will just fail below */ }
        }
        try {
          await previewLayer.delete();
        } catch (deleteErr) {
          console.warn("Could not delete old preview layer (leaving it in place):", deleteErr);
        }
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

      // Target batchPlay calls explicitly by layer ID — never by "targetEnum"
      // (currently selected layer) since Photoshop doesn't guarantee our new
      // layer stays selected after putPixels. Using the ID is unambiguous and
      // won't accidentally fire on a text layer or whatever happens to be active.
      const layerRef = [{ _ref: "layer", _id: newLayer.id }];

      // Blend mode depends on color source: Ramp mode renders on a dark
      // background, so Screen lets that background disappear and the
      // colored cells glow over the photo underneath. Original mode
      // already samples full photo colors per cell, so Normal reads
      // correctly without the extra brightening Screen would add.
      const layerBlendMode = s.colorMode === "original" ? "normal" : "screen";
      await action.batchPlay([{
        _obj: "set",
        _target: layerRef,
        to: { _obj: "layer", mode: { _enum: "blendMode", _value: layerBlendMode } }
      }], { synchronousExecution: true });

      // Color Overlay only makes sense in Ramp mode — it tints the whole
      // layer with a single color, which would just paint over Original
      // mode's actual sampled photo colors. Skip it entirely there.
      if (s.colorMode !== "original") {
        sortStops();
        const topStop = rampStops[rampStops.length - 1];
        const overlayCol = hexToRgb(topStop.color);
        await action.batchPlay([{
          _obj: "set",
          _target: [
            { _ref: "property", _property: "layerEffects" },
            ...layerRef
          ],
          to: {
            _obj: "layerEffects",
            solidFill: {
              _obj: "solidFill",
              enabled: true,
              present: true,
              showInDialog: true,
              mode: { _enum: "blendMode", _value: "color" },
              color: {
                _obj: "RGBColor",
                red: overlayCol.r,
                grain: overlayCol.g,
                blue: overlayCol.b
              },
              opacity: { _unit: "percentUnit", _value: 100 }
            },
            scale: { _unit: "percentUnit", _value: 100 }
          }
        }], { synchronousExecution: true });
      }

    }, { commandName: "Apply Phosphor Effect" });

    statusEl.textContent = "Done.";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message || err}`;
  }
}

document.getElementById("applyBtn").addEventListener("click", applyEffect);

// Fast preview / Live preview are plain toggle buttons — clicking flips
// the .active class, which the two checks above read directly.
const fastPreviewBtn = document.getElementById("fastPreviewEnable");
fastPreviewBtn.addEventListener("click", () => {
  fastPreviewBtn.classList.toggle("active");
  // Re-render immediately at the new resolution rather than waiting for
  // the next slider tweak.
  schedulePreview();
});

// Deletes the live "Phosphor Preview" layer, if one exists, from the
// currently active document. Wrapped in executeAsModal since layer
// deletion is a document-mutating operation. Reuses the same lock
// handling as elsewhere — a locked preview layer gets unlocked first.
//
// IMPORTANT: previewLayerId is only cleared once deletion is CONFIRMED —
// previously it was cleared unconditionally in a finally block regardless
// of whether the delete actually succeeded, which silently orphaned the
// old layer on canvas (still visible, no longer tracked) and caused the
// next preview to create a brand new layer on top of it instead of
// reusing/replacing it.
async function deletePreviewLayer() {
  const doc = app.activeDocument;
  if (!doc) return;

  let deleted = false;

  await suppressedModal(async () => {
    // Resolved by name too — previewLayerId may be null after a plugin
    // reload even though an orphaned layer from a previous session still
    // exists on canvas; without the name fallback this would silently
    // no-op and leave that layer stuck.
    const layer = resolvePreviewLayer(doc);
    if (!layer) {
      // Layer's already gone (or was never really there) — safe to
      // clear tracking.
      deleted = true;
      return;
    }
    if (layer.locked) {
      try { await unlockLayer(layer); } catch (e) { /* best effort */ }
    }
    try {
      await layer.delete();
      deleted = true;
    } catch (deleteErr) {
      console.error("Could not delete preview layer:", deleteErr);
      statusEl.textContent = "Couldn't remove the preview layer — try deleting it manually.";
    }
  }, { commandName: "Remove Phosphor Preview" });

  if (deleted) {
    previewLayerId = null;
  }
}

const livePreviewBtn = document.getElementById("livePreviewEnable");
livePreviewBtn.addEventListener("click", () => {
  livePreviewBtn.classList.toggle("active");
  if (livePreviewBtn.classList.contains("active")) {
    // Turning it back on invalidates the cached source pixels first, so
    // the next preview reads the document fresh instead of reusing
    // whatever was captured the last time it ran — the photo may have
    // changed while preview was off. Every slider/setting stays exactly
    // as the user left it; only the source pixel cache resets.
    cachedSrc = null;
    cachedSrcDocId = null;
    schedulePreview();
  } else {
    // Cancel any pending debounced preview first — without this, a preview
    // scheduled just before this click (e.g. from a slider drag) can still
    // fire ~300ms later and recreate the layer right after we delete it,
    // making deletion look like it silently failed.
    clearTimeout(previewDebounceTimer);
    // Turning it off removes the live preview layer entirely rather than
    // just leaving a stale render sitting on the canvas.
    deletePreviewLayer().catch(err => console.error(err));
  }
});

// Kick off an initial preview once a document is open and the panel loads,
// so you see the current default settings applied immediately rather than
// a blank canvas until the first slider move.
schedulePreview();

// ---------- Auto-refresh when OTHER layers change ----------
// Watches Photoshop's own event stream and refreshes the live preview
// whenever the document changes from something other than our own plugin
// (moving/hiding/editing/painting on other layers, etc.), so the phosphor
// effect always reflects the current state of the photo without requiring
// a manual toggle-off/on. This is a first pass and hasn't been verified
// live — 'select'-type events are filtered out since they don't change
// pixels, but there may be other noisy events worth adding to the ignore
// list once this is tested against real usage.
const AUTO_REFRESH_IGNORED_EVENTS = new Set([
  "select", "selectNoLayers", "get", "wait", "notify",
  "currentToolChanged", "toolModalStateChanged"
]);

action.addNotificationListener(["all"], (event) => {
  if (suppressAutoRefresh) return;
  if (AUTO_REFRESH_IGNORED_EVENTS.has(event)) return;
  if (!livePreviewBtn.classList.contains("active")) return;

  // Something changed the document that wasn't us — force a fresh read
  // on the next preview tick rather than reusing stale cached pixels.
  cachedSrc = null;
  cachedSrcDocId = null;
  schedulePreview();
});
