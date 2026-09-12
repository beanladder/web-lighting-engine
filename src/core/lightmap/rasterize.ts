import * as THREE from 'three';

/**
 * Lightmap-space rasterizer.
 *
 * Walks every triangle in `uv1` space and records, for each covered texel, the
 * world position / normal / albedo of the surface point that lands there. Those
 * are the shading points the path tracer later solves for.
 */

export interface RasterInput {
  id: string;
  geometry: THREE.BufferGeometry;
  matrixWorld: THREE.Matrix4;
  material: THREE.Material | THREE.Material[];
}

export interface RasterOutput {
  size: number;
  /** size*size*3 world-space positions. */
  position: Float32Array;
  /** size*size*3 world-space normals. */
  normal: Float32Array;
  /** size*size*3 linear albedo, used for bounce colour and combined export. */
  albedo: Float32Array;
  /** size*size, 1 where a surface covers the texel. */
  mask: Uint8Array;
  covered: number;
}

type AlbedoSampler = (u: number, v: number, out: Float32Array, offset: number) => void;

const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

function imageData(texture: THREE.Texture): ImageData | null {
  const source = texture.image as
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageBitmap
    | { data?: ArrayLike<number>; width?: number; height?: number }
    | undefined;
  if (!source) return null;

  // DataTextures already hand us pixels.
  if ('data' in source && source.data && source.width && source.height) {
    const data = source.data;
    const out = new Uint8ClampedArray(source.width * source.height * 4);
    const isFloat = !(data instanceof Uint8Array || data instanceof Uint8ClampedArray);
    for (let i = 0; i < out.length; i++) {
      const value = data[i] ?? (i % 4 === 3 ? (isFloat ? 1 : 255) : 0);
      out[i] = isFloat ? value * 255 : value;
    }
    return new ImageData(out, source.width, source.height);
  }

  const width = (source as HTMLImageElement).width;
  const height = (source as HTMLImageElement).height;
  if (!width || !height) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source as CanvasImageSource, 0, 0);
    return context.getImageData(0, 0, width, height);
  } catch {
    // Cross-origin or compressed textures: fall back to the flat colour.
    return null;
  }
}

/**
 * Builds a bilinear sampler for a material's base colour, folding in the
 * material tint. Textures we cannot read (compressed, tainted) degrade to the
 * tint alone rather than failing the bake.
 */
function createAlbedoSampler(material: THREE.Material | undefined): AlbedoSampler {
  const standard = material as THREE.MeshStandardMaterial | undefined;
  const tint = new THREE.Color(1, 1, 1);
  if (standard?.color) tint.copy(standard.color);

  const map = standard?.map ?? null;
  const pixels = map ? imageData(map) : null;

  if (!map || !pixels) {
    return (_u, _v, out, offset) => {
      out[offset] = tint.r;
      out[offset + 1] = tint.g;
      out[offset + 2] = tint.b;
    };
  }

  const { width, height, data } = pixels;
  const isSRGB = map.colorSpace === THREE.SRGBColorSpace;
  const flipY = map.flipY;
  const repeatX = map.repeat.x;
  const repeatY = map.repeat.y;
  const offsetX = map.offset.x;
  const offsetY = map.offset.y;

  const fetch = (x: number, y: number, out: Float32Array) => {
    const i = (y * width + x) * 4;
    if (isSRGB) {
      out[0] = SRGB_TO_LINEAR[data[i]];
      out[1] = SRGB_TO_LINEAR[data[i + 1]];
      out[2] = SRGB_TO_LINEAR[data[i + 2]];
    } else {
      out[0] = data[i] / 255;
      out[1] = data[i + 1] / 255;
      out[2] = data[i + 2] / 255;
    }
  };

  const c00 = new Float32Array(3);
  const c10 = new Float32Array(3);
  const c01 = new Float32Array(3);
  const c11 = new Float32Array(3);

  return (u, v, out, offset) => {
    let su = u * repeatX + offsetX;
    let sv = v * repeatY + offsetY;
    if (flipY) sv = 1 - sv;
    su -= Math.floor(su);
    sv -= Math.floor(sv);

    const fx = su * width - 0.5;
    const fy = sv * height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const wrap = (value: number, size: number) => ((value % size) + size) % size;
    const xa = wrap(x0, width);
    const xb = wrap(x0 + 1, width);
    const ya = wrap(y0, height);
    const yb = wrap(y0 + 1, height);

    fetch(xa, ya, c00);
    fetch(xb, ya, c10);
    fetch(xa, yb, c01);
    fetch(xb, yb, c11);

    for (let i = 0; i < 3; i++) {
      const top = c00[i] + (c10[i] - c00[i]) * tx;
      const bottom = c01[i] + (c11[i] - c01[i]) * tx;
      out[offset + i] = (top + (bottom - top) * ty) * (i === 0 ? tint.r : i === 1 ? tint.g : tint.b);
    }
  };
}

