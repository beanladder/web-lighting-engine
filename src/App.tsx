import { useEffect } from 'react';
import Toolbar from './components/Toolbar';
import Hierarchy from './components/Hierarchy';
import Inspector from './components/Inspector';
import Viewport from './components/Viewport';
import BakePanel from './components/BakePanel';
import StatusBar from './components/StatusBar';
import { useEngine } from './state/store';

/** Editor shell: toolbar, scene tree, viewport + bake bar, inspector, status bar. */
export default function App() {
  // Blender/Unity-style shortcuts, ignored while typing into a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const engine = useEngine.getState();
      switch (event.key.toLowerCase()) {
        case 'w':
          engine.setTransformMode('translate');
          break;
        case 'e':
          engine.setTransformMode('rotate');
          break;
        case 'r':
          engine.setTransformMode('scale');
          break;
        case 'g':
          engine.setView({ showGrid: !engine.showGrid });
          break;
        case 'h':
          engine.setView({ showHelpers: !engine.showHelpers });
          break;
        case 'escape':
          // Cancel an armed "click to place target" first; only fall through
          // to deselecting once there's nothing left to cancel.
          if (engine.pickingTargetFor) engine.setPickingTarget(null);
          else engine.select(null);
          break;
        case 'delete':
        case 'backspace':
          if (engine.selection?.kind === 'light') engine.removeLight(engine.selection.id);
          else if (engine.selection?.kind === 'light-target') {
            engine.updateLight(engine.selection.id, { target: null });
            engine.select({ kind: 'light', id: engine.selection.id });
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <Hierarchy />
        <div className="stage">
          <Viewport />
          <BakePanel />
        </div>
        <Inspector />
      </div>
      <StatusBar />
    </div>
  );
}
