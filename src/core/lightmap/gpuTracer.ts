import type { SamplePayload, SceneGeometryPayload, SerializedEnvironment, SerializedLight } from '../../state/types';
import { getBakeDevice } from '../gpu';
import { buildGpuBvh } from './gpuBvh';
import { TRACER_WGSL } from './gpuTracer.wgsl';

/**
 * GPU path tracer: the same solve as `bakeWorker.ts`, run as a WGSL compute
 * shader instead of across CPU workers.
 *
 * Three structural notes:
 * - It asks `gpu.ts` for its own device rather than borrowing the renderer's
 *   (see that file for why), so this works even when the viewport fell back to
 *   WebGL2.
 * - The BVH is built here on the CPU and uploaded, because `three-mesh-bvh`'s
 *   GPU kit is WebGL/GLSL-shaped; `gpuBvh.ts` owns that layout.
 * - Work is dispatched in batches rather than one giant dispatch. A single
 *   submit covering a whole atlas can run for many seconds, which is how you
 *   trip the OS GPU watchdog and lose the device mid-bake; batching also gives
 *   the progress bar something to report.
 */

/** Bytes per WGSL struct, matching the layouts declared in the shader. */
const VERTEX_STRIDE_FLOATS = 16; // 4 × vec4
const LIGHT_STRIDE_FLOATS = 24; // 6 × vec4
const UNIFORM_BYTES = 80;

const WORKGROUP_SIZE = 64;

/**
 * Batching is adaptive rather than a fixed guess.
 *
 * Two forces pull against each other: a dispatch long enough to trip Windows'
 * ~2s GPU watchdog loses the device mid-bake, while dispatches that are too
 * small leave the GPU idle between round-trips and can end up slower than the
 * CPU backend. Since "how many texels is that" depends on both the settings and
 * the hardware, each batch is timed and the next one is scaled toward a target
 * duration — which self-tunes to whatever GPU is actually present instead of
 * being calibrated against the one it was written on.
 */
const TARGET_BATCH_MS = 250;
const MIN_BATCH_TEXELS = 256;
const MAX_BATCH_TEXELS = 65536;
const START_BATCH_TEXELS = 4096;

export interface GpuTraceSettings {
  samples: number;
  bounces: number;
  shadowSamples: number;
  rayDistance: number;
  bias: number;
  aoStrength: number;
}

export interface GpuTraceResult {
  /** Linear irradiance per sample, 3 floats each, in the order of `samples`. */
  color: Float32Array;
  rays: number;
}

const LIGHT_KIND: Record<SerializedLight['type'], number> = {
  directional: 0,
  point: 1,
  spot: 2,
  area: 3,
};

function packVertices(geometry: SceneGeometryPayload): Float32Array {
  const vertexCount = Math.floor(geometry.positions.length / 3);
  const data = new Float32Array(vertexCount * VERTEX_STRIDE_FLOATS);
  for (let i = 0; i < vertexCount; i++) {
    const o = i * VERTEX_STRIDE_FLOATS;
    data[o] = geometry.positions[i * 3];
    data[o + 1] = geometry.positions[i * 3 + 1];
    data[o + 2] = geometry.positions[i * 3 + 2];
    data[o + 4] = geometry.normals[i * 3];
    data[o + 5] = geometry.normals[i * 3 + 1];
    data[o + 6] = geometry.normals[i * 3 + 2];
    data[o + 8] = geometry.albedo[i * 3];
    data[o + 9] = geometry.albedo[i * 3 + 1];
    data[o + 10] = geometry.albedo[i * 3 + 2];
    data[o + 12] = geometry.emissive[i * 3];
    data[o + 13] = geometry.emissive[i * 3 + 1];
    data[o + 14] = geometry.emissive[i * 3 + 2];
  }
  return data;
}

function packLights(lights: SerializedLight[]): Float32Array {
  // One dummy light keeps the binding valid when nothing is lit; the shader
  // reads `lightCount` (0) and never touches it.
  const data = new Float32Array(Math.max(lights.length, 1) * LIGHT_STRIDE_FLOATS);
  lights.forEach((light, i) => {
    const o = i * LIGHT_STRIDE_FLOATS;
    data[o] = light.position[0];
    data[o + 1] = light.position[1];
    data[o + 2] = light.position[2];
    data[o + 3] = LIGHT_KIND[light.type];
    data[o + 4] = light.direction[0];
    data[o + 5] = light.direction[1];
    data[o + 6] = light.direction[2];
    data[o + 7] = light.radius;
    data[o + 8] = light.color[0];
    data[o + 9] = light.color[1];
    data[o + 10] = light.color[2];
    data[o + 11] = light.distance;
    data[o + 12] = light.right[0];
    data[o + 13] = light.right[1];
    data[o + 14] = light.right[2];
    data[o + 15] = light.decay;
    data[o + 16] = light.up[0];
    data[o + 17] = light.up[1];
    data[o + 18] = light.up[2];
    data[o + 19] = light.angle;
    data[o + 20] = light.penumbra;
    data[o + 21] = light.width;
    data[o + 22] = light.height;
  });
  return data;
}

