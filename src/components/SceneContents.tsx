import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import { runtime, useEngine } from '../state/store';
import type { LightDef } from '../state/types';

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

/** Frames the camera on whatever's loaded, once, whenever it's replaced. */
function CameraFraming({ modelVersion }: { modelVersion: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | (THREE.Controls<Record<string, unknown>> & { target: THREE.Vector3; update: () => void })
    | null;

  useEffect(() => {
    const model = runtime.model;
    if (!model || !controls) return;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
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
  }, [modelVersion, camera, controls]); // Keyed on modelVersion since runtime.model lives outside React

  return null;
}

/** Wraps `runtime.model` so it remounts whenever a new one is installed. */
function ModelRoot({ modelVersion }: { modelVersion: number }) {
  if (!runtime.model) return null;
  return <primitive key={modelVersion} object={runtime.model} />;
}

/**
 * Clickable viewport handle for a light. Stays visible regardless of whether
 * the light is enabled, so a disabled light can still be found and re-enabled.
 */
function LightHandle({
  light,
  selected,
  onSelect,
}: {
  light: LightDef;
  selected: boolean;
  onSelect: (event: ThreeEvent<MouseEvent>) => void;
}) {
  const color = useMemo(
    () => new THREE.Color(selected ? '#ffb454' : light.color),
    [selected, light.color],
  );

  const rays = useMemo(() => {
    const points: number[] = [];
    if (light.type === 'directional') {
      for (const [x, y] of [
        [0, 0],
        [0.3, 0],
        [-0.3, 0],
        [0, 0.3],
        [0, -0.3],
      ]) {
        points.push(x, y, 0, x, y, -1.8);
      }
    } else if (light.type === 'spot') {
      points.push(0, 0, 0, 0, 0, -0.4);
    }
    return new Float32Array(points);
  }, [light.type]);

  const outline = useMemo(() => {
    if (light.type !== 'area') return new Float32Array(0);
    const w = light.width / 2;
    const h = light.height / 2;
    const corners: [number, number][] = [
      [-w, -h],
      [w, -h],
      [w, h],
      [-w, h],
    ];
    const points: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      points.push(a[0], a[1], 0, b[0], b[1], 0);
    }
    points.push(0, 0, 0, 0, 0, -Math.max(w, h) * 0.8);
    return new Float32Array(points);
  }, [light.type, light.width, light.height]);

  const coneLength = Math.max(light.distance > 0 ? Math.min(light.distance, 8) : 3, 0.5);

  return (
    <group>
      <mesh onClick={onSelect} renderOrder={3}>
        <sphereGeometry args={[0.12, 16, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} depthTest={!selected} />
      </mesh>

      {rays.length ? (
        <lineSegments renderOrder={3} raycast={noRaycast}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[rays, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={color} toneMapped={false} transparent opacity={0.9} />
        </lineSegments>
      ) : null}

      {/*
       * ConeGeometry's narrow tip sits at local +Y, base at -Y. Rotating by
       * +90° around X (not -90°) is what actually puts the tip at the origin
       * (the bulb) and flares the wide end out along -Z, matching where the
       * light really falls — the other sign draws a funnel narrowing into
       * the distance instead of a beam widening away from the source.
       */}
      {light.type === 'spot' ? (
        <mesh position={[0, 0, -coneLength / 2]} rotation={[Math.PI / 2, 0, 0]} raycast={noRaycast}>
          <coneGeometry args={[Math.tan(light.angle) * coneLength, coneLength, 28, 1, true]} />
          <meshBasicMaterial
            color={color}
            wireframe
            transparent
            opacity={selected ? 0.35 : 0.16}
            toneMapped={false}
          />
        </mesh>
      ) : null}

      {light.type === 'area' ? (
        <>
          <mesh onClick={onSelect}>
            <planeGeometry args={[light.width, light.height]} />
            <meshBasicMaterial
              color={new THREE.Color(light.color)}
              transparent
              opacity={selected ? 0.35 : 0.18}
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
          <lineSegments renderOrder={3} raycast={noRaycast}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[outline, 3]} />
            </bufferGeometry>
            <lineBasicMaterial color={color} toneMapped={false} />
          </lineSegments>
        </>
      ) : null}
    </group>
  );
}

/** One authored light: the three.js light itself plus its handle. */
function LightObject({ light, selected }: { light: LightDef; selected: boolean }) {
  const group = useRef<THREE.Group>(null);
  const sceneRadius = useEngine((s) => s.sceneRadius);
  const showHelpers = useEngine((s) => s.showHelpers);
  const select = useEngine((s) => s.select);

  // A child object one unit down -Z gives directional and spot lights their
  // aim without needing a separate target in the scene root.
  const target = useMemo(() => {
    const object = new THREE.Object3D();
    object.position.set(0, 0, -1);
    return object;
  }, []);

  // Sync transforms edited from the inspector. TransformControls mutates the
  // object directly, so this is a no-op during a drag.
  useLayoutEffect(() => {
    const object = group.current;
    if (!object) return;
    object.position.set(light.position[0], light.position[1], light.position[2]);
    object.rotation.set(light.rotation[0], light.rotation[1], light.rotation[2]);
  }, [light.position, light.rotation]);

  const color = useMemo(() => new THREE.Color(light.color), [light.color]);
  const shadowExtent = Math.max(sceneRadius * 1.5, 1);
  const shadowFar = sceneRadius * 6 + 20;

  const onSelect = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    select({ kind: 'light', id: light.id });
  };

  return (
    <group ref={group} name={'light:' + light.id}>
      <primitive object={target} />

      {light.enabled && light.type === 'directional' ? (
        <directionalLight
          color={color}
          intensity={light.intensity}
          castShadow={light.castShadow}
          target={target}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={light.shadowBias}
          shadow-normalBias={0.02}
          shadow-camera-near={0.1}
          shadow-camera-far={shadowFar}
          shadow-camera-left={-shadowExtent}
          shadow-camera-right={shadowExtent}
          shadow-camera-top={shadowExtent}
          shadow-camera-bottom={-shadowExtent}
        />
      ) : null}

      {light.enabled && light.type === 'point' ? (
        <pointLight
          color={color}
          intensity={light.intensity}
          distance={light.distance}
          decay={light.decay}
          castShadow={light.castShadow}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-bias={light.shadowBias}
          shadow-normalBias={0.02}
          shadow-camera-near={0.05}
          shadow-camera-far={light.distance > 0 ? light.distance : shadowFar}
        />
      ) : null}

      {light.enabled && light.type === 'spot' ? (
        <spotLight
          color={color}
          intensity={light.intensity}
          distance={light.distance}
          decay={light.decay}
          angle={light.angle}
          penumbra={light.penumbra}
          castShadow={light.castShadow}
          target={target}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={light.shadowBias}
          shadow-normalBias={0.02}
          shadow-camera-near={0.05}
          shadow-camera-far={light.distance > 0 ? light.distance : shadowFar}
        />
      ) : null}

      {light.enabled && light.type === 'area' ? (
        <rectAreaLight
          color={color}
          intensity={light.intensity}
          width={light.width}
          height={light.height}
        />
      ) : null}

      {showHelpers ? <LightHandle light={light} selected={selected} onSelect={onSelect} /> : null}
    </group>
  );
}

