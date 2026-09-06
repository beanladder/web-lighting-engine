import * as THREE from 'three';
import { runtime, useEngine } from '../state/store';
import type { MeshEntry } from '../state/types';
import { loadModel } from './loaders';

/** Owns the lifetime of whatever's currently loaded, outside of React. */

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  for (const entry of Array.isArray(material) ? material : [material]) {
    for (const value of Object.values(entry) as unknown[]) {
      if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
    }
    entry.dispose();
  }
}

function disposeModel() {
  const model = runtime.model;
  if (model) {
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      disposeMaterial(mesh.material);
    });
  }
  runtime.model = null;
  runtime.meshes.clear();
}

function describe(mesh: THREE.Mesh): MeshEntry {
  const position = mesh.geometry.getAttribute('position');
  const triangles = mesh.geometry.index ? mesh.geometry.index.count / 3 : (position?.count ?? 0) / 3;
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;

  return {
    id: mesh.uuid,
    name: mesh.name || 'Mesh',
    visible: mesh.visible,
    triangles: Math.round(triangles),
    materialName: material?.name || material?.type || 'Material',
  };
}

/** Swaps in a freshly loaded hierarchy and rebuilds the editor's view of it. */
export function installModel(group: THREE.Group, name: string): MeshEntry[] {
  disposeModel();

  runtime.model = group;
  group.updateMatrixWorld(true);

  const entries: MeshEntry[] = [];
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    runtime.meshes.set(mesh.uuid, mesh);
    entries.push(describe(mesh));
  });

  const box = new THREE.Box3().setFromObject(group);
  const radius = box.isEmpty() ? 5 : box.getBoundingSphere(new THREE.Sphere()).radius;

  useEngine.getState().setMeshes(entries, name, Math.max(radius, 0.5));
  return entries;
}

export function clearModel() {
  disposeModel();
  useEngine.getState().clearModel();
}

/** Shared by every import trigger (File menu, drag-drop) so the "importing…" indicator stays consistent. */
export async function importFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  const engine = useEngine.getState();
  engine.setBusy('Importing ' + files[0].name);
  try {
    const loaded = await loadModel(files);
    installModel(loaded.group, loaded.name);
  } finally {
    useEngine.getState().setBusy(null);
  }
}
