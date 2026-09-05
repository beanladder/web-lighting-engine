import * as THREE from 'three';

/** Builds a small stand-in scene for the demo. */
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
