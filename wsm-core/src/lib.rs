// lib.rs — Phosphor // Scan WASM core.
// Ports the hot per-pixel loops from index.js's buildPhosphorBuffer and
// post-effect functions. ASCII glyph mode stays in JS for now since
// porting the font lookup adds complexity for a render mode that's
// already cheap relative to the others — only the expensive numeric
// loops (grid fill, glow blur, noise, vignette, curvature) live here.
//
// Build with: wasm-pack build --target web --release
// Output goes to wasm-core/pkg/ — copy phosphor_core.js and
// phosphor_core_bg.wasm into the plugin's wasm/ folder.

use wasm_bindgen::prelude::*;

#[derive(Clone, Copy)]
struct Rgb {
    r: f64,
    g: f64,
    b: f64,
}

// ---------- Tone mapping ----------
fn apply_tone(
    raw: f64,
    brightness: f64,
    contrast: f64,
    gamma: f64,
    white_clip: f64,
    posterize: f64,
    invert: bool,
) -> f64 {
    let mut v = raw * brightness;
    v = (v - 128.0) * contrast + 128.0;
    v = v.max(0.0).min(255.0);
    v = 255.0 * (v / 255.0).powf(1.0 / gamma);
    if posterize > 0.0 {
        v = ((v / 255.0 * posterize).round() / posterize) * 255.0;
    }
    let white_clip_val = (white_clip / 100.0) * 255.0;
    if white_clip_val < 255.0 && white_clip_val > 0.0 {
        v = v.min(white_clip_val) * (255.0 / white_clip_val);
    }
    v = v.max(0.0).min(255.0);
    if invert {
        v = 255.0 - v;
    }
    v
}

// Simple xorshift PRNG so dropout/jitter/noise are deterministic per call
// without needing the `rand` crate (keeps the WASM binary small).
struct Rng {
    state: u32,
}
impl Rng {
    fn new(seed: u32) -> Self {
        Rng { state: if seed == 0 { 0x9E3779B9 } else { seed } }
    }
    fn next_f64(&mut self) -> f64 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17;
        self.state ^= self.state << 5;
        (self.state as f64) / (u32::MAX as f64)
    }
}

