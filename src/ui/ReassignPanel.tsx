import { useMemo, useState } from 'react';
import type { Dt1 } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import { cornerPartner } from '../formats/dt1Blocks';
import {
  checkNumber,
  composeMoves,
  fixedKind,
  lowestFreeSub,
  MAX_MAIN,
  MAX_SUB,
  movedNumbers,
  numberKey,
  numberProblem,
  settledMoves,
  WALL_KINDS,
  withCornerHalves,
  type NumberOwners,
  type TileNumber,
} from '../game/reassignTiles';
import { ORIENTATION_NAMES } from './state';
import { Thumb } from './TilePalette';
import { HelpTip } from './HelpTip';

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');
const list = (paths: string[], max = 4) => paths.slice(0, max).map(short).join(', ') + (paths.length > max ? ` and ${paths.length - max} more` : '');

interface Props {
  /** The DT1 being edited (game path). */
  path: string;
  tiles: Dt1['tiles'];
  /** The numbers of every tile of the DT1 as it is now (with unsaved changes). */
  numbers: TileNumber[];
  /** The tiles to renumber (the selection, with the other half of any north corner). */
  indices: number[];
  /** Rarity (0 = drawn only if nothing else has the number) and whether the tile is an animation frame. */
  rarityOf: (i: number) => { rarity: number; animated: boolean };
  palette: Palette;
  /** Numbers of the DT1s loaded together with this one, and of every DT1 in the game and mod (null: still reading). */
  loadedWith: NumberOwners | null;
  library: NumberOwners | null;
  libraryProgress: string | null;
  /** Cells of the open map the moves would change; null: the open map doesn't load this DT1. */
  mapCells: ((moves: Map<string, string>) => number) | null;
  /** Renumberings already applied but not saved (old → new, relative to the map). */
  pendingMoves: Map<string, string>;
  remapMap: boolean;
  setRemapMap: (on: boolean) => void;
  onApply: (changes: Map<number, TileNumber>) => void;
  onCancel: () => void;
}

/**
 * "Reassign index": new main index, sub index and kind (orientation) for the selected tiles, each with a check of
 * the number against the DT1s loaded with this one (red) and every other DT1 (orange), and how many placed cells of
 * the open map follow the tiles to their new numbers when the DT1 is saved.
 */
