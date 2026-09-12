import { runtime, useEngine } from '../state/store';
import { applyLightmap, clearLightmap, setLightmapIntensity } from './materials';
import { bakeLightmap, createLightmapTexture, type BakeTarget } from './lightmap/baker';

/** Glue between the bake pipeline and the editor state. */

let running = false;
let cancelToken: { cancelled: boolean } | null = null;

export const isBaking = () => running;

export function cancelBake() {
  if (cancelToken) cancelToken.cancelled = true;
}

export async function runBake() {
  if (running) return;
  const engine = useEngine.getState();
  const { meshes, lights, environment, bakeSettings } = engine;

  const targets: BakeTarget[] = meshes
    .map((entry) => {
      const mesh = runtime.meshes.get(entry.id);
      if (!mesh) return null;
      return {
        id: entry.id,
        mesh,
        lightmapped: entry.lightmapped && entry.visible,
        occluder: entry.occluder && entry.visible,
      };
    })
    .filter((target): target is BakeTarget => target !== null);

  if (!targets.length) {
    engine.pushLog('error', 'Import a model before baking.');
    return;
  }

  running = true;
  cancelToken = { cancelled: false };
  const started = performance.now();

  try {
    const output = await bakeLightmap(
      targets,
      lights,
      environment,
      bakeSettings,
      (progress) => engine.setBakeStatus({ ...progress }),
      cancelToken,
    );

    const previous = useEngine.getState().bakeResult;
    previous?.texture.dispose();

    const texture = createLightmapTexture(output.raw, output.size, bakeSettings.exposure);
    const meshIds = targets.filter((target) => target.lightmapped).map((target) => target.id);

    applyLightmap(meshIds, texture, 1);
    useEngine.getState().setBakeResult({
      texture,
      raw: output.raw,
      albedo: output.albedo,
      size: output.size,
      meshIds,
      stats: output.stats,
    });
    useEngine.getState().setBakeStatus({ phase: 'done', stats: output.stats });

    const seconds = (performance.now() - started) / 1000;
    engine.pushLog(
      'info',
      'Baked ' +
        output.stats.texels.toLocaleString() +
        ' texels across ' +
        output.stats.charts.toLocaleString() +
        ' charts in ' +
        seconds.toFixed(1) +
        's (' +
        (output.stats.rays / 1e6).toFixed(1) +
        'M rays).',
    );

    // Land on the lit view so the lightmap is visible immediately.
    if (useEngine.getState().viewMode === 'lightmap') return;
    useEngine.getState().setView({ viewMode: 'lit' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    useEngine.getState().setBakeStatus({ phase: 'error', message });
    engine.pushLog('error', 'Bake failed: ' + message);
  } finally {
    running = false;
    cancelToken = null;
  }
}

/** Re-applies exposure to an existing bake without re-tracing anything. */
export function refreshExposure(exposure: number) {
  const result = useEngine.getState().bakeResult;
  if (!result) return;
  const texture = createLightmapTexture(result.raw, result.size, exposure);
  result.texture.dispose();
  applyLightmap(result.meshIds, texture, 1);
  setLightmapIntensity(1);
  useEngine.getState().setBakeResult({ ...result, texture });
}

export function clearBake() {
  const result = useEngine.getState().bakeResult;
  result?.texture.dispose();
  clearLightmap();
  useEngine.getState().setBakeResult(null);
  useEngine.getState().setBakeStatus({ phase: 'idle' });
}
