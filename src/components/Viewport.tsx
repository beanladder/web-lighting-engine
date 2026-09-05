import { useEffect, useState } from 'react';
import { WebGPURenderer } from 'three/webgpu';
import { Canvas, useThree } from '@react-three/fiber';
import SceneContents from './SceneContents';
import { useEngine } from '../state/store';

/** Requests a WebGPU adapter, racing it against a timeout so a hung driver falls back instead of hanging forever. */
async function webGPUAvailable(timeoutMs = 4000): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return false;
  try {
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return !!adapter;
  } catch {
    return false;
  }
}

/** Reads which backend the renderer actually landed on, once, into the store. */
function BackendReporter() {
  const gl = useThree((s) => s.gl) as unknown as WebGPURenderer & {
    backend?: { isWebGPUBackend?: boolean };
  };
  const setRendererBackend = useEngine((s) => s.setRendererBackend);
  useEffect(() => {
    setRendererBackend(gl.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2');
  }, [gl, setRendererBackend]);
  return null;
}

/** Boots three.js' WebGPURenderer inside an R3F Canvas, falling back to WebGL2 automatically. */
export default function Viewport() {
  const [status, setStatus] = useState<'init' | 'ready' | 'failed'>('init'); // Renderer startup status
  const [error, setError] = useState<string | null>(null); // Renderer init error message, if any
  const sceneName = useEngine((s) => s.sceneName); // Name of the currently loaded scene, if any
  const loadDemoScene = useEngine((s) => s.loadDemoScene); // Loads the placeholder demo scene

  return (
    <div className="stage__canvas">
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [4, 3, 5], fov: 45, near: 0.05, far: 1000 }}
        gl={async (props) => {
          try {
            const forceWebGL = !(await webGPUAvailable());
            const renderer = new WebGPURenderer({
              canvas: props.canvas as HTMLCanvasElement,
              antialias: true,
              alpha: false,
              powerPreference: 'high-performance',
              forceWebGL,
            });
            await renderer.init();
            setStatus('ready');
            return renderer;
          } catch (cause) {
            setStatus('failed');
            setError(cause instanceof Error ? cause.message : String(cause));
            throw cause;
          }
        }}
      >
        <BackendReporter />
        <SceneContents />
      </Canvas>

      {status === 'init' ? (
        <div className="loading">
          <div className="spinner" />
          <div>Starting the WebGPU renderer…</div>
        </div>
      ) : null}

      {status === 'failed' ? (
        <div className="loading">
          <strong className="note note--warn">Renderer failed to start</strong>
          <div className="note">
            {error}
            <br />
            This build needs WebGPU or WebGL2. Try a current Chrome, Edge or Safari.
          </div>
        </div>
      ) : null}

      {status === 'ready' && !sceneName ? (
        <div className="overlay overlay--hint">
          <strong>Nothing in the scene yet</strong>
          <div>Real model import lands in an upcoming commit — for now, try the demo scene.</div>
          <div className="overlay__actions">
            <button className="btn" type="button" onClick={loadDemoScene}>
              Load demo scene
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
