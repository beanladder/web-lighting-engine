import * as THREE from 'three';
import type {
  BakeSettings,
  BakeStats,
  EnvironmentDef,
  LightDef,
  SceneGeometryPayload,
  SerializedEnvironment,
  SerializedLight,
  WorkerRequest,
  WorkerResponse,
} from '../../state/types';
import { packExistingUVs, unwrapForLightmap, type UnwrapInput } from './unwrap';
import { collectSamples, rasterizeToAtlas, type RasterInput } from './rasterize';

export interface BakeTarget {
  id: string;
  mesh: THREE.Mesh;
  lightmapped: boolean;
  occluder: boolean;
}

export interface BakeOutput {
  size: number;
  /** Linear irradiance, RGB per texel, before exposure. */
  raw: Float32Array;
  /** Linear albedo per texel, for the combined/unlit export. */
  albedo: Float32Array;
  /** Coverage mask after dilation. */
  mask: Uint8Array;
  stats: BakeStats;
}

export interface BakeProgress {
  phase: 'unwrapping' | 'preparing' | 'tracing' | 'resolving';
  progress: number;
  note: string;
}

const tempColor = new THREE.Color();

/**
 * Hex string to the linear RGB the solver works in.
 *
 * `Color.set` already moves the value into three's linear working colour space,
 * so converting again here would darken every light.
 */
function linearColor(hex: string, scale = 1): [number, number, number] {
  tempColor.set(hex);
  return [tempColor.r * scale, tempColor.g * scale, tempColor.b * scale];
}

const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const euler = new THREE.Euler();

export function serializeLights(lights: LightDef[]): SerializedLight[] {
  return lights
    .filter((light) => light.enabled && light.bake)
    .map((light) => {
      euler.set(light.rotation[0], light.rotation[1], light.rotation[2], 'XYZ');
      quaternion.setFromEuler(euler);
      // Every light type emits along local -Z, matching three's own convention
      // for directional, spot and rect-area lights.
      forward.set(0, 0, -1).applyQuaternion(quaternion);
      right.set(1, 0, 0).applyQuaternion(quaternion).multiplyScalar(light.width * 0.5);
      up.set(0, 1, 0).applyQuaternion(quaternion).multiplyScalar(light.height * 0.5);

      return {
        type: light.type,
        position: [...light.position] as [number, number, number],
        direction: [forward.x, forward.y, forward.z],
        color: linearColor(light.color, light.intensity),
        distance: light.distance,
        decay: light.decay,
        angle: light.angle,
        penumbra: light.penumbra,
        radius: light.radius,
        width: light.width,
        height: light.height,
        right: [right.x, right.y, right.z],
        up: [up.x, up.y, up.z],
      };
    });
}

export function serializeEnvironment(environment: EnvironmentDef): SerializedEnvironment {
  const active = environment.enabled && environment.bake;
  return {
    skyColor: active ? linearColor(environment.skyColor, environment.intensity) : [0, 0, 0],
    groundColor: active ? linearColor(environment.groundColor, environment.intensity) : [0, 0, 0],
    enabled: active,
  };
}

/**
 * Flattens every occluding mesh into one world-space triangle soup with
 * per-vertex albedo and emissive, which is what the tracer bounces light off.
 * Base-colour textures are not sampled here; bounce colour comes from the
 * material tint and vertex colours, which is plenty for colour bleeding.
 */