// ---------- Main grid renderer ----------
// mode: 0=bars, 1=dots, 2=blocks, 3=lines (ASCII stays in JS, mode 4 is a
// no-op grid pass that still runs post-effects on a blank/JS-prefilled buffer)
#[wasm_bindgen]
pub fn build_phosphor_buffer(
    src_data: &[u8],
    src_width: u32,
    src_height: u32,
    src_components: u32,
    cell_size: f64,
    fill_width: f64,
    jitter: f64,
    dropout: f64,
    brightness: f64,
    contrast: f64,
    gamma: f64,
    threshold: f64,
    white_clip: f64,
    posterize: f64,
    invert: bool,
    bg_r: u8,
    bg_g: u8,
    bg_b: u8,
    ramp_stop_positions: &[f64],
    ramp_stop_r: &[u8],
    ramp_stop_g: &[u8],
    ramp_stop_b: &[u8],
    mode: u32,
    seed: u32,
) -> Vec<u8> {
    let w = src_width as usize;
    let h = src_height as usize;
    let comp = src_components as usize;
    let mut out = vec![0u8; w * h * 4];

    for i in 0..(w * h) {
        out[i * 4] = bg_r;
        out[i * 4 + 1] = bg_g;
        out[i * 4 + 2] = bg_b;
        out[i * 4 + 3] = 255;
    }

    let get_ramp_color = |t: f64| -> Rgb {
        let n = ramp_stop_positions.len();
        if n == 0 {
            return Rgb { r: 255.0, g: 255.0, b: 255.0 };
        }
        if t <= ramp_stop_positions[0] {
            return Rgb {
                r: ramp_stop_r[0] as f64,
                g: ramp_stop_g[0] as f64,
                b: ramp_stop_b[0] as f64,
            };
        }
        if t >= ramp_stop_positions[n - 1] {
            return Rgb {
                r: ramp_stop_r[n - 1] as f64,
                g: ramp_stop_g[n - 1] as f64,
                b: ramp_stop_b[n - 1] as f64,
            };
        }
        for i in 0..(n - 1) {
            let (pa, pb) = (ramp_stop_positions[i], ramp_stop_positions[i + 1]);
            if t >= pa && t <= pb {
                let local_t = if pb == pa { 0.0 } else { (t - pa) / (pb - pa) };
                let ra = ramp_stop_r[i] as f64;
                let rb = ramp_stop_r[i + 1] as f64;
                let ga = ramp_stop_g[i] as f64;
                let gb = ramp_stop_g[i + 1] as f64;
                let ba = ramp_stop_b[i] as f64;
                let bb = ramp_stop_b[i + 1] as f64;
                return Rgb {
                    r: ra + (rb - ra) * local_t,
                    g: ga + (gb - ga) * local_t,
                    b: ba + (bb - ba) * local_t,
                };
            }
        }
        Rgb { r: 255.0, g: 255.0, b: 255.0 }
    };

    let cols = ((w as f64) / cell_size).floor().max(1.0) as usize;
    let rows = ((h as f64) / cell_size).floor().max(1.0) as usize;
    let mut rng = Rng::new(seed);

    for gy in 0..rows {
        for gx in 0..cols {
            if dropout > 0.0 && rng.next_f64() < dropout {
                continue;
            }

            let sx = ((gx as f64) * cell_size + cell_size / 2.0).floor().min((w - 1) as f64) as usize;
            let sy = ((gy as f64) * cell_size + cell_size / 2.0).floor().min((h - 1) as f64) as usize;
            let s_idx = (sy * w + sx) * comp;

            let r = src_data[s_idx] as f64;
            let g = src_data[s_idx + 1] as f64;
            let b = src_data[s_idx + 2] as f64;
            let lum_raw = r * 0.299 + g * 0.587 + b * 0.114;
            let lum = apply_tone(lum_raw, brightness, contrast, gamma, white_clip, posterize, invert);
            if lum < threshold {
                continue;
            }
            let t = lum / 255.0;
            let col = get_ramp_color(t);

            let mut cx = (gx as f64) * cell_size;
            let mut cy = (gy as f64) * cell_size;
            if jitter > 0.0 {
                cx += (rng.next_f64() - 0.5) * cell_size * jitter;
                cy += (rng.next_f64() - 0.5) * cell_size * jitter;
            }

            let mut draw_cell_rect = |out: &mut Vec<u8>, rx: f64, ry: f64, rw: f64, rh: f64, alpha: f64| {
                let rx = rx.round() as i64;
                let ry = ry.round() as i64;
                let rw = rw.round().max(1.0) as i64;
                let rh = rh.round().max(1.0) as i64;
                for py in ry..(ry + rh) {
                    if py < 0 || py >= h as i64 {
                        continue;
                    }
                    for px in rx..(rx + rw) {
                        if px < 0 || px >= w as i64 {
                            continue;
                        }
                        let o_idx = (py as usize * w + px as usize) * 4;
                        out[o_idx] = (col.r * alpha + out[o_idx] as f64 * (1.0 - alpha)) as u8;
                        out[o_idx + 1] = (col.g * alpha + out[o_idx + 1] as f64 * (1.0 - alpha)) as u8;
                        out[o_idx + 2] = (col.b * alpha + out[o_idx + 2] as f64 * (1.0 - alpha)) as u8;
                        out[o_idx + 3] = 255;
                    }
                }
            };

            match mode {
                0 => {
                    // bars
                    let bar_h = t * cell_size;
                    let bar_w = (cell_size * fill_width).max(1.0);
                    draw_cell_rect(
                        &mut out,
                        cx + (cell_size - bar_w) / 2.0,
                        cy + (cell_size - bar_h),
                        bar_w,
                        bar_h,
                        t,
                    );
                }
                1 => {
                    // dots
                    let radius = (t * cell_size) / 2.2;
                    let ccx = cx + cell_size / 2.0;
                    let ccy = cy + cell_size / 2.0;
                    let py0 = (ccy - radius).floor() as i64;
                    let py1 = (ccy + radius).ceil() as i64;
                    let px0 = (ccx - radius).floor() as i64;
                    let px1 = (ccx + radius).ceil() as i64;
                    for py in py0..=py1 {
                        if py < 0 || py >= h as i64 {
                            continue;
                        }
                        for px in px0..=px1 {
                            if px < 0 || px >= w as i64 {
                                continue;
                            }
                            let dx = px as f64 - ccx;
                            let dy = py as f64 - ccy;
                            if dx * dx + dy * dy <= radius * radius {
                                let o_idx = (py as usize * w + px as usize) * 4;
                                out[o_idx] = col.r as u8;
                                out[o_idx + 1] = col.g as u8;
                                out[o_idx + 2] = col.b as u8;
                                out[o_idx + 3] = 255;
                            }
                        }
                    }
                }
                2 => {
                    // blocks
                    let bw = cell_size * fill_width;
                    let bh = cell_size * fill_width;
                    draw_cell_rect(&mut out, cx + (cell_size - bw) / 2.0, cy + (cell_size - bh) / 2.0, bw, bh, t);
                }
                3 => {
                    // lines
                    let line_len = t * cell_size;
                    let lh = (cell_size * fill_width * 0.3).max(1.0);
                    draw_cell_rect(&mut out, cx, cy + (cell_size - lh) / 2.0, line_len.max(1.0), lh, t);
                }
                _ => {}
            }
        }
    }

    out
}

