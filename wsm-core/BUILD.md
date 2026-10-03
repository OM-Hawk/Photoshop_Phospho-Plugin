# Phosphor // Scan — WASM Core Build & Integration Guide

This adds a Rust-compiled WASM module for the hot per-pixel rendering loops
(grid fill + all post-effects except ASCII glyphs, which stay in JS).
UXP supports WebAssembly directly but NOT Web Workers — so this gives a
faster crunch on the main thread, not a non-blocking one. Dragging a slider
still pauses briefly during render; it should just be a shorter pause.

## 1. One-time toolchain setup (you need to do this locally)

Install Rust (if you don't have it):
https://www.rust-lang.org/tools/install

Then install wasm-pack:
```
cargo install wasm-pack
```

Verify:
```
rustc --version
wasm-pack --version
```

## 2. Build the WASM module

From inside the `wasm-core/` folder (alongside this file):
```
cd wasm-core
wasm-pack build --target web --release
```

This produces a `pkg/` folder containing:
- `phosphor_core.js` — the JS glue/loader wasm-bindgen generates
- `phosphor_core_bg.wasm` — the compiled binary
- a few other files (`.d.ts`, `package.json`) you can ignore for this use case

## 3. Copy into the plugin

Create a `wasm/` folder inside your main plugin folder (alongside
`index.html`, `index.js`, `manifest.json`, `font5x7.js`) and copy these two
files into it:
```
phosphor-plugin/
  wasm/
    phosphor_core.js
    phosphor_core_bg.wasm
  index.html
  index.js
  font5x7.js
  manifest.json
```

## 4. Update the manifest (if needed)

UXP manifest v5 should already allow loading local module files via the
plugin's own folder without extra permissions, since `.wasm` files are
treated as static plugin assets. If you hit a permissions or CSP-style
error on load, that's the first place to check — but this typically isn't
required for same-origin plugin files.

## 5. Reload in UDT

Use Load & Watch so changes to index.js are picked up, then test as usual.
The WASM module loads asynchronously on panel startup — if you click
Preview/Apply before it's finished loading, the code falls back to the
pure-JS renderer automatically (see `wasmReady` flag in index.js) so the
plugin keeps working even before/if WASM fails to load.

## What ported, what didn't

**Ported to Rust/WASM:**
- Grid fill for bars, dots, blocks, lines modes
- Tone mapping (brightness, contrast, gamma, threshold, white clip, posterize, invert)
- Color ramp interpolation
- Glow/bloom, chromatic aberration, noise, tracking jitter, vignette,
  curvature shading, scanlines, bezel

**Stayed in JS:**
- ASCII glyph mode (font lookup + glyph blitting) — cheap relative to the
  other modes, porting the font table added complexity without much payoff
- All UI logic, settings reading, layer read/write via the Photoshop
  `imaging` API — none of that is per-pixel work, no reason to move it

## Troubleshooting

- **"cargo: command not found"** — Rust isn't installed or isn't on PATH.
  Restart your terminal after installing, or check the installer's PATH
  instructions for your OS.
- **wasm-pack build fails with linker errors** — usually means a stale
  Rust install; try `rustup update` first.
- **Plugin loads but WASM functions throw "not a function"** — check the
  browser-style import in index.js matches the actual exported function
  names in `phosphor_core.js` (wasm-bindgen names them after the Rust
  `#[wasm_bindgen] pub fn` signatures, snake_case preserved as-is).
- **Output looks different from the pure-JS version** — the Rust port
  uses an internal xorshift PRNG for jitter/dropout/noise instead of
  JS's `Math.random()`, so exact random patterns won't match seed-for-seed,
  but the statistical look should be equivalent.
