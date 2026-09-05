/**
 * Scene tree. Empty for now — the environment, lights and imported meshes
 * each get a section here as the commits that create them land.
 */
export default function Hierarchy() {
  return (
    <div className="panel panel--left">
      <div className="section__head" style={{ cursor: 'default' }}>
        <span>Scene</span>
      </div>
      <div className="panel__scroll">
        <div className="empty">
          Nothing imported yet.
          <br />
          Model import lands in an upcoming commit.
        </div>
      </div>
    </div>
  );
}
