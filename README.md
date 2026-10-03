# Phosphor // Scan

A Photoshop panel that turns a photo into a phosphor / CRT / dot-matrix display, with a live preview on its own layer.

## Features

- **5 render modes:** Dots, Bars, Blocks, Lines, ASCII
- **Two color sources:** a multi-stop color ramp (with presets: green, amber, cyan, magenta, white, vapor, thermal), or the photo's original colors
- **Tone controls:** brightness, contrast, gamma, black/white clip, invert, and posterize in four styles (uniform, Bayer dither, error diffusion, per-channel)
- **Display FX:** glow, scanlines, chromatic aberration, static noise, tracking jitter, screen curvature, vignette, bezel
- **Live preview** on a "Phosphor Preview" layer, with a Fast mode for large images
- **Apply** renders a final full-resolution layer. In Ramp mode it is set to Screen with a Color Overlay from the ramp's top color; in Original mode it is set to Normal.

## Install

1. Download the latest `.ccx` from [Releases](https://github.com/OM-Hawk/Photoshop_Phospho-Plugin/releases).
2. Double-click it. Creative Cloud installs it and may warn that the plugin isn't from the Adobe Marketplace.
3. In Photoshop, open **Plugins → Phosphor // Scan**.

**Requirements:** Photoshop 24.2 or later, and an **8-bit RGB** document. For 16- or 32-bit files, use Image → Mode → 8 Bits/Channel first.

## Usage

1. Open a photo and the panel. With **Live Preview** on, the effect appears on a "Phosphor Preview" layer and updates as you move sliders.
2. Turn on **Fast mode** while adjusting a large image. It previews at reduced resolution.
3. Double-click a slider's number to reset it to the default.
4. Click **Apply** to render the final layer at full resolution. This replaces the preview layer.

Turning Live Preview off deletes the preview layer.

## Development

The plugin is plain JavaScript with no build step.

| File | Contents |
| --- | --- |
| `manifest.json` | UXP manifest (v5) |
| `index.html` | Panel markup and CSS |
| `index.js` | UI wiring and Photoshop calls: reading pixels, preview/output layers, `batchPlay` |
| `render.js` | The render pipeline as pure functions on pixel buffers. No Photoshop or DOM code, so it runs in Node. |
| `font5x7.js` | Bitmap font for ASCII mode |
| `tests/` | Node tests for `render.js` |
| `wsm-core/`, `wasm/` | Unfinished Rust/WebAssembly port of the renderer. Not used: UXP rejects the generated loader, so the plugin always uses `render.js`. |

### Running it in Photoshop

1. Install Adobe's [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/).
2. Click **Add Plugin** and select this repo's `manifest.json`.
3. Click **Load**. **Watch** reloads the plugin when you save a file; **Debug** opens DevTools for console output.

### Tests

Requires Node 18 or later; there are no dependencies to install.

```
npm test
```

The suite renders a fixed synthetic image through every mode and effect and compares a hash of each output with `tests/__snapshots__/render.json`. Randomized effects (noise, jitter, dropout, tracking) use a seeded random number generator, so the output is the same on every run.

If you change how something looks on purpose, check it in Photoshop, then accept the new output:

```
npm run test:update
```

### Packaging a release

A `.ccx` is a zip of the runtime files. Build one from a tag with:

```
git archive --format=zip -o PhosphorScan-<version>.ccx v<version> manifest.json index.html index.js render.js font5x7.js
```

Bump `version` in `manifest.json` before tagging.
