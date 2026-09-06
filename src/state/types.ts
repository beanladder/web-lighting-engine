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
