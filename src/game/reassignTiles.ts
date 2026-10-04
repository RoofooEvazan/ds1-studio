import { isEmptyCell, withFields, type Ds1, type TileCell, type WallCell } from '../formats/ds1';
import { readTileSettings, tileCount, writeTileSettings } from '../formats/dt1Header';
import { cornerPartner } from '../formats/dt1Blocks';
import { normalizePath } from '../vfs/vfs';
import { tileIdentity } from './assetUsage';
import type { CellEdit } from './MapDocument';
import type { GameData } from './GameData';

/**
 * Giving DT1 tiles new numbers (orientation, main index, sub index) — the "Reassign index" menu of the DT1 editor —
 * and moving the cells a map has placed with the old numbers along to the new ones.
 */

export interface TileNumber {
  orientation: number;
  main: number;
  sub: number;
}

export const numberKey = (n: TileNumber) => tileIdentity(n.orientation, n.main, n.sub);
const parseKey = (k: string): TileNumber => {
  const [orientation, main, sub] = k.split('|').map(Number);
  return { orientation, main, sub };
};

/** Highest main index a map cell can hold (6 bits) and sub index (8 bits). */
export const MAX_MAIN = 63;
export const MAX_SUB = 255;

/**
 * The kinds a tile may be changed to: a map keeps floors, shadows and walls in different layers, so a floor stays a
 * floor and a shadow a shadow; walls may become another wall kind. The two halves of a north corner (3, 4) only exist
 * as a pair, so they keep their kind.
 */
export const fixedKind = (o: number) => o === 0 || o === 13 || cornerPartner(o) !== null;
export const WALL_KINDS = [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19];

/** The numbers of every tile of a DT1, in file order (headers only: no pixels are decoded). */
export function tileNumbers(bytes: Uint8Array): TileNumber[] {
  const out: TileNumber[] = [];
  for (let i = 0, n = tileCount(bytes); i < n; i++) {
    const s = readTileSettings(bytes, i);
    out.push({ orientation: s.orientation, main: s.mainIndex, sub: s.subIndex });
  }
  return out;
}

/** What is wrong with a number (null: nothing). */
export function numberProblem(n: TileNumber, was: TileNumber): string | null {
  if (!Number.isInteger(n.main) || n.main < 0 || n.main > MAX_MAIN) return `Main index must be 0–${MAX_MAIN} (a map cell holds 6 bits).`;
  if (!Number.isInteger(n.sub) || n.sub < 0 || n.sub > MAX_SUB) return `Sub index must be 0–${MAX_SUB}.`;
  if (n.orientation !== was.orientation && (fixedKind(was.orientation) || !WALL_KINDS.includes(n.orientation)))
    return 'Floors, shadows and corner halves keep their kind; walls can only become another wall kind.';
  return null;
}

/**
 * The changes with the other half of every north corner among them added (the halves share their main and sub index
 * and are placed as one): a half that isn't being changed itself follows its partner's new numbers.
 */
export function withCornerHalves(numbers: TileNumber[], changes: Map<number, TileNumber>): Map<number, TileNumber> {
  const out = new Map(changes);
  for (const [i, next] of changes) {
    const was = numbers[i];
    const other = cornerPartner(was.orientation);
    if (other === null) continue;
    numbers.forEach((n, j) => {
      if (!out.has(j) && n.orientation === other && n.main === was.main && n.sub === was.sub) out.set(j, { orientation: other, main: next.main, sub: next.sub });
    });
  }
  return out;
}

/** The DT1 with the tiles' new numbers (the headers change; pixels, flags and everything else stay). */
export function renumberDt1(bytes: Uint8Array, changes: Map<number, TileNumber>): Uint8Array {
  return writeTileSettings(bytes, new Map([...changes].map(([i, n]) => [i, { orientation: n.orientation, mainIndex: n.main, subIndex: n.sub }])));
}

/**
 * Old number → new number for the map's cells, from the DT1's numbers before and after a renumbering. A number moves
 * with its tiles to the new number of the first of them (the one the game drew for it), also when another tile takes
 * the old number (a swap). A number one of its tiles keeps (a variant left as it was) stays where it is (`kept`).
 */
export function movedNumbers(before: TileNumber[], after: TileNumber[]): { moves: Map<string, string>; kept: string[] } {
  const stays = new Set(before.filter((b, i) => numberKey(b) === numberKey(after[i])).map(numberKey));
  const moves = new Map<string, string>();
  const kept = new Set<string>();
  before.forEach((b, i) => {
    const k = numberKey(b), n = numberKey(after[i]);
    if (k === n) return;
    if (stays.has(k)) kept.add(k);
    else if (!moves.has(k)) moves.set(k, n);
  });
  return { moves, kept: [...kept] };
}

/**
 * Two renumberings one after the other, as one (numbers relative to the map as it is). A number that was moved away
 * and is later given to another tile is that tile's, not the map's, so it doesn't move the map's cells again.
 */
export function composeMoves(first: Map<string, string>, second: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [a, b] of first) out.set(a, second.get(b) ?? b);
  const targets = new Set(first.values());
  for (const [a, b] of second) if (!first.has(a) && !targets.has(a)) out.set(a, b);
  for (const [a, b] of out) if (a === b) out.delete(a);
  return out;
}

/** Only the moves still right for the DT1 as saved: a tile has the new number (it wasn't deleted since). */
export function settledMoves(moves: Map<string, string>, finalNumbers: TileNumber[]): Map<string, string> {
  const have = new Set(finalNumbers.map(numberKey));
  return new Map([...moves].filter(([, b]) => have.has(b)));
}