function buildSceneGeometry(targets: BakeTarget[]): SceneGeometryPayload & { triangles: number } {
  const occluders = targets.filter((t) => t.occluder);
  let vertexCount = 0;
  let indexCount = 0;

  for (const target of occluders) {
    const geometry = target.mesh.geometry;
    const position = geometry.getAttribute('position');
    vertexCount += position.count;
    indexCount += geometry.index ? geometry.index.count : position.count;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const albedo = new Float32Array(vertexCount * 3);
  const emissive = new Float32Array(vertexCount * 3);
  const index = new Uint32Array(indexCount);

  const vertex = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let vertexBase = 0;
  let indexBase = 0;

  for (const target of occluders) {
    const mesh = target.mesh;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;

    mesh.updateWorldMatrix(true, false);
    normalMatrix.getNormalMatrix(mesh.matrixWorld);

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const base = materials[0] as THREE.MeshStandardMaterial;
    const baseColor = new THREE.Color(1, 1, 1);
    if (base?.color) baseColor.copy(base.color);
    const emissiveColor = new THREE.Color(0, 0, 0);
    if (base?.emissive) {
      emissiveColor.copy(base.emissive).multiplyScalar(base.emissiveIntensity ?? 1);
    }

    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      positions[(vertexBase + i) * 3] = vertex.x;
      positions[(vertexBase + i) * 3 + 1] = vertex.y;
      positions[(vertexBase + i) * 3 + 2] = vertex.z;

      if (normal) {
        vertex.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
        normals[(vertexBase + i) * 3] = vertex.x;
        normals[(vertexBase + i) * 3 + 1] = vertex.y;
        normals[(vertexBase + i) * 3 + 2] = vertex.z;
      } else {
        normals[(vertexBase + i) * 3 + 1] = 1;
      }

      const vr = colorAttr ? colorAttr.getX(i) : 1;
      const vg = colorAttr ? colorAttr.getY(i) : 1;
      const vb = colorAttr ? colorAttr.getZ(i) : 1;
      albedo[(vertexBase + i) * 3] = baseColor.r * vr;
      albedo[(vertexBase + i) * 3 + 1] = baseColor.g * vg;
      albedo[(vertexBase + i) * 3 + 2] = baseColor.b * vb;

      emissive[(vertexBase + i) * 3] = emissiveColor.r;
      emissive[(vertexBase + i) * 3 + 1] = emissiveColor.g;
      emissive[(vertexBase + i) * 3 + 2] = emissiveColor.b;
    }

    if (geometry.index) {
      const source = geometry.index;
      for (let i = 0; i < source.count; i++) index[indexBase + i] = source.getX(i) + vertexBase;
      indexBase += source.count;
    } else {
      for (let i = 0; i < position.count; i++) index[indexBase + i] = vertexBase + i;
      indexBase += position.count;
    }

    vertexBase += position.count;
  }

  return { positions, normals, index, albedo, emissive, triangles: indexCount / 3 };
}

/** Bleeds colour outward past chart edges so bilinear filtering has data to read. */
function dilate(color: Float32Array, mask: Uint8Array, size: number, iterations: number) {
  if (iterations <= 0) return;
  let current = mask;
  for (let pass = 0; pass < iterations; pass++) {
    const next = current.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (current[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const sy = y + dy;
          if (sy < 0 || sy >= size) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx;
            if (sx < 0 || sx >= size) continue;
            const j = sy * size + sx;
            if (!current[j]) continue;
            r += color[j * 3];
            g += color[j * 3 + 1];
            b += color[j * 3 + 2];
            n++;
          }
        }
        if (!n) continue;
        color[i * 3] = r / n;
        color[i * 3 + 1] = g / n;
        color[i * 3 + 2] = b / n;
        next[i] = 1;
      }
    }
    current = next;
  }
  mask.set(current);
}

/**
 * Edge-aware blur. Monte Carlo noise is high frequency and the signal is not,
 * so a luminance-guided box filter removes most of the grain without smearing
 * shadow boundaries.
 */
