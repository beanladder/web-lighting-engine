import { runtime, useEngine } from '../state/store';

/** Scene tree: the imported model's meshes, with a visibility toggle each. */
export default function Hierarchy() {
  const meshes = useEngine((s) => s.meshes);
  const modelName = useEngine((s) => s.modelName);
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