// ---------- Post effects ----------

#[wasm_bindgen]
pub fn apply_glow(buf: &mut [u8], width: u32, height: u32, radius: f64, amount: f64) {
    if radius <= 0.0 || amount <= 0.0 {
        return;
    }
    let w = width as usize;
    let h = height as usize;
    let r = (radius.round() as i64).max(1);
    let mut temp = vec![0f64; buf.len()];

    for y in 0..h {
        for x in 0..w {
            let mut sr = 0f64;
            let mut sg = 0f64;
            let mut sb = 0f64;
            let mut count = 0f64;
            for k in -r..=r {
                let xx = x as i64 + k;
                if xx < 0 || xx >= w as i64 {
                    continue;
                }
                let idx = (y * w + xx as usize) * 4;
                sr += buf[idx] as f64;
                sg += buf[idx + 1] as f64;
                sb += buf[idx + 2] as f64;
                count += 1.0;
            }
            let o_idx = (y * w + x) * 4;
            temp[o_idx] = sr / count;
            temp[o_idx + 1] = sg / count;
            temp[o_idx + 2] = sb / count;
        }
    }

    for x in 0..w {
        for y in 0..h {
            let mut sr = 0f64;
            let mut sg = 0f64;
            let mut sb = 0f64;
            let mut count = 0f64;
            for k in -r..=r {
                let yy = y as i64 + k;
                if yy < 0 || yy >= h as i64 {
                    continue;
                }
                let idx = (yy as usize * w + x) * 4;
                sr += temp[idx];
                sg += temp[idx + 1];
                sb += temp[idx + 2];
                count += 1.0;
            }
            let o_idx = (y * w + x) * 4;
            let blur_r = sr / count;
            let blur_g = sg / count;
            let blur_b = sb / count;
            buf[o_idx] = (buf[o_idx] as f64 + blur_r * amount).min(255.0) as u8;
            buf[o_idx + 1] = (buf[o_idx + 1] as f64 + blur_g * amount).min(255.0) as u8;
            buf[o_idx + 2] = (buf[o_idx + 2] as f64 + blur_b * amount).min(255.0) as u8;
        }
    }
}

#[wasm_bindgen]
pub fn apply_chromatic_aberration(buf: &mut [u8], width: u32, height: u32, shift: i32) {
    let w = width as usize;
    let h = height as usize;
    let snap = buf.to_vec();
    for y in 0..h {
        for x in 0..w {
            let o_idx = (y * w + x) * 4;
            let left_x = (x as i32 - shift).max(0) as usize;
            let right_x = (x as i32 + shift).min(w as i32 - 1) as usize;
            let left_idx = (y * w + left_x) * 4;
            let right_idx = (y * w + right_x) * 4;
            buf[o_idx] = ((snap[o_idx] as f64 * 0.5) + (snap[left_idx] as f64 * 0.5)).min(255.0) as u8;
            buf[o_idx + 2] = ((snap[o_idx + 2] as f64 * 0.5) + (snap[right_idx + 2] as f64 * 0.5)).min(255.0) as u8;
        }
    }
}

#[wasm_bindgen]
pub fn apply_noise(buf: &mut [u8], width: u32, height: u32, amount: f64, seed: u32) {
    let w = width as usize;
    let h = height as usize;
    let mut rng = Rng::new(seed);
    for i in 0..(w * h) {
        let idx = i * 4;
        let n = (rng.next_f64() - 0.5) * 255.0 * amount;
        buf[idx] = (buf[idx] as f64 + n).max(0.0).min(255.0) as u8;
        buf[idx + 1] = (buf[idx + 1] as f64 + n).max(0.0).min(255.0) as u8;
        buf[idx + 2] = (buf[idx + 2] as f64 + n).max(0.0).min(255.0) as u8;
    }
}

