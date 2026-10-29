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

describe('special tiles', () => {
  it("draws a special tile with art in a game DT1 (a warp's archway) as a wall; a marker stays a special tile", () => {
    const wallRec = blockerRecord(1, 0, new Uint8Array(25));
    const [base] = parseDt1(buildDt1([wallRec])).tiles;
    const art = { ...base, orientation: 10, mainIndex: 1, subIndex: 0, blocks: [{ x: 0, y: 0, gridX: 0, gridY: 0, format: 1, data: new Uint8Array(256) }] };
    const lib = new TileLibrary();
    lib.add('act2/palace/sub-har.dt1', { version: [7, 6], tiles: [art] });
    lib.addFallback('builtin/special tiles', { version: [7, 6], tiles: [{ ...base, orientation: 10, mainIndex: 2, subIndex: 0 }] });
    const d = newDs1({ width: 3, height: 3, act: 1, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
    d.walls[0][0] = { ...withTile(d.walls[0][0], 1, 0, 0x81), orientation: 10 };
    d.walls[0][1] = { ...withTile(d.walls[0][1], 2, 0, 0x81), orientation: 10 };
    const scene = buildScene(d, lib);
    expect(scene.items.find((it) => it.cellX === 0 && it.cellY === 0)?.kind).toBe('wall');
    expect(scene.items.find((it) => it.cellX === 1 && it.cellY === 0)?.kind).toBe('special');
    expect(scene.specials.map((s) => [s.cellX, s.main])).toEqual([[0, 1], [1, 2]]);
  });
});
