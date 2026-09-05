import { create } from 'zustand';
import * as THREE from 'three';
import { buildDemoScene } from '../core/loaders';
import type { RendererBackend, TransformMode } from './types';

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

  sceneGroup: THREE.Group | null; // Whatever's currently in the viewport
  sceneName: string | null; // Name of the currently loaded scene
  sceneRadius: number; // Bounding-sphere radius of sceneGroup, used to size the grid and frame the camera
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
