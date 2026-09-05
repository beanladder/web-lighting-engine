/**
 * Property editor for whatever is selected. Empty for now — selection itself
 * doesn't exist until lights (and later, meshes) do.
 */
export default function Inspector() {
  return (
    <div className="panel panel--right">
      <div className="section__head" style={{ cursor: 'default' }}>
        <span>Inspector</span>
      </div>
      <div className="panel__scroll">
        <div className="empty">
          Nothing selected.
          <br />
          Lights and meshes land in upcoming commits.
        </div>
      </div>
    </div>
  );
}
