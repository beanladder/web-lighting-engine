import { create } from 'zustand';
import * as THREE from 'three';
import type {
  BakeSettings,
  BakeStats,
  BakeStatus,
  EnvironmentDef,
  LightDef,
  LightType,
  MeshEntry,
  RendererBackend,
  Selection,
  TransformMode,
  Vec3,
  ViewMode,
} from './types';

let idCounter = 0;
const nextId = (prefix: string) => prefix + '-' + (++idCounter).toString(36) + '-' + Date.now().toString(36);

// Scratch objects for the look-at math below — reused so aiming a light at a
// target doesn't allocate on every drag frame.
const lookAtHelper = new THREE.Object3D();
const lookAtTarget = new THREE.Vector3();

/** The Euler rotation that makes local -Z (every light's aim direction) point from `position` toward `target`. */
function computeLookAtRotation(position: Vec3, target: Vec3): Vec3 {
  lookAtHelper.position.set(position[0], position[1], position[2]);
  lookAtHelper.rotation.set(0, 0, 0);
  lookAtTarget.set(target[0], target[1], target[2]);
  lookAtHelper.lookAt(lookAtTarget);
  // Object3D.lookAt() aims local +Z at the target, not -Z — the opposite of
  // what every light in three.js treats as "forward". Turning an extra 180°
  // around Y swaps which end faces the target without touching which way is
  // "up" (verified numerically: without this, the light aims exactly
  // backwards — a dot product of -1 against the true direction to target).
  lookAtHelper.rotateY(Math.PI);
  return [lookAtHelper.rotation.x, lookAtHelper.rotation.y, lookAtHelper.rotation.z];
}

/** Sensible per-type starting points — everything else defaults the same way. */
const LIGHT_DEFAULTS: Record<LightType, Partial<LightDef>> = {
  directional: { intensity: 3, radius: 0.5, castShadow: true },
  point: { intensity: 12, distance: 0, decay: 2, radius: 0.15, castShadow: true },
  spot: {
    intensity: 40,
    distance: 0,
    decay: 2,
    angle: Math.PI / 6,
    penumbra: 0.4,
    radius: 0.1,
    castShadow: true,
  },
  area: { intensity: 6, width: 2, height: 2, castShadow: false },
};

function makeLight(type: LightType, index: number): LightDef {
  const base: LightDef = {
    id: nextId('light'),
    name: type[0].toUpperCase() + type.slice(1) + ' Light ' + index,
    type,
    enabled: true,
    preview: true,
    bake: true,
    position: type === 'directional' ? [4, 6, 4] : [0, 2.5, 2],
    rotation: [-Math.PI / 4, Math.PI / 5, 0],
    target: null,
    color: '#ffffff',
    intensity: 1,
    castShadow: true,
    shadowBias: -0.0005,
    distance: 0,
    decay: 2,
    angle: Math.PI / 6,
    penumbra: 0.3,
    radius: 0.1,
    width: 2,
    height: 2,
  };
  return { ...base, ...LIGHT_DEFAULTS[type] };
}

// A key light so the viewport is never a black void — replaces the flat
// hemisphere-light scaffold from the previous commit now that real lights exist.
const DEFAULT_LIGHTS: LightDef[] = [{ ...makeLight('directional', 1), name: 'Key Light' }];

const DEFAULT_ENVIRONMENT: EnvironmentDef = {
  skyColor: '#8fb4ff',
  groundColor: '#2a2622',
  intensity: 0.6,
  enabled: true,
  bake: true,
  background: 'gradient',
  backgroundColor: '#101216',
};

const DEFAULT_BAKE_SETTINGS: BakeSettings = {
  resolution: 1024,
  unwrap: 'generate',
  padding: 3,
  samples: 128,
  bounces: 1,
  shadowSamples: 4,
  rayDistance: 0,
  bias: 0.004,
  denoise: true,
  denoiseStrength: 0.6,
  dilate: 4,
  exposure: 1,
  aoStrength: 1,
  threads: 0,
};

export interface BakeResult {
  texture: THREE.DataTexture;
  /** Raw linear irradiance, kept so exposure can be re-applied without re-tracing. */
  raw: Float32Array;
  /** Per-texel albedo, needed for the combined (unlit) export. */
  albedo: Float32Array;
  size: number;
  /** Meshes that were included, so we know what to strip on clear. */
  meshIds: string[];
  stats: BakeStats;
}

/** The editor's global state. */
interface EngineState {
  rendererBackend: RendererBackend | null; // Backend the WebGPURenderer landed on, once initialized
  setRendererBackend: (backend: RendererBackend) => void;

  transformMode: TransformMode; // Gizmo mode for the transform controls
  setTransformMode: (mode: TransformMode) => void;

  showGrid: boolean; // Whether the grid helper is visible
  showHelpers: boolean; // Whether light handles are visible
  showGizmo: boolean; // Whether the transform gizmo is visible
  viewMode: ViewMode; // Which material variant the viewport shows
  setView: (patch: Partial<Pick<EngineState, 'showGrid' | 'showHelpers' | 'showGizmo' | 'viewMode'>>) => void;

  /** A short label while an import is in flight, shared so any trigger (menu, drag-drop) agrees. */
  busy: string | null;
  setBusy: (busy: string | null) => void;