export function ReassignPanel(p: Props) {
  const { numbers, indices } = p;
  // A corner half whose other half is also listed follows it (the first of the two leads).
  const leaderOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const i of indices) {
      const n = numbers[i];
      const other = cornerPartner(n.orientation);
      if (other === null || m.has(i)) continue;
      const j = indices.find((x) => x !== i && !m.has(x) && numbers[x].orientation === other && numbers[x].main === n.main && numbers[x].sub === n.sub);
      if (j !== undefined) m.set(j, i);
    }
    return m;
  }, [indices, numbers]);
  const leaders = indices.filter((i) => !leaderOf.has(i));
  const [draft, setDraft] = useState<Map<number, TileNumber>>(() => new Map(leaders.map((i) => [i, { ...numbers[i] }])));
  const [allMain, setAllMain] = useState('');
  const [fromSub, setFromSub] = useState('');

  const changes = useMemo(() => {
    const c = new Map<number, TileNumber>();
    for (const [i, n] of draft) if (numberKey(n) !== numberKey(numbers[i])) c.set(i, n);
    return withCornerHalves(numbers, c);
  }, [draft, numbers]);
  const after = useMemo(() => numbers.map((n, i) => changes.get(i) ?? n), [numbers, changes]);
  const moved = useMemo(() => movedNumbers(numbers, after), [numbers, after]);
  const cells = useMemo(() => p.mapCells?.(settledMoves(composeMoves(p.pendingMoves, moved.moves), after)) ?? null, [p, moved, after]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems = leaders.map((i) => numberProblem(draft.get(i)!, numbers[i])).filter(Boolean);

  const set = (i: number, patch: Partial<TileNumber>) => setDraft((d) => new Map(d).set(i, { ...d.get(i)!, ...patch }));
  const takenNear = useMemo(() => new Set(p.loadedWith?.keys() ?? []), [p.loadedWith]);
  const freeSubFor = (i: number) => {
    const n = draft.get(i)!;
    const used = after.filter((_, j) => j !== i && leaderOf.get(j) !== i).map(numberKey);
    return lowestFreeSub(n.orientation, n.main, used, takenNear);
  };
  const setAll = () => {
    const main = allMain.trim() === '' ? null : Number(allMain);
    let sub = fromSub.trim() === '' ? null : Number(fromSub);
    setDraft((d) => {
      const next = new Map(d);
      for (const i of leaders) {
        const n = { ...next.get(i)! };
        if (main !== null) n.main = main;
        if (sub !== null) n.sub = sub++;
        next.set(i, n);
      }
      return next;
    });
  };

  const card = (i: number) => {
    const lead = leaderOf.get(i);
    const n = lead === undefined ? draft.get(i)! : { ...draft.get(lead)!, orientation: numbers[i].orientation };
    const was = numbers[i];
    const { rarity, animated } = p.rarityOf(i);
    const check = checkNumber(n, animated ? 0 : rarity, p.path, p.loadedWith, p.library);
    const twins = after.map((m, j) => (j !== i && numberKey(m) === numberKey(n) ? j : -1)).filter((j) => j >= 0 && leaderOf.get(j) !== i && leaderOf.get(i) !== j);
    const problem = lead === undefined ? numberProblem(n, was) : null;
    const changed = numberKey(n) !== numberKey(was);
    const notes: string[] = [];
    if (check.loadedWith.length) notes.push(`${check.level === 'clash' ? 'Clash' : 'Also'} in ${list(check.loadedWith)}, loaded with this DT1${check.level === 'clash' ? ' (rarity 0: the game can draw that tile instead)' : ` (this tile has rarity ${rarity})`}.`);
    if (check.library.length) notes.push(`Used in ${list(check.library)}.`);
    if (twins.length) notes.push(`Same number as tile${twins.length === 1 ? '' : 's'} ${twins.map((j) => `#${j}`).join(', ')} here (random variants of one number).`);
    return (
      <div key={i} className={`reassign-card${check.level ? ` reassign-${check.level}` : ''}${problem ? ' reassign-bad' : ''}`} title={notes.join('\n') || 'No other DT1 has this number.'}>
        <div className="reassign-thumb">
          <Thumb tile={p.tiles[i]} palette={p.palette} />
        </div>
        <div className="reassign-was mono small muted">
          #{i} · was {was.orientation}/{was.main}/{was.sub}
          {changed ? ' →' : ''}
        </div>
        {lead !== undefined ? (
          <p className="small muted">Other half of #{lead}: follows it ({n.orientation}/{n.main}/{n.sub}).</p>
        ) : (
          <div className="reassign-fields">
            <label className="small">
              Main
              <input type="number" min={0} max={MAX_MAIN} value={n.main} onChange={(e) => set(i, { main: Number(e.target.value) })} />
            </label>
            <label className="small">
              Sub
              <input type="number" min={0} max={MAX_SUB} value={n.sub} onChange={(e) => set(i, { sub: Number(e.target.value) })} />
              <button className="link small" title="The lowest sub index for this kind and main index that no tile here or in a DT1 loaded with it has" onClick={() => { const s = freeSubFor(i); if (s >= 0) set(i, { sub: s }); }}>
                free
              </button>
            </label>
            <label className="small">
              Kind
              {fixedKind(was.orientation) ? (
                <span className="muted"> {ORIENTATION_NAMES[was.orientation] ?? was.orientation}</span>
              ) : (
                <select value={n.orientation} onChange={(e) => set(i, { orientation: Number(e.target.value) })}>
                  {WALL_KINDS.map((o) => (
                    <option key={o} value={o}>
                      {o} · {ORIENTATION_NAMES[o] ?? ''}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
        )}
        {problem && <p className="small error-text">{problem}</p>}
        {notes.length > 0 && <p className="small reassign-notes">{notes.join(' ')}</p>}
      </div>
    );
  };

  return (
    <div className="reassign" role="region" aria-label="Reassign index">
      <div className="reassign-head">
        <b>Reassign index</b>
        <span className="muted small">
          {indices.length} tile{indices.length === 1 ? '' : 's'}
          {leaderOf.size ? ` (${leaderOf.size} corner half${leaderOf.size === 1 ? '' : 's'} follow${leaderOf.size === 1 ? 's' : ''} its other half)` : ''}
        </span>
        <span className="reassign-legend small">
          <span className="reassign-swatch reassign-clash" /> loaded with this DT1 (rarity 0)
          <span className="reassign-swatch reassign-elsewhere" /> used in another DT1
        </span>
        <HelpTip text="Maps ask for tiles by kind (orientation), main index and sub index. When two DT1s loaded together have the same number, the game may draw the other one. Red: a DT1 loaded with this one (the map's other libraries, or its level types') has the number and this tile's rarity is 0. Orange: another DT1 has it — loaded with this one (this tile has a rarity), or anywhere in the game and your mod. Hover a tile for the DT1s." />
        {p.libraryProgress && <span className="small muted">{p.libraryProgress}</span>}
      </div>
      {leaders.length > 1 && (
        <div className="reassign-bulk small">
          All: main <input type="number" min={0} max={MAX_MAIN} value={allMain} placeholder="keep" onChange={(e) => setAllMain(e.target.value)} />
          sub from <input type="number" min={0} max={MAX_SUB} value={fromSub} placeholder="keep" onChange={(e) => setFromSub(e.target.value)} /> counting up
          <button className="btn small" disabled={allMain.trim() === '' && fromSub.trim() === ''} onClick={setAll}>
            Set
          </button>
        </div>
      )}
      <div className="reassign-grid">{indices.map(card)}</div>
      <div className="reassign-foot">
        <label className="small" title={p.mapCells ? '' : 'The open map doesn’t load this DT1 (or no map is open)'}>
          <input type="checkbox" checked={p.remapMap && !!p.mapCells} disabled={!p.mapCells} onChange={(e) => p.setRemapMap(e.target.checked)} /> Reassign placed tiles in map
          {p.mapCells ? (
            <span className="muted">
              {' '}
              — {cells ?? 0} cell{cells === 1 ? '' : 's'} of the open map will move to the new numbers when you save (one undo step)
            </span>
          ) : (
            <span className="muted"> — the open map doesn’t load this DT1</span>
          )}
        </label>
        {moved.kept.length > 0 && (
          <p className="small warn-text">
            {moved.kept.length} old number{moved.kept.length === 1 ? '' : 's'} ({moved.kept.slice(0, 4).join(', ')}) still {moved.kept.length === 1 ? 'has' : 'have'} another tile here, so placed cells stay on {moved.kept.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        {problems.length > 0 && <p className="small error-text">Fix the numbers with an error first.</p>}
        <span className="reassign-actions">
          <button className="btn small" onClick={p.onCancel}>
            Cancel
          </button>
          <button className="btn small primary" disabled={!changes.size || problems.length > 0} onClick={() => p.onApply(changes)}>
            Apply {changes.size ? `(${changes.size} tile${changes.size === 1 ? '' : 's'})` : ''}
          </button>
        </span>
      </div>
    </div>
  );
}
