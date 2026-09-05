import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useEngine } from '../state/store';

/** Everything that lives inside the R3F canvas. */

const noRaycast = () => undefined;

/** Vertical gradient used as the visible sky. */
function useSkyTexture() {
  return useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const gradient = context.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, '#8fb4ff');
    gradient.addColorStop(0.47, '#8fb4ff');
    gradient.addColorStop(0.53, '#2a2622');
    gradient.addColorStop(1, '#2a2622');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 4, 256);
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
}

function Background() {
  const scene = useThree((s) => s.scene);
  const texture = useSkyTexture();

  useEffect(() => {
    scene.background = texture;
    return () => {
      scene.background = null;
      texture?.dispose();
    };
  }, [scene, texture]);

  return null;
}

/** Frames the camera on whatever's loaded, once, whenever it changes. */
function CameraFraming() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | (THREE.Controls<Record<string, unknown>> & { target: THREE.Vector3; update: () => void })
    | null;
  const sceneGroup = useEngine((s) => s.sceneGroup);

  useEffect(() => {
    if (!sceneGroup || !controls) return;
    sceneGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(sceneGroup);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = sphere.radius * 2.6 + 1;
    const direction = new THREE.Vector3(0.8, 0.55, 1).normalize();
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    if ('near' in camera) {
      const perspective = camera as THREE.PerspectiveCamera;
      perspective.near = Math.max(sphere.radius / 500, 0.01);
      perspective.far = distance + sphere.radius * 10 + 100;
      perspective.updateProjectionMatrix();
    }
    controls.target.copy(sphere.center);
    controls.update();
  }, [sceneGroup, camera, controls]);

  return null;
}

export default function SceneContents() {
  const showGrid = useEngine((s) => s.showGrid);
  const sceneGroup = useEngine((s) => s.sceneGroup);
  const sceneRadius = useEngine((s) => s.sceneRadius);
  const gridSize = Math.max(Math.ceil(sceneRadius * 2) * 2, 10);

  return (
    <>
      <Background />

      {/*
       * Temporary flat lighting so the demo scene's MeshStandardMaterial
       * primitives aren't pitch black. Replaced by the authored lighting rig
       * (directional/point/spot/area lights) in an upcoming commit.
       */}
      <hemisphereLight color="#8fb4ff" groundColor="#2a2622" intensity={0.9} />

      {sceneGroup ? <primitive object={sceneGroup} /> : null}

      <CameraFraming />

      {showGrid ? (
        <gridHelper
          args={[gridSize, gridSize, 0x4d5666, 0x2b313b]}
          position={[0, -0.002, 0]}
          raycast={noRaycast}
        />
      ) : null}

      <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxDistance={2000} />
    </>
  );
}
