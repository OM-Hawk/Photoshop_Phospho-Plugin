/* @ts-self-types="./phosphor_core.d.ts" */

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} bezel_width
 */
export function apply_bezel(buf, width, height, bezel_width) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_bezel(ptr0, len0, buf, width, height, bezel_width);
}

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} shift
 */
export function apply_chromatic_aberration(buf, width, height, shift) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_chromatic_aberration(ptr0, len0, buf, width, height, shift);
}

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} amount
 */
export function apply_curvature_shading(buf, width, height, amount) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_curvature_shading(ptr0, len0, buf, width, height, amount);
}

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @param {number} amount
 */
export function apply_glow(buf, width, height, radius, amount) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_glow(ptr0, len0, buf, width, height, radius, amount);
}

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} amount
 * @param {number} seed
 */
export function apply_noise(buf, width, height, amount, seed) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_noise(ptr0, len0, buf, width, height, amount, seed);
}

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} intensity
 * @param {number} spacing
 */
export function apply_scanlines(buf, width, height, intensity, spacing) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_scanlines(ptr0, len0, buf, width, height, intensity, spacing);
}

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} amount
 * @param {number} bg_r
 * @param {number} bg_g
 * @param {number} bg_b
 * @param {number} seed
 */
export function apply_tracking_jitter(buf, width, height, amount, bg_r, bg_g, bg_b, seed) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_tracking_jitter(ptr0, len0, buf, width, height, amount, bg_r, bg_g, bg_b, seed);
}

/**
 * @param {Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} amount
 * @param {number} reach_frac
 */
export function apply_vignette(buf, width, height, amount, reach_frac) {
    var ptr0 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.apply_vignette(ptr0, len0, buf, width, height, amount, reach_frac);
}

/**
 * @param {Uint8Array} src_data
 * @param {number} src_width
 * @param {number} src_height
 * @param {number} src_components
 * @param {number} cell_size
 * @param {number} fill_width
 * @param {number} jitter
 * @param {number} dropout
 * @param {number} brightness
 * @param {number} contrast
 * @param {number} gamma
 * @param {number} threshold
 * @param {number} white_clip
 * @param {number} posterize
 * @param {boolean} invert
 * @param {number} bg_r
 * @param {number} bg_g
 * @param {number} bg_b
 * @param {Float64Array} ramp_stop_positions
 * @param {Uint8Array} ramp_stop_r
 * @param {Uint8Array} ramp_stop_g
 * @param {Uint8Array} ramp_stop_b
 * @param {number} mode
 * @param {number} seed
 * @returns {Uint8Array}
 */
export function build_phosphor_buffer(src_data, src_width, src_height, src_components, cell_size, fill_width, jitter, dropout, brightness, contrast, gamma, threshold, white_clip, posterize, invert, bg_r, bg_g, bg_b, ramp_stop_positions, ramp_stop_r, ramp_stop_g, ramp_stop_b, mode, seed) {
    const ptr0 = passArray8ToWasm0(src_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(ramp_stop_positions, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(ramp_stop_r, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(ramp_stop_g, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(ramp_stop_b, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.build_phosphor_buffer(ptr0, len0, src_width, src_height, src_components, cell_size, fill_width, jitter, dropout, brightness, contrast, gamma, threshold, white_clip, posterize, invert, bg_r, bg_g, bg_b, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, mode, seed);
    var v6 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v6;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_c5728021fabd0236: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./phosphor_core_bg.js": import0,
    };
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('phosphor_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
