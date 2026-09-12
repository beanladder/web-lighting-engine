import * as THREE from 'three';
import potpack from 'potpack';

/**
 * Lightmap UV generation.
 *
 * Charts are grown by flood fill across triangle adjacency while the surface
 * stays within an angular tolerance, then each chart is projected onto its own
 * best-fit plane and the resulting rectangles are packed into a single atlas
 * shared by every baked mesh. Same shape of algorithm as xatlas, kept small
 * enough to run on the main thread between animation frames.
 */

export interface UnwrapInput {
  id: string;
  /** Non-indexed geometry. Mutated: an `uv1` attribute is written back. */
  geometry: THREE.BufferGeometry;
  matrixWorld: THREE.Matrix4;
}

export interface UnwrapOptions {
  resolution: number;
  /** Gap between charts, in texels. */
  padding: number;
  /** Max angle between a triangle and its chart, in degrees. */
  angleTolerance: number;
  onProgress?: (progress: number, note: string) => void;
}

export interface UnwrapResult {
  atlasSize: number;
  charts: number;
  /** Texels per world unit that the packing settled on. */
  density: number;
  /** Fraction of the atlas covered by charts. */
  fill: number;
  triangles: number;
}

interface Chart {
  mesh: number;
  tris: number[];
  /** Projected 2D coords, 6 floats per triangle, already offset to origin. */
  uv: Float32Array;
  w: number;
  h: number;
  // Filled in by potpack.
  x: number;
  y: number;
}

const EPSILON = 1e-9;

const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Quantised position key, so vertices that coincide across triangles weld. */
function positionKey(x: number, y: number, z: number, scale: number): string {
  return Math.round(x * scale) + ',' + Math.round(y * scale) + ',' + Math.round(z * scale);
}

function buildAdjacency(positions: Float32Array, triCount: number, weldScale: number) {
  // Weld vertices by position so adjacency survives duplicated corners.
  const vertexIds = new Int32Array(triCount * 3);
  const lookup = new Map<string, number>();
  let nextVertex = 0;
  for (let i = 0; i < triCount * 3; i++) {
    const key = positionKey(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], weldScale);
    let id = lookup.get(key);
    if (id === undefined) {
      id = nextVertex++;
      lookup.set(key, id);
    }
    vertexIds[i] = id;
  }

  // Edge -> the (at most two, in a manifold) triangles that share it.
  const edgeMap = new Map<number, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? a * nextVertex + b : b * nextVertex + a);
  const pushEdge = (a: number, b: number, tri: number) => {
    const k = edgeKey(a, b);
    const list = edgeMap.get(k);
    if (list) list.push(tri);
    else edgeMap.set(k, [tri]);
  };

  for (let t = 0; t < triCount; t++) {
    const a = vertexIds[t * 3];
    const b = vertexIds[t * 3 + 1];
    const c = vertexIds[t * 3 + 2];
    pushEdge(a, b, t);
    pushEdge(b, c, t);
    pushEdge(c, a, t);
  }

  const neighbours: number[][] = new Array(triCount);
  for (let t = 0; t < triCount; t++) neighbours[t] = [];
  for (const tris of edgeMap.values()) {
    if (tris.length < 2) continue;
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        neighbours[tris[i]].push(tris[j]);
        neighbours[tris[j]].push(tris[i]);
      }
    }
  }
  return neighbours;
}

/** Project a chart's triangles onto the plane defined by its average normal. */
function projectChart(
  mesh: number,
  tris: number[],
  world: Float32Array,
  nx: number,
  ny: number,
  nz: number,
): Chart {
  // Any tangent perpendicular to the normal works; pick the numerically stable one.
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
  const tLen = Math.hypot(tx, ty, tz) || 1;
  tx /= tLen;
  ty /= tLen;
  tz /= tLen;
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;

  const uv = new Float32Array(tris.length * 6);
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;

  for (let i = 0; i < tris.length; i++) {
    const tri = tris[i];
    for (let c = 0; c < 3; c++) {
      const o = tri * 9 + c * 3;
      const px = world[o];
      const py = world[o + 1];
      const pz = world[o + 2];
      const u = px * tx + py * ty + pz * tz;
      const v = px * bx + py * by + pz * bz;
      uv[i * 6 + c * 2] = u;
      uv[i * 6 + c * 2 + 1] = v;
      if (u < minU) minU = u;
      if (v < minV) minV = v;
      if (u > maxU) maxU = u;
      if (v > maxV) maxV = v;
    }
  }

  for (let i = 0; i < uv.length; i += 2) {
    uv[i] -= minU;
    uv[i + 1] -= minV;
  }

  return {
    mesh,
    tris,
    uv,
    w: Math.max(maxU - minU, EPSILON),
    h: Math.max(maxV - minV, EPSILON),
    x: 0,
    y: 0,
  };
}

