import { useMemo, useRef, useState } from 'react';
import type { Ds1 } from '../formats/ds1';
import type { TileLibrary } from '../game/GameData';
import { worldToSubTile, type Scene } from '../render/scene';
import { overlayFlags } from '../game/mapOverlays';
import type { PresetInfo } from '../game/GameData';
import { collisionHex, describeCollision } from '../game/collisionFlags';
import type { WalkPaint } from '../game/walkEdit';
import { WALK_FLAGS } from '../game/walkEdit';
import { HelpTip } from './HelpTip';
import { emptyCells } from '../game/cellFlags';

export type WalkBrushSize = 1 | 3 | 5 | 'cell';

export interface WalkBrush {
  mode: 'block' | 'clear' | 'replace';
  /** Flag bits the brush sets or clears (WALK_FLAGS). */
  bits: number;
  size: WalkBrushSize;
  /** Where the change goes: this map only (blocker tiles / tile copies in <map>_walk.dt1), or the tiles' own flags. */
  target: 'map' | 'tile';
}

interface Props {
  ds1: Ds1;
  lib: TileLibrary;
  scene: Scene;
  /** The map's LvlPrest row (FillBlanks decides what empty cells are in game). */
  preset?: PresetInfo | null;
  revision: number;
  hover: { cellX: number; cellY: number; world?: [number, number] } | null;
  onPaint: (paint: WalkPaint) => void;
  brush: WalkBrush;
  onChange: (b: WalkBrush) => void;
  busy: boolean;
  canWrite: boolean;
  /** The map's walkability library, tiles-relative (where blockers and tile copies go). */
  libraryPath: string;
  /** The last stroke's result, in words. */
  last: string | null;
  /** Tile flag changes waiting to be written (the "tiles themselves" target). */
  tileFlags: { pending: number; saving: boolean; onSave: () => void; onDiscard: () => void };
  /** Blocks every empty cell (of the selection, when `inSelection`) with the whole-cell flag. */
  onBlockEmpty: () => void;
  /** Whether there is a selection to limit Block empty cells to. */
  inSelection: boolean;
  onDone: () => void;
}

/** What the walkability overlay's colours mean, and the brush's (the same colours as MapView draws them). */
export function WalkLegend({ floating = false }: { floating?: boolean }) {
  const rows: { fill: string; stroke?: string; dashed?: boolean; text: string }[] = [
    { fill: 'rgba(255, 176, 40, 0.6)', text: "Can't be walked on" },
    { fill: 'rgba(255, 60, 70, 0.65)', text: 'Jump / flight barrier (may also block walking)' },
    { fill: 'none', stroke: '#8a8f98', dashed: true, text: 'No movement flags shown (other flags may remain)' },
    { fill: 'rgba(255, 176, 40, 0.28)', stroke: 'rgb(255, 176, 40)', text: 'Brush: will block' },
    { fill: 'rgba(110, 230, 140, 0.28)', stroke: 'rgb(110, 230, 140)', text: 'Brush: remove or replace flags' },
  ];
  return (
    <div className={floating ? 'walk-legend floating' : 'walk-legend'}>
      {floating && <div className="walk-legend-title">Walkability</div>}
      {rows.map((r) => (
        <div key={r.text} className="walk-legend-row">
          <svg className="walk-legend-swatch" viewBox="0 0 20 10" aria-hidden>
            <polygon points="10,0.8 19.2,5 10,9.2 0.8,5" fill={r.fill} stroke={r.stroke ?? 'none'} strokeWidth={1.3} strokeDasharray={r.dashed ? '2 1.5' : undefined} />
          </svg>
          {r.text}
        </div>
      ))}
      <div className="walk-legend-note">Each diamond is one sub-tile (5×5 per cell). Blocks to sight &amp; light aren&apos;t drawn.</div>
    </div>
  );
}

