/**
 * Bake controls and progress. Just a locked slab for now — resolution,
 * samples, progress and the log all arrive with the bake pipeline itself.
 */
export default function BakePanel() {
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
        <span className="note">Available once a model and lights are in the scene.</span>
        <div className="spacer" />
        <button className="btn" type="button" disabled>
          Bake
        </button>
      </div>
    </div>
  );
}
