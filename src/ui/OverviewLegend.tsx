import type { MapOverlay } from '../game/mapOverlays';

/** The legend of a colour-coded overview (walkable, monster spawns), floating over the map's top right corner. */
export function OverviewLegend({ overlay }: { overlay: MapOverlay }) {
  const rows = overlay.classes.map((c, i) => ({ c, n: overlay.counts[i] })).filter((r) => r.n > 0);
  return (
    <div className="walk-legend floating overview-legend">
      <div className="walk-legend-title">{overlay.title}</div>
      {rows.map(({ c, n }) => (
        <div key={c.key} className="walk-legend-row">
          <svg className="walk-legend-swatch" viewBox="0 0 20 10" aria-hidden>
            <polygon points="10,0.8 19.2,5 10,9.2 0.8,5" fill={`rgba(${c.rgba[0]}, ${c.rgba[1]}, ${c.rgba[2]}, ${Math.min(1, c.rgba[3] * 1.6)})`} />
          </svg>
          {c.label} <span className="muted">· {Math.round(n / 25).toLocaleString()} tiles²</span>
        </div>
      ))}
      {overlay.notes.map((n) => (
        <div key={n} className="walk-legend-note">
          {n}
        </div>
      ))}
    </div>
  );
}
