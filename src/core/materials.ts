import * as THREE from 'three';
import { runtime } from '../state/store';
import type { ViewMode } from '../state/types';

/**
 * Material swapping for the viewport.
 *
 * Imported materials are never mutated — they are kept in `runtime.originalMaterials`
 * and a baked variant is derived from them, so toggling view modes, re-baking or
 * clearing a bake is always reversible.
 */

function asArray(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

export function rememberOriginals() {
  for (const [id, mesh] of runtime.meshes) {
    if (!runtime.originalMaterials.has(id)) runtime.originalMaterials.set(id, mesh.material);
  }
}

export function disposeBakedMaterials() {
  for (const material of runtime.bakedMaterials.values()) {
    for (const entry of asArray(material)) entry.dispose();
  }
  runtime.bakedMaterials.clear();
}

/**
 * Clones each lightmapped mesh's material and wires the atlas into the
 * `lightMap` slot on UV set 1.
 */
export function applyLightmap(meshIds: string[], texture: THREE.DataTexture, intensity: number) {
  rememberOriginals();
  disposeBakedMaterials();

  for (const id of meshIds) {
    const mesh = runtime.meshes.get(id);
    const original = runtime.originalMaterials.get(id);
    if (!mesh || !original) continue;

    const baked = asArray(original).map((material) => {
      const clone = material.clone() as THREE.MeshStandardMaterial;
      clone.name = material.name ? material.name + ' (baked)' : 'baked';
      clone.lightMap = texture;
      clone.lightMapIntensity = intensity;
      clone.needsUpdate = true;
      return clone as THREE.Material;
    });

    runtime.bakedMaterials.set(id, Array.isArray(original) ? baked : baked[0]);
  }
}

export function setLightmapIntensity(intensity: number) {
  for (const material of runtime.bakedMaterials.values()) {
    for (const entry of asArray(material)) {
      (entry as THREE.MeshStandardMaterial).lightMapIntensity = intensity;
    }
  }
}

let previewMaterials: THREE.Material[] = [];

function disposePreview() {
  for (const material of previewMaterials) material.dispose();
  previewMaterials = [];
}

/** Points every mesh at whichever material the current view mode calls for. */
export function applyViewMode(mode: ViewMode, lightmap: THREE.DataTexture | null) {
  rememberOriginals();
  disposePreview();

  for (const [id, mesh] of runtime.meshes) {
    const original = runtime.originalMaterials.get(id);
    if (!original) continue;
    const baked = runtime.bakedMaterials.get(id);

    switch (mode) {
      case 'lit':
      case 'baked':
        mesh.material = baked ?? original;
        break;

      case 'lightmap': {
        // Irradiance without albedo — the view you want when hunting for seams
        // or splotchy texels. Scaled by the Lambert 1/PI so it reads as "what
        // this lighting does to a white surface" instead of clipping to white.
        const material = new THREE.MeshBasicMaterial({
          color: lightmap ? new THREE.Color(1, 1, 1).multiplyScalar(1 / Math.PI) : new THREE.Color(0x202020),
          map: lightmap,
        });
        previewMaterials.push(material);
        mesh.material = material;
        break;
      }

      case 'albedo': {
        const source = asArray(original)[0] as THREE.MeshStandardMaterial;
        const material = new THREE.MeshBasicMaterial({
          color: source.color ? source.color.clone() : new THREE.Color(0xffffff),
          map: source.map ?? null,
          vertexColors: source.vertexColors,
        });
        previewMaterials.push(material);
        mesh.material = material;
        break;
      }

      case 'wireframe': {
        const material = new THREE.MeshBasicMaterial({ color: 0x6fd3ff, wireframe: true });
        previewMaterials.push(material);
        mesh.material = material;
        break;
      }
    }
  }
}

/** Drops the baked variants and restores the imported materials. */
export function clearLightmap() {
  for (const [id, mesh] of runtime.meshes) {
    const original = runtime.originalMaterials.get(id);
    if (original) mesh.material = original;
  }
  disposeBakedMaterials();
  disposePreview();
}
