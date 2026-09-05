import Toolbar from './components/Toolbar';
import Hierarchy from './components/Hierarchy';
import Inspector from './components/Inspector';
import Viewport from './components/Viewport';
import BakePanel from './components/BakePanel';
import StatusBar from './components/StatusBar';

/**
 * LumenForge — a browser-based lighting engine.
 *
 * This commit lays out the editor shell (toolbar, scene tree, viewport +
 * bake bar, inspector, status bar) around the zustand store introduced
 * alongside it. Model import, the lighting rig and the path-traced baker
 * each fill in their panel in the commits that follow.
 */
export default function App() {
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
