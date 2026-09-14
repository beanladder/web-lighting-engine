/**
 * WebGPU availability, device acquisition and GPU naming for the bake backend.
 *
 * The bake tracer deliberately asks for its **own** adapter and device rather
 * than borrowing the renderer's: three's `WebGPUBackend` requests its device in
 * `compatibility` mode, which can cap storage buffers per stage below what the
 * tracer binds, and the renderer may not be on WebGPU at all (it falls back to
 * WebGL2 — see Viewport). A bake-only device sidesteps both.
 */

export interface GpuInfo {
  available: boolean;
  /** Human-readable GPU name, as good as the browser will give us. */
  name: string | null;
  /** Why WebGPU is unusable, when it is. */
  reason?: string;
}

/**
 * Chrome masks `GPUAdapterInfo.device`/`.description` unless the user has
 * `--enable-webgpu-developer-features` on, so a plain browser reports nothing
 * more specific than "amd / rdna-3". WebGL's debug-renderer extension is *not*
 * masked the same way and still returns the real model, so it is the better
 * source for a display name, with the adapter's own fields preferred whenever
 * they do carry something.
 */
/**
 * Pulls the model out of a WebGL renderer string.
 *
 * Chrome on Windows reports through ANGLE, e.g.
 *   "ANGLE (AMD, AMD Radeon(TM) 860M Graphics (0x00001114) Direct3D11 vs_5_0 ps_5_0, D3D11)"
 * and the useful part is in the middle. Done as steps rather than one regex
 * because the model itself can contain brackets and commas ("Radeon(TM)"),
 * which is exactly what defeats the obvious pattern.
 */
export function cleanRendererString(raw: string): string {
  let text = raw.trim();

  const angle = text.match(/^ANGLE \((.*)\)$/s);
  if (angle) {
    text = angle[1];
    const vendorBreak = text.indexOf(', ');
    if (vendorBreak !== -1) text = text.slice(vendorBreak + 2);

    // Everything from the PCI id (or the graphics API, when there is no id) on
    // is driver detail rather than the name.
    const pciId = text.search(/\s*\(0x[0-9A-Fa-f]+\)/);
    if (pciId !== -1) {
      text = text.slice(0, pciId);
    } else {
      const api = text.search(/\s+(Direct3D|OpenGL|Vulkan|D3D|Metal)/);
      if (api !== -1) text = text.slice(0, api);
    }
  }

  return text.replace(/\((?:TM|R)\)|™|®/g, '').replace(/\s{2,}/g, ' ').trim();
}

function nameFromWebGL(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = debugInfo
      ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string);
    if (!raw) return null;
    return cleanRendererString(raw) || null;
  } catch {
    return null;
  }
}

/** The exact model, when the browser is willing to name it. */
function specificName(info: GPUAdapterInfo | null | undefined): string | null {
  return info ? info.description || info.device || null : null;
}

/** The masked fallback: "amd · rdna-3" and the like. */
function genericName(info: GPUAdapterInfo | null | undefined): string | null {
  if (!info) return null;
  const parts = [info.vendor, info.architecture].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

let cached: Promise<GpuInfo> | null = null;

/** Probes WebGPU once and reports whether the GPU backend can be offered, and on what hardware. */
export function detectGpu(): Promise<GpuInfo> {
  if (!cached) cached = probe();
  return cached;
}

async function probe(): Promise<GpuInfo> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    return { available: false, name: nameFromWebGL(), reason: 'This browser has no WebGPU.' };
  }
  try {
    // Same timed race as the renderer's probe: a blocklisted or flaky driver can
    // leave requestAdapter() pending forever rather than rejecting.
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    if (!adapter) {
      return { available: false, name: nameFromWebGL(), reason: 'No WebGPU adapter available.' };
    }
    // WebGL's name is preferred over the adapter's masked vendor/architecture:
    // "AMD Radeon(TM) 860M Graphics" tells you far more than "amd · rdna-3".
    return {
      available: true,
      name: specificName(adapter.info) ?? nameFromWebGL() ?? genericName(adapter.info) ?? 'WebGPU device',
    };
  } catch (cause) {
    return {
      available: false,
      name: nameFromWebGL(),
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

let devicePromise: Promise<GPUDevice> | null = null;

/** The bake tracer's device, created on first use and reused for later bakes. */
export async function getBakeDevice(): Promise<GPUDevice> {
  if (devicePromise) return devicePromise;

  devicePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      throw new Error('WebGPU is not available in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter available for the GPU baker.');

    const device = await adapter.requestDevice();
    // A lost device can never be reused — drop it so the next bake makes a new one.
    void device.lost.then(() => {
      devicePromise = null;
    });
    return device;
  })();

  try {
    return await devicePromise;
  } catch (cause) {
    devicePromise = null;
    throw cause;
  }
}