function denoise(color: Float32Array, mask: Uint8Array, size: number, strength: number) {
  if (strength <= 0) return;
  const source = color.slice();
  const luminance = (i: number) =>
    source[i * 3] * 0.2126 + source[i * 3 + 1] * 0.7152 + source[i * 3 + 2] * 0.0722;
  // Scale the tolerance with the image's own brightness so the filter behaves
  // the same in a dim scene as in a bright one.
  let mean = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    mean += luminance(i);
    count++;
  }
  mean = count ? mean / count : 1;
  const tolerance = Math.max(mean * 0.35, 1e-4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!mask[i]) continue;
      const centre = luminance(i);
      let r = 0;
      let g = 0;
      let b = 0;
      let weightSum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= size) continue;
          const j = sy * size + sx;
          if (!mask[j]) continue;
          const difference = Math.abs(luminance(j) - centre);
          const weight = Math.exp(-(difference * difference) / (tolerance * tolerance));
          r += source[j * 3] * weight;
          g += source[j * 3 + 1] * weight;
          b += source[j * 3 + 2] * weight;
          weightSum += weight;
        }
      }
      if (weightSum <= 0) continue;
      color[i * 3] += (r / weightSum - source[i * 3]) * strength;
      color[i * 3 + 1] += (g / weightSum - source[i * 3 + 1]) * strength;
      color[i * 3 + 2] += (b / weightSum - source[i * 3 + 2]) * strength;
    }
  }
}

function workerCount(requested: number) {
  const cores = navigator.hardwareConcurrency || 4;
  if (requested > 0) return Math.max(1, Math.min(requested, 32));
  // Leave a core for the UI thread so the progress bar keeps moving.
  return Math.max(1, Math.min(cores - 1, 16));
}

