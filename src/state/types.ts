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
  /** Euler XYZ in radians. Emission direction is -Z rotated by this. */
  rotation: Vec3;

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

/** What's selected in the viewport/hierarchy. Meshes join lights once mesh selection lands. */
export type Selection = { kind: 'light'; id: string } | null;
