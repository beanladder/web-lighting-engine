import { runtime, useEngine } from '../state/store';

const TYPE_GLYPH: Record<string, string> = {
  directional: '☀',
  point: '◉',
  spot: '▽',
  area: '▭',
};

/** Scene tree: the authored lights, and the imported model's meshes. */
export default function Hierarchy() {
  const lights = useEngine((s) => s.lights);
  const meshes = useEngine((s) => s.meshes);
  const modelName = useEngine((s) => s.modelName);
  const selection = useEngine((s) => s.selection);
  const select = useEngine((s) => s.select);
  const updateLight = useEngine((s) => s.updateLight);
  const updateMesh = useEngine((s) => s.updateMesh);

  return (
    <div className="panel panel--left">
      <div className="section__head" style={{ cursor: 'default' }}>
        <span>Scene</span>
        {modelName ? (
          <span
            style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}
          >
            {modelName}
          </span>
        ) : null}
      </div>

      <div className="panel__scroll">
        <div className="tree">
          <div className="tree__group">
            Lights <span className="tree__count">{lights.length}</span>
          </div>

          {lights.length === 0 ? (
            <div className="empty">
              No lights yet.
              <br />
              Use <strong>Add light</strong> in the toolbar.
            </div>
          ) : (
            lights.map((light) => (
              <div
                key={light.id}
                className={
                  'row' +
                  (selection?.kind === 'light' && selection.id === light.id ? ' row--selected' : '') +
                  (light.enabled ? '' : ' row--muted')
                }
                onClick={() => select({ kind: 'light', id: light.id })}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') select({ kind: 'light', id: light.id });
                }}
              >
                <span style={{ color: light.color, fontSize: 11, width: 12 }}>
                  {TYPE_GLYPH[light.type]}
                </span>
                <span className="row__name">{light.name}</span>
                <button
                  type="button"
                  className="row__toggle"
                  title={light.enabled ? 'Disable' : 'Enable'}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateLight(light.id, { enabled: !light.enabled });
                  }}
                >
                  {light.enabled ? '●' : '○'}
                </button>
              </div>
            ))
          )}

          <div className="tree__group">
            Meshes <span className="tree__count">{meshes.length}</span>
          </div>

          {meshes.length === 0 ? (
            <div className="empty">Nothing imported yet.</div>
          ) : (
            meshes.map((mesh) => (
              <div key={mesh.id} className={'row' + (mesh.visible ? '' : ' row--muted')}>
                <span style={{ color: 'var(--text-faint)', fontSize: 11, width: 12 }}>▧</span>
                <span className="row__name">{mesh.name}</span>
                <button
                  type="button"
                  className="row__toggle"
                  title={mesh.visible ? 'Hide' : 'Show'}
                  onClick={() => {
                    const object = runtime.meshes.get(mesh.id);
                    if (object) object.visible = !mesh.visible;
                    updateMesh(mesh.id, { visible: !mesh.visible });
                  }}
                >
                  {mesh.visible ? '●' : '○'}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
