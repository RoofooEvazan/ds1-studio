import { describe, expect, it } from 'vitest';
import { withTile, type WallCell } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { blockerRecord, buildDt1, dt1Records, recordInfo } from '../src/formats/dt1Write';
import { MapDocument } from '../src/game/MapDocument';
import {
  cellMoves,
  checkNumber,
  composeMoves,
  lowestFreeSub,
  movedNumbers,
  numberProblem,
  renumberDt1,
  settledMoves,
  tileNumbers,
  withCornerHalves,
  type TileNumber,
} from '../src/game/reassignTiles';

const n = (orientation: number, main: number, sub: number): TileNumber => ({ orientation, main, sub });
/** A DT1 with tiles of these numbers (all start as floors; others are set by renumbering). */
const dt1Of = (...numbers: TileNumber[]) => {
  const flat = buildDt1(numbers.map((x) => blockerRecord(x.main, x.sub, new Uint8Array(25))));
  return renumberDt1(flat, new Map(numbers.map((x, i) => [i, x])));
};

describe('reassigning tile numbers', () => {
  it('changes only the numbers of the chosen tiles', () => {
    const bytes = dt1Of(n(0, 1, 0), n(0, 1, 1), n(1, 2, 0));
    const out = renumberDt1(bytes, new Map([[1, n(0, 5, 3)]]));
    expect(tileNumbers(out)).toEqual([n(0, 1, 0), n(0, 5, 3), n(1, 2, 0)]);
    expect(dt1Records(out).map((r) => r.blocks.length)).toEqual(dt1Records(bytes).map((r) => r.blocks.length));
    expect(recordInfo(dt1Records(out)[1]).flags).toEqual(recordInfo(dt1Records(bytes)[1]).flags);
  });

  it('moves a number only when no tile keeps it (variants stay put)', () => {
    const before = [n(0, 1, 0), n(0, 1, 0), n(0, 2, 0)];
    // One of two variants of 0|1|0 moves: the other still has the number, so placed cells stay.
    expect(movedNumbers(before, [n(0, 1, 0), n(0, 3, 0), n(0, 2, 0)])).toEqual({ moves: new Map(), kept: ['0|1|0'] });
    // Both move: cells go where the first one went.
    expect(movedNumbers(before, [n(0, 4, 0), n(0, 4, 1), n(0, 2, 0)]).moves).toEqual(new Map([['0|1|0', '0|4|0']]));
    // A swap.
    expect(movedNumbers([n(0, 1, 0), n(0, 2, 0)], [n(0, 2, 0), n(0, 1, 0)]).moves).toEqual(new Map([['0|1|0', '0|2|0'], ['0|2|0', '0|1|0']]));
  });

  it('keeps the two halves of a north corner together', () => {
    const numbers = [n(3, 4, 0), n(4, 4, 0), n(3, 4, 1)];
    expect(withCornerHalves(numbers, new Map([[0, n(3, 9, 2)]]))).toEqual(new Map([[0, n(3, 9, 2)], [1, n(4, 9, 2)]]));
  });

  it('chains renumberings made before saving, against the map as it is', () => {
    expect(composeMoves(new Map([['0|1|0', '0|2|0']]), new Map([['0|2|0', '0|3|0']]))).toEqual(new Map([['0|1|0', '0|3|0']]));
    // Moving back is no move; a number later given to another tile isn't the map's.
    expect(composeMoves(new Map([['0|1|0', '0|2|0']]), new Map([['0|2|0', '0|1|0']]))).toEqual(new Map());
    expect(composeMoves(new Map([['0|1|0', '0|2|0']]), new Map([['0|1|0', '0|7|0']]))).toEqual(new Map([['0|1|0', '0|2|0']]));
    // Moves whose new number was deleted before saving are dropped.
    expect(settledMoves(new Map([['0|1|0', '0|2|0'], ['0|5|0', '0|6|0']]), [n(0, 2, 0), n(0, 5, 0)])).toEqual(new Map([['0|1|0', '0|2|0']]));
  });

  it('moves the placed cells (walls with their kind) as one undo step', () => {
    const ds1 = newDs1({ width: 3, height: 1, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
    ds1.floors[0][0] = withTile(ds1.floors[0][0], 1, 0, 1);
    ds1.floors[0][1] = withTile(ds1.floors[0][1], 2, 0, 1);
    ds1.walls[0][2] = { ...withTile(ds1.walls[0][2], 7, 1, 1), orientation: 1 };
    const moves = new Map([['0|1|0', '0|2|0'], ['0|2|0', '0|1|0'], ['1|7|1', '2|9|4']]);
    const doc = new MapDocument('m.ds1', ds1);
    doc.apply(cellMoves(ds1, moves), 'Reassign', { path: 'x.dt1', before: new Uint8Array([1]), after: new Uint8Array([2]) });
    expect([ds1.floors[0][0].mainIndex, ds1.floors[0][1].mainIndex]).toEqual([2, 1]);
    const w = ds1.walls[0][2] as WallCell;
    expect([w.orientation, w.mainIndex, w.subIndex, w.prop1]).toEqual([2, 9, 4, 1]);
    let restored: number[] = [];
    void doc.undoWithFiles(async (_p, bytes) => {
      restored = [...bytes];
    });
    return Promise.resolve().then(() => {
      expect(restored).toEqual([1]);
      expect([ds1.floors[0][0].mainIndex, ds1.floors[0][1].mainIndex, (ds1.walls[0][2] as WallCell).orientation]).toEqual([1, 2, 1]);
    });
  });

  it('checks numbers: red for a DT1 loaded with it (rarity 0), orange elsewhere', () => {
    const loaded = new Map([['0|1|0', ['data/global/tiles/a/x.dt1']]]);
    const library = new Map([['0|1|0', ['data/global/tiles/a/x.dt1']], ['0|2|0', ['data/global/tiles/b/y.dt1', 'data/global/tiles/me.dt1']]]);
    const self = 'data/global/tiles/me.dt1';
    expect(checkNumber(n(0, 1, 0), 0, self, loaded, library)).toMatchObject({ level: 'clash', loadedWith: ['data/global/tiles/a/x.dt1'], library: [] });
    expect(checkNumber(n(0, 1, 0), 5, self, loaded, library).level).toBe('elsewhere');
    expect(checkNumber(n(0, 2, 0), 0, self, loaded, library)).toMatchObject({ level: 'elsewhere', library: ['data/global/tiles/b/y.dt1'] });
    expect(checkNumber(n(0, 3, 0), 0, self, loaded, library).level).toBe(null);
  });

  it('rejects numbers a map cell cannot hold and kind changes a map cannot follow', () => {
    expect(numberProblem(n(0, 64, 0), n(0, 1, 0))).toMatch(/Main/);
    expect(numberProblem(n(0, 1, 256), n(0, 1, 0))).toMatch(/Sub/);
    expect(numberProblem(n(1, 1, 0), n(0, 1, 0))).toMatch(/kind/);
    expect(numberProblem(n(2, 1, 0), n(1, 1, 0))).toBe(null);
    expect(lowestFreeSub(3, 4, ['3|4|0'], new Set(['4|4|1']))).toBe(2);
  });
});