export async function bakeLightmap(
  targets: BakeTarget[],
  lights: LightDef[],
  environment: EnvironmentDef,
  settings: BakeSettings,
  onProgress: (progress: BakeProgress) => void,
  signal?: { cancelled: boolean },
): Promise<BakeOutput> {
  const started = performance.now();
  const lightmapped = targets.filter((t) => t.lightmapped);
  if (!lightmapped.length) throw new Error('No meshes are marked for lightmapping.');

  // --- Unwrap ------------------------------------------------------------
  // Lightmap UVs are per-triangle, so the geometry has to be split first.
  for (const target of lightmapped) {
    if (target.mesh.geometry.index) {
      const indexed = target.mesh.geometry;
      target.mesh.geometry = indexed.toNonIndexed();
      indexed.dispose();
    }
    target.mesh.updateWorldMatrix(true, false);
  }

  const unwrapInputs: UnwrapInput[] = lightmapped.map((target) => ({
    id: target.id,
    geometry: target.mesh.geometry,
    matrixWorld: target.mesh.matrixWorld,
  }));

  const unwrapOptions = {
    resolution: settings.resolution,
    padding: settings.padding,
    angleTolerance: 55,
    onProgress: (progress: number, note: string) =>
      onProgress({ phase: 'unwrapping' as const, progress, note }),
  };

  const unwrap =
    settings.unwrap === 'generate'
      ? await unwrapForLightmap(unwrapInputs, unwrapOptions)
      : await packExistingUVs(
          unwrapInputs,
          settings.unwrap === 'existing-uv1' ? 'uv1' : 'uv',
          unwrapOptions,
        );

  if (signal?.cancelled) throw new Error('Bake cancelled');

  // --- Rasterize ---------------------------------------------------------
  const rasterInputs: RasterInput[] = lightmapped.map((target) => ({
    id: target.id,
    geometry: target.mesh.geometry,
    matrixWorld: target.mesh.matrixWorld,
    material: target.mesh.material,
  }));

  const raster = await rasterizeToAtlas(rasterInputs, settings.resolution, (progress, note) =>
    onProgress({ phase: 'preparing', progress, note }),
  );
  if (!raster.covered) throw new Error('Nothing landed in the lightmap — check the UV settings.');
  if (signal?.cancelled) throw new Error('Bake cancelled');

  const samples = collectSamples(raster);
  const scene = buildSceneGeometry(targets);

  // --- Trace -------------------------------------------------------------
  const threads = Math.min(workerCount(settings.threads), Math.max(1, Math.ceil(samples.count / 512)));
  const serializedLights = serializeLights(lights);
  const serializedEnvironment = serializeEnvironment(environment);

  if (!serializedLights.length && !serializedEnvironment.enabled) {
    throw new Error('Nothing to bake — enable at least one light or the environment.');
  }

  const atlas = new Float32Array(settings.resolution * settings.resolution * 3);
  const chunk = Math.ceil(samples.count / threads);
  const progressPerWorker = new Array(threads).fill(0);
  let totalRays = 0;

  onProgress({ phase: 'tracing', progress: 0, note: 'Tracing on ' + threads + ' threads' });

  const jobs = Array.from({ length: threads }, (_, index) => {
    const start = index * chunk;
    const end = Math.min(start + chunk, samples.count);
    const count = Math.max(0, end - start);

    return new Promise<void>((resolve, reject) => {
      if (count === 0) {
        progressPerWorker[index] = 1;
        resolve();
        return;
      }

      const worker = new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });

      const positions = samples.positions.slice(start * 3, end * 3);
      const normals = samples.normals.slice(start * 3, end * 3);
      const texelIndex = samples.texelIndex.slice(start, end);

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === 'progress') {
          progressPerWorker[index] = message.total ? message.done / message.total : 1;
          const total = progressPerWorker.reduce((a, b) => a + b, 0) / threads;
          onProgress({
            phase: 'tracing',
            progress: total,
            note: Math.round(total * 100) + '% · ' + threads + ' threads',
          });
        } else if (message.type === 'result') {
          totalRays += message.rays;
          for (let i = 0; i < message.texelIndex.length; i++) {
            const texel = message.texelIndex[i];
            atlas[texel * 3] = message.color[i * 3];
            atlas[texel * 3 + 1] = message.color[i * 3 + 1];
            atlas[texel * 3 + 2] = message.color[i * 3 + 2];
          }
          worker.terminate();
          resolve();
        } else {
          worker.terminate();
          reject(new Error(message.message));
        }
      };

      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || 'Bake worker failed'));
      };

      const request: WorkerRequest = {
        type: 'bake',
        // Geometry is cloned per worker rather than transferred: every thread
        // needs its own copy to build a BVH from.
        geometry: {
          positions: scene.positions,
          normals: scene.normals,
          index: scene.index,
          albedo: scene.albedo,
          emissive: scene.emissive,
        },
        samples: { positions, normals, texelIndex, count },
        lights: serializedLights,
        environment: serializedEnvironment,
        settings: {
          samples: settings.samples,
          bounces: settings.bounces,
          shadowSamples: settings.shadowSamples,
          rayDistance: settings.rayDistance,
          bias: settings.bias,
          aoStrength: settings.aoStrength,
        },
        seed: 0x9e3779b9 ^ (index * 2654435761),
      };

      worker.postMessage(request, [positions.buffer, normals.buffer, texelIndex.buffer]);
    });
  });

  await Promise.all(jobs);

  // --- Resolve -----------------------------------------------------------
  onProgress({ phase: 'resolving', progress: 0.2, note: 'Denoising' });
  const mask = raster.mask.slice();
  if (settings.denoise) denoise(atlas, mask, settings.resolution, settings.denoiseStrength);

  onProgress({ phase: 'resolving', progress: 0.6, note: 'Dilating edges' });
  dilate(atlas, mask, settings.resolution, settings.dilate);

  const stats: BakeStats = {
    atlasSize: settings.resolution,
    texels: raster.covered,
    charts: unwrap.charts,
    meshes: lightmapped.length,
    triangles: scene.triangles,
    rays: totalRays,
    seconds: (performance.now() - started) / 1000,
  };

  onProgress({ phase: 'resolving', progress: 1, note: 'Done' });

  return { size: settings.resolution, raw: atlas, albedo: raster.albedo, mask, stats };
}

/** Packs linear irradiance into a half-float texture three can sample directly. */
export function createLightmapTexture(
  raw: Float32Array,
  size: number,
  exposure: number,
): THREE.DataTexture {
  const data = new Uint16Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(raw[i * 3] * exposure);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(raw[i * 3 + 1] * exposure);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(raw[i * 3 + 2] * exposure);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.name = 'Lightmap';
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  // Lightmaps live on the second UV set.
  texture.channel = 1;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
