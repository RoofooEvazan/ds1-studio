import { DEFAULT_PROP1, EMPTY_CELL, isEmptyCell, withTile, type Ds1, type TileCell } from '../formats/ds1';
import type { CellEdit, LayerRef, MapDocument } from './MapDocument';
import { UNWALKABLE } from './spawnRegions';

/**
 * The DS1's whole-cell "unwalkable" flag (bit 17 of a cell, prop3 & 0x02), as WinDS1 sets it: the game marks the tile
 * with it unwalkable (D2Common DRLGROOMTILE_InitializeTileDataFlags), blocking walking on the whole cell. It lives in the
 * map, not a DT1: only the chosen cells change, not other copies of the tile, and no tile file is needed, so it works
 * whatever floor layers the cell already uses.
 */

/** Where a cell's flag goes: Floor 1 (as WinDS1), else the first layer with a tile there. Shadows don't count. */
function holder(doc: MapDocument, x: number, y: number): LayerRef | null {
  const order: LayerRef[] = [...doc.ds1.floors.map((_, index) => ({ kind: 'floor' as const, index })), ...doc.ds1.walls.map((_, index) => ({ kind: 'wall' as const, index }))];
  return order.find((l) => !isEmptyCell(doc.cell(l, x, y))) ?? null;
}

/**
 * The cells with no tile at all (no floor, no wall; shadows don't count), optionally only those `within`. In game they
 * are open ground (LvlPrest FillBlanks=0) or get the level's blank tile, which may leave sub-tiles walkable: monsters
 * can spawn there. `flags` (the game's sub-tile flags, 25 per cell): only those with a walkable sub-tile.
 */
export function emptyCells(ds1: Ds1, within?: (x: number, y: number) => boolean, flags?: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < ds1.height; y++)
    for (let x = 0; x < ds1.width; x++) {
      const i = y * ds1.width + x;
      if (within && !within(x, y)) continue;
      if (!ds1.floors.every((l) => isEmptyCell(l[i])) || !ds1.walls.every((l) => isEmptyCell(l[i]))) continue;
      if (flags && !flags.subarray(i * 25, i * 25 + 25).some((f) => !(f & 0x01))) continue;
      out.push([x, y]);
    }
  return out;
}

/** Whether a cell carries the unwalkable flag on any of its tiles. */
export function isCellUnwalkable(doc: MapDocument, x: number, y: number): boolean {
  return doc.layers().some((l) => {
    const c = doc.cell(l, x, y);
    return !isEmptyCell(c) && (c.prop3 & UNWALKABLE) !== 0;
  });
}

/** The floor tile the map uses most (visible floor 1 tiles): a hidden copy of it holds the flag in an empty cell. */
function commonFloor(doc: MapDocument): { main: number; sub: number } | null {
  const count = new Map<number, number>();
  for (const c of doc.ds1.floors[0] ?? []) if (!isEmptyCell(c) && !c.hidden) count.set(c.mainIndex * 256 + c.subIndex, (count.get(c.mainIndex * 256 + c.subIndex) ?? 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best === undefined ? null : { main: best >> 8, sub: best & 255 };
}

/**
 * Edits that make cells unwalkable (`on`: the flag on Floor 1, or the first layer with a tile) or walkable again (the
 * flag cleared from every layer). An empty cell (no tile at all) is open ground in game unless LvlPrest FillBlanks
 * fills it: it gets a hidden copy of the map's most used floor tile holding the flag (`filled`), drawn as nothing.
 * `skipped`: empty cells of a map with no floor tile to copy.
 */
export function cellUnwalkableEdits(doc: MapDocument, cells: [number, number][], on: boolean): { edits: CellEdit[]; cells: number; filled: number; skipped: number } {
  const edits: CellEdit[] = [];
  let changed = 0;
  let filled = 0;
  let skipped = 0;
  let floor: { main: number; sub: number } | null | undefined;
  for (const [x, y] of cells) {
    if (!doc.inBounds(x, y)) continue;
    if (on) {
      if (isCellUnwalkable(doc, x, y)) continue;
      const layer = holder(doc, x, y);
      if (!layer) {
        if (floor === undefined) floor = commonFloor(doc);
        if (!floor || !doc.ds1.floors.length) {
          skipped++;
          continue;
        }
        const tile = withTile(EMPTY_CELL, floor.main, floor.sub, DEFAULT_PROP1.floor);
        edits.push({ layer: { kind: 'floor', index: 0 }, x, y, cell: { ...tile, hidden: true, prop4: tile.prop4 | 0x80, prop3: tile.prop3 | UNWALKABLE } });
        changed++;
        filled++;
        continue;
      }
      const c = doc.cell(layer, x, y);
      edits.push({ layer, x, y, cell: { ...c, prop3: c.prop3 | UNWALKABLE } as TileCell });
      changed++;
    } else {
      let any = false;
      for (const layer of doc.layers()) {
        const c = doc.cell(layer, x, y);
        if (isEmptyCell(c) || !(c.prop3 & UNWALKABLE)) continue;
        edits.push({ layer, x, y, cell: { ...c, prop3: c.prop3 & ~UNWALKABLE } as TileCell });
        any = true;
      }
      if (any) changed++;
    }
  }
  return { edits, cells: changed, filled, skipped };
}
