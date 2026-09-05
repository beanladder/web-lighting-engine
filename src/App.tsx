import Toolbar from './components/Toolbar';
import Hierarchy from './components/Hierarchy';
import Inspector from './components/Inspector';
import Viewport from './components/Viewport';
import BakePanel from './components/BakePanel';
import StatusBar from './components/StatusBar';

/** Editor shell: toolbar, scene tree, viewport + bake bar, inspector, status bar. */
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
