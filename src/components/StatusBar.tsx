import { useEffect } from 'react';
import { useEngine } from '../state/store';
import { detectGpu } from '../core/gpu';

/** Bottom strip: renderer backend, GPU, scene counts. */
export default function StatusBar() {
  const backend = useEngine((s) => s.rendererBackend);
  const meshes = useEngine((s) => s.meshes);
  const lights = useEngine((s) => s.lights);
  const gpuName = useEngine((s) => s.gpuName);
  const gpuAvailable = useEngine((s) => s.gpuAvailable);
  const setGpu = useEngine((s) => s.setGpu);
  const triangles = meshes.reduce((sum, mesh) => sum + mesh.triangles, 0);

  // Probed once here rather than in the viewport: the GPU bake backend is
  // usable even when the renderer itself fell back to WebGL2.
  useEffect(() => {
    let cancelled = false;
    void detectGpu().then((info) => {
      if (!cancelled) setGpu({ name: info.name, available: info.available });
    });
    return () => {
      cancelled = true;
    };
  }, [setGpu]);

  return (
    <div className="status">
      <span className="status__chip">
        <span className={'dot' + (backend === 'WebGPU' ? ' dot--on' : backend ? ' dot--warn' : '')} />
        {backend ?? 'starting…'}
        {backend === 'WebGL2' ? ' (WebGPU unavailable — fell back)' : ''}
      </span>
      {gpuName ? (
        <span
          className="status__chip"
          title={
            gpuAvailable
              ? 'GPU bake backend available on this device'
              : 'Reported by WebGL — WebGPU compute is not available, so GPU baking is off'
          }
        >
          <span className={'dot' + (gpuAvailable ? ' dot--on' : '')} />
          {gpuName}
        </span>
      ) : null}
      <span className="divider" />
      <span>{meshes.length} meshes</span>
      <span>{triangles.toLocaleString()} triangles</span>
      <span>{lights.length} lights</span>
      <span className="spacer" />
      <span>editor under construction</span>
    </div>
  );
}