export async function unwrapForLightmap(
  inputs: UnwrapInput[],
  options: UnwrapOptions,
): Promise<UnwrapResult> {
  const { resolution, padding, angleTolerance } = options;
  const cosTolerance = Math.cos((angleTolerance * Math.PI) / 180);
  const charts: Chart[] = [];
  let totalTriangles = 0;
  let totalArea = 0;

  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const pc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const scratch = new THREE.Vector3();

  for (let m = 0; m < inputs.length; m++) {
    const { geometry, matrixWorld } = inputs[m];
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const triCount = Math.floor(posAttr.count / 3);
    totalTriangles += triCount;
    options.onProgress?.((m / inputs.length) * 0.7, 'Charting mesh ' + (m + 1) + '/' + inputs.length);

    // Work in world space: charts share one atlas, so a mesh scaled 10x has to
    // claim 10x the texels.
    const world = new Float32Array(posAttr.count * 3);
    for (let i = 0; i < posAttr.count; i++) {
      scratch.fromBufferAttribute(posAttr, i).applyMatrix4(matrixWorld);
      world[i * 3] = scratch.x;
      world[i * 3 + 1] = scratch.y;
      world[i * 3 + 2] = scratch.z;
    }

    const faceNormals = new Float32Array(triCount * 3);
    const areas = new Float32Array(triCount);
    const bounds = new THREE.Box3().setFromArray(world);
    const diagonal = Math.max(bounds.getSize(scratch).length(), EPSILON);
    const weldScale = 1e5 / diagonal;

    for (let t = 0; t < triCount; t++) {
      pa.fromArray(world, t * 9);
      pb.fromArray(world, t * 9 + 3);
      pc.fromArray(world, t * 9 + 6);
      ab.subVectors(pb, pa);
      ac.subVectors(pc, pa);
      faceNormal.crossVectors(ab, ac);
      const len = faceNormal.length();
      areas[t] = len * 0.5;
      totalArea += areas[t];
      if (len > EPSILON) faceNormal.divideScalar(len);
      else faceNormal.set(0, 1, 0);
      faceNormals[t * 3] = faceNormal.x;
      faceNormals[t * 3 + 1] = faceNormal.y;
      faceNormals[t * 3 + 2] = faceNormal.z;
    }

    const neighbours = buildAdjacency(world, triCount, weldScale);

    // Seed charts in area order, so big flat regions claim their neighbourhood
    // before slivers get a chance to fragment it.
    const order = Array.from({ length: triCount }, (_, i) => i).sort((a, b) => areas[b] - areas[a]);
    const assigned = new Uint8Array(triCount);
    const queue: number[] = [];

    for (const seed of order) {
      if (assigned[seed]) continue;
      assigned[seed] = 1;
      const tris = [seed];
      let nx = faceNormals[seed * 3];
      let ny = faceNormals[seed * 3 + 1];
      let nz = faceNormals[seed * 3 + 2];
      queue.length = 0;
      queue.push(seed);

      while (queue.length) {
        const current = queue.pop() as number;
        const adjacent = neighbours[current];
        for (let n = 0; n < adjacent.length; n++) {
          const next = adjacent[n];
          if (assigned[next]) continue;
          const dx = faceNormals[next * 3];
          const dy = faceNormals[next * 3 + 1];
          const dz = faceNormals[next * 3 + 2];
          // Compare against the chart's running average normal rather than the
          // neighbour's, so a chart cannot slowly wrap around a cylinder.
          if (dx * nx + dy * ny + dz * nz < cosTolerance) continue;
          assigned[next] = 1;
          tris.push(next);
          queue.push(next);
          const weight = 1 / tris.length;
          nx += (dx - nx) * weight;
          ny += (dy - ny) * weight;
          nz += (dz - nz) * weight;
          const len = Math.hypot(nx, ny, nz) || 1;
          nx /= len;
          ny /= len;
          nz /= len;
        }
      }

      charts.push(projectChart(m, tris, world, nx, ny, nz));
      if (charts.length % 8192 === 0) await yieldToUI();
    }

    await yieldToUI();
  }

  options.onProgress?.(0.8, 'Packing ' + charts.length + ' charts');

  // Pick a texel density that fills the atlas without overflowing, then let
  // potpack tell us how wrong we were and correct. Converges in a few passes.
  const usable = resolution - padding * 2;
  let density = totalArea > EPSILON ? Math.sqrt((usable * usable * 0.62) / totalArea) : 1;
  let packed: { w: number; h: number; fill: number } = { w: 0, h: 0, fill: 0 };
  const boxes = charts.map((c) => ({ w: 0, h: 0, x: 0, y: 0, chart: c }));

  for (let attempt = 0; attempt < 8; attempt++) {
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      // A single chart must never exceed the atlas.
      box.w = Math.min(Math.max(1, Math.ceil(box.chart.w * density)), usable) + padding;
      box.h = Math.min(Math.max(1, Math.ceil(box.chart.h * density)), usable) + padding;
    }
    packed = potpack(boxes);
    const overflow = Math.max(packed.w, packed.h) / usable;
    if (overflow <= 1) {
      // Grow back into any slack we left on the table, but only once we fit.
      if (overflow > 0.94 || attempt >= 6) break;
      density /= Math.max(overflow, 0.6);
    } else {
      density /= overflow * 1.02;
    }
  }

  for (let i = 0; i < boxes.length; i++) {
    boxes[i].chart.x = boxes[i].x;
    boxes[i].chart.y = boxes[i].y;
  }

  options.onProgress?.(0.95, 'Writing UVs');

  const uvArrays = inputs.map((input) => {
    const count = (input.geometry.getAttribute('position') as THREE.BufferAttribute).count;
    return new Float32Array(count * 2);
  });

  const inverse = 1 / resolution;
  const half = padding * 0.5;
  for (const chart of charts) {
    const uvs = uvArrays[chart.mesh];
    for (let i = 0; i < chart.tris.length; i++) {
      const tri = chart.tris[i];
      for (let c = 0; c < 3; c++) {
        const u = chart.uv[i * 6 + c * 2];
        const v = chart.uv[i * 6 + c * 2 + 1];
        const vertex = tri * 3 + c;
        uvs[vertex * 2] = (chart.x + half + u * density) * inverse;
        uvs[vertex * 2 + 1] = (chart.y + half + v * density) * inverse;
      }
    }
  }

  for (let m = 0; m < inputs.length; m++) {
    inputs[m].geometry.setAttribute('uv1', new THREE.BufferAttribute(uvArrays[m], 2));
  }

  options.onProgress?.(1, 'Unwrap complete');

  return {
    atlasSize: resolution,
    charts: charts.length,
    density,
    fill: packed.fill,
    triangles: totalTriangles,
  };
}

