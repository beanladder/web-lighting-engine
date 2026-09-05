import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Canvas, useThree } from '@react-three/fiber';
import { useEngine } from '../state/store';

const BACKGROUND = new THREE.Color('#0d0f12');

/**
 * Ask for a WebGPU adapter, but do not wait forever.
 *
 * `requestAdapter()` rejects outright on a machine with no WebGPU at all, but
 * on a flaky or blocklisted driver it can simply never settle — and three's
 * own fallback never fires, because nothing ever threw. Racing it against a
 * timeout means the worst case is a couple of seconds on WebGL2 rather than a
 * spinner forever.
 */
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

/**
 * Boots three.js' WebGPURenderer inside an R3F Canvas, falling back to WebGL2
 * automatically. The scene itself is intentionally empty here — grid, sky and
 * actual content arrive in later commits; this one only has to prove the
 * renderer initializes and reports which backend it landed on.
 */
export default function Viewport() {
  const [status, setStatus] = useState<'init' | 'ready' | 'failed'>('init');
  const [error, setError] = useState<string | null>(null);

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
        <color attach="background" args={[BACKGROUND]} />
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
    </div>
  );
}
