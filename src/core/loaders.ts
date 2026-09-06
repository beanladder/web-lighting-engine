import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

const SUPPORTED = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'];

export const SUPPORTED_EXTENSIONS = SUPPORTED;

export interface LoadedModel {
  group: THREE.Group;
  name: string;
  warnings: string[];
}

function extensionOf(name: string) {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * Resolves sibling files (textures, .bin, .mtl) from a multi-file drop, so a
 * folder dragged straight out of a DCC tool loads with its maps intact.
 */
function createManager(files: File[], urls: string[]) {
  const manager = new THREE.LoadingManager();
  const byName = new Map<string, File>();
  for (const file of files) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    byName.set(file.name.toLowerCase(), file);
    byName.set(path.toLowerCase(), file);
  }

  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const clean = decodeURIComponent(url.split('?')[0].replace(/^\.\//, ''));
    const candidates = [clean.toLowerCase(), clean.slice(clean.lastIndexOf('/') + 1).toLowerCase()];
    for (const candidate of candidates) {
      const file = byName.get(candidate);
      if (file) {
        const objectUrl = URL.createObjectURL(file);
        urls.push(objectUrl);
        return objectUrl;
      }
    }
    return url;
  });

  return manager;
}

let dracoLoader: DRACOLoader | null = null;
function getDraco() {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader();
    // Only fetched if a file actually uses Draco compression.
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  }
  return dracoLoader;
}

export async function loadModel(files: File[]): Promise<LoadedModel> {
  const warnings: string[] = [];
  const primary = files.find((file) => SUPPORTED.includes(extensionOf(file.name)));
  if (!primary) {
    throw new Error('Drop a ' + SUPPORTED.map((e) => '.' + e).join(', ') + ' file.');
  }

  const urls: string[] = [];
  const manager = createManager(files, urls);
  const url = URL.createObjectURL(primary);
  urls.push(url);

  try {
    const extension = extensionOf(primary.name);
    let group: THREE.Group;

    switch (extension) {
      case 'glb':
      case 'gltf': {
        const loader = new GLTFLoader(manager);
        loader.setDRACOLoader(getDraco());
        const gltf = await loader.loadAsync(url);
        group = gltf.scene;
        break;
      }
      case 'obj': {
        const mtl = files.find((file) => extensionOf(file.name) === 'mtl');
        const loader = new OBJLoader(manager);
        if (mtl) {
          const mtlUrl = URL.createObjectURL(mtl);
          urls.push(mtlUrl);
          const materials = await new MTLLoader(manager).loadAsync(mtlUrl);
          materials.preload();
          loader.setMaterials(materials);
        } else {
          warnings.push('No .mtl alongside the .obj — using a default material.');
        }
        group = await loader.loadAsync(url);
        break;
      }
      case 'fbx': {
        group = (await new FBXLoader(manager).loadAsync(url)) as unknown as THREE.Group;
        break;
      }
      case 'stl': {
        const geometry = await new STLLoader(manager).loadAsync(url);
        group = new THREE.Group();
        group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xcccccc })));
        break;
      }
      case 'ply': {
        const geometry = await new PLYLoader(manager).loadAsync(url);
        group = new THREE.Group();
        group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xcccccc })));
        break;
      }
      default:
        throw new Error('Unsupported file type: .' + extension);
    }

    group.name = primary.name;
    prepareModel(group, warnings);
    return { group, name: primary.name, warnings };
  } finally {
    // The loaders have already parsed everything into memory by now.
    for (const objectUrl of urls) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Normalises an imported hierarchy: PBR materials everywhere, normals present,
 * and the model resting on the origin so a lighting rig makes sense against it.
 */
export function prepareModel(group: THREE.Group, warnings: string[] = []) {
  const converted = new Map<THREE.Material, THREE.Material>();
  let missingNormals = 0;
  let skinned = 0;

  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) skinned++;

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (!mesh.geometry.getAttribute('normal')) {
      mesh.geometry.computeVertexNormals();
      missingNormals++;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const upgraded = materials.map((material) => convertToStandard(material, converted));
    mesh.material = Array.isArray(mesh.material) ? upgraded : upgraded[0];
  });

  if (missingNormals) warnings.push('Generated normals for ' + missingNormals + ' mesh(es).');
  if (skinned) {
    warnings.push(
      skinned +
        ' skinned mesh(es) found. Baked lighting only fits the bind pose — animated meshes are better lit in realtime.',
    );
  }

  // Sit the model on the ground plane, centred on the origin.
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty()) {
    const centre = box.getCenter(new THREE.Vector3());
    group.position.x -= centre.x;
    group.position.z -= centre.z;
    group.position.y -= box.min.y;
  }
  group.updateMatrixWorld(true);
  return group;
}

/** Phong/Lambert/Basic imports become physical materials so lighting behaves. */
function convertToStandard(
  material: THREE.Material,
  cache: Map<THREE.Material, THREE.Material>,
): THREE.Material {
  const existing = cache.get(material);
  if (existing) return existing;

  const standard = material as THREE.MeshStandardMaterial & { isMeshPhysicalMaterial?: boolean };
  if (standard.isMeshStandardMaterial || standard.isMeshPhysicalMaterial) {
    cache.set(material, material);
    return material;
  }

  const source = material as THREE.MeshPhongMaterial;
  const replacement = new THREE.MeshStandardMaterial({
    name: source.name,
    color: source.color ? source.color.clone() : new THREE.Color(0xcccccc),
    map: source.map ?? null,
    normalMap: source.normalMap ?? null,
    aoMap: source.aoMap ?? null,
    emissive: source.emissive ? source.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: source.emissiveMap ?? null,
    transparent: source.transparent,
    opacity: source.opacity,
    side: source.side,
    alphaTest: source.alphaTest,
    vertexColors: source.vertexColors,
    // Phong shininess maps loosely onto roughness; this reads about right.
    roughness:
      source.shininess !== undefined ? THREE.MathUtils.clamp(1 - source.shininess / 100, 0.2, 1) : 0.85,
    metalness: 0,
  });
  cache.set(material, replacement);
  return replacement;
}

/** A small stand-in scene, so the editor is usable before importing anything. */
export function buildDemoScene(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Demo Scene';

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(10, 0.2, 10),
    new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.95, metalness: 0 }),
  );
  floor.position.y = -0.1;
  floor.name = 'Floor';
  group.add(floor);

  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(10, 5, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xc94f3d, roughness: 0.9 }),
  );
  backWall.position.set(0, 2.5, -5);
  backWall.name = 'Wall Red';
  group.add(backWall);

  const sideWall = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 5, 10),
    new THREE.MeshStandardMaterial({ color: 0x4d8c53, roughness: 0.9 }),
  );
  sideWall.position.set(-5, 2.5, 0);
  sideWall.name = 'Wall Green';
  group.add(sideWall);

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 2.6, 1.4),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 }),
  );
  box.position.set(-1.4, 1.3, -1.2);
  box.rotation.y = 0.3;
  box.name = 'Column';
  group.add(box);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.55 }),
  );
  sphere.position.set(1.5, 1, 1);
  sphere.name = 'Sphere';
  group.add(sphere);

  const torus = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.6, 0.2, 128, 24),
    new THREE.MeshStandardMaterial({ color: 0xe8c37a, roughness: 0.4, metalness: 0.1 }),
  );
  torus.position.set(1.6, 3, -2);
  torus.name = 'Knot';
  group.add(torus);

  for (const child of group.children) {
    child.castShadow = true;
    child.receiveShadow = true;
  }

  return group;
}
