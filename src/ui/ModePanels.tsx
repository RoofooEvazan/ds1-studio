import type { ReactNode } from 'react';
import type { Ds1 } from '../formats/ds1';
import { popProblems, type PopArea } from '../game/pops';
import { HelpTip } from './HelpTip';
import { LevelLightEditor, type LevelLight } from './panels';
import type { ViewMode } from './state';
import { AUTOMAP_KIND_LIST, AUTOMAP_PARTS, AUTOMAP_RECOLOUR, type AutomapStyle } from '../game/automapStyle';
import { KindIcon } from './AutomapLook';

/**
 * The right-hand panel of a view mode (walkability, automap, level light, roof hiding): a bar naming the mode with a
 * way back to editing tiles, then only that mode's options.
 */

const MODE_NAMES: Record<Exclude<ViewMode, 'tiles'>, string> = {
  objects: 'Objects',
  walk: 'Walkability',
  automap: 'Automap',
  light: 'Level light',
  roofs: 'Roof hiding',
};

export function ModeBar({ mode, onDone }: { mode: Exclude<ViewMode, 'tiles'>; onDone: () => void }) {
  return (
    <div className="mode-bar">
      <span>
        <span className="muted small">View · </span>
        <b>{MODE_NAMES[mode]}</b>
      </span>
      <button className="btn small" onClick={onDone} title="Back to editing tiles (the Tiles panel)">
        Done
      </button>
    </div>
  );
}

interface LightPanelProps {
  light: LevelLight | null;
  canWrite: boolean;
  playerLight: number;
  onPlayerLight: (r: number) => void;
  onDraft: (d: LevelLight | null) => void;
  onApply: (intensity: number, rgb: [number, number, number]) => Promise<void>;
  onAddToGame: () => void;
  /** How many placed objects give off light, whether they light the preview, and whether their rings are drawn. */
  objectLights: number;
  lightsOn: boolean;
  onLightsOn: (on: boolean) => void;
  rings: boolean;
  onRings: (on: boolean) => void;
}

/** Level light mode: the map drawn in its level's light, and the light's settings. */
export function LightPanel({ light, canWrite, playerLight, onPlayerLight, onDraft, onApply, onAddToGame, objectLights, lightsOn, onLightsOn, rings, onRings }: LightPanelProps) {
  return (
    <section className="panel">
      <div className="panel-body">
        {light ? (
          <>
            <LevelLightEditor light={light} shown canWrite={canWrite} onApply={onApply} onDraft={onDraft} playerLight={playerLight} onPlayerLight={onPlayerLight} />
            <label className="mini-check">
              <input type="checkbox" checked={lightsOn} onChange={(e) => onLightsOn(e.target.checked)} /> Object lights <span className="muted small">{objectLights}</span>{' '}
              <HelpTip text="Torches, fires, candles and other objects light the area around them, as in game: objects.txt gives each its light radius (Lit, by the mode the object is in, in sub-tiles like a player's light) and colour (Red/Green/Blue). Shrines and Cairn Stones light up only once used, so not here. Flicker isn't shown." />
            </label>
            <label className="mini-check">
              <input type="checkbox" checked={rings} onChange={(e) => onRings(e.target.checked)} /> Show how far each reaches{' '}
              <HelpTip text="A ring around each light, where it fades out. Also in any mode: Lights in the bar above the map (handy for placing invisible light sources in Objects mode)." />
            </label>
            <p className="muted small">
              The map is drawn as dark and tinted as the game lights this level. Move the mouse over it to see a player&apos;s own light (Player light).
              Changes show straight away; Apply writes them into Levels.txt.
            </p>
          </>
        ) : (
          <>
            <p className="small">This map isn&apos;t a level of the game yet, so it has no light settings.</p>
            <button className="btn small" onClick={onAddToGame} disabled={!canWrite}>
              Add to game…
            </button>
          </>
        )}
      </div>
    </section>
  );
}

interface RoofPanelProps {
  ds1: Ds1;
  areas: PopArea[];
  /** LvlPrest.txt Pops / PopPad for the map (null when it has no row). */
  preset: { pops: number; popPad: number } | null;
  inside: boolean;
  onInside: (on: boolean) => void;
  onShowCells: (cells: { x: number; y: number }[]) => void;
  onSetUp: () => void;
}

