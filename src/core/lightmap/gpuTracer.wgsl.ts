/**
 * The GPU path tracer, as WGSL.
 *
 * This is a port of `bakeWorker.ts` — deliberately a close one. Every shading
 * formula (three's distance attenuation, the spot cone's smoothstep, the
 * single-sided area-light weight, the cosine hemisphere, the emissive PI) is
 * the same term-for-term, because the whole point of the baker is that its
 * output lines up with three's realtime shading rather than merely resembling
 * it — and a second tracer that drifts from the first would break that twice
 * over. If you change the maths in one, change it in the other.
 *
 * The differences are all structural, forced by the shader: traversal uses an
 * explicit stack instead of `three-mesh-bvh`'s callbacks (see gpuBvh.ts for the
 * node layout), and each invocation solves one texel.
 */

export const TRACER_WGSL = /* wgsl */ `

const PI: f32 = 3.14159265359;
const STACK_SIZE: u32 = 32u;

struct Uniforms {
  skyColor: vec3<f32>,
  skyEnabled: f32,
  groundColor: vec3<f32>,
  bias: f32,
  maxRayDistance: f32,
  aoStrength: f32,
  shadowSamples: u32,
  hemisphereSamples: u32,
  bounces: u32,
  lightCount: u32,
  sampleOffset: u32,
  sampleCount: u32,
  seed: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

struct Vertex {
  position: vec3<f32>,
  _p0: f32,
  normal: vec3<f32>,
  _p1: f32,
  albedo: vec3<f32>,
  _p2: f32,
  emissive: vec3<f32>,
  _p3: f32,
};

// kind: 0 = directional, 1 = point, 2 = spot, 3 = area.
struct Light {
  position: vec3<f32>,
  kind: f32,
  direction: vec3<f32>,
  radius: f32,
  color: vec3<f32>,
  distance: f32,
  right: vec3<f32>,
  decay: f32,
  up: vec3<f32>,
  angle: f32,
  penumbra: f32,
  width: f32,
  height: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> vertices: array<Vertex>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read> triOrder: array<u32>;
@group(0) @binding(4) var<storage, read> nodes: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> lights: array<Light>;
@group(0) @binding(6) var<storage, read> samples: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> result: array<vec4<f32>>;

// --- Random numbers -------------------------------------------------------
// xorshift32, same generator as the CPU worker.

var<private> rngState: u32;

fn seedRng(value: u32) {
  var s = value;
  if (s == 0u) { s = 1u; }
  rngState = s;
}

fn random() -> f32 {
  rngState = rngState ^ (rngState << 13u);
  rngState = rngState ^ (rngState >> 17u);
  rngState = rngState ^ (rngState << 5u);
  return f32(rngState) / 4294967296.0;
}

// --- Ray casting ----------------------------------------------------------

struct Hit {
  t: f32,
  u: f32,
  v: f32,
  tri: u32,
};

fn boundsHit(nodeIndex: u32, origin: vec3<f32>, invDir: vec3<f32>, tMax: f32) -> bool {
  let lo = nodes[nodeIndex * 2u];
  let hi = nodes[nodeIndex * 2u + 1u];
  let t0 = (lo.xyz - origin) * invDir;
  let t1 = (hi.xyz - origin) * invDir;
  let tsmall = min(t0, t1);
  let tbig = max(t0, t1);
  let tmin = max(max(tsmall.x, tsmall.y), tsmall.z);
  let tmax = min(min(tbig.x, tbig.y), tbig.z);
  return tmax >= max(tmin, 0.0) && tmin <= tMax;
}

/** Möller-Trumbore, double sided. Returns t, or -1 for a miss. */
fn triangleHit(tri: u32, origin: vec3<f32>, dir: vec3<f32>, tMax: f32) -> vec3<f32> {
  let i = tri * 3u;
  let a = vertices[indices[i]].position;
  let e1 = vertices[indices[i + 1u]].position - a;
  let e2 = vertices[indices[i + 2u]].position - a;

  let p = cross(dir, e2);
  let det = dot(e1, p);
  if (det > -1e-12 && det < 1e-12) { return vec3<f32>(-1.0, 0.0, 0.0); }
  let invDet = 1.0 / det;

  let tvec = origin - a;
  let u = dot(tvec, p) * invDet;
  if (u < 0.0 || u > 1.0) { return vec3<f32>(-1.0, 0.0, 0.0); }

  let q = cross(tvec, e1);
  let v = dot(dir, q) * invDet;
  if (v < 0.0 || u + v > 1.0) { return vec3<f32>(-1.0, 0.0, 0.0); }

  let t = dot(e2, q) * invDet;
  if (t <= 1e-7 || t > tMax) { return vec3<f32>(-1.0, 0.0, 0.0); }

  return vec3<f32>(t, u, v);
}

/** True if anything blocks the segment. Stops at the first hit. */
fn occluded(origin: vec3<f32>, dir: vec3<f32>, distance: f32) -> bool {
  let invDir = 1.0 / select(dir, vec3<f32>(1e-20), abs(dir) < vec3<f32>(1e-20));

  var stack: array<u32, 32>;
  var depth: u32 = 0u;
  stack[0] = 0u;
  depth = 1u;

  while (depth > 0u) {
    depth = depth - 1u;
    let nodeIndex = stack[depth];
    if (!boundsHit(nodeIndex, origin, invDir, distance)) { continue; }

    // For a leaf this is the first triangle; for an internal node it is the
    // right child (the left child is always the next node along).
    let firstOrRight = bitcast<u32>(nodes[nodeIndex * 2u].w);
    let count = bitcast<u32>(nodes[nodeIndex * 2u + 1u].w);

    if (count > 0u) {
      for (var i: u32 = 0u; i < count; i = i + 1u) {
        if (triangleHit(triOrder[firstOrRight + i], origin, dir, distance).x >= 0.0) {
          return true;
        }
      }
    } else if (depth + 2u <= STACK_SIZE) {
      stack[depth] = nodeIndex + 1u;
      stack[depth + 1u] = firstOrRight;
      depth = depth + 2u;
    }
  }
  return false;
}

/** Nearest hit along the ray. A negative t means the ray escaped. */
fn traceClosest(origin: vec3<f32>, dir: vec3<f32>, maxDistance: f32) -> Hit {
  let invDir = 1.0 / select(dir, vec3<f32>(1e-20), abs(dir) < vec3<f32>(1e-20));

  var best: Hit;
  best.t = -1.0;
  best.u = 0.0;
  best.v = 0.0;
  best.tri = 0u;
  var closest = maxDistance;

  var stack: array<u32, 32>;
  var depth: u32 = 0u;
  stack[0] = 0u;
  depth = 1u;

  while (depth > 0u) {
    depth = depth - 1u;
    let nodeIndex = stack[depth];
    if (!boundsHit(nodeIndex, origin, invDir, closest)) { continue; }

    // For a leaf this is the first triangle; for an internal node it is the
    // right child (the left child is always the next node along).
    let firstOrRight = bitcast<u32>(nodes[nodeIndex * 2u].w);
    let count = bitcast<u32>(nodes[nodeIndex * 2u + 1u].w);

    if (count > 0u) {
      for (var i: u32 = 0u; i < count; i = i + 1u) {
        let tri = triOrder[firstOrRight + i];
        let hit = triangleHit(tri, origin, dir, closest);
        if (hit.x >= 0.0) {
          closest = hit.x;
          best.t = hit.x;
          best.u = hit.y;
          best.v = hit.z;
          best.tri = tri;
        }
      }
    } else if (depth + 2u <= STACK_SIZE) {
      stack[depth] = nodeIndex + 1u;
      stack[depth + 1u] = firstOrRight;
      depth = depth + 2u;
    }
  }
  return best;
}

// --- Shading --------------------------------------------------------------

/** Sky radiance in three's irradiance convention, blended by ray elevation. */
fn sampleSky(upness: f32) -> vec3<f32> {
  if (uniforms.skyEnabled < 0.5) { return vec3<f32>(0.0); }
  let t = upness * 0.5 + 0.5;
  return mix(uniforms.groundColor, uniforms.skyColor, t);
}

/** three.js' physically-based point/spot falloff, matched exactly. */
fn distanceAttenuation(distance: f32, cutoff: f32, decay: f32) -> f32 {
  var falloff = 1.0 / max(pow(distance, decay), 0.01);
  if (cutoff > 0.0) {
    let ratio = distance / cutoff;
    let clamped = clamp(1.0 - ratio * ratio * ratio * ratio, 0.0, 1.0);
    falloff = falloff * clamped * clamped;
  }
  return falloff;
}

fn smoothstepEdges(edge0: f32, edge1: f32, x: f32) -> f32 {
  if (edge0 == edge1) {
    if (x < edge0) { return 0.0; }
    return 1.0;
  }
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/** An orthonormal basis around the axis, matching the CPU worker's choice of tangent. */
fn basis(axis: vec3<f32>) -> mat3x3<f32> {
  var t: vec3<f32>;
  if (abs(axis.x) < 0.9) {
    t = vec3<f32>(0.0, -axis.z, axis.y);
  } else {
    t = vec3<f32>(-axis.z, 0.0, axis.x);
  }
  let len = max(length(t), 1e-20);
  t = t / len;
  let b = cross(axis, t);
  return mat3x3<f32>(t, b, axis);
}

/** Uniform direction inside a cone of the given half-angle around the axis. */
fn sampleCone(axis: vec3<f32>, angle: f32) -> vec3<f32> {
  if (angle <= 0.0) { return axis; }
  let cosAngle = cos(angle);
  let z = 1.0 - random() * (1.0 - cosAngle);
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = random() * 2.0 * PI;
  let m = basis(axis);
  return m * vec3<f32>(r * cos(phi), r * sin(phi), z);
}

/** Cosine-weighted direction in the hemisphere around a normal. */
fn cosineHemisphere(n: vec3<f32>) -> vec3<f32> {
  let r = sqrt(random());
  let phi = random() * 2.0 * PI;
  let x = r * cos(phi);
  let y = r * sin(phi);
  let z = sqrt(max(0.0, 1.0 - x * x - y * y));
  let m = basis(n);
  return m * vec3<f32>(x, y, z);
}

/** Uniform point inside the unit sphere, for soft point/spot shadows. */
fn sampleUnitSphere() -> vec3<f32> {
  var v: vec3<f32>;
  var lengthSq: f32 = 2.0;
  // Rejection sampling, bounded so a shader invocation can never hang.
  for (var attempt: u32 = 0u; attempt < 16u; attempt = attempt + 1u) {
    v = vec3<f32>(random(), random(), random()) * 2.0 - vec3<f32>(1.0);
    lengthSq = dot(v, v);
    if (lengthSq <= 1.0 && lengthSq >= 1e-6) { return v; }
  }
  return normalize(vec3<f32>(0.0, 0.0, 1.0) + v * 0.001);
}

/** Irradiance from every baked light, with ray-traced shadows. */
fn directLighting(p: vec3<f32>, n: vec3<f32>, shadowRays: u32) -> vec3<f32> {
  var total = vec3<f32>(0.0);
  let origin = p + n * uniforms.bias;

  for (var l: u32 = 0u; l < uniforms.lightCount; l = l + 1u) {
    let light = lights[l];
    var sum = vec3<f32>(0.0);
    let kind = u32(light.kind);

    if (kind == 0u) {
      let angle = light.radius * PI / 180.0;
      var count: u32 = 1u;
      if (angle > 0.0) { count = shadowRays; }
      for (var s: u32 = 0u; s < count; s = s + 1u) {
        let dir = sampleCone(-light.direction, angle);
        let ndl = dot(n, dir);
        if (ndl <= 0.0) { continue; }
        if (occluded(origin, dir, uniforms.maxRayDistance)) { continue; }
        sum = sum + light.color * ndl;
      }
      sum = sum / f32(count);
    } else if (kind == 1u || kind == 2u) {
      var count: u32 = 1u;
      if (light.radius > 0.0) { count = shadowRays; }
      for (var s: u32 = 0u; s < count; s = s + 1u) {
        var lightPos = light.position;
        if (light.radius > 0.0) {
          lightPos = lightPos + sampleUnitSphere() * light.radius;
        }
        let delta = lightPos - p;
        let distance = length(delta);
        if (distance < 1e-6) { continue; }
        let dir = delta / distance;
        let ndl = dot(n, dir);
        if (ndl <= 0.0) { continue; }

        var attenuation = distanceAttenuation(distance, light.distance, light.decay);
        if (kind == 2u) {
          let cosAngle = -dot(dir, light.direction);
          let cone = cos(light.angle);
          let penumbra = cos(light.angle * (1.0 - light.penumbra));
          attenuation = attenuation * smoothstepEdges(cone, penumbra, cosAngle);
          if (attenuation <= 0.0) { continue; }
        }
        if (occluded(origin, dir, distance - uniforms.bias)) { continue; }
        sum = sum + light.color * ndl * attenuation;
      }
      sum = sum / f32(count);
    } else {
      // Area light: uniform area sampling of the emitting rectangle.
      let area = max(light.width * light.height, 1e-8);
      let count = shadowRays;
      for (var s: u32 = 0u; s < count; s = s + 1u) {
        let su = random() * 2.0 - 1.0;
        let sv = random() * 2.0 - 1.0;
        let lightPos = light.position + light.right * su + light.up * sv;
        let delta = lightPos - p;
        let distanceSq = dot(delta, delta);
        let distance = sqrt(distanceSq);
        if (distance < 1e-6) { continue; }
        let dir = delta / distance;
        let ndl = dot(n, dir);
        if (ndl <= 0.0) { continue; }
        // Emitters are single sided, matching three's RectAreaLight.
        let cosLight = -dot(dir, light.direction);
        if (cosLight <= 0.0) { continue; }
        if (occluded(origin, dir, distance - uniforms.bias)) { continue; }
        sum = sum + light.color * (ndl * cosLight * area / distanceSq);
      }
      sum = sum / f32(count);
    }

    total = total + sum;
  }

  return total;
}

struct Surface {
  albedo: vec3<f32>,
  emissive: vec3<f32>,
  normal: vec3<f32>,
};

/** Interpolates the vertex attributes of a hit triangle. */
fn resolveHit(hit: Hit, rayDir: vec3<f32>) -> Surface {
  let i = hit.tri * 3u;
  let a = vertices[indices[i]];
  let b = vertices[indices[i + 1u]];
  let c = vertices[indices[i + 2u]];
  let w1 = hit.u;
  let w2 = hit.v;
  let w0 = 1.0 - w1 - w2;

  var surface: Surface;
  surface.albedo = a.albedo * w0 + b.albedo * w1 + c.albedo * w2;
  surface.emissive = a.emissive * w0 + b.emissive * w1 + c.emissive * w2;

  var n = a.normal * w0 + b.normal * w1 + c.normal * w2;
  let len = length(n);
  if (len > 1e-20) { n = n / len; }
  // Always shade the side the ray arrived on.
  if (dot(n, rayDir) > 0.0) { n = -n; }
  surface.normal = n;

  return surface;
}

/** Full solve for one shading point. */
fn shade(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let direct = directLighting(p, n, uniforms.shadowSamples);
  var indirect = vec3<f32>(0.0);

  for (var s: u32 = 0u; s < uniforms.hemisphereSamples; s = s + 1u) {
    var rayDir = cosineHemisphere(n);
    var origin = p + n * uniforms.bias;
    var throughput = vec3<f32>(1.0);

    for (var bounce: u32 = 0u; bounce <= uniforms.bounces; bounce = bounce + 1u) {
      let hit = traceClosest(origin, rayDir, uniforms.maxRayDistance);

      if (hit.t < 0.0) {
        indirect = indirect + throughput * sampleSky(rayDir.y);
        break;
      }

      if (bounce == 0u && uniforms.aoStrength < 1.0) {
        // Artistic dial: let some ambient leak through occluders.
        indirect = indirect + throughput * sampleSky(rayDir.y) * (1.0 - uniforms.aoStrength);
      }

      if (bounce == uniforms.bounces) { break; }

      let hitPoint = origin + rayDir * hit.t;
      let surface = resolveHit(hit, rayDir);

      let bounced = directLighting(hitPoint, surface.normal, 1u);
      indirect = indirect + throughput * (bounced * surface.albedo + PI * surface.emissive);

      throughput = throughput * surface.albedo;
      if (throughput.x + throughput.y + throughput.z < 1e-4) { break; }

      origin = hitPoint + surface.normal * uniforms.bias;
      rayDir = cosineHemisphere(surface.normal);
    }
  }

  return direct + indirect / f32(uniforms.hemisphereSamples);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let local = gid.x;
  if (local >= uniforms.sampleCount) { return; }
  let index = uniforms.sampleOffset + local;

  // Decorrelate the per-texel sequences; hashed so neighbouring texels do not
  // start from adjacent seeds and end up with visibly similar noise.
  var seed = ((index + 1u) * 2654435761u) ^ uniforms.seed;
  seed = seed ^ (seed >> 15u);
  seed = seed * 2246822519u;
  seed = seed ^ (seed >> 13u);
  seedRng(seed);

  let position = samples[local * 2u].xyz;
  let normal = samples[local * 2u + 1u].xyz;

  result[local] = vec4<f32>(shade(position, normal), 1.0);
}
`;
