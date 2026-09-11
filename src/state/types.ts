/** Which backend the renderer actually landed on. */
export type RendererBackend = 'WebGPU' | 'WebGL2';

/** Gizmo mode for whatever ends up selectable. */
export type TransformMode = 'translate' | 'rotate' | 'scale';

/** A mesh from the imported model, as tracked by the editor. */
export interface MeshEntry {
  id: string;
  name: string;
  visible: boolean;
  triangles: number;
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

  /** area: rectangle dimensions in world units. */
  width: number;
  height: number;
}

/**
 * What's selected in the viewport/hierarchy. A light-target is its own kind
 * (rather than folded into 'light') since it's a separate draggable point in
 * space, addressed by the same light's id.
 */
export type Selection = { kind: 'light' | 'light-target' | 'mesh'; id: string } | null;
