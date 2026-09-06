import { useRef } from 'react';
import { useEngine } from '../state/store';
import { Menu, MenuItem, MenuSeparator } from './ui';
import { buildDemoScene } from '../core/loaders';
import { clearModel, importFiles, installModel } from '../core/modelManager';
import type { TransformMode } from '../state/types';

const MODES: { mode: TransformMode; label: string; key: string }[] = [
  { mode: 'translate', label: 'Move', key: 'W' },
  { mode: 'rotate', label: 'Rotate', key: 'E' },
  { mode: 'scale', label: 'Scale', key: 'R' },
];

/** Top bar: File menu, transform mode, and viewport toggles. */
export default function Toolbar() {
  const fileInput = useRef<HTMLInputElement>(null);

  const modelName = useEngine((s) => s.modelName);
  const busy = useEngine((s) => s.busy);
  const transformMode = useEngine((s) => s.transformMode);
  const setTransformMode = useEngine((s) => s.setTransformMode);
  const showGrid = useEngine((s) => s.showGrid);
  const showHelpers = useEngine((s) => s.showHelpers);
  const showGizmo = useEngine((s) => s.showGizmo);
  const setView = useEngine((s) => s.setView);

  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand__mark">LumenForge</span>
        <span className="brand__sub">WebGPU Lighting</span>
      </div>

      <Menu label="File" disabled={!!busy}>
        {(close) => (
          <>
            <MenuItem
              label="Import model…"
              hint=".glb .gltf .fbx .obj .stl .ply"
              onClick={() => {
                close();
                fileInput.current?.click();
              }}
            />
            <MenuItem
              label="Load demo scene"
              hint="A small room to test against"
              onClick={() => {
                close();
                installModel(buildDemoScene(), 'Demo Scene');
              }}
            />
            <MenuSeparator />
            <MenuItem
              label="Close model"
              disabled={!modelName}
              onClick={() => {
                close();
                clearModel();
              }}
            />
          </>
        )}
      </Menu>

      <div className="divider" />

      <div className="seg">
        {MODES.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            title={entry.label + ' (' + entry.key + ')'}
            className={'btn' + (transformMode === entry.mode ? ' btn--active' : '')}
            onClick={() => setTransformMode(entry.mode)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="seg">
        <button
          type="button"
          className={'btn' + (showGrid ? ' btn--active' : '')}
          onClick={() => setView({ showGrid: !showGrid })}
          title="Toggle grid"
        >
          Grid
        </button>
        <button
          type="button"
          className={'btn' + (showHelpers ? ' btn--active' : '')}
          onClick={() => setView({ showHelpers: !showHelpers })}
          title="Toggle light handles"
        >
          Handles
        </button>
        <button
          type="button"
          className={'btn' + (showGizmo ? ' btn--active' : '')}
          onClick={() => setView({ showGizmo: !showGizmo })}
          title="Toggle transform gizmo"
        >
          Gizmo
        </button>
      </div>

      <div className="spacer" />

      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".glb,.gltf,.bin,.obj,.mtl,.fbx,.stl,.ply,.png,.jpg,.jpeg,.webp"
        style={{ display: 'none' }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void importFiles(files).catch(() => undefined);
        }}
      />
    </div>
  );
}
