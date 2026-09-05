/**
 * Shared editor types.
 *
 * This grows commit by commit: lights, meshes, selection, and bake settings
 * each land alongside the feature that needs them, rather than being
 * speculatively defined here up front.
 */

/** Which backend the renderer actually landed on — see components/Viewport.tsx. */
export type RendererBackend = 'WebGPU' | 'WebGL2';

/** Gizmo mode for whatever ends up selectable (lights first, meshes later). */
export type TransformMode = 'translate' | 'rotate' | 'scale';
