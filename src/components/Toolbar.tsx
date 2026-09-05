import { useEngine } from '../state/store';
import type { TransformMode } from '../state/types';

const MODES: { mode: TransformMode; label: string; key: string }[] = [
  { mode: 'translate', label: 'Move', key: 'W' },
  { mode: 'rotate', label: 'Rotate', key: 'E' },
  { mode: 'scale', label: 'Scale', key: 'R' },
];

/**
 * Top bar. Only the view controls that are real today (transform mode, and
 * the grid/handles/gizmo toggles) are wired up — File, Add light, Bake and
 * Export each show up in the commit that gives them something to do.
 */
export default function Toolbar() {
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
    </div>
  );
}