function LightRig() {
  const lights = useEngine((s) => s.lights);
  const selection = useEngine((s) => s.selection);

  return (
    <>
      {lights.map((light) => (
        <LightObject
          key={light.id}
          light={light}
          selected={selection?.kind === 'light' && selection.id === light.id}
        />
      ))}
    </>
  );
}

/** Moves the selected light, writing the result back to the store. */
function Gizmo() {
  const selection = useEngine((s) => s.selection);
  const mode = useEngine((s) => s.transformMode);
  const showGizmo = useEngine((s) => s.showGizmo);
  const lights = useEngine((s) => s.lights);
  const updateLight = useEngine((s) => s.updateLight);
  const scene = useThree((s) => s.scene);
  const [attached, setAttached] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    if (!showGizmo || !selection) {
      setAttached(null);
      return;
    }
    setAttached(scene.getObjectByName('light:' + selection.id) ?? null);
  }, [selection, showGizmo, scene, lights.length]);

  if (!attached || !selection) return null;

  // Scaling a light means nothing; fall back to moving it.
  const gizmoMode = mode === 'scale' ? 'translate' : mode;

  return (
    <TransformControls
      object={attached}
      mode={gizmoMode}
      size={0.8}
      onObjectChange={() => {
        updateLight(selection.id, {
          position: [attached.position.x, attached.position.y, attached.position.z],
          rotation: [attached.rotation.x, attached.rotation.y, attached.rotation.z],
        });
      }}
    />
  );
}

export default function SceneContents() {
  const showGrid = useEngine((s) => s.showGrid);
  const sceneRadius = useEngine((s) => s.sceneRadius);
  const modelVersion = useEngine((s) => s.modelVersion);
  const gridSize = Math.max(Math.ceil(sceneRadius * 2) * 2, 10);

  return (
    <>
      <Background />

      <LightRig />
      <Gizmo />

      <ModelRoot modelVersion={modelVersion} />

      <CameraFraming modelVersion={modelVersion} />

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