  meshes: MeshEntry[]; // Every mesh in the currently loaded model (or demo scene)
  modelName: string | null; // Name of whatever's loaded, if anything
  sceneRadius: number; // Bounding-sphere radius, used to size the grid and frame the camera
  /** Bumped whenever `runtime.model` is replaced, since that swap itself is invisible to React. */
  modelVersion: number;
  setMeshes: (meshes: MeshEntry[], modelName: string | null, sceneRadius: number) => void;
  updateMesh: (id: string, patch: Partial<MeshEntry>) => void;
  clearModel: () => void;

  lights: LightDef[];
  selection: Selection;
  addLight: (type: LightType) => string;
  duplicateLight: (id: string) => void;
  removeLight: (id: string) => void;
  updateLight: (id: string, patch: Partial<LightDef>) => void;
  select: (selection: Selection) => void;

  /** Light id currently waiting for a scene click to place its target, if any. */
  pickingTargetFor: string | null;
  setPickingTarget: (id: string | null) => void;

  environment: EnvironmentDef;
  updateEnvironment: (patch: Partial<EnvironmentDef>) => void;

  bakeSettings: BakeSettings;
  bakeStatus: BakeStatus;
  bakeResult: BakeResult | null;
  log: { time: number; level: 'info' | 'warn' | 'error'; message: string }[];
  updateBakeSettings: (patch: Partial<BakeSettings>) => void;
  setBakeStatus: (status: BakeStatus) => void;
  setBakeResult: (result: BakeResult | null) => void;
  pushLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export const useEngine = create<EngineState>((set, get) => ({
  rendererBackend: null,
  setRendererBackend: (rendererBackend) => set({ rendererBackend }),

  transformMode: 'translate',
  setTransformMode: (transformMode) => set({ transformMode }),

  showGrid: true,
  showHelpers: true,
  showGizmo: true,
  viewMode: 'lit',
  setView: (patch) => set(patch),

  busy: null,
  setBusy: (busy) => set({ busy }),

  meshes: [],
  modelName: null,
  sceneRadius: 5,
  modelVersion: 0,
  setMeshes: (meshes, modelName, sceneRadius) =>
    set((s) => ({ meshes, modelName, sceneRadius, modelVersion: s.modelVersion + 1 })),
  updateMesh: (id, patch) =>
    set((s) => ({ meshes: s.meshes.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  clearModel: () =>
    set((s) => ({
      meshes: [],
      modelName: null,
      sceneRadius: 5,
      modelVersion: s.modelVersion + 1,
      bakeResult: null,
      bakeStatus: { phase: 'idle' },
    })),

  lights: DEFAULT_LIGHTS,
  selection: null,

  addLight: (type) => {
    const count = get().lights.filter((l) => l.type === type).length + 1;
    const light = makeLight(type, count);
    set((s) => ({ lights: [...s.lights, light], selection: { kind: 'light', id: light.id } }));
    return light.id;
  },

  duplicateLight: (id) => {
    const source = get().lights.find((l) => l.id === id);
    if (!source) return;
    const copy: LightDef = { ...source, id: nextId('light'), name: source.name + ' Copy' };
    set((s) => ({ lights: [...s.lights, copy], selection: { kind: 'light', id: copy.id } }));
  },

  removeLight: (id) =>
    set((s) => ({
      lights: s.lights.filter((l) => l.id !== id),
      selection: s.selection && s.selection.kind !== 'environment' && s.selection.id === id ? null : s.selection,
      pickingTargetFor: s.pickingTargetFor === id ? null : s.pickingTargetFor,
    })),

  // Whenever a target is in play, position/target edits keep `rotation` in
  // sync (a look-at) so the actual three.js light, its handle, and its gizmo
  // — all of which only ever consume `rotation` — stay correct without
  // needing to know a target exists at all.
  updateLight: (id, patch) =>
    set((s) => ({
      lights: s.lights.map((l) => {
        if (l.id !== id) return l;
        const next = { ...l, ...patch };
        if (next.target && (patch.position || patch.target)) {
          next.rotation = computeLookAtRotation(next.position, next.target);
        }
        return next;
      }),
    })),

  select: (selection) => set({ selection }),

  pickingTargetFor: null,
  setPickingTarget: (pickingTargetFor) => set({ pickingTargetFor }),

  environment: DEFAULT_ENVIRONMENT,
  updateEnvironment: (patch) => set((s) => ({ environment: { ...s.environment, ...patch } })),

  bakeSettings: DEFAULT_BAKE_SETTINGS,
  bakeStatus: { phase: 'idle' },
  bakeResult: null,
  log: [],
  updateBakeSettings: (patch) => set((s) => ({ bakeSettings: { ...s.bakeSettings, ...patch } })),
  setBakeStatus: (bakeStatus) => set({ bakeStatus }),
  setBakeResult: (bakeResult) => set({ bakeResult }),
  pushLog: (level, message) =>
    set((s) => ({ log: [...s.log.slice(-199), { time: Date.now(), level, message }] })),
}));

/** Live three.js objects, kept outside the store so they don't trigger React re-renders. */
export const runtime: {
  model: THREE.Group | null;
  meshes: Map<string, THREE.Mesh>;
  /** Materials as they arrived, so preview modes can be swapped non-destructively. */
  originalMaterials: Map<string, THREE.Material | THREE.Material[]>;
  /** Lightmap-wired clones of the originals, rebuilt on every bake. */
  bakedMaterials: Map<string, THREE.Material | THREE.Material[]>;
} = {
  model: null,
  meshes: new Map(),
  originalMaterials: new Map(),
  bakedMaterials: new Map(),
};
