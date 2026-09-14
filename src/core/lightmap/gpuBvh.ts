/**
 * Flat BVH for GPU traversal.
 *
 * The CPU tracer leans on `three-mesh-bvh`, but its GPU-side kit is built for
 * WebGL/GLSL shader chunks and its packed node layout is an internal detail, so
 * it can't be handed to a WGSL compute shader as-is. This builds a small binary
 * BVH in a layout the shader can read directly: a flat `vec4` pair per node and
 * a triangle-order array that leaves index into.
 *
 * Node layout (2 × vec4, 32 bytes):
 *   [0].xyz = bounds min      [0].w = u32 bits: right child index, or first triangle if leaf
 *   [1].xyz = bounds max      [1].w = u32 bits: triangle count (0 marks an internal node)
 *
 * Nodes are emitted depth-first, so an internal node's *left* child is always
 * the very next node and only the right child's index needs storing. Integer
 * fields are written through a Uint32Array view over the same buffer and read
 * back in WGSL with `bitcast<u32>()`, which keeps them exact instead of relying
 * on float round-tripping.
 */

export interface GpuBvh {
  /** 8 floats per node: min.xyz + leftOrStart, max.xyz + count. */
  nodes: Float32Array;
  nodeCount: number;
  /** Triangle indices in leaf order. */
  triIndices: Uint32Array;
  maxDepth: number;
}

const MAX_LEAF_TRIANGLES = 4;
// Traversal in the shader uses a fixed-size stack; keep the tree within it.
const MAX_DEPTH = 32;

/**
 * Builds the tree over a world-space triangle soup.
 *
 * @param positions Per-vertex world positions, 3 floats each.
 * @param index Triangle vertex indices, 3 per triangle.
 */
export function buildGpuBvh(positions: Float32Array, index: Uint32Array): GpuBvh {
  const triangleCount = Math.floor(index.length / 3);
  if (triangleCount === 0) {
    return { nodes: new Float32Array(8), nodeCount: 1, triIndices: new Uint32Array(0), maxDepth: 0 };
  }

  // Centroid and bounds per triangle, computed once and reused at every split.
  const centroids = new Float32Array(triangleCount * 3);
  const triMin = new Float32Array(triangleCount * 3);
  const triMax = new Float32Array(triangleCount * 3);

  for (let t = 0; t < triangleCount; t++) {
    const a = index[t * 3] * 3;
    const b = index[t * 3 + 1] * 3;
    const c = index[t * 3 + 2] * 3;
    for (let axis = 0; axis < 3; axis++) {
      const va = positions[a + axis];
      const vb = positions[b + axis];
      const vc = positions[c + axis];
      triMin[t * 3 + axis] = Math.min(va, vb, vc);
      triMax[t * 3 + axis] = Math.max(va, vb, vc);
      centroids[t * 3 + axis] = (va + vb + vc) / 3;
    }
  }

  const order = new Uint32Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) order[t] = t;

  // Worst case for a binary tree over n leaves of >=1 triangle is 2n-1 nodes.
  const nodes = new Float32Array(Math.max(1, triangleCount * 2 - 1) * 8);
  const nodeInts = new Uint32Array(nodes.buffer);
  let nodeCount = 0;
  let deepest = 0;

  const scratch = new Uint32Array(triangleCount);

  /** Reserves a node slot and writes the bounds of `[start, start+count)`. */
  function allocNode(start: number, count: number): number {
    const node = nodeCount++;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = order[i] * 3;
      if (triMin[t] < minX) minX = triMin[t];
      if (triMin[t + 1] < minY) minY = triMin[t + 1];
      if (triMin[t + 2] < minZ) minZ = triMin[t + 2];
      if (triMax[t] > maxX) maxX = triMax[t];
      if (triMax[t + 1] > maxY) maxY = triMax[t + 1];
      if (triMax[t + 2] > maxZ) maxZ = triMax[t + 2];
    }
    const o = node * 8;
    nodes[o] = minX;
    nodes[o + 1] = minY;
    nodes[o + 2] = minZ;
    nodes[o + 4] = maxX;
    nodes[o + 5] = maxY;
    nodes[o + 6] = maxZ;
    return node;
  }

  function makeLeaf(node: number, start: number, count: number) {
    nodeInts[node * 8 + 3] = start;
    nodeInts[node * 8 + 7] = count;
  }

  /**
   * Splits at the midpoint of the centroid bounds along the widest axis, which
   * is cheap and behaves well on the kind of architectural geometry this bakes.
   * Degenerate splits (everything on one side — co-planar or duplicated
   * triangles) fall back to halving the range so the recursion always shrinks.
   */
  function build(start: number, count: number, depth: number): number {
    const node = allocNode(start, count);
    deepest = Math.max(deepest, depth);

    if (count <= MAX_LEAF_TRIANGLES || depth >= MAX_DEPTH - 1) {
      makeLeaf(node, start, count);
      return node;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < start + count; i++) {
      const c = order[i] * 3;
      if (centroids[c] < minX) minX = centroids[c];
      if (centroids[c + 1] < minY) minY = centroids[c + 1];
      if (centroids[c + 2] < minZ) minZ = centroids[c + 2];
      if (centroids[c] > maxX) maxX = centroids[c];
      if (centroids[c + 1] > maxY) maxY = centroids[c + 1];
      if (centroids[c + 2] > maxZ) maxZ = centroids[c + 2];
    }

    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const spanZ = maxZ - minZ;
    const axis = spanX > spanY ? (spanX > spanZ ? 0 : 2) : spanY > spanZ ? 1 : 2;
    const split = (axis === 0 ? minX + maxX : axis === 1 ? minY + maxY : minZ + maxZ) / 2;

    let left = 0;
    let right = count - 1;
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      if (centroids[t * 3 + axis] < split) scratch[left++] = t;
      else scratch[right--] = t;
    }
    order.set(scratch.subarray(0, count), start);

    let leftCount = left;
    if (leftCount === 0 || leftCount === count) leftCount = count >> 1;

    // Depth-first: the left child lands at `node + 1`, so only the right child's
    // index — emitted after the whole left subtree — has to be recorded.
    build(start, leftCount, depth + 1);
    const rightChild = build(start + leftCount, count - leftCount, depth + 1);

    nodeInts[node * 8 + 3] = rightChild;
    nodeInts[node * 8 + 7] = 0;
    return node;
  }

  build(0, triangleCount, 0);

  return {
    nodes: nodes.subarray(0, nodeCount * 8),
    nodeCount,
    triIndices: order,
    maxDepth: deepest,
  };
}
