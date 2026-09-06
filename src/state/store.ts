import { create } from 'zustand';
import * as THREE from 'three';
import type { MeshEntry, RendererBackend, TransformMode } from './types';

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
}

export const useEngine = create<EngineState>((set) => ({
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
}));

/** Live three.js objects, kept outside the store so they don't trigger React re-renders. */
export const runtime: {
  model: THREE.Group | null;
  meshes: Map<string, THREE.Mesh>;
} = {
  model: null,
  meshes: new Map(),
};
