import { useEffect, useRef } from 'react';
import { useEngine } from '../state/store';
import { Check, Field, NumberInput, Select, SliderInput } from './ui';
import { cancelBake, clearBake, refreshExposure, runBake } from '../core/bake';
import type { BakeSettings } from '../state/types';

/** Bake settings, progress and the running log. */

const PHASE_LABEL: Record<string, string> = {
  idle: 'Ready',
  unwrapping: 'Unwrapping',
  preparing: 'Rasterizing',
  tracing: 'Tracing',
  resolving: 'Resolving',
  done: 'Done',
  error: 'Error',
};

function estimateRays(settings: BakeSettings, lightCount: number) {
  // Rough order-of-magnitude for the header, not a promise.
  const texels = settings.resolution * settings.resolution * 0.45;
  const perTexel =
    settings.shadowSamples * Math.max(lightCount, 1) +
    settings.samples * (1 + settings.bounces * (1 + Math.max(lightCount, 1)));
  return texels * perTexel;
}

export default function BakePanel() {
  const settings = useEngine((s) => s.bakeSettings);
  const status = useEngine((s) => s.bakeStatus);
  const log = useEngine((s) => s.log);
  const lights = useEngine((s) => s.lights);
  const meshes = useEngine((s) => s.meshes);
  const bakeResult = useEngine((s) => s.bakeResult);
  const modelName = useEngine((s) => s.modelName);
  const environmentBaked = useEngine((s) => s.environment.enabled && s.environment.bake);
  const update = useEngine((s) => s.updateBakeSettings);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [log.length]);

  const running = status.phase !== 'idle' && status.phase !== 'done' && status.phase !== 'error';
  const progress = 'progress' in status ? status.progress : status.phase === 'done' ? 1 : 0;
  const note = 'note' in status ? status.note : status.phase === 'error' ? status.message : '';
  const bakeableLights = lights.filter((light) => light.enabled && light.bake).length;
  const lightmapped = meshes.filter((mesh) => mesh.lightmapped && mesh.visible).length;
  const rayEstimate = estimateRays(settings, bakeableLights);

  const anyUV = meshes.some((mesh) => mesh.hasUV);

  return (
    <div className="bakebar">
      <div className="bakebar__head">
        <strong
          style={{
            fontSize: 11,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
          }}
        >
          Bake
        </strong>

        <div className="progress">
          <div className="progress__fill" style={{ width: Math.round(progress * 100) + '%' }} />
          <div className="progress__label">
            {PHASE_LABEL[status.phase]}
            {note ? ' · ' + note : ''}
          </div>
        </div>

        {running ? (
          <button className="btn btn--danger" type="button" onClick={cancelBake}>
            Cancel
          </button>
        ) : (
          <button
            className="btn btn--primary"
            type="button"
            disabled={!modelName || !lightmapped}
            onClick={() => void runBake()}
          >
            Bake
          </button>
        )}
        <button className="btn" type="button" disabled={!bakeResult} onClick={clearBake}>
          Clear
        </button>
      </div>

      <div className="bakebar__body">
        <div className="bakebar__col">
          <Field label="Resolution">
            <Select
              value={settings.resolution}
              options={[256, 512, 1024, 2048, 4096].map((size) => ({
                value: size as BakeSettings['resolution'],
                label: size + ' × ' + size,
              }))}
              onChange={(resolution) => update({ resolution })}
            />
          </Field>
          <Field label="UVs">
            <Select
              value={settings.unwrap}
              options={[
                { value: 'generate' as const, label: 'Generate lightmap UVs' },
                { value: 'existing-uv0' as const, label: 'Reuse UV0' },
                { value: 'existing-uv1' as const, label: 'Reuse UV1' },
              ]}
              onChange={(unwrap) => update({ unwrap })}
            />
          </Field>
          <Field label="Padding">
            <SliderInput
              value={settings.padding}
              min={0}
              max={12}
              step={1}
              precision={0}
              onChange={(padding) => update({ padding })}
            />
          </Field>
          <Field label="Edge bleed">
            <SliderInput
              value={settings.dilate}
              min={0}
              max={16}
              step={1}
              precision={0}
              onChange={(dilate) => update({ dilate })}
            />
          </Field>
          {settings.unwrap !== 'generate' && !anyUV ? (
            <p className="note note--warn">No mesh has a UV set — generation is the only option.</p>
          ) : null}
        </div>

        <div className="bakebar__col">
          <Field label="Hemisphere">
            <SliderInput
              value={settings.samples}
              min={8}
              max={2048}
              step={8}
              precision={0}
              onChange={(samples) => update({ samples })}
            />
          </Field>
          <Field label="Bounces">
            <SliderInput
              value={settings.bounces}
              min={0}
              max={6}
              step={1}
              precision={0}
              onChange={(bounces) => update({ bounces })}
            />
          </Field>
          <Field label="Shadow rays">
            <SliderInput
              value={settings.shadowSamples}
              min={1}
              max={64}
              step={1}
              precision={0}
              onChange={(shadowSamples) => update({ shadowSamples })}
            />
          </Field>
          <Field label="Occlusion">
            <SliderInput
              value={settings.aoStrength}
              min={0}
              max={1}
              step={0.01}
              onChange={(aoStrength) => update({ aoStrength })}
            />
          </Field>
          <p className="note">
            {settings.bounces === 0
              ? 'No bounces: direct light, sky and ambient occlusion only.'
              : settings.bounces + ' bounce(s) of indirect light, with colour bleeding.'}
          </p>
        </div>

        <div className="bakebar__col">
          <Check label="Denoise" checked={settings.denoise} onChange={(denoise) => update({ denoise })} />
          {settings.denoise ? (
            <Field label="Strength">
              <SliderInput
                value={settings.denoiseStrength}
                min={0}
                max={1}
                step={0.01}
                onChange={(denoiseStrength) => update({ denoiseStrength })}
              />
            </Field>
          ) : null}
          <Field label="Exposure">
            <SliderInput
              value={settings.exposure}
              min={0.1}
              max={4}
              step={0.01}
              onChange={(exposure) => {
                update({ exposure });
                refreshExposure(exposure);
              }}
            />
          </Field>
          <Field label="Ray bias">
            <NumberInput
              value={settings.bias}
              step={0.001}
              min={0.0001}
              precision={4}
              onChange={(bias) => update({ bias })}
            />
          </Field>
          <Field label="Threads">
            <NumberInput
              value={settings.threads}
              step={1}
              min={0}
              max={32}
              precision={0}
              onChange={(threads) => update({ threads })}
            />
          </Field>
          <p className="note">Threads 0 = one per core, minus one for the UI.</p>
        </div>

        <div className="bakebar__col">
          <div className="note">
            {lightmapped} of {meshes.length} mesh(es) lightmapped
            <br />
            {bakeableLights} light(s) + {environmentBaked ? 'sky' : 'no sky'}
            <br />~{(rayEstimate / 1e6).toFixed(1)}M rays estimated
          </div>
          {status.phase === 'done' ? (
            <div className="note">
              {status.stats.texels.toLocaleString()} texels · {status.stats.charts.toLocaleString()} charts
              <br />
              {status.stats.seconds.toFixed(1)}s · {(status.stats.rays / 1e6).toFixed(1)}M rays traced
            </div>
          ) : null}
          {status.phase === 'error' ? <div className="note note--warn">{status.message}</div> : null}
        </div>
      </div>

      <div className="log">
        {log.length === 0 ? <div>Ready.</div> : null}
        {log.map((entry, index) => (
          <div
            key={index}
            className={entry.level === 'error' ? 'log__error' : entry.level === 'warn' ? 'log__warn' : ''}
          >
            {new Date(entry.time).toLocaleTimeString()} — {entry.message}
          </div>
        ))}
        <div ref={logEnd} />
      </div>
    </div>
  );
}