#[wasm_bindgen]
pub fn apply_tracking_jitter(
    buf: &mut [u8],
    width: u32,
    height: u32,
    amount: f64,
    bg_r: u8,
    bg_g: u8,
    bg_b: u8,
    seed: u32,
) {
    let w = width as usize;
    let h = height as usize;
    let snap = buf.to_vec();
    let mut rng = Rng::new(seed);
    let band_height = (h / 40).max(4);

    let mut y0 = 0usize;
    while y0 < h {
        let burst = if rng.next_f64() < 0.15 { 3.0 } else { 1.0 };
        let shift = ((rng.next_f64() - 0.5) * amount * burst).round() as i64;
        let y1 = (y0 + band_height).min(h);
        for y in y0..y1 {
            for x in 0..w {
                let src_x = x as i64 - shift;
                let o_idx = (y * w + x) * 4;
                if src_x < 0 || src_x >= w as i64 {
                    buf[o_idx] = bg_r;
                    buf[o_idx + 1] = bg_g;
                    buf[o_idx + 2] = bg_b;
                } else {
                    let s_idx = (y * w + src_x as usize) * 4;
                    buf[o_idx] = snap[s_idx];
                    buf[o_idx + 1] = snap[s_idx + 1];
                    buf[o_idx + 2] = snap[s_idx + 2];
                }
            }
        }
        y0 += band_height;
    }
}

#[wasm_bindgen]
pub fn apply_vignette(buf: &mut [u8], width: u32, height: u32, amount: f64, reach_frac: f64) {
    let w = width as usize;
    let h = height as usize;
    let cx = w as f64 / 2.0;
    let cy = h as f64 / 2.0;
    let inner_r = (w.min(h) as f64) * 0.2;
    let outer_r = (w.max(h) as f64) * reach_frac;
    for y in 0..h {
        for x in 0..w {
            let dx = x as f64 - cx;
            let dy = y as f64 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let mut f = (dist - inner_r) / (outer_r - inner_r).max(1.0);
            f = f.max(0.0).min(1.0);
            let darken = 1.0 - f * amount;
            let idx = (y * w + x) * 4;
            buf[idx] = (buf[idx] as f64 * darken) as u8;
            buf[idx + 1] = (buf[idx + 1] as f64 * darken) as u8;
            buf[idx + 2] = (buf[idx + 2] as f64 * darken) as u8;
        }
    }
}

#[wasm_bindgen]
pub fn apply_curvature_shading(buf: &mut [u8], width: u32, height: u32, amount: f64) {
    let w = width as usize;
    let h = height as usize;
    let corners = [(0.0, 0.0), (w as f64, 0.0), (0.0, h as f64), (w as f64, h as f64)];
    let corner_r = (w.min(h) as f64) * 0.45;
    for y in 0..h {
        for x in 0..w {
            let mut darken = 1.0;
            for (ccx, ccy) in corners.iter() {
                let dx = x as f64 - ccx;
                let dy = y as f64 - ccy;
                let dist = (dx * dx + dy * dy).sqrt();
                let f = (1.0 - dist / corner_r).max(0.0);
                darken -= f * amount * 0.8;
            }
            darken = darken.max(0.15);
            let idx = (y * w + x) * 4;
            buf[idx] = (buf[idx] as f64 * darken) as u8;
            buf[idx + 1] = (buf[idx + 1] as f64 * darken) as u8;
            buf[idx + 2] = (buf[idx + 2] as f64 * darken) as u8;
        }
    }
}

#[wasm_bindgen]
pub fn apply_scanlines(buf: &mut [u8], width: u32, height: u32, intensity: f64, spacing: u32) {
    let w = width as usize;
    let h = height as usize;
    let spacing = spacing.max(1) as usize;
    let line_height = (spacing / 2).max(1);
    let mut y = 0usize;
    while y < h {
        let y_end = (y + line_height).min(h);
        for ly in y..y_end {
            for x in 0..w {
                let idx = (ly * w + x) * 4;
                buf[idx] = (buf[idx] as f64 * (1.0 - intensity)) as u8;
                buf[idx + 1] = (buf[idx + 1] as f64 * (1.0 - intensity)) as u8;
                buf[idx + 2] = (buf[idx + 2] as f64 * (1.0 - intensity)) as u8;
            }
        }
        y += spacing;
    }
}

#[wasm_bindgen]
pub fn apply_bezel(buf: &mut [u8], width: u32, height: u32, bezel_width: u32) {
    let w = width as usize;
    let h = height as usize;
    let bw = (bezel_width.max(1)) as usize;
    for y in 0..h {
        for x in 0..w {
            if x < bw || x >= w - bw || y < bw || y >= h - bw {
                let idx = (y * w + x) * 4;
                buf[idx] = 0;
                buf[idx + 1] = 0;
                buf[idx + 2] = 0;
            }
        }
    }
}