/** The cell edits that move the map's cells from old numbers to new (floors, walls with their kind, shadows). */
export function cellMoves(ds1: Ds1, moves: Map<string, string>): CellEdit[] {
  if (!moves.size) return [];
  const edits: CellEdit[] = [];
  const at = (i: number) => ({ x: i % ds1.width, y: Math.floor(i / ds1.width) });
  const move = (c: TileCell, o: number) => {
    if (isEmptyCell(c)) return null;
    const to = moves.get(tileIdentity(o, c.mainIndex, c.subIndex));
    return to ? parseKey(to) : null;
  };
  ds1.floors.forEach((layer, index) =>
    layer.forEach((c, i) => {
      const n = move(c, 0);
      if (n) edits.push({ layer: { kind: 'floor', index }, ...at(i), cell: withFields(c, { main: n.main, sub: n.sub }) });
    }),
  );
  ds1.walls.forEach((layer, index) =>
    layer.forEach((c, i) => {
      const w = c as WallCell;
      const n = move(w, w.orientation);
      if (n) edits.push({ layer: { kind: 'wall', index }, ...at(i), cell: { ...withFields(w, { main: n.main, sub: n.sub }), orientation: n.orientation } });
    }),
  );
  ds1.shadows.forEach((layer, index) =>
    layer.forEach((c, i) => {
      const n = move(c, 13);
      if (n) edits.push({ layer: { kind: 'shadow', index }, ...at(i), cell: withFields(c, { main: n.main, sub: n.sub }) });
    }),
  );
  return edits;
}

/** Number → the DT1s (game paths) that have it. */
export type NumberOwners = Map<string, string[]>;

async function ownersOf(gd: GameData, paths: Iterable<string>, onProgress?: (done: number, total: number) => void): Promise<NumberOwners> {
  const list = [...paths];
  const owners: NumberOwners = new Map();
  let done = 0;
  for (const p of list) {
    const bytes = await gd.fs.read(p).catch(() => null);
    if (bytes) {
      try {
        for (const k of new Set(tileNumbers(bytes).map(numberKey))) owners.set(k, [...(owners.get(k) ?? []), p]);
      } catch {
        // not a readable DT1: it has no numbers to clash with
      }
    }
    onProgress?.(++done, list.length);
  }
  return owners;
}

/**
 * The DT1s loaded together with `dt1Path`: the open map's other libraries (`mapLibs`) and those of every level type
 * that lists it. A tile given a number one of them has could be drawn from that DT1 instead (the first-loaded wins).
 */
export function loadedWithPaths(gd: GameData, dt1Path: string, mapLibs: string[] = []): string[] {
  const self = normalizePath(dt1Path);
  const paths = new Set(mapLibs.map(normalizePath));
  for (const t of gd.lvlTypes) {
    const files = t.files.filter(Boolean).map((f) => normalizePath('data/global/tiles/' + f));
    if (files.includes(self)) for (const f of files) paths.add(f);
  }
  paths.delete(self);
  return [...paths];
}

export const loadedWithOwners = (gd: GameData, dt1Path: string, mapLibs: string[] = []) => ownersOf(gd, loadedWithPaths(gd, dt1Path, mapLibs));

const libraryCache = new WeakMap<GameData, Promise<NumberOwners>>();
/** The numbers of every DT1 in the game and the mod (read once per game data; headers only). */
export function libraryOwners(gd: GameData, onProgress?: (done: number, total: number) => void): Promise<NumberOwners> {
  let p = libraryCache.get(gd);
  if (!p) {
    p = ownersOf(gd, gd.fs.list((f) => f.endsWith('.dt1') && f.startsWith('data/global/tiles/')), onProgress);
    libraryCache.set(gd, p);
  }
  return p;
}

export interface NumberCheck {
  /** 'clash': a DT1 loaded with this one has the number and the tile's rarity is 0 (the other tile may be drawn
   * instead); 'elsewhere': another DT1 has it (loaded with this one but with rarity, or anywhere in the library). */
  level: 'clash' | 'elsewhere' | null;
  loadedWith: string[];
  library: string[];
}

export function checkNumber(n: TileNumber, rarity: number, self: string, loadedWith: NumberOwners | null, library: NumberOwners | null): NumberCheck {
  const k = numberKey(n);
  const other = (o: NumberOwners | null) => (o?.get(k) ?? []).filter((p) => normalizePath(p) !== normalizePath(self));
  const lw = other(loadedWith);
  const lib = other(library).filter((p) => !lw.includes(p));
  return { level: lw.length ? (rarity === 0 ? 'clash' : 'elsewhere') : lib.length ? 'elsewhere' : null, loadedWith: lw, library: lib };
}

/** The lowest sub index free for (orientation, main): not in `used` (this DT1's numbers) nor `taken` (others'). */
export function lowestFreeSub(orientation: number, main: number, used: Iterable<string>, taken: ReadonlySet<string> = new Set()): number {
  const keys = new Set(used);
  const os = [orientation, ...(cornerPartner(orientation) !== null ? [cornerPartner(orientation)!] : [])];
  for (let s = 0; s <= MAX_SUB; s++) if (os.every((o) => !keys.has(tileIdentity(o, main, s)) && !taken.has(tileIdentity(o, main, s)))) return s;
  return -1;
}
