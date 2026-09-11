import * as THREE from 'three';
import { runtime, useEngine } from '../state/store';
import { Check, ColorInput, Field, NumberInput, Section, SliderInput, Vec3Input } from './ui';
import type { LightDef, MeshEntry } from '../state/types';

const RAD = 180 / Math.PI;

/** Property editor for whatever is selected. */
export default function Inspector() {
  const selection = useEngine((s) => s.selection);
  const lights = useEngine((s) => s.lights);
  const meshes = useEngine((s) => s.meshes);
  // Selecting a light's target still shows that light's inspector — you want
  // to see (and edit) its numbers live while dragging the target around.
  const light = selection && selection.kind !== 'mesh' ? lights.find((l) => l.id === selection.id) : undefined;
  const mesh = selection?.kind === 'mesh' ? meshes.find((m) => m.id === selection.id) : undefined;

  return (
    <div className="panel panel--right">
      <div className="section__head" style={{ cursor: 'default' }}>
        <span>Inspector</span>
      </div>
      <div className="panel__scroll">
        {light ? <LightInspector light={light} /> : null}
        {mesh ? <MeshInspector mesh={mesh} /> : null}
        {!light && !mesh ? (
          <div className="empty">
            Nothing selected.
            <br />
            Pick a light or a mesh in the scene tree.
          </div>
        ) : null}
      </div>
    </div>
  );
}

const AIMABLE = new Set<LightDef['type']>(['directional', 'spot']);

function LightInspector({ light }: { light: LightDef }) {
  const update = useEngine((s) => s.updateLight);
  const remove = useEngine((s) => s.removeLight);
  const duplicate = useEngine((s) => s.duplicateLight);
  const pickingTargetFor = useEngine((s) => s.pickingTargetFor);
  const setPickingTarget = useEngine((s) => s.setPickingTarget);
  const set = (patch: Partial<LightDef>) => update(light.id, patch);
  const picking = pickingTargetFor === light.id;

  return (
    <>
      <Section title={light.type + ' light'}>
        <Field label="Name">
          <input
            className="input"
            value={light.name}
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>
        <Check label="Enabled" checked={light.enabled} onChange={(enabled) => set({ enabled })} />
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <button className="btn" type="button" onClick={() => duplicate(light.id)}>
            Duplicate
          </button>
          <button className="btn btn--danger" type="button" onClick={() => remove(light.id)}>
            Delete
          </button>
        </div>
      </Section>

      <Section title="Transform">
        <div className="field field--stack">
          <span className="field__label">Position</span>
          <Vec3Input value={light.position} onChange={(position) => set({ position })} />
        </div>
        {light.type !== 'point' && !light.target ? (
          <div className="field field--stack">
            <span className="field__label">Rotation (degrees)</span>
            <Vec3Input
              value={[light.rotation[0] * RAD, light.rotation[1] * RAD, light.rotation[2] * RAD]}
              step={1}
              precision={1}
              onChange={(value) =>
                set({ rotation: [value[0] / RAD, value[1] / RAD, value[2] / RAD] })
              }
            />
          </div>
        ) : null}
        {light.type !== 'point' && !light.target ? (
          <p className="note">Light emits along its local −Z, like every light in three.js.</p>
        ) : null}
        {light.target ? (
          <p className="note">Aiming at its target — drag the target, or edit it below, to redirect.</p>
        ) : null}
      </Section>

      {AIMABLE.has(light.type) ? (
        <Section title="Target">
          {!light.target ? (
            <>
              <button
                className={'btn' + (picking ? ' btn--active' : '')}
                type="button"
                onClick={() => setPickingTarget(picking ? null : light.id)}
              >
                {picking ? 'Click in the scene…' : 'Add target'}
              </button>
              <p className="note">
                {picking
                  ? 'Click anywhere on the model or the ground to place it. Esc to cancel.'
                  : 'Aim by clicking a point in space instead of hand-rotating.'}
              </p>
            </>
          ) : (
            <>
              <div className="field field--stack">
                <span className="field__label">Target position</span>
                <Vec3Input value={light.target} onChange={(target) => set({ target })} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className={'btn' + (picking ? ' btn--active' : '')}
                  type="button"
                  onClick={() => setPickingTarget(picking ? null : light.id)}
                >
                  {picking ? 'Click in the scene…' : 'Reposition with click'}
                </button>
                <button className="btn btn--danger" type="button" onClick={() => set({ target: null })}>
                  Remove target
                </button>
              </div>
            </>
          )}
        </Section>
      ) : null}

      <Section title="Emission">
        <Field label="Colour">
          <ColorInput value={light.color} onChange={(color) => set({ color })} />
        </Field>
        <Field label="Intensity">
          <SliderInput
            value={light.intensity}
            min={0}
            max={light.type === 'directional' ? 20 : light.type === 'area' ? 40 : 200}
            step={0.01}
            onChange={(intensity) => set({ intensity })}
          />
        </Field>

        {light.type === 'point' || light.type === 'spot' ? (
          <>
            <Field label="Range">
              <NumberInput
                value={light.distance}
                min={0}
                step={0.5}
                onChange={(distance) => set({ distance })}
              />
            </Field>
            <Field label="Decay">
              <SliderInput
                value={light.decay}
                min={0}
                max={4}
                step={0.05}
                onChange={(decay) => set({ decay })}
              />
            </Field>
          </>
        ) : null}

        {light.type === 'spot' ? (
          <>
            <Field label="Cone angle">
              <SliderInput
                value={light.angle * RAD}
                min={1}
                max={89}
                step={0.5}
                precision={1}
                onChange={(angle) => set({ angle: angle / RAD })}
              />
            </Field>
            <Field label="Penumbra">
              <SliderInput
                value={light.penumbra}
                min={0}
                max={1}
                step={0.01}
                onChange={(penumbra) => set({ penumbra })}
              />
            </Field>
          </>
        ) : null}

        {light.type === 'area' ? (
          <>
            <Field label="Width">
              <NumberInput
                value={light.width}
                min={0.01}
                step={0.1}
                onChange={(width) => set({ width })}
              />
            </Field>
            <Field label="Height">
              <NumberInput
                value={light.height}
                min={0.01}
                step={0.1}
                onChange={(height) => set({ height })}
              />
            </Field>
            <p className="note">Rect area lights emit from one face only and cast no realtime shadow.</p>
          </>
        ) : null}
      </Section>

      {light.type !== 'area' ? (
        <Section title="Shadows">
          <Check
            label="Cast shadow"
            checked={light.castShadow}
            onChange={(castShadow) => set({ castShadow })}
          />
          <Field label="Shadow bias">
            <NumberInput
              value={light.shadowBias}
              step={0.0001}
              precision={5}
              onChange={(shadowBias) => set({ shadowBias })}
            />
          </Field>
        </Section>
      ) : null}
    </>
  );
}

