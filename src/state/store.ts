import { create } from 'zustand';
import * as THREE from 'three';
import { buildDemoScene } from '../core/loaders';
import type { RendererBackend, TransformMode } from './types';

/**
 * The editor's global state. Deliberately small right now — it grows one
 * slice at a time as each feature (lights, model import, baking, ...) lands,
 * instead of being speculatively fleshed out ahead of the code that needs it.
 */
interface EngineState {
  /** Reported once the WebGPURenderer finishes initializing (or falls back). */
  rendererBackend: RendererBackend | null;
  setRendererBackend: (backend: RendererBackend) => void;

  /** Gizmo mode for the transform controls a later commit wires up. */
  transformMode: TransformMode;
  setTransformMode: (mode: TransformMode) => void;

  /** Viewport toggles. Inert until the grid/handles/gizmo they control exist. */
  showGrid: boolean;
  showHelpers: boolean;
  showGizmo: boolean;
  setView: (patch: Partial<Pick<EngineState, 'showGrid' | 'showHelpers' | 'showGizmo'>>) => void;

  /**
   * Whatever's currently in the viewport. Just the demo scene for now — real
   * imported models (and the mesh list that comes with them) land in the next
   * commit, which is also when this outgrows a single Group reference.
   */
  sceneGroup: THREE.Group | null;
  sceneName: string | null;
  /** Bounding-sphere radius of `sceneGroup`, used to size the grid and frame the camera. */
  sceneRadius: number;
  loadDemoScene: () => void;
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

  sceneGroup: null,
  sceneName: null,
  sceneRadius: 5,
  loadDemoScene: () => {
    const group = buildDemoScene();
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const radius = box.isEmpty() ? 5 : box.getBoundingSphere(new THREE.Sphere()).radius;
    set({ sceneGroup: group, sceneName: group.name, sceneRadius: Math.max(radius, 0.5) });
  },
}));
