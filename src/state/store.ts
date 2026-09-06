import { create } from 'zustand';
import * as THREE from 'three';
import type { LightDef, LightType, MeshEntry, RendererBackend, Selection, TransformMode } from './types';

let idCounter = 0;
const nextId = (prefix: string) => prefix + '-' + (++idCounter).toString(36) + '-' + Date.now().toString(36);

/** Sensible per-type starting points — everything else defaults the same way. */
const LIGHT_DEFAULTS: Record<LightType, Partial<LightDef>> = {
  directional: { intensity: 3, castShadow: true },
  point: { intensity: 12, distance: 0, decay: 2, castShadow: true },
  spot: { intensity: 40, distance: 0, decay: 2, angle: Math.PI / 6, penumbra: 0.4, castShadow: true },
  area: { intensity: 6, width: 2, height: 2, castShadow: false },
};

function makeLight(type: LightType, index: number): LightDef {
  const base: LightDef = {
    id: nextId('light'),
    name: type[0].toUpperCase() + type.slice(1) + ' Light ' + index,
    type,
    enabled: true,
    position: type === 'directional' ? [4, 6, 4] : [0, 2.5, 2],
    rotation: [-Math.PI / 4, Math.PI / 5, 0],
    color: '#ffffff',
    intensity: 1,
    castShadow: true,
    shadowBias: -0.0005,
    distance: 0,
    decay: 2,
    angle: Math.PI / 6,
    penumbra: 0.3,
    width: 2,
    height: 2,
  };
  return { ...base, ...LIGHT_DEFAULTS[type] };
}

// A key light so the viewport is never a black void — replaces the flat
// hemisphere-light scaffold from the previous commit now that real lights exist.
const DEFAULT_LIGHTS: LightDef[] = [{ ...makeLight('directional', 1), name: 'Key Light' }];

/** The editor's global state. */
interface EngineState {
  rendererBackend: RendererBackend | null; // Backend the WebGPURenderer landed on, once initialized
  setRendererBackend: (backend: RendererBackend) => void;

  transformMode: TransformMode; // Gizmo mode for the transform controls
  setTransformMode: (mode: TransformMode) => void;

  showGrid: boolean; // Whether the grid helper is visible
  showHelpers: boolean; // Whether light handles are visible
  showGizmo: boolean; // Whether the transform gizmo is visible
  setView: (patch: Partial<Pick<EngineState, 'showGrid' | 'showHelpers' | 'showGizmo'>>) => void;

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
}

export const useEngine = create<EngineState>((set, get) => ({
  rendererBackend: null,
  setRendererBackend: (rendererBackend) => set({ rendererBackend }),

  transformMode: 'translate',
  setTransformMode: (transformMode) => set({ transformMode }),

  showGrid: true,
  showHelpers: true,
  showGizmo: true,
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
    set((s) => ({ meshes: [], modelName: null, sceneRadius: 5, modelVersion: s.modelVersion + 1 })),

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
      selection: s.selection?.kind === 'light' && s.selection.id === id ? null : s.selection,
    })),

  updateLight: (id, patch) =>
    set((s) => ({ lights: s.lights.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),

  select: (selection) => set({ selection }),
}));

/** Live three.js objects, kept outside the store so they don't trigger React re-renders. */
export const runtime: {
  model: THREE.Group | null;
  meshes: Map<string, THREE.Mesh>;
} = {
  model: null,
  meshes: new Map(),
};
