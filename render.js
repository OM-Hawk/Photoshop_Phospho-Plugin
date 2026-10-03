// render.js — Phosphor // Scan render pipeline.
// Pure functions over typed arrays: no Photoshop API, no DOM, no globals.
// Loaded by index.js in UXP and directly by the Node test suite (tests/),
// so anything added here must stay free of `require("photoshop")`.
//
// Randomness (dropout, jitter, noise, tracking) goes through an injectable
// `rand` function defaulting to Math.random, so tests can pass a seeded RNG
// and get deterministic output.

const { FONT_5X7, FONT_WIDTH, FONT_HEIGHT } = require("./font5x7.js");

// ---------- Color helpers ----------
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

// Sorts and pre-parses ramp stops once per render, rather than per cell.
// Input: [{ pos: 0-1, color: "#rrggbb" }, ...] in any order.
function prepareRamp(stops) {
  return [...stops]
    .sort((a, b) => a.pos - b.pos)
    .map(st => ({ pos: st.pos, ...hexToRgb(st.color) }));
}

// Samples a prepared ramp at t (0-1). Always returns a fresh object —
// per-channel posterize mutates the result in place.
function getRampColor(ramp, t) {
  if (ramp.length === 0) return { r: 255, g: 255, b: 255 };
  const first = ramp[0], last = ramp[ramp.length - 1];
  if (t <= first.pos) return { r: first.r, g: first.g, b: first.b };
  if (t >= last.pos) return { r: last.r, g: last.g, b: last.b };
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i], b = ramp[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const lt = b.pos === a.pos ? 0 : (t - a.pos) / (b.pos - a.pos);
      return {
        r: a.r + (b.r - a.r) * lt,
        g: a.g + (b.g - a.g) * lt,
        b: a.b + (b.b - a.b) * lt
      };
    }
  }
  return { r: last.r, g: last.g, b: last.b };
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
// we sample a coarser grid directly from the full-res source).
// s.rampStops supplies the ramp for "ramp" color mode.
function buildPhosphorBufferJS(src, s, mode, rand = Math.random) {
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
  const ramp = prepareRamp(s.rampStops || []);

  for (let gy = 0; gy < rows; gy++) {
    // Error-diffusion carry resets at the start of each row — quantization
    // error only propagates left-to-right within a row, not down to the
    // next one.
    const diffusionState = { carry: 0 };

    for (let gx = 0; gx < cols; gx++) {
      if (s.dropout > 0 && rand() < s.dropout) continue;

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
        : getRampColor(ramp, t);

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
        cx += (rand() - 0.5) * cellSize * s.jitter;
        cy += (rand() - 0.5) * cellSize * s.jitter;
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
    applyNoise(out, w, h, s.noiseAmount, rand);
  }

  if (s.trackingEnable && s.trackingAmount > 0) {
    applyTrackingJitter(out, w, h, s.trackingAmount, s.bgColor, rand);
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

function applyNoise(buf, w, h, amount, rand = Math.random) {
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    const n = (rand() - 0.5) * 255 * amount;
    buf[idx + 0] = Math.max(0, Math.min(255, buf[idx + 0] + n));
    buf[idx + 1] = Math.max(0, Math.min(255, buf[idx + 1] + n));
    buf[idx + 2] = Math.max(0, Math.min(255, buf[idx + 2] + n));
  }
}

function applyTrackingJitter(buf, w, h, amount, bgColor, rand = Math.random) {
  const snap = new Uint8Array(buf);
  const bandHeight = Math.max(4, Math.floor(h / 40));
  for (let y0 = 0; y0 < h; y0 += bandHeight) {
    const shift = Math.round((rand() - 0.5) * amount * (rand() < 0.15 ? 3 : 1));
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

module.exports = {
  hexToRgb,
  rgbToHexStr,
  prepareRamp,
  getRampColor,
  applyTone,
  quantizeToSteps,
  applyPosterize,
  drawGlyph,
  buildPhosphorBufferJS,
  applyGlow,
  applyChromaticAberration,
  applyNoise,
  applyTrackingJitter,
  applyVignette,
  applyCurvatureShading,
  applyScanlines,
  applyBezel,
  downscaleSource,
  upscaleBuffer
};