/** The side panel while the walkability overlay is on: painting sub-tiles blocked or walkable, for this map only. */
export function WalkPanel({ ds1, lib, scene, preset, revision, hover, onPaint, brush, onChange, busy, canWrite, libraryPath, last, tileFlags, onBlockEmpty, inSelection, onDone }: Props) {
  const set = (patch: Partial<WalkBrush>) => onChange({ ...brush, ...patch });
  const [pick, setPick] = useState(false);
  const remembered = useRef<{ ds1: Ds1; x: number; y: number; sub: number } | null>(null);
  if (hover?.world) {
    const [sx, sy] = worldToSubTile(...hover.world).map(Math.round);
    const x = Math.floor(sx / 5), y = Math.floor(sy / 5);
    if (x >= 0 && y >= 0 && x < ds1.width && y < ds1.height) remembered.current = { ds1, x, y, sub: (sy % 5) * 5 + sx % 5 };
  }
  const cell = remembered.current?.ds1 === ds1 ? remembered.current : null;
  // As the game builds collision: an empty cell is open ground unless FillBlanks puts a blocking blank tile there.
  const flags = useMemo(() => overlayFlags(ds1, scene, lib, preset), [ds1, scene, lib, preset, revision]);
  // Open void: empty cells the game leaves (partly) walkable, where monsters can spawn outside the play area.
  const voidCells = useMemo(() => emptyCells(ds1, undefined, flags).length, [ds1, flags]);
  const paintOne = (k: number) => {
    if (!cell) return;
    const i = cell.y * ds1.width + cell.x;
    if (pick) { set({ bits: flags[i * 25 + k], mode: 'replace' }); setPick(false); }
    else onPaint({ mode: brush.mode, bits: brush.bits, cells: new Map([[i, 1 << k]]) });
  };
  return (
    <section className="panel">
      <div className="panel-header static">
        <span>Walkability</span>
        <HelpTip text="The game works out where units can go from the sub-tiles of every tile in a cell (5×5 per cell). “This map only”: blocking adds an invisible blocker tile to the cell, making walkable gives the cell its own copy of the blocking tile without that flag; other maps don't change. “The tiles themselves” (like WinDS1): the flags are changed in the tiles' DT1s, for every cell and map using them." />
      </div>
      <div className="panel-body">
        <p className="small muted">
          Click or drag on the map to paint sub-tiles. <b>Shift</b>+drag paints a rectangle; hold <b>Ctrl</b> to swap add/remove (with Set exactly, Ctrl temporarily adds).
        </p>
        <details className="small muted"><summary>Map colour legend</summary><WalkLegend /></details>
        <div className="field-label">Change</div>
        <div className="segmented">
          <button className={brush.target !== 'tile' ? 'active' : ''} onClick={() => set({ target: 'map' })} title="Only this map: blocker tiles and tile copies go into this map's own walkability DT1. Other maps don't change.">
            This map only
          </button>
          <button className={brush.target === 'tile' ? 'active' : ''} onClick={() => set({ target: 'tile' })} title="Like WinDS1: change the sub-tile flags of the tiles themselves, in their DT1s. No extra DT1; every cell and map using those tiles changes too.">
            The tiles themselves
          </button>
        </div>
        <p className="small muted">
          {brush.target === 'tile'
            ? 'Like WinDS1: the flags are changed in the tiles’ own DT1s. No extra DT1 and never “full”, but every cell, in every map, that uses those tiles changes too. Adding flags puts them on the cell’s floor tile; removing takes them off every tile in the cell.'
            : 'Only this map changes: blockers and tile copies go into its own walkability DT1. A cell whose two floor layers are both used can still be blocked whole (Cell brush) with the map’s whole-cell flag.'}{' '}
          To block whole cells with that flag straight away, no tile file (like WinDS1): <b>Ctrl+Shift+right-click</b> a cell, or select cells and use <b>Make unwalkable</b>.
        </p>
        {voidCells > 0 && (
          <div className="imp-callout small">
            <span>
              {voidCells} empty cell{voidCells === 1 ? ' has' : 's have'} walkable ground in game:{' '}
              {preset?.fillBlanks === false ? 'this level doesn’t fill blanks (LvlPrest FillBlanks=0)' : 'the blank tile the level fills them with (floor style 30) doesn’t block every sub-tile'}, so monsters can spawn and walk there.
            </span>
            <span className="inline">
              <button className="btn small primary" disabled={busy} onClick={onBlockEmpty} title="Give every empty cell a hidden floor with the whole-cell unwalkable flag (drawn as nothing). One undo step; save the map to keep it.">
                Block empty cells{inSelection ? ' (selection)' : ''}
              </button>
            </span>
          </div>
        )}
        {brush.target === 'tile' && tileFlags.pending > 0 && (
          <div className="imp-callout small">
            <span>
              {tileFlags.pending} tile{tileFlags.pending === 1 ? '' : 's'} with changed flags, not saved yet (the DT1s are written into your mod; originals kept as .bak).
            </span>
            <span className="inline">
              <button className="btn small primary" disabled={tileFlags.saving || !canWrite} onClick={tileFlags.onSave}>
                {tileFlags.saving ? 'Saving…' : 'Save tile flags'}
              </button>
              <button className="btn small" disabled={tileFlags.saving} onClick={tileFlags.onDiscard}>
                Discard
              </button>
            </span>
          </div>
        )}
        <fieldset className="collision-controls" disabled={busy || !canWrite}>
        <div className="field-label">Quick brushes</div>
        <div className="chips">
          <button className="chip" onClick={() => set({ mode: 'clear', bits: 0x0D })} title="Remove walking, player-walking and jump/flight restrictions. Keep other flags.">Make walkable</button>
          <button className="chip" onClick={() => set({ mode: 'block', bits: 0x07 })} title="Add walking, sight and jump/flight barriers together.">Solid barrier</button>
          <button className="chip" onClick={() => set({ mode: 'replace', bits: 0 })} title="Remove all eight DT1 flags from the painted sub-tiles.">Clear all flags</button>
        </div>
        <div className="field-label">How to apply the combination</div>
        <div className="segmented">
          {([['block', 'Add flags'], ['clear', 'Remove flags'], ['replace', 'Set exactly']] as const).map(([mode, label]) =>
            <button key={mode} className={brush.mode === mode ? 'active' : ''} onClick={() => set({ mode })}>{label}</button>)}
        </div>
        <p className="small muted">{brush.mode === 'replace' ? 'Replace all eight bits on each painted sub-tile with this exact combination.' : brush.mode === 'clear' ? 'Remove only the checked flags. Unchecked flags stay as they are.' : 'Add the checked flags together. Existing flags stay as they are.'}</p>
        <div className="field-label">Combined flags · {collisionHex(brush.bits)}</div>
        {!brush.bits && brush.mode !== 'replace' && (
          <p className="small warn-text">
            Nothing ticked: this brush changes nothing. Tick the flags to {brush.mode === 'block' ? 'add' : 'remove'}. To make cells walkable, choose Remove flags with Block walking ticked (or the Make walkable quick brush).
          </p>
        )}
        {[false, true].map(advanced => {
          const rows = WALK_FLAGS.filter(f => (f.bit >= 0x10) === advanced).map(f => (
            <label key={f.bit} className="collision-flag" title={f.help}>
              <input type="checkbox" checked={(brush.bits & f.bit) !== 0} onChange={(e) => set({ bits: e.target.checked ? brush.bits | f.bit : brush.bits & ~f.bit })} />
              <span className="mono" style={{ color: f.color }}>{collisionHex(f.bit)}</span>
              <span>{f.name}</span><HelpTip text={f.help} />
            </label>
          ));
          return advanced ? <details key="advanced"><summary className="small">Advanced flags{brush.bits & 0xF0 ? ` · ${collisionHex(brush.bits & 0xF0)} selected` : ''}</summary>{rows}</details> : <div key="common">{rows}</div>;
        })}
        <label className="collision-hex">Exact combination (00–FF)
          <input key={brush.bits} aria-label="Collision hex combination" className="small-input mono" defaultValue={collisionHex(brush.bits)} maxLength={2}
            onBlur={e => { if (/^[\da-f]{1,2}$/i.test(e.target.value)) set({ bits: parseInt(e.target.value, 16) }); else e.target.value = collisionHex(brush.bits); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </label>
        <details className="small muted"><summary>How combinations work</summary><p>Each sub-tile stores eight independent bits. For example, 01 + 02 + 04 = 07. Flags from overlapping floors, walls and roofs combine. Shadows do not contribute. Removing a flag here removes its contributions from every affected layer: in this map cell only, or (The tiles themselves) in those tiles everywhere.</p><p>Advanced flags have context-dependent meanings in the classic engine. Test them in your mod. Teleport rules also depend on the level and skill.</p></details>
        <div className="field-label">Brush</div>
        <div className="segmented">
          {([1, 3, 5, 'cell'] as const).map((s) => (
            <button key={s} className={brush.size === s ? 'active' : ''} onClick={() => set({ size: s })} title={s === 'cell' ? 'Every sub-tile of the cells you paint' : `${s}×${s} sub-tiles`}>
              {s === 'cell' ? 'Cell' : `${s}×${s}`}
            </button>
          ))}
        </div>
        <div className="field-label">Inspect a cell · {cell ? `${cell.x}, ${cell.y}` : 'hover over the map'}</div>
        <p className="small muted">Hover over a map cell, then use this grid to change one sub-tile. Numbers show all combined flags, including flags that are not coloured on the map.</p>
        <button className={`btn${pick ? ' active' : ''}`} onClick={() => setPick(!pick)}>{pick ? 'Choose a sub-tile below…' : 'Pick combination from grid'}</button>
        <svg className="collision-grid" viewBox="0 0 260 150" role="group" aria-label="Cell collision grid">
          {Array.from({ length: 25 }, (_, k) => {
            const x = 130 + (k % 5 - Math.floor(k / 5)) * 24, y = 22 + (k % 5 + Math.floor(k / 5)) * 13;
            const f = cell ? flags[(cell.y * ds1.width + cell.x) * 25 + k] : 0;
            const color = f & 4 ? '#c84b56' : f & 9 ? '#aa782b' : f ? '#386975' : '#252b34';
            return <g key={k} role="button" tabIndex={cell && !busy && canWrite ? 0 : -1} aria-label={`Sub-tile ${k % 5 + 1}, ${Math.floor(k / 5) + 1}: ${collisionHex(f)}`} onClick={() => { if (!busy && canWrite) paintOne(k); }} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !busy && canWrite) { e.preventDefault(); paintOne(k); } }}>
              <title>{describeCollision(f)}</title><polygon points={`${x},${y - 12} ${x + 23},${y} ${x},${y + 12} ${x - 23},${y}`} fill={color} stroke={cell?.sub === k ? '#fff' : '#73777f'} />
              <text x={x} y={y + 3} textAnchor="middle" fontSize="9" fill="white" pointerEvents="none">{cell ? collisionHex(f) : '—'}</text>
            </g>;
          })}
        </svg>
        </fieldset>
        {!canWrite && <p className="small warn-text">Needs a writable mod folder: the changes add a small tile library for this map.</p>}
        {busy && <p className="small muted">Applying…</p>}
        {last && !busy && <p className="small">{last}</p>}
        <details className="small muted"><summary>Saving and undo</summary><p>
          This map only: blockers and tile copies go into <span className="mono">{libraryPath}</span>, which is added to the map&apos;s tile libraries and level type. Undo
          (Ctrl+Z) takes a stroke back; save the map to keep them.
        </p><p>The tiles themselves: changes show at once; Save tile flags writes the DT1s (Discard takes them all back).</p></details>
        <div className="modal-actions">
          <button className="btn" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </section>
  );
}