/** Roof hiding mode: where roofs (or other tiles) fade when a player walks in, what fades, and what would stop it. */
export function RoofPanel({ ds1, areas, preset, inside, onInside, onShowCells, onSetUp }: RoofPanelProps) {
  const problems = popProblems(ds1, areas, preset ? preset.pops : null, preset?.popPad ?? 0);
  return (
    <section className="panel">
      <div className="panel-body">
        <label className="mini-check">
          <input type="checkbox" checked={inside} onChange={(e) => onInside(e.target.checked)} /> As if inside{' '}
          <HelpTip text="Hide the tiles of every hide area, as the game does while a player stands inside: clicks then reach the floors and walls under the roof. The same toggle is in View → Show, for painting with the Tiles panel." />
        </label>
        <div className="field-label">
          Hide areas <span className="muted small">{areas.length}</span>
        </div>
        {areas.length ? (
          <ul className="mode-list">
            {areas.map((a, i) => (
              <li key={i}>
                <button className="link" onClick={() => onShowCells(a.markers.map((m) => ({ x: m.x, y: m.y })))} title="Mark its corner markers on the map">
                  Area {a.main}
                </button>{' '}
                <span className="small">
                  cells {a.x0},{a.y0} – {a.x1},{a.y1} · hides main index {a.target}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None: no roof fades when a player walks in.</p>
        )}
        {preset && (
          <p className="small muted">
            LvlPrest.txt: Pops {preset.pops}, PopPad {preset.popPad}
          </p>
        )}
        {problems.map((p, i) => (
          <p key={i} className={`small ${p.severity === 'error' ? 'error-text' : p.severity === 'warning' ? 'warn-text' : 'muted'}`}>
            {p.text}
          </p>
        ))}
        <button className="btn small primary" onClick={onSetUp}>
          {areas.length ? 'Change roof hiding…' : 'Set up roof hiding…'}
        </button>
      </div>
    </section>
  );
}

/** What the Automap view's colours mean (floats over the map, like the walkability legend), in the chosen look. */
export function AutomapLegend({ style }: { style: AutomapStyle }) {
  const kinds = AUTOMAP_KIND_LIST.filter((k) => style.kinds[k.id].show);
  return (
    <div className="walk-legend floating">
      <div className="walk-legend-title">Automap</div>
      {style.colours === 'kind' ? (
        <>
          {kinds.map((k) => (
            <div key={k.id} className="walk-legend-row">
              <KindIcon kind={k.id} colour={style.kinds[k.id].colour} size={14} />
              {k.label}
            </div>
          ))}
          {AUTOMAP_PARTS.filter((pt) => style.parts[pt.id]?.show).map((pt) => (
            <div key={pt.id} className="walk-legend-row">
              <KindIcon kind={pt.kind} colour={style.parts[pt.id].colour} size={14} />
              {pt.label}
            </div>
          ))}
        </>
      ) : (
        <div className="walk-legend-row">Pieces in the game&apos;s own colours{kinds.length < AUTOMAP_KIND_LIST.length ? ` (${kinds.map((k) => k.label.toLowerCase()).join(', ')})` : ''}</div>
      )}
      {style.missing && (
        <div className="walk-legend-row">
          <svg className="walk-legend-swatch" viewBox="0 0 20 10" aria-hidden>
            <polygon points="10,0.8 19.2,5 10,9.2 0.8,5" fill="none" stroke={style.missingColour} strokeWidth={1.3} />
          </svg>
          Wall with no AutoMap.txt entry
        </div>
      )}
      <div className="walk-legend-row">
        <svg className="walk-legend-swatch" viewBox="0 0 20 10" aria-hidden>
          <polygon points="10,0.8 19.2,5 10,9.2 0.8,5" fill="none" stroke="rgba(110, 230, 255, 0.85)" strokeWidth={1.3} />
        </svg>
        Suggested piece, not written yet
      </div>
      <div className="walk-legend-note">{AUTOMAP_RECOLOUR ? 'Colours, thickness' : 'Thickness'} and what shows: Look, in the panel.</div>
    </div>
  );
}

/** A mode's panel with its bar. */
export function ModeFrame({ mode, onDone, children }: { mode: Exclude<ViewMode, 'tiles'>; onDone: () => void; children: ReactNode }) {
  return (
    <>
      <ModeBar mode={mode} onDone={onDone} />
      {children}
    </>
  );
}