function createStorage(device: GPUDevice, data: Float32Array | Uint32Array, label: string): GPUBuffer {
  // WebGPU requires a 4-byte-aligned size; every array here is already 4-byte
  // typed, but an empty one still needs a non-zero binding.
  const byteLength = Math.max(data.byteLength, 4);
  const buffer = device.createBuffer({
    label,
    size: byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Written through the underlying ArrayBuffer with an explicit byte range:
  // some of these are subarrays, and it also sidesteps the DOM types' refusal
  // to accept a possibly-SharedArrayBuffer-backed view.
  if (data.byteLength > 0) {
    device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  }
  return buffer;
}

/**
 * Traces every sample on the GPU.
 *
 * @param onProgress Fraction of samples finished, called once per batch.
 * @param signal Checked between batches so a cancelled bake stops promptly.
 */
export async function traceOnGPU(
  geometry: SceneGeometryPayload,
  samples: SamplePayload,
  lights: SerializedLight[],
  environment: SerializedEnvironment,
  settings: GpuTraceSettings,
  onProgress: (progress: number, note: string) => void,
  signal?: { cancelled: boolean },
): Promise<GpuTraceResult> {
  const device = await getBakeDevice();

  onProgress(0, 'Building GPU BVH');
  const bvh = buildGpuBvh(geometry.positions, geometry.index);

  const vertexData = packVertices(geometry);
  const lightData = packLights(lights);

  const buffers = {
    vertices: createStorage(device, vertexData, 'lf-vertices'),
    indices: createStorage(device, geometry.index, 'lf-indices'),
    triOrder: createStorage(device, bvh.triIndices, 'lf-tri-order'),
    nodes: createStorage(device, bvh.nodes, 'lf-bvh-nodes'),
    lights: createStorage(device, lightData, 'lf-lights'),
  };

  // Buffers are allocated for the largest batch the tracer will ever dispatch,
  // so the adaptive sizing below can grow without reallocating.
  const capacity = Math.min(MAX_BATCH_TEXELS, Math.max(MIN_BATCH_TEXELS, samples.count));

  const sampleBuffer = device.createBuffer({
    label: 'lf-samples',
    size: capacity * 2 * 4 * 4, // 2 × vec4 per sample
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const resultBuffer = device.createBuffer({
    label: 'lf-result',
    size: capacity * 4 * 4, // 1 × vec4 per sample
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    label: 'lf-readback',
    size: capacity * 4 * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const uniformBuffer = device.createBuffer({
    label: 'lf-uniforms',
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ label: 'lf-tracer', code: TRACER_WGSL });

  // Surface compile errors as real errors rather than letting the pipeline fail
  // opaquely later — WGSL diagnostics are the whole debugging story here.
  const compilation = await module.getCompilationInfo();
  const problems = compilation.messages.filter((message) => message.type === 'error');
  if (problems.length) {
    const detail = problems.map((m) => `line ${m.lineNum}: ${m.message}`).join('; ');
    throw new Error('GPU tracer shader failed to compile — ' + detail);
  }

  const pipeline = await device.createComputePipelineAsync({
    label: 'lf-tracer',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: buffers.vertices } },
      { binding: 2, resource: { buffer: buffers.indices } },
      { binding: 3, resource: { buffer: buffers.triOrder } },
      { binding: 4, resource: { buffer: buffers.nodes } },
      { binding: 5, resource: { buffer: buffers.lights } },
      { binding: 6, resource: { buffer: sampleBuffer } },
      { binding: 7, resource: { buffer: resultBuffer } },
    ],
  });

  const color = new Float32Array(samples.count * 3);
  const batchSamples = new Float32Array(capacity * 8);
  const uniformData = new ArrayBuffer(UNIFORM_BYTES);
  const uniformFloats = new Float32Array(uniformData);
  const uniformInts = new Uint32Array(uniformData);

  // A lost device (driver reset, watchdog, tab backgrounded too long) rejects
  // every later call with no useful message, so capture the reason up front.
  let deviceLost: string | null = null;
  void device.lost.then((info) => {
    deviceLost = info.message || String(info.reason);
  });

  let traced = 0;
  let batchSize = Math.min(START_BATCH_TEXELS, capacity);
  try {
    // Advanced by the count actually traced, never by `batchSize` — that is
    // resized at the end of each pass, and stepping by the new value would
    // skip the texels in between and leave them black.
    let start = 0;
    while (start < samples.count) {
      if (signal?.cancelled) throw new Error('Bake cancelled');
      if (deviceLost) throw new Error('The GPU device was lost during the bake: ' + deviceLost);

      const count = Math.min(batchSize, samples.count - start);
      const batchStarted = performance.now();

      batchSamples.fill(0, 0, count * 8);
      for (let i = 0; i < count; i++) {
        const s = (start + i) * 3;
        batchSamples[i * 8] = samples.positions[s];
        batchSamples[i * 8 + 1] = samples.positions[s + 1];
        batchSamples[i * 8 + 2] = samples.positions[s + 2];
        batchSamples[i * 8 + 4] = samples.normals[s];
        batchSamples[i * 8 + 5] = samples.normals[s + 1];
        batchSamples[i * 8 + 6] = samples.normals[s + 2];
      }
      device.queue.writeBuffer(sampleBuffer, 0, batchSamples, 0, count * 8);

      uniformFloats[0] = environment.skyColor[0];
      uniformFloats[1] = environment.skyColor[1];
      uniformFloats[2] = environment.skyColor[2];
      uniformFloats[3] = environment.enabled ? 1 : 0;
      uniformFloats[4] = environment.groundColor[0];
      uniformFloats[5] = environment.groundColor[1];
      uniformFloats[6] = environment.groundColor[2];
      uniformFloats[7] = settings.bias;
      uniformFloats[8] = settings.rayDistance > 0 ? settings.rayDistance : 1e30;
      uniformFloats[9] = settings.aoStrength;
      uniformInts[10] = Math.max(1, settings.shadowSamples);
      uniformInts[11] = Math.max(1, settings.samples);
      uniformInts[12] = Math.max(0, settings.bounces);
      uniformInts[13] = lights.length;
      uniformInts[14] = start;
      uniformInts[15] = count;
      uniformInts[16] = 0x9e3779b9;
      device.queue.writeBuffer(uniformBuffer, 0, uniformData);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(resultBuffer, 0, readbackBuffer, 0, count * 16);
      device.queue.submit([encoder.finish()]);

      await readbackBuffer.mapAsync(GPUMapMode.READ, 0, count * 16);
      const mapped = new Float32Array(readbackBuffer.getMappedRange(0, count * 16));
      for (let i = 0; i < count; i++) {
        color[(start + i) * 3] = mapped[i * 4];
        color[(start + i) * 3 + 1] = mapped[i * 4 + 1];
        color[(start + i) * 3 + 2] = mapped[i * 4 + 2];
      }
      readbackBuffer.unmap();

      start += count;
      traced += count;
      const progress = traced / samples.count;
      onProgress(progress, Math.round(progress * 100) + '% · GPU');

      // Steer the next batch toward TARGET_BATCH_MS, but never swing by more
      // than 2× at a time so one hitchy frame can't blow past the watchdog.
      const elapsed = performance.now() - batchStarted;
      if (elapsed > 0) {
        const scaled = batchSize * Math.min(Math.max(TARGET_BATCH_MS / elapsed, 0.5), 2);
        batchSize = Math.round(Math.min(Math.max(scaled, MIN_BATCH_TEXELS), capacity));
      }
    }
  } finally {
    for (const buffer of Object.values(buffers)) buffer.destroy();
    sampleBuffer.destroy();
    resultBuffer.destroy();
    readbackBuffer.destroy();
    uniformBuffer.destroy();
  }

  // Ray counts are not tallied on the GPU (an atomic per ray would cost more
  // than the rays themselves); this is the same estimate the panel shows.
  const perTexel =
    Math.max(1, settings.shadowSamples) * Math.max(lights.length, 1) +
    Math.max(1, settings.samples) * (1 + Math.max(0, settings.bounces) * (1 + Math.max(lights.length, 1)));

  return { color, rays: Math.round(samples.count * perTexel) };
}
