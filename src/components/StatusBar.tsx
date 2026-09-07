import { useEngine } from '../state/store';

/** Bottom strip: renderer backend, scene counts. Bake status joins it later. */
export default function StatusBar() {
  const backend = useEngine((s) => s.rendererBackend);
  const meshes = useEngine((s) => s.meshes);
  const lights = useEngine((s) => s.lights);
  const triangles = meshes.reduce((sum, mesh) => sum + mesh.triangles, 0);

  return (
    <div className="status">
      <span className="status__chip">
        <span className={'dot' + (backend === 'WebGPU' ? ' dot--on' : backend ? ' dot--warn' : '')} />
        {backend ?? 'starting…'}
        {backend === 'WebGL2' ? ' (WebGPU unavailable — fell back)' : ''}
      </span>
      <span className="divider" />
      <span>{meshes.length} meshes</span>
      <span>{triangles.toLocaleString()} triangles</span>
      <span>{lights.length} lights</span>
      <span className="spacer" />
      <span>editor under construction</span>
    </div>
  );
}
