/// <reference lib="webworker" />
import { BufferAttribute, BufferGeometry, Box3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { SerializedLight, WorkerRequest, WorkerResponse } from '../../state/types';

/**
 * Offline lightmap solver.
 *
 * For every shading point produced by the rasterizer this traces direct light
 * with real (ray-traced, area-sampled) shadows, then integrates a cosine-
 * weighted hemisphere for sky light, ambient occlusion and diffuse bounces.
 *
 * The value written out is irradiance in three.js' own convention, i.e. exactly
 * what the `lightMap` slot of a MeshStandardMaterial expects, so the baked
 * result lines up with the realtime preview instead of merely resembling it.
 */

const PI = Math.PI;

// ---------------------------------------------------------------------------
// Random numbers
// ---------------------------------------------------------------------------

let rngState = 1;

function seedRng(seed: number) {
  rngState = seed >>> 0 || 1;
}

function random(): number {
  // xorshift32 — plenty for stratum-free Monte Carlo and far faster than Math.random.
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

let bvh: MeshBVH | null = null;
// Explicit annotations: these are handed buffers that arrive over postMessage,
// so they carry the wider ArrayBufferLike backing type.
let indexArray: Uint32Array | Uint16Array = new Uint32Array(0);
let positionArray: Float32Array = new Float32Array(0);
let normalArray: Float32Array = new Float32Array(0);
let albedoArray: Float32Array = new Float32Array(0);
let emissiveArray: Float32Array = new Float32Array(0);

let lights: SerializedLight[] = [];
let skyColor = [0, 0, 0];
let groundColor = [0, 0, 0];
let skyEnabled = false;

let bias = 0.004;
let maxRayDistance = Infinity;
let aoStrength = 1;
let shadowSamples = 4;
let hemisphereSamples = 64;
let bounces = 1;
let rayCount = 0;

// ---------------------------------------------------------------------------
// Ray casting primitives
// ---------------------------------------------------------------------------

// Ray state, kept in module scope so the shapecast callbacks stay allocation-free.
let ox = 0;
let oy = 0;
let oz = 0;
let dx = 0;
let dy = 0;
let dz = 0;
let invDx = 0;
let invDy = 0;
let invDz = 0;
let tMax = Infinity;

// Closest-hit results.
let hitT = 0;
let hitTri = 0;
let hitU = 0;
let hitV = 0;

function setRay(x: number, y: number, z: number, ux: number, uy: number, uz: number, far: number) {
  ox = x;
  oy = y;
  oz = z;
  dx = ux;
  dy = uy;
  dz = uz;
  invDx = 1 / (ux || 1e-20);
  invDy = 1 / (uy || 1e-20);
  invDz = 1 / (uz || 1e-20);
  tMax = far;
}

function boundsHit(box: Box3): boolean {
  const min = box.min;
  const max = box.max;
  let t0 = (min.x - ox) * invDx;
  let t1 = (max.x - ox) * invDx;
  let tmin = t0 < t1 ? t0 : t1;
  let tmax = t0 < t1 ? t1 : t0;

  t0 = (min.y - oy) * invDy;
  t1 = (max.y - oy) * invDy;
  const ymin = t0 < t1 ? t0 : t1;
  const ymax = t0 < t1 ? t1 : t0;
  if (ymin > tmin) tmin = ymin;
  if (ymax < tmax) tmax = ymax;

  t0 = (min.z - oz) * invDz;
  t1 = (max.z - oz) * invDz;
  const zmin = t0 < t1 ? t0 : t1;
  const zmax = t0 < t1 ? t1 : t0;
  if (zmin > tmin) tmin = zmin;
  if (zmax < tmax) tmax = zmax;

  return tmax >= Math.max(tmin, 0) && tmin <= tMax;
}

/** Möller-Trumbore, double sided. Returns t or -1. */
function triangleHit(tri: number): number {
  const i = tri * 3;
  const a = indexArray[i] * 3;
  const b = indexArray[i + 1] * 3;
  const c = indexArray[i + 2] * 3;

  const ax = positionArray[a];
  const ay = positionArray[a + 1];
  const az = positionArray[a + 2];

  const e1x = positionArray[b] - ax;
  const e1y = positionArray[b + 1] - ay;
  const e1z = positionArray[b + 2] - az;
  const e2x = positionArray[c] - ax;
  const e2y = positionArray[c + 1] - ay;
  const e2z = positionArray[c + 2] - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const invDet = 1 / det;

  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;

  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return -1;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return -1;

  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (t <= 1e-7 || t > tMax) return -1;

  hitU = u;
  hitV = v;
  return t;
}

const occlusionCallbacks = {
  intersectsBounds: (box: Box3) => boundsHit(box),
  intersectsRange: (offset: number, count: number) => {
    for (let t = offset, end = offset + count; t < end; t++) {
      if (triangleHit(t) >= 0) return true;
    }
    return false;
  },
};

/** True if anything blocks the segment. Early-outs on the first hit. */
function occluded(
  x: number,
  y: number,
  z: number,
  ux: number,
  uy: number,
  uz: number,
  distance: number,
): boolean {
  rayCount++;
  setRay(x, y, z, ux, uy, uz, distance);
  return bvh!.shapecast(occlusionCallbacks);
}

let hitBaryU = 0;
let hitBaryV = 0;

const closestCallbacks = {
  intersectsBounds: (box: Box3) => boundsHit(box),
  intersectsRange: (offset: number, count: number) => {
    for (let t = offset, end = offset + count; t < end; t++) {
      const distance = triangleHit(t);
      if (distance >= 0) {
        hitT = distance;
        hitTri = t;
        tMax = distance;
        hitBaryU = hitU;
        hitBaryV = hitV;
      }
    }
    return false;
  },
};

/** Nearest hit along the ray, or -1. Fills hitTri / hitBaryU / hitBaryV. */
function trace(
  x: number,
  y: number,
  z: number,
  ux: number,
  uy: number,
  uz: number,
  distance: number,
): number {
  rayCount++;
  setRay(x, y, z, ux, uy, uz, distance);
  hitT = -1;
  bvh!.shapecast(closestCallbacks);
  return hitT;
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

/** Sky radiance in three's irradiance convention, blended by ray elevation. */
function sampleSky(uy: number, out: Float32Array, offset: number) {
  if (!skyEnabled) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    return;
  }
  const t = uy * 0.5 + 0.5;
  out[offset] = groundColor[0] + (skyColor[0] - groundColor[0]) * t;
  out[offset + 1] = groundColor[1] + (skyColor[1] - groundColor[1]) * t;
  out[offset + 2] = groundColor[2] + (skyColor[2] - groundColor[2]) * t;
}

/** three.js' physically-based point/spot falloff, matched exactly. */
function distanceAttenuation(distance: number, cutoff: number, decay: number): number {
  let falloff = 1 / Math.max(Math.pow(distance, decay), 0.01);
  if (cutoff > 0) {
    const ratio = distance / cutoff;
    const clamped = Math.min(Math.max(1 - ratio * ratio * ratio * ratio, 0), 1);
    falloff *= clamped * clamped;
  }
  return falloff;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Uniform direction inside a cone of half-angle `angle` around (ax, ay, az). */
const coneDir = new Float32Array(3);
function sampleCone(ax: number, ay: number, az: number, angle: number) {
  if (angle <= 0) {
    coneDir[0] = ax;
    coneDir[1] = ay;
    coneDir[2] = az;
    return;
  }
  const cosAngle = Math.cos(angle);
  const z = 1 - random() * (1 - cosAngle);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = random() * 2 * PI;
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  // Build a basis around the axis.
  let tx: number;
  let ty: number;
  let tz: number;
  if (Math.abs(ax) < 0.9) {
    tx = 0;
    ty = -az;
    tz = ay;
  } else {
    tx = -az;
    ty = 0;
    tz = ax;
  }
  const len = Math.hypot(tx, ty, tz) || 1;
  tx /= len;
  ty /= len;
  tz /= len;
  const bx = ay * tz - az * ty;
  const by = az * tx - ax * tz;
  const bz = ax * ty - ay * tx;
  coneDir[0] = tx * x + bx * y + ax * z;
  coneDir[1] = ty * x + by * y + ay * z;
  coneDir[2] = tz * x + bz * y + az * z;
}

/**
 * Irradiance arriving at a point from every baked light, with ray-traced
 * shadows. `samples` shadow rays are spent per soft light.
 */
function directLighting(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  samples: number,
  out: Float32Array,
) {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;

  const sx = px + nx * bias;
  const sy = py + ny * bias;
  const sz = pz + nz * bias;

  for (let l = 0; l < lights.length; l++) {
    const light = lights[l];
    let r = 0;
    let g = 0;
    let b = 0;

    if (light.type === 'directional') {
      const angle = (light.radius * PI) / 180;
      const count = angle > 0 ? samples : 1;
      for (let s = 0; s < count; s++) {
        sampleCone(-light.direction[0], -light.direction[1], -light.direction[2], angle);
        const lx = coneDir[0];
        const ly = coneDir[1];
        const lz = coneDir[2];
        const ndl = nx * lx + ny * ly + nz * lz;
        if (ndl <= 0) continue;
        if (occluded(sx, sy, sz, lx, ly, lz, maxRayDistance)) continue;
        r += light.color[0] * ndl;
        g += light.color[1] * ndl;
        b += light.color[2] * ndl;
      }
      const inv = 1 / count;
      r *= inv;
      g *= inv;
      b *= inv;
    } else if (light.type === 'point' || light.type === 'spot') {
      const count = light.radius > 0 ? samples : 1;
      for (let s = 0; s < count; s++) {
        let lpx = light.position[0];
        let lpy = light.position[1];
        let lpz = light.position[2];
        if (light.radius > 0) {
          // Uniform point in a sphere gives a believable soft penumbra.
          let ux: number;
          let uy: number;
          let uz: number;
          let lengthSq: number;
          do {
            ux = random() * 2 - 1;
            uy = random() * 2 - 1;
            uz = random() * 2 - 1;
            lengthSq = ux * ux + uy * uy + uz * uz;
          } while (lengthSq > 1 || lengthSq < 1e-6);
          lpx += ux * light.radius;
          lpy += uy * light.radius;
          lpz += uz * light.radius;
        }
        let lx = lpx - px;
        let ly = lpy - py;
        let lz = lpz - pz;
        const distance = Math.hypot(lx, ly, lz);
        if (distance < 1e-6) continue;
        lx /= distance;
        ly /= distance;
        lz /= distance;
        const ndl = nx * lx + ny * ly + nz * lz;
        if (ndl <= 0) continue;

        let attenuation = distanceAttenuation(distance, light.distance, light.decay);
        if (light.type === 'spot') {
          const cosAngle = -(lx * light.direction[0] + ly * light.direction[1] + lz * light.direction[2]);
          const cone = Math.cos(light.angle);
          const penumbra = Math.cos(light.angle * (1 - light.penumbra));
          attenuation *= smoothstep(cone, penumbra, cosAngle);
          if (attenuation <= 0) continue;
        }
        if (occluded(sx, sy, sz, lx, ly, lz, distance - bias)) continue;
        r += light.color[0] * ndl * attenuation;
        g += light.color[1] * ndl * attenuation;
        b += light.color[2] * ndl * attenuation;
      }
      const inv = 1 / count;
      r *= inv;
      g *= inv;
      b *= inv;
    } else {
      // Area light: uniform area sampling of the emitting rectangle.
      const area = Math.max(light.width * light.height, 1e-8);
      const count = samples;
      for (let s = 0; s < count; s++) {
        const su = random() * 2 - 1;
        const sv = random() * 2 - 1;
        const lpx = light.position[0] + light.right[0] * su + light.up[0] * sv;
        const lpy = light.position[1] + light.right[1] * su + light.up[1] * sv;
        const lpz = light.position[2] + light.right[2] * su + light.up[2] * sv;
        let lx = lpx - px;
        let ly = lpy - py;
        let lz = lpz - pz;
        const distanceSq = lx * lx + ly * ly + lz * lz;
        const distance = Math.sqrt(distanceSq);
        if (distance < 1e-6) continue;
        lx /= distance;
        ly /= distance;
        lz /= distance;
        const ndl = nx * lx + ny * ly + nz * lz;
        if (ndl <= 0) continue;
        // Emitters are single sided, matching three's RectAreaLight.
        const cosLight = -(lx * light.direction[0] + ly * light.direction[1] + lz * light.direction[2]);
        if (cosLight <= 0) continue;
        if (occluded(sx, sy, sz, lx, ly, lz, distance - bias)) continue;
        const weight = (ndl * cosLight * area) / distanceSq;
        r += light.color[0] * weight;
        g += light.color[1] * weight;
        b += light.color[2] * weight;
      }
      const inv = 1 / count;
      r *= inv;
      g *= inv;
      b *= inv;
    }

    out[0] += r;
    out[1] += g;
    out[2] += b;
  }
}

/** Cosine-weighted direction in the hemisphere around a normal. */
const hemiDir = new Float32Array(3);
function cosineHemisphere(nx: number, ny: number, nz: number) {
  const r = Math.sqrt(random());
  const phi = random() * 2 * PI;
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));

  let tx: number;
  let ty: number;
  let tz: number;
  if (Math.abs(nx) < 0.9) {
    tx = 0;
    ty = -nz;
    tz = ny;
  } else {
    tx = -nz;
    ty = 0;
    tz = nx;
  }
  const len = Math.hypot(tx, ty, tz) || 1;
  tx /= len;
  ty /= len;
  tz /= len;
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;

  hemiDir[0] = tx * x + bx * y + nx * z;
  hemiDir[1] = ty * x + by * y + ny * z;
  hemiDir[2] = tz * x + bz * y + nz * z;
}

const directScratch = new Float32Array(3);
const skyScratch = new Float32Array(3);
const hitAlbedo = new Float32Array(3);
const hitEmissive = new Float32Array(3);
const hitNormal = new Float32Array(3);

/** Interpolates the vertex attributes of the last hit triangle. */
function resolveHit(rayDx: number, rayDy: number, rayDz: number) {
  const i = hitTri * 3;
  const a = indexArray[i];
  const b = indexArray[i + 1];
  const c = indexArray[i + 2];
  const w1 = hitBaryU;
  const w2 = hitBaryV;
  const w0 = 1 - w1 - w2;

  for (let k = 0; k < 3; k++) {
    hitAlbedo[k] = albedoArray[a * 3 + k] * w0 + albedoArray[b * 3 + k] * w1 + albedoArray[c * 3 + k] * w2;
    hitEmissive[k] =
      emissiveArray[a * 3 + k] * w0 + emissiveArray[b * 3 + k] * w1 + emissiveArray[c * 3 + k] * w2;
    hitNormal[k] = normalArray[a * 3 + k] * w0 + normalArray[b * 3 + k] * w1 + normalArray[c * 3 + k] * w2;
  }

  const len = Math.hypot(hitNormal[0], hitNormal[1], hitNormal[2]) || 1;
  hitNormal[0] /= len;
  hitNormal[1] /= len;
  hitNormal[2] /= len;

  // Always shade the side the ray arrived on.
  if (hitNormal[0] * rayDx + hitNormal[1] * rayDy + hitNormal[2] * rayDz > 0) {
    hitNormal[0] = -hitNormal[0];
    hitNormal[1] = -hitNormal[1];
    hitNormal[2] = -hitNormal[2];
  }
}

/** Full solve for one shading point. */
function shade(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  out: Float32Array,
  offset: number,
) {
  directLighting(px, py, pz, nx, ny, nz, shadowSamples, directScratch);
  let r = directScratch[0];
  let g = directScratch[1];
  let b = directScratch[2];

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let s = 0; s < hemisphereSamples; s++) {
    cosineHemisphere(nx, ny, nz);
    let rayX = hemiDir[0];
    let rayY = hemiDir[1];
    let rayZ = hemiDir[2];
    let originX = px + nx * bias;
    let originY = py + ny * bias;
    let originZ = pz + nz * bias;
    let throughputR = 1;
    let throughputG = 1;
    let throughputB = 1;

    for (let bounce = 0; bounce <= bounces; bounce++) {
      const distance = trace(originX, originY, originZ, rayX, rayY, rayZ, maxRayDistance);

      if (distance < 0) {
        sampleSky(rayY, skyScratch, 0);
        sumR += throughputR * skyScratch[0];
        sumG += throughputG * skyScratch[1];
        sumB += throughputB * skyScratch[2];
        break;
      }

      if (bounce === 0 && aoStrength < 1) {
        // Artistic dial: let some ambient leak through occluders.
        sampleSky(rayY, skyScratch, 0);
        const leak = 1 - aoStrength;
        sumR += throughputR * skyScratch[0] * leak;
        sumG += throughputG * skyScratch[1] * leak;
        sumB += throughputB * skyScratch[2] * leak;
      }

      if (bounce === bounces) break;

      const hx = originX + rayX * distance;
      const hy = originY + rayY * distance;
      const hz = originZ + rayZ * distance;
      resolveHit(rayX, rayY, rayZ);

      directLighting(hx, hy, hz, hitNormal[0], hitNormal[1], hitNormal[2], 1, directScratch);

      sumR += throughputR * (directScratch[0] * hitAlbedo[0] + PI * hitEmissive[0]);
      sumG += throughputG * (directScratch[1] * hitAlbedo[1] + PI * hitEmissive[1]);
      sumB += throughputB * (directScratch[2] * hitAlbedo[2] + PI * hitEmissive[2]);

      throughputR *= hitAlbedo[0];
      throughputG *= hitAlbedo[1];
      throughputB *= hitAlbedo[2];
      if (throughputR + throughputG + throughputB < 1e-4) break;

      originX = hx + hitNormal[0] * bias;
      originY = hy + hitNormal[1] * bias;
      originZ = hz + hitNormal[2] * bias;
      cosineHemisphere(hitNormal[0], hitNormal[1], hitNormal[2]);
      rayX = hemiDir[0];
      rayY = hemiDir[1];
      rayZ = hemiDir[2];
    }
  }

  const inv = 1 / hemisphereSamples;
  out[offset] = r + sumR * inv;
  out[offset + 1] = g + sumG * inv;
  out[offset + 2] = b + sumB * inv;
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

const post = (message: WorkerResponse, transfer?: Transferable[]) =>
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer ?? []);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'bake') return;

  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(request.geometry.positions, 3));
    geometry.setIndex(new BufferAttribute(request.geometry.index, 1));

    bvh = new MeshBVH(geometry, { maxDepth: 48, verbose: false });

    // MeshBVH reorders the index in place; read it back after the build.
    indexArray = geometry.getIndex()!.array as Uint32Array;
    positionArray = request.geometry.positions;
    normalArray = request.geometry.normals;
    albedoArray = request.geometry.albedo;
    emissiveArray = request.geometry.emissive;

    lights = request.lights;
    skyColor = request.environment.skyColor;
    groundColor = request.environment.groundColor;
    skyEnabled = request.environment.enabled;

    bias = request.settings.bias;
    maxRayDistance = request.settings.rayDistance > 0 ? request.settings.rayDistance : Infinity;
    aoStrength = request.settings.aoStrength;
    shadowSamples = Math.max(1, request.settings.shadowSamples);
    hemisphereSamples = Math.max(1, request.settings.samples);
    bounces = Math.max(0, request.settings.bounces);
    rayCount = 0;

    seedRng(request.seed);

    const { positions, normals, texelIndex, count } = request.samples;
    const color = new Float32Array(count * 3);

    // Report often enough for a responsive bar, rarely enough not to spam.
    const step = Math.max(1, Math.floor(count / 100));
    for (let i = 0; i < count; i++) {
      shade(
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
        normals[i * 3],
        normals[i * 3 + 1],
        normals[i * 3 + 2],
        color,
        i * 3,
      );
      if (i % step === 0) post({ type: 'progress', done: i, total: count });
    }

    post({ type: 'progress', done: count, total: count });
    post({ type: 'result', color, texelIndex, rays: rayCount }, [color.buffer, texelIndex.buffer]);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
