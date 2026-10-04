import { describe, expect, it } from 'vitest';
import { EMPTY_CELL, withTile, type Ds1 } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { noSpawnPlan, partlyNoSpawnRooms, presetRooms, roomRegions, spawns, UNWALKABLE } from '../src/game/spawnRegions';

/** A 17×9 map (two game rooms) floored with 1/0 everywhere, with a line of left walls down x = 4. */
function map(): Ds1 {
  const d = newDs1({ width: 17, height: 9, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
  d.floors[0] = d.floors[0].map((c) => withTile(c, 1, 0, 0xc2));
  for (let y = 0; y < 9; y++) d.walls[0][y * 17 + 4] = { ...withTile(d.walls[0][y * 17 + 4], 2, 0, 0x81), orientation: 1 };
  return d;
}

function apply(d: Ds1, plan: ReturnType<typeof noSpawnPlan>) {
  while (d.floors.length < plan.floors) d.floors.push(Array.from({ length: d.width * d.height }, () => EMPTY_CELL));
  for (const e of plan.edits) d.floors[e.layer.index][e.y * d.width + e.x] = e.cell;
}

describe('spawn regions', () => {
  it('cuts a map into 8×8 game rooms (the last row and column only border them)', () => {
    expect(presetRooms(17, 9)).toEqual([
      { x0: 0, y0: 0, w: 8, h: 8 },
      { x0: 8, y0: 0, w: 8, h: 8 },
    ]);
    expect(presetRooms(18, 10).map((r) => `${r.x0},${r.y0} ${r.w}×${r.h}`)).toEqual(['0,0 8×8', '8,0 8×8', '16,0 1×8', '0,8 8×1', '8,8 8×1', '16,8 1×1']);
  });

  it('floods regions bounded by first-layer walls, seeded at the first cell scanned', () => {
    const d = map();
    const rr = roomRegions(d, presetRooms(17, 9)[0]);
    expect(rr.regions.map((r) => [r.seed, r.cells.length, r.node])).toEqual([
      [{ x: 0, y: 0 }, 32, false],
      [{ x: 4, y: 0 }, 32, false],
    ]);
    expect(rr.regions.every((r) => spawns(rr, r))).toBe(true);
    // A wall on another layer bounds nothing.
    const moved = map();
    moved.walls.push(moved.walls[0]);
    moved.walls[0] = moved.walls[0].map(() => ({ ...EMPTY_CELL, orientation: 0, orientationHigh: 0 }));
    expect(roomRegions(moved, presetRooms(17, 9)[0]).regions).toHaveLength(1);
  });

  it('makes a region a node by its seed: a hidden floor 1, or main index 30', () => {
    const d = map();
    d.floors[0][4] = { ...d.floors[0][4], hidden: true, prop4: 0x80 };
    expect(roomRegions(d, presetRooms(17, 9)[0]).regions.map((r) => r.node)).toEqual([false, true]);
    d.floors[0][0] = withTile(d.floors[0][0], 30, 0, 0xc2);
    expect(roomRegions(d, presetRooms(17, 9)[0]).regions.map((r) => r.node)).toEqual([true, true]);
  });

  it('a room with a level warp spawns nothing', () => {
    const d = map();
    d.walls[0][2 * 17 + 2] = { ...withTile(d.walls[0][2 * 17 + 2], 0, 0, 0x81), orientation: 10 };
    const rr = roomRegions(d, presetRooms(17, 9)[0]);
    expect(rr.warp).toBe(true);
    expect(rr.regions.some((r) => spawns(rr, r))).toBe(false);
  });

  it('no-spawn area: hides each seed’s floor 1 under a floor 2 copy, voids get a hidden unwalkable floor', () => {
    const d = map();
    d.floors[0][0] = EMPTY_CELL; // a void seed
    const plan = noSpawnPlan(d, [[2, 2]]);
    expect(plan.rooms).toEqual([{ x0: 0, y0: 0, w: 8, h: 8 }]);
    expect([plan.copied, plan.voids, plan.floors, plan.skipped]).toEqual([1, 1, 2, []]);
    apply(d, plan);
    expect(d.floors[1][4]).toMatchObject({ mainIndex: 1, subIndex: 0, hidden: false });
    expect(d.floors[0][4]).toMatchObject({ mainIndex: 1, hidden: true });
    expect(d.floors[0][0]).toMatchObject({ mainIndex: 1, hidden: true });
    expect(d.floors[0][0].prop3 & UNWALKABLE).toBe(UNWALKABLE);
    const rr = roomRegions(d, presetRooms(17, 9)[0]);
    expect(rr.regions.every((r) => r.node)).toBe(true);
    // The other room still spawns, and isn't reported: none of its seeds is marked.
    expect(roomRegions(d, presetRooms(17, 9)[1]).regions.some((r) => !r.node)).toBe(true);
    expect(partlyNoSpawnRooms(d)).toEqual([]);
  });

  it('reports rooms only partly made no-spawn', () => {
    const d = map();
    d.floors[0][4] = { ...d.floors[0][4], hidden: true, prop4: 0x80 };
    const found = partlyNoSpawnRooms(d);
    expect(found).toHaveLength(1);
    expect(found[0].open.map((r) => r.seed)).toEqual([{ x: 0, y: 0 }]);
  });

  it('whole rooms: every floored cell, and seeds that already have floor 2 are skipped with a reason', () => {
    const d = map();
    d.floors.push(Array.from({ length: d.width * d.height }, () => EMPTY_CELL));
    d.floors[1][0] = withTile(EMPTY_CELL, 1, 1, 0xc2);
    const plan = noSpawnPlan(d, [[0, 0]], { wholeRooms: true });
    expect(plan.skipped).toEqual(["0,0 (a region seed) has a floor 2 tile already, so its floor 1 can't be hidden without changing the look"]);
    expect(plan.copied).toBe(63);
  });
});
