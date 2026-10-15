import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import { runtime, useEngine } from '../state/store';
import type { LightDef, Vec3 } from '../state/types';

/** Everything that lives inside the R3F canvas. */

const noRaycast = () => undefined;

/** Vertical gradient used as the visible sky. Matches the baker's ambient term. */
function useSkyTexture(skyColor: string, groundColor: string, mode: string, flatColor: string) {
  return useMemo(() => {
    if (mode === 'transparent') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) return null;
    if (mode === 'flat') {
      context.fillStyle = flatColor;
      context.fillRect(0, 0, 4, 256);
    } else {
      const gradient = context.createLinearGradient(0, 0, 0, 256);
      gradient.addColorStop(0, skyColor);
      gradient.addColorStop(0.47, skyColor);
      gradient.addColorStop(0.53, groundColor);
      gradient.addColorStop(1, groundColor);
      context.fillStyle = gradient;
      context.fillRect(0, 0, 4, 256);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, [skyColor, groundColor, mode, flatColor]);
}

function Background() {
  const environment = useEngine((s) => s.environment);
  const scene = useThree((s) => s.scene);
  const texture = useSkyTexture(
    environment.skyColor,
    environment.groundColor,
    environment.background,
    environment.backgroundColor,
  );

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
  const select = useEngine((s) => s.select);
  if (!runtime.model) return null;
  return (
    <primitive
      key={modelVersion}
      object={runtime.model}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        // R3F walks up from whatever mesh was actually hit to find the
        // nearest ancestor with a handler — this primitive is the model's
        // root, but `event.object` still names the real mesh underneath.
        const mesh = event.object as THREE.Mesh;
        if (!mesh.isMesh || !runtime.meshes.has(mesh.uuid)) return;
        event.stopPropagation();
        select({ kind: 'mesh', id: mesh.uuid });
      }}
    />
  );
}

const outlineColor = new THREE.Color(0xffb454);