function MeshInspector({ mesh }: { mesh: MeshEntry }) {
  const updateMesh = useEngine((s) => s.updateMesh);
  const object = runtime.meshes.get(mesh.id);
  const material = object
    ? ((Array.isArray(object.material) ? object.material[0] : object.material) as
        | THREE.MeshStandardMaterial
        | undefined)
    : undefined;

  // Material edits are imperative (straight onto the live three.js material,
  // same as everything else in `runtime`) — this nudges the store afterward
  // purely so the Inspector re-reads the values it just wrote and reflects
  // them, without duplicating material state into zustand.
  const editMaterial = (apply: (target: THREE.MeshStandardMaterial) => void) => {
    if (!material) return;
    apply(material);
    updateMesh(mesh.id, {});
  };

  return (
    <>
      <Section title="Mesh">
        <Field label="Name">
          <input className="input" value={mesh.name} readOnly />
        </Field>
        <Field label="Triangles">
          <input className="input input--number" value={mesh.triangles.toLocaleString()} readOnly />
        </Field>
        <Field label="Material">
          <input className="input" value={mesh.materialName} readOnly />
        </Field>
        <Check
          label="Visible"
          checked={mesh.visible}
          onChange={(visible) => {
            if (object) object.visible = visible;
            updateMesh(mesh.id, { visible });
          }}
        />
      </Section>

      {object ? (
        <Section title="Transform">
          {/*
           * Unlike lights, a mesh's Object3D is already the single source of
           * truth for its own transform — nothing mirrors it into the store.
           * These edit it directly and nudge the store afterward, same as
           * the gizmo drag above and the material edits below.
           */}
          <div className="field field--stack">
            <span className="field__label">Position</span>
            <Vec3Input
              value={[object.position.x, object.position.y, object.position.z]}
              onChange={(position) => {
                object.position.set(position[0], position[1], position[2]);
                updateMesh(mesh.id, {});
              }}
            />
          </div>
          <div className="field field--stack">
            <span className="field__label">Rotation (degrees)</span>
            <Vec3Input
              value={[
                object.rotation.x * RAD,
                object.rotation.y * RAD,
                object.rotation.z * RAD,
              ]}
              step={1}
              precision={1}
              onChange={(value) => {
                object.rotation.set(value[0] / RAD, value[1] / RAD, value[2] / RAD);
                updateMesh(mesh.id, {});
              }}
            />
          </div>
          <div className="field field--stack">
            <span className="field__label">Scale</span>
            <Vec3Input
              value={[object.scale.x, object.scale.y, object.scale.z]}
              step={0.01}
              onChange={(scale) => {
                object.scale.set(scale[0], scale[1], scale[2]);
                updateMesh(mesh.id, {});
              }}
            />
          </div>
        </Section>
      ) : null}

      {material ? (
        <Section title="Surface">
          <Field label="Base colour">
            <ColorInput
              value={'#' + material.color.getHexString()}
              onChange={(value) => editMaterial((target) => target.color.set(value))}
            />
          </Field>
          <Field label="Roughness">
            <SliderInput
              value={material.roughness}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => editMaterial((target) => (target.roughness = value))}
            />
          </Field>
          <Field label="Metalness">
            <SliderInput
              value={material.metalness}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => editMaterial((target) => (target.metalness = value))}
            />
          </Field>
          <Field label="Emissive">
            <ColorInput
              value={'#' + material.emissive.getHexString()}
              onChange={(value) => editMaterial((target) => target.emissive.set(value))}
            />
          </Field>
          <Field label="Emissive power">
            <SliderInput
              value={material.emissiveIntensity}
              min={0}
              max={20}
              step={0.05}
              onChange={(value) => editMaterial((target) => (target.emissiveIntensity = value))}
            />
          </Field>
        </Section>
      ) : null}
    </>
  );
}
