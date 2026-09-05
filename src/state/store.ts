import { create } from 'zustand';
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
}));
