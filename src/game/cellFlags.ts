import { isEmptyCell, type TileCell } from '../formats/ds1';
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

/** Whether a cell carries the unwalkable flag on any of its tiles. */
export function isCellUnwalkable(doc: MapDocument, x: number, y: number): boolean {
  return doc.layers().some((l) => {
    const c = doc.cell(l, x, y);
    return !isEmptyCell(c) && (c.prop3 & UNWALKABLE) !== 0;
  });
}

/**
 * Edits that make cells unwalkable (`on`: the flag on Floor 1, or the first layer with a tile) or walkable again (the
 * flag cleared from every layer). Cells with no tile can't hold the flag (`skipped`): put a floor there first.
 */
export function cellUnwalkableEdits(doc: MapDocument, cells: [number, number][], on: boolean): { edits: CellEdit[]; cells: number; skipped: number } {
  const edits: CellEdit[] = [];
  let changed = 0;
  let skipped = 0;
  for (const [x, y] of cells) {
    if (!doc.inBounds(x, y)) continue;
    if (on) {
      if (isCellUnwalkable(doc, x, y)) continue;
      const layer = holder(doc, x, y);
      if (!layer) {
        skipped++;
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
  return { edits, cells: changed, skipped };
}