/**
 * Reuse an existing UV set instead of generating charts. Each mesh gets its own
 * slice of the atlas, sized by surface area, so meshes do not overlap even
 * though their source UVs all live in the same 0..1 square.
 */
export async function packExistingUVs(
  inputs: UnwrapInput[],
  source: 'uv' | 'uv1',
  options: UnwrapOptions,
): Promise<UnwrapResult> {
  const { resolution, padding } = options;
  const areas: number[] = [];
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const pc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (const input of inputs) {
    const pos = input.geometry.getAttribute('position') as THREE.BufferAttribute;
    let area = 0;
    for (let t = 0; t < Math.floor(pos.count / 3); t++) {
      pa.fromBufferAttribute(pos, t * 3).applyMatrix4(input.matrixWorld);
      pb.fromBufferAttribute(pos, t * 3 + 1).applyMatrix4(input.matrixWorld);
      pc.fromBufferAttribute(pos, t * 3 + 2).applyMatrix4(input.matrixWorld);
      area += ab.subVectors(pb, pa).cross(ac.subVectors(pc, pa)).length() * 0.5;
    }
    areas.push(Math.max(area, EPSILON));
  }

  const usable = resolution - padding * 2;
  const totalArea = areas.reduce((a, b) => a + b, 0);
  let density = Math.sqrt((usable * usable * 0.9) / totalArea);
  let packed: { w: number; h: number; fill: number } = { w: 0, h: 0, fill: 0 };
  const boxes = inputs.map((_, i) => ({ w: 0, h: 0, x: 0, y: 0, index: i }));

  for (let attempt = 0; attempt < 8; attempt++) {
    for (const box of boxes) {
      const side = Math.min(Math.max(1, Math.ceil(Math.sqrt(areas[box.index]) * density)), usable);
      box.w = side + padding;
      box.h = side + padding;
    }
    packed = potpack(boxes);
    const overflow = Math.max(packed.w, packed.h) / usable;
    if (overflow <= 1) break;
    density /= overflow * 1.02;
  }

  const inverse = 1 / resolution;
  const half = padding * 0.5;
  for (const box of boxes) {
    const input = inputs[box.index];
    const attribute = input.geometry.getAttribute(source) as THREE.BufferAttribute | undefined;
    const count = (input.geometry.getAttribute('position') as THREE.BufferAttribute).count;
    const uvs = new Float32Array(count * 2);
    const w = box.w - padding;
    const h = box.h - padding;
    for (let i = 0; i < count; i++) {
      // Wrap into 0..1 so tiled source UVs still land inside the slot.
      const rawU = attribute ? attribute.getX(i) : 0;
      const rawV = attribute ? attribute.getY(i) : 0;
      const su = rawU - Math.floor(rawU);
      const sv = rawV - Math.floor(rawV);
      uvs[i * 2] = (box.x + half + su * w) * inverse;
      uvs[i * 2 + 1] = (box.y + half + sv * h) * inverse;
    }
    input.geometry.setAttribute('uv1', new THREE.BufferAttribute(uvs, 2));
  }

  options.onProgress?.(1, 'Packed existing UVs');
  await yieldToUI();

  return {
    atlasSize: resolution,
    charts: inputs.length,
    density,
    fill: packed.fill,
    triangles: inputs.reduce(
      (sum, i) =>
        sum + Math.floor((i.geometry.getAttribute('position') as THREE.BufferAttribute).count / 3),
      0,
    ),
  };
}
