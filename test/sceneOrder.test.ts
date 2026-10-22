import { describe, expect, it } from 'vitest';
import { withTile } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';
import { TileLibrary } from '../src/game/GameData';
import { buildScene } from '../src/render/scene';

describe('scene draw order', () => {
  it('draws lower walls before floors, so a cell with both shows its floor (as the game does)', () => {
    const [floor] = parseDt1(buildDt1([blockerRecord(1, 0, new Uint8Array(25))])).tiles;
    const lib = new TileLibrary();
    lib.add('t.dt1', { version: [7, 6], tiles: [floor, { ...floor, orientation: 17, mainIndex: 60, subIndex: 0 }] });
    const d = newDs1({ width: 3, height: 3, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
    d.floors[0] = d.floors[0].map((c) => withTile(c, 1, 0, 0xc2));
    // A lower wall at the back corner and one at the front corner; both cells also have a floor.
    for (const i of [0, 8]) d.walls[0][i] = { ...withTile(d.walls[0][i], 60, 0, 0x81), orientation: 17 };
    const kinds = buildScene(d, lib).items.map((it) => it.kind);
    expect(kinds.slice(0, 2)).toEqual(['lowerWall', 'lowerWall']);
    expect(kinds.slice(2)).toEqual(Array(9).fill('floor'));
  });
});
