/** Which backend the renderer actually landed on. */
export type RendererBackend = 'WebGPU' | 'WebGL2';

/** Gizmo mode for whatever ends up selectable. */
export type TransformMode = 'translate' | 'rotate' | 'scale';

/** A mesh from the imported model, as tracked by the editor. */
export interface MeshEntry {
  id: string;
  name: string;
  visible: boolean;
  /** Receives a lightmap. Off by default for transparent surfaces — a baked value behind glass is worse than none. */
  lightmapped: boolean;
  /** Blocks light while baking. */
  occluder: boolean;
  triangles: number;
  /** Whether the source mesh already has a UV set, so "reuse existing UVs" can be offered. */
  hasUV: boolean;
  materialName: string;
}

export type Vec3 = [number, number, number];

export type LightType = 'directional' | 'point' | 'spot' | 'area';

/**
 * One light in the rig. Every light is authored here — nothing is read back
 * out of an imported file — so the same description drives the realtime
 * preview (and, once it exists, the offline baker).
 */
export interface LightDef {
  id: string;
  name: string;
  type: LightType;
  enabled: boolean;
  /** Included in the realtime preview. */
  preview: boolean;
  /** Included when baking. */
  bake: boolean;

  position: Vec3;
  /** Euler XYZ in radians. Emission direction is -Z rotated by this. Ignored (and kept in sync instead) while `target` is set. */
  rotation: Vec3;
  /**
   * directional / spot only: an absolute world point to aim at instead of
   * hand-rotating. When set, `rotation` is recomputed automatically (a
   * look-at) whenever this or `position` changes, so everything downstream
   * that already consumes `rotation` keeps working unchanged.
   */
  target: Vec3 | null;

  color: string;
  intensity: number;

  castShadow: boolean;
  shadowBias: number;

  /** point / spot: falloff cutoff (0 = infinite). */
  distance: number;
  /** point / spot: physical falloff exponent. */
  decay: number;

  /** spot: cone half-angle in radians. */
  angle: number;
  /** spot: 0..1 edge softness. */
  penumbra: number;

  /**
   * Source size, used for soft shadows while baking.
   * point/spot -> sphere radius in world units.
   * directional -> angular radius in degrees (the sun disc is ~0.27).
   */
  radius: number;

  /** area: rectangle dimensions in world units. */
  width: number;
  height: number;
}

/** The sky dome. Acts as ambient light in preview and as the miss shader in the baker. */
export interface EnvironmentDef {
  skyColor: string;
  groundColor: string;
  intensity: number;
  enabled: boolean;
  bake: boolean;
  /** What the camera sees behind the model. */
  background: 'gradient' | 'flat' | 'transparent';
  backgroundColor: string;
}

export type UnwrapMode = 'generate' | 'existing-uv1' | 'existing-uv0';

export interface BakeSettings {
  resolution: 256 | 512 | 1024 | 2048 | 4096;
  unwrap: UnwrapMode;
  /** Padding between charts, in texels. */
  padding: number;
  /** Hemisphere rays per texel — the main quality/time dial. */
  samples: number;
  /** Extra light-transport bounces after the first hemisphere hit. */
  bounces: number;
  /** Shadow rays per light per texel. Drives soft-shadow quality. */
  shadowSamples: number;
  /** Cap on indirect ray length; keeps open scenes fast. 0 = unbounded. */
  rayDistance: number;
  /** Nudge along the normal before tracing, to dodge self-intersection. */
  bias: number;
  /** Edge-aware blur pass over the atlas. */
  denoise: boolean;
  denoiseStrength: number;
  /** Texels of bleed past chart edges, to survive bilinear filtering. */
  dilate: number;
  /** Global multiplier applied to the baked result. */
  exposure: number;
  /** Ambient occlusion darkening applied on top of the sky term, 0..1. */
  aoStrength: number;
  /** Worker count. 0 = auto. */
  threads: number;
}

export interface BakeStats {
  atlasSize: number;
  texels: number;
  charts: number;
  meshes: number;
  triangles: number;
  rays: number;
  seconds: number;
}

export type BakeStatus =
  | { phase: 'idle' }
  | { phase: 'unwrapping'; progress: number; note: string }
  | { phase: 'preparing'; progress: number; note: string }
  | { phase: 'tracing'; progress: number; note: string }
  | { phase: 'resolving'; progress: number; note: string }
  | { phase: 'done'; stats: BakeStats }
  | { phase: 'error'; message: string };

export type ViewMode = 'lit' | 'baked' | 'lightmap' | 'albedo' | 'wireframe';

/**
 * What's selected in the viewport/hierarchy. A light-target is its own kind
 * (rather than folded into 'light') since it's a separate draggable point in
 * space, addressed by the same light's id. The environment has no id — there's
 * only ever one of it.
 */
export type Selection =
  | { kind: 'light' | 'light-target' | 'mesh'; id: string }
  | { kind: 'environment' }
  | null;

/**
 * Everything the bake worker needs about one light, flattened for structured
 * clone across the worker boundary. A separate shape from `LightDef` on
 * purpose: the worker only ever sees a fully-resolved snapshot (world-space
 * direction, intensity already folded into `color`), never the authoring
 * model.
 */
export interface SerializedLight {
  type: LightType;
  position: Vec3;
  /** Unit emission direction in world space. */
  direction: Vec3;
  /** Linear RGB, already multiplied by intensity. */
  color: Vec3;
  distance: number;
  decay: number;
  angle: number;
  penumbra: number;
  /** point/spot: sphere radius. directional: angular radius in degrees. Drives soft shadows. */
  radius: number;
  width: number;
  height: number;
  /** area: world-space basis vectors scaled to half-width / half-height. */
  right: Vec3;
  up: Vec3;
}

/** The sky term the worker uses as its miss shader. */
export interface SerializedEnvironment {
  skyColor: Vec3;
  groundColor: Vec3;
  enabled: boolean;
}

/** World-space triangle soup handed to the bake worker. */
export interface SceneGeometryPayload {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
  /** Linear RGB per vertex — drives colour bleeding on bounces. */
  albedo: Float32Array;
  /** Linear RGB per vertex — emissive surfaces light the scene. */
  emissive: Float32Array;
}

/** Per-texel shading points produced by the rasterizer. */
export interface SamplePayload {
  positions: Float32Array;
  normals: Float32Array;
  texelIndex: Uint32Array;
  count: number;
}

export interface WorkerRequest {
  type: 'bake';
  geometry: SceneGeometryPayload;
  samples: SamplePayload;
  lights: SerializedLight[];
  environment: SerializedEnvironment;
  settings: {
    /** Hemisphere rays per texel — the main quality/time dial. */
    samples: number;
    /** Extra light-transport bounces after the first hemisphere hit. */
    bounces: number;
    /** Shadow rays per light per texel. Drives soft-shadow quality. */
    shadowSamples: number;
    /** Cap on indirect ray length; keeps open scenes fast. 0 = unbounded. */
    rayDistance: number;
    /** Nudge along the normal before tracing, to dodge self-intersection. */
    bias: number;
    /** Ambient occlusion darkening applied on top of the sky term, 0..1. */
    aoStrength: number;
  };
  seed: number;
}

export type WorkerResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; color: Float32Array; texelIndex: Uint32Array; rays: number }
  | { type: 'error'; message: string };