/** Wire box around the selected mesh, so a click actually feels like it landed. */
function SelectionOutline() {
  const selection = useEngine((s) => s.selection);
  const meshes = useEngine((s) => s.meshes); // re-measure if the mesh's own visibility (or anything else) changes
  const [box, setBox] = useState<THREE.Box3 | null>(null);

  useEffect(() => {
    if (selection?.kind !== 'mesh') {
      setBox(null);
      return;
    }
    const mesh = runtime.meshes.get(selection.id);
    if (!mesh) {
      setBox(null);
      return;
    }
    mesh.updateWorldMatrix(true, false);
    setBox(new THREE.Box3().setFromObject(mesh));
  }, [selection, meshes]);

  if (!box) return null;
  return <box3Helper args={[box, outlineColor]} raycast={noRaycast} />;
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

/**
 * The point a light is aiming at, shown as a small diamond connected to the
 * light by a line. Its own selectable, draggable object — moving it (or the
 * light) recomputes the light's rotation via the store's look-at logic.
 */
function TargetHandle({ light, target }: { light: LightDef; target: Vec3 }) {
  const selection = useEngine((s) => s.selection);
  const select = useEngine((s) => s.select);
  const selected = selection?.kind === 'light-target' && selection.id === light.id;

  const linePoints = useMemo(
    () => new Float32Array([...light.position, ...target]),
    [light.position, target],
  );
  const color = useMemo(
    () => new THREE.Color(selected ? '#ffb454' : light.color),
    [selected, light.color],
  );

  return (
    <>
      <lineSegments raycast={noRaycast}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[linePoints, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} toneMapped={false} transparent opacity={0.5} />
      </lineSegments>
      <group name={'light-target:' + light.id} position={target}>
        <mesh
          onClick={(event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            select({ kind: 'light-target', id: light.id });
          }}
        >
          <octahedronGeometry args={[0.14, 0]} />
          <meshBasicMaterial color={color} wireframe toneMapped={false} depthTest={!selected} />
        </mesh>
      </group>
    </>
  );
}

/** One authored light: the three.js light itself plus its handle. */
function LightObject({
  light,
  selected,
  realtime,
}: {
  light: LightDef;
  selected: boolean;
  realtime: boolean;
}) {
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
  const active = realtime && light.enabled && light.preview;

  const onSelect = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    select({ kind: 'light', id: light.id });
  };

  return (
    <>
      <group ref={group} name={'light:' + light.id}>
        <primitive object={target} />

      {active && light.type === 'directional' ? (
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

      {active && light.type === 'point' ? (
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

      {active && light.type === 'spot' ? (
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

      {active && light.type === 'area' ? (
        <rectAreaLight
          color={color}
          intensity={light.intensity}
          width={light.width}
          height={light.height}
        />
      ) : null}

      {showHelpers ? <LightHandle light={light} selected={selected} onSelect={onSelect} /> : null}
    </group>
    {showHelpers && light.target ? <TargetHandle light={light} target={light.target} /> : null}
    </>
  );
}

function LightRig() {
  const lights = useEngine((s) => s.lights);
  const environment = useEngine((s) => s.environment);
  const viewMode = useEngine((s) => s.viewMode);
  const selection = useEngine((s) => s.selection);
  const baked = useEngine((s) => s.bakeResult !== null);

  // "Baked" answers the question "what did I actually bake?", so the realtime
  // rig steps out of the way and only the lightmap contributes.
  const realtime = viewMode === 'lit';

  // Once a bake exists, a light marked for baking is already in the lightmap.
  // Letting it also light the scene in realtime would count it twice, so it
  // drops out — the same mixed/baked split every offline renderer uses.
  const servedByLightmap = (bake: boolean) => baked && bake;

  return (
    <>
      {realtime && environment.enabled && !servedByLightmap(environment.bake) ? (
        <hemisphereLight
          color={environment.skyColor}
          groundColor={environment.groundColor}
          intensity={environment.intensity}
        />
      ) : null}
      {lights.map((light) => (
        <LightObject
          key={light.id}
          light={light}
          realtime={realtime && !servedByLightmap(light.bake)}
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
  const updateMesh = useEngine((s) => s.updateMesh);
  const scene = useThree((s) => s.scene);
  const [attached, setAttached] = useState<THREE.Object3D | null>(null);

  useEffect(() => {
    if (!showGizmo || !selection) {
      setAttached(null);
      return;
    }
    if (selection.kind === 'mesh') {
      // Meshes are looked up by uuid straight from the runtime map — unlike
      // lights, there's no synthetic name to rely on (`mesh.name` is
      // whatever the imported file called it, not an id).
      setAttached(runtime.meshes.get(selection.id) ?? null);
      return;
    }
    if (selection.kind === 'environment') {
      setAttached(null);
      return;
    }
    const name =
      selection.kind === 'light-target' ? 'light-target:' + selection.id : 'light:' + selection.id;
    setAttached(scene.getObjectByName(name) ?? null);
  }, [selection, showGizmo, scene, lights.length]);

  if (!attached || !selection) return null;

  const selectedLight =
    selection.kind === 'light' || selection.kind === 'light-target'
      ? lights.find((l) => l.id === selection.id)
      : undefined;
  // A target point only ever moves. A light that's aiming at one is also
  // locked to translate — rotating it would have no visible effect, since
  // the target overrides its aim on the very next update. Meshes get the
  // full set: translate, rotate and scale are all meaningful on a mesh.
  const lockedToTranslate = selection.kind === 'light-target' || !!selectedLight?.target;
  const gizmoMode = lockedToTranslate ? 'translate' : selection.kind === 'mesh' ? mode : mode === 'scale' ? 'translate' : mode;

  return (
    <TransformControls
      object={attached}
      mode={gizmoMode}
      size={0.8}
      onObjectChange={() => {
        if (selection.kind === 'mesh') {
          // The mesh's Object3D is already the source of truth for its own
          // transform — nothing to write back. This just nudges the store so
          // the Inspector (and the selection outline) re-render with it.
          updateMesh(selection.id, {});
          return;
        }
        if (selection.kind === 'light-target') {
          updateLight(selection.id, {
            target: [attached.position.x, attached.position.y, attached.position.z],
          });
          return;
        }
        if (selection.kind === 'environment') return; // unreachable — attached is null for this kind
        updateLight(selection.id, {
          position: [attached.position.x, attached.position.y, attached.position.z],
          rotation: [attached.rotation.x, attached.rotation.y, attached.rotation.z],
        });
      }}
    />
  );
}

/**
 * Handles "click anywhere to place the target" mode: while armed, a click on
 * the model (or an invisible ground plane, so empty space still works) moves
 * that light's target to the hit point. Runs as a raw DOM listener rather
 * than R3F's per-mesh onClick, so it can hit-test the model and a synthetic
 * ground plane through one raycaster call without needing either to opt in.
 */
function TargetPicker() {
  const pickingTargetFor = useEngine((s) => s.pickingTargetFor);
  const setPickingTarget = useEngine((s) => s.setPickingTarget);
  const updateLight = useEngine((s) => s.updateLight);
  const select = useEngine((s) => s.select);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const raycaster = useThree((s) => s.raycaster);

  // Invisible, never added to the scene — three.js raycasts against an
  // object's own geometry regardless of `.visible`, so this only needs a
  // correct matrixWorld, not a mount.
  const groundPlane = useMemo(() => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000));
    mesh.rotation.x = -Math.PI / 2;
    mesh.updateMatrixWorld(true);
    return mesh;
  }, []);

  useEffect(() => {
    if (!pickingTargetFor) return;
    const canvas = gl.domElement;
    const lightId = pickingTargetFor;

    const pick = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const candidates: THREE.Object3D[] = runtime.model ? [runtime.model, groundPlane] : [groundPlane];
      const hits = raycaster.intersectObjects(candidates, true);
      if (hits.length) {
        const point = hits[0].point;
        updateLight(lightId, { target: [point.x, point.y, point.z] });
        select({ kind: 'light-target', id: lightId });
      }
      setPickingTarget(null);

      // The browser synthesizes a 'click' right after this pointerdown's
      // matching pointerup, and the target now sits exactly under the
      // cursor — if R3F's own click raycasting also processes it, it could
      // (depending on render timing) either re-select the same target
      // harmlessly, or, if its handle mesh hasn't mounted yet, find nothing
      // and fire onPointerMissed, clearing the selection just made above.
      // A one-shot capture-phase listener added right here — rather than
      // tied to this effect's cleanup, which is itself timing-dependent on
      // React's own render — swallows exactly that one click regardless of
      // how fast the re-render lands.
      const swallowClick = (event: Event) => event.stopPropagation();
      canvas.addEventListener('click', swallowClick, { capture: true, once: true });
    };

    canvas.addEventListener('pointerdown', pick, { capture: true });
    // Escape is handled centrally in App.tsx, alongside every other shortcut.
    return () => canvas.removeEventListener('pointerdown', pick, { capture: true });
  }, [pickingTargetFor, gl, camera, raycaster, groundPlane, updateLight, setPickingTarget, select]);

  return null;
}

export default function SceneContents() {
  const showGrid = useEngine((s) => s.showGrid);
  const sceneRadius = useEngine((s) => s.sceneRadius);
  const modelVersion = useEngine((s) => s.modelVersion);
  const pickingTargetFor = useEngine((s) => s.pickingTargetFor);
  const gridSize = Math.max(Math.ceil(sceneRadius * 2) * 2, 10);

  return (
    <>
      <Background />

      <LightRig />
      <Gizmo />
      <TargetPicker />

      <ModelRoot modelVersion={modelVersion} />
      <SelectionOutline />

      <CameraFraming modelVersion={modelVersion} />

      {showGrid ? (
        <gridHelper
          args={[gridSize, gridSize, 0x4d5666, 0x2b313b]}
          position={[0, -0.002, 0]}
          raycast={noRaycast}
        />
      ) : null}

      <OrbitControls
        makeDefault
        enabled={!pickingTargetFor}
        enableDamping
        dampingFactor={0.08}
        maxDistance={2000}
      />
    </>
  );
}
