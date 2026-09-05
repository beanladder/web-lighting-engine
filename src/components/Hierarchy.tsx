import { useEngine } from '../state/store';

/**
 * Scene tree. Still no per-mesh listing — that lands with model import — but
 * it now at least knows whether something's loaded.
 */
export default function Hierarchy() {
  const sceneName = useEngine((s) => s.sceneName);

  return (
    <div className="panel panel--left">
      <div className="section__head" style={{ cursor: 'default' }}>
        <span>Scene</span>
        {sceneName ? (
          <span
            style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}
          >
            {sceneName}
          </span>
        ) : null}
      </div>
      <div className="panel__scroll">
        <div className="empty">
          {sceneName ? (
            'Mesh listing lands in an upcoming commit.'
          ) : (
            <>
              Nothing imported yet.
              <br />
              Model import lands in an upcoming commit.
            </>
          )}
        </div>
      </div>
    </div>
  );
}