/** Maps each triangle to its material slot, honouring geometry groups. */
function triangleMaterials(geometry: THREE.BufferGeometry, triCount: number): Uint16Array {
  const result = new Uint16Array(triCount);
  if (!geometry.groups.length) return result;
  for (const group of geometry.groups) {
    const start = Math.floor(group.start / 3);
    const end = group.count === Infinity ? triCount : Math.floor((group.start + group.count) / 3);
    for (let t = start; t < Math.min(end, triCount); t++) result[t] = group.materialIndex ?? 0;
  }
  return result;
}

export async function rasterizeToAtlas(
  inputs: RasterInput[],
  size: number,
  onProgress?: (progress: number, note: string) => void,
): Promise<RasterOutput> {
  const position = new Float32Array(size * size * 3);
  const normal = new Float32Array(size * size * 3);
  const albedo = new Float32Array(size * size * 3);
  const mask = new Uint8Array(size * size);

  const normalMatrix = new THREE.Matrix3();
  const vertex = new THREE.Vector3();
  const worldPositions: Float32Array[] = [];
  const worldNormals: Float32Array[] = [];

  // Pre-transform everything into world space once.
  for (const input of inputs) {
    const pos = input.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nrm = input.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const wp = new Float32Array(pos.count * 3);
    const wn = new Float32Array(pos.count * 3);
    normalMatrix.getNormalMatrix(input.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      vertex.fromBufferAttribute(pos, i).applyMatrix4(input.matrixWorld);
      wp[i * 3] = vertex.x;
      wp[i * 3 + 1] = vertex.y;
      wp[i * 3 + 2] = vertex.z;
      if (nrm) {
        vertex.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
        wn[i * 3] = vertex.x;
        wn[i * 3 + 1] = vertex.y;
        wn[i * 3 + 2] = vertex.z;
      }
    }
    worldPositions.push(wp);
    worldNormals.push(wn);
  }

  const scratch = new Float32Array(3);

  for (let m = 0; m < inputs.length; m++) {
    const input = inputs[m];
    const uvAttr = input.geometry.getAttribute('uv1') as THREE.BufferAttribute | undefined;
    if (!uvAttr) continue;
    const uv0Attr = input.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const pos = input.geometry.getAttribute('position') as THREE.BufferAttribute;
    const hasNormals = !!input.geometry.getAttribute('normal');
    const triCount = Math.floor(pos.count / 3);
    const wp = worldPositions[m];
    const wn = worldNormals[m];

    const materials = Array.isArray(input.material) ? input.material : [input.material];
    const samplers = materials.map((mat) => createAlbedoSampler(mat));
    const triMaterial = triangleMaterials(input.geometry, triCount);

    onProgress?.(m / inputs.length, 'Rasterizing mesh ' + (m + 1) + '/' + inputs.length);

    // Two passes: exact coverage first, then a one-texel conservative pass that
    // only claims texels the strict pass missed. Without it, chart borders end
    // up black and bilinear filtering drags that into the surface.
    for (let pass = 0; pass < 2; pass++) {
      const expand = pass === 0 ? 0 : 1;
      for (let t = 0; t < triCount; t++) {
        const i0 = t * 3;
        const i1 = t * 3 + 1;
        const i2 = t * 3 + 2;

        const ax = uvAttr.getX(i0) * size;
        const ay = uvAttr.getY(i0) * size;
        const bx = uvAttr.getX(i1) * size;
        const by = uvAttr.getY(i1) * size;
        const cx = uvAttr.getX(i2) * size;
        const cy = uvAttr.getY(i2) * size;

        const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(area) < 1e-12) continue;
        const invArea = 1 / area;

        const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - expand));
        const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx) + expand));
        const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - expand));
        const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy) + expand));
        if (minX > maxX || minY > maxY) continue;

        const sampler = samplers[Math.min(triMaterial[t], samplers.length - 1)];

        for (let y = minY; y <= maxY; y++) {
          const py = y + 0.5;
          for (let x = minX; x <= maxX; x++) {
            const texel = y * size + x;
            if (mask[texel]) continue;
            const px = x + 0.5;

            let w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * invArea;
            let w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * invArea;
            let w2 = 1 - w0 - w1;

            if (pass === 0) {
              if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            } else {
              // Snap just-outside texels onto the nearest point of the triangle.
              if (w0 < -0.5 || w1 < -0.5 || w2 < -0.5) continue;
              w0 = Math.max(w0, 0);
              w1 = Math.max(w1, 0);
              w2 = Math.max(w2, 0);
              const sum = w0 + w1 + w2;
              if (sum <= 0) continue;
              w0 /= sum;
              w1 /= sum;
              w2 /= sum;
            }

            const o = texel * 3;
            position[o] = wp[i0 * 3] * w0 + wp[i1 * 3] * w1 + wp[i2 * 3] * w2;
            position[o + 1] = wp[i0 * 3 + 1] * w0 + wp[i1 * 3 + 1] * w1 + wp[i2 * 3 + 1] * w2;
            position[o + 2] = wp[i0 * 3 + 2] * w0 + wp[i1 * 3 + 2] * w1 + wp[i2 * 3 + 2] * w2;

            if (hasNormals) {
              let nx = wn[i0 * 3] * w0 + wn[i1 * 3] * w1 + wn[i2 * 3] * w2;
              let ny = wn[i0 * 3 + 1] * w0 + wn[i1 * 3 + 1] * w1 + wn[i2 * 3 + 1] * w2;
              let nz = wn[i0 * 3 + 2] * w0 + wn[i1 * 3 + 2] * w1 + wn[i2 * 3 + 2] * w2;
              const len = Math.hypot(nx, ny, nz) || 1;
              nx /= len;
              ny /= len;
              nz /= len;
              normal[o] = nx;
              normal[o + 1] = ny;
              normal[o + 2] = nz;
            } else {
              const e1x = wp[i1 * 3] - wp[i0 * 3];
              const e1y = wp[i1 * 3 + 1] - wp[i0 * 3 + 1];
              const e1z = wp[i1 * 3 + 2] - wp[i0 * 3 + 2];
              const e2x = wp[i2 * 3] - wp[i0 * 3];
              const e2y = wp[i2 * 3 + 1] - wp[i0 * 3 + 1];
              const e2z = wp[i2 * 3 + 2] - wp[i0 * 3 + 2];
              let nx = e1y * e2z - e1z * e2y;
              let ny = e1z * e2x - e1x * e2z;
              let nz = e1x * e2y - e1y * e2x;
              const len = Math.hypot(nx, ny, nz) || 1;
              normal[o] = nx / len;
              normal[o + 1] = ny / len;
              normal[o + 2] = nz / len;
            }

            if (uv0Attr) {
              const u = uv0Attr.getX(i0) * w0 + uv0Attr.getX(i1) * w1 + uv0Attr.getX(i2) * w2;
              const v = uv0Attr.getY(i0) * w0 + uv0Attr.getY(i1) * w1 + uv0Attr.getY(i2) * w2;
              sampler(u, v, albedo, o);
            } else {
              sampler(0, 0, scratch, 0);
              albedo[o] = scratch[0];
              albedo[o + 1] = scratch[1];
              albedo[o + 2] = scratch[2];
            }

            mask[texel] = 1;
          }
        }

        if ((t & 4095) === 0) await yieldToUI();
      }
    }
  }

  let covered = 0;
  for (let i = 0; i < mask.length; i++) covered += mask[i];

  onProgress?.(1, 'Rasterized ' + covered.toLocaleString() + ' texels');

  return { size, position, normal, albedo, mask, covered };
}

/** Flattens the covered texels into the flat arrays a worker consumes. */
export function collectSamples(raster: RasterOutput) {
  const { mask, position, normal, covered } = raster;
  const positions = new Float32Array(covered * 3);
  const normals = new Float32Array(covered * 3);
  const texelIndex = new Uint32Array(covered);
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    positions[n * 3] = position[i * 3];
    positions[n * 3 + 1] = position[i * 3 + 1];
    positions[n * 3 + 2] = position[i * 3 + 2];
    normals[n * 3] = normal[i * 3];
    normals[n * 3 + 1] = normal[i * 3 + 1];
    normals[n * 3 + 2] = normal[i * 3 + 2];
    texelIndex[n] = i;
    n++;
  }
  return { positions, normals, texelIndex, count: n };
}
