import { useEngine } from '../state/store';

/** Bottom strip: renderer backend for now, scene/bake counts join it later. */
export default function StatusBar() {
  const backend = useEngine((s) => s.rendererBackend);

  return (
    <div className="status">
      <span className="status__chip">
        <span className={'dot' + (backend === 'WebGPU' ? ' dot--on' : backend ? ' dot--warn' : '')} />
        {backend ?? 'starting…'}
        {backend === 'WebGL2' ? ' (WebGPU unavailable — fell back)' : ''}
      </span>
      <span className="spacer" />
      <span>editor under construction</span>
    </div>
  );
}
