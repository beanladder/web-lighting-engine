import { useState } from 'react';
import Viewport, { type RendererBackend } from './components/Viewport';

/**
 * LumenForge — a browser-based lighting engine.
 *
 * This commit boots the WebGPU (WebGL2 fallback) renderer inside an empty
 * scene. The editor shell, the lighting rig and the path-traced baker all
 * land in the commits that follow.
 */
export default function App() {
  const [backend, setBackend] = useState<RendererBackend | null>(null);

  return (
    <div className="app-shell">
      <div className="brand-mark">
        LumenForge <span className="brand-mark__sub">WebGPU Lighting</span>
      </div>

      <Viewport onBackend={setBackend} />

      <div className="status-bar">
        <span className={'dot' + (backend === 'WebGPU' ? ' dot--on' : backend ? ' dot--warn' : '')} />
        {backend ?? 'starting…'}
      </div>
    </div>
  );
}
