import { describe, expect, it } from 'vitest';
import { withTile, writeDs1, parseDs1, type WallCell } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { MapDocument } from '../src/game/MapDocument';
import { cellUnwalkableEdits, isCellUnwalkable } from '../src/game/cellFlags';

const doc = () => {
  const ds1 = newDs1({ width: 3, height: 1, act: 0, floorLayers: 2, wallLayers: 1, tagType: 0, files: [] });
  ds1.floors[0][0] = withTile(ds1.floors[0][0], 1, 0, 1);
  ds1.floors[1][0] = withTile(ds1.floors[1][0], 2, 0, 1);
  ds1.walls[0][1] = { ...withTile(ds1.walls[0][1], 5, 0, 1), orientation: 1 } as WallCell;
  return new MapDocument('m.ds1', ds1);
};

describe('whole-cell unwalkable flag', () => {
  it('goes on Floor 1 (else the first layer with a tile), even with both floor layers used; empty cells are skipped', () => {
    const d = doc();
    const r = cellUnwalkableEdits(d, [[0, 0], [1, 0], [2, 0]], true);
    expect(r).toMatchObject({ cells: 2, skipped: 1 });
    expect(r.edits.map((e) => `${e.layer.kind}${e.layer.index}@${e.x}`)).toEqual(['floor0@0', 'wall0@1']);
    expect(d.apply(r.edits, 'Make unwalkable (cell flag)')).toBe(true);
    expect([isCellUnwalkable(d, 0, 0), isCellUnwalkable(d, 1, 0), isCellUnwalkable(d, 2, 0)]).toEqual([true, true, false]);
    // Only the flag changed: the tiles stay, and the map saves with it (bit 17 of the cell).
    const saved = parseDs1(writeDs1(d.ds1));
    expect([saved.floors[0][0].mainIndex, saved.floors[0][0].prop3 & 2, saved.floors[1][0].prop3 & 2]).toEqual([1, 2, 0]);
    expect(d.history().done.map((h) => h.label)).toEqual(['Make unwalkable (cell flag) (2 cells)']);
  });

  it('is cleared from every layer, and nothing changes where there is no flag', () => {
    const d = doc();
    d.apply([{ layer: { kind: 'floor', index: 1 }, x: 0, y: 0, cell: { ...d.cell({ kind: 'floor', index: 1 }, 0, 0), prop3: 2 } }]);
    d.apply(cellUnwalkableEdits(d, [[0, 0]], true).edits);
    expect(cellUnwalkableEdits(d, [[0, 0]], true).cells).toBe(0);
    const off = cellUnwalkableEdits(d, [[0, 0], [1, 0]], false);
    expect(off.cells).toBe(1);
    d.apply(off.edits);
    expect(isCellUnwalkable(d, 0, 0)).toBe(false);
  });
});
