import { describe, expect, it } from 'vitest';
import { decodeCell, withFields, withTile, type Ds1 } from '../src/formats/ds1';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';
import { TileLibrary } from '../src/game/GameData';
import { fileIndex, planTileFlags, planWalkEdit, type WalkPaint, type WalkPlan } from '../src/game/walkEdit';
import { buildScene, walkability } from '../src/render/scene';

const FLOOR = 'data/global/tiles/test/floor.dt1';
const WALK = 'data/global/tiles/test/map_walk.dt1';

/** Floor tiles: 1/0 walkable everywhere, 1/1 blocking its middle sub-tile (overlay 12). */
const floorFlags = (blocked: number[]) => new Uint8Array(25).map((_, j) => (blocked.map(fileIndex).includes(j) ? 1 : 0));
const floorDt1 = buildDt1([blockerRecord(1, 0, floorFlags([])), blockerRecord(1, 1, floorFlags([12]))]);

function ds1(): Ds1 {
  const cells = () => Array.from({ length: 4 }, () => decodeCell(0));
  const d: Ds1 = {
    version: 18, width: 4, height: 1, act: 0, actRaw: 0, tagType: 0, files: [],
    walls: [cells().map((c) => ({ ...c, orientation: 0, orientationHigh: 0 }))],
    floors: [cells()], shadows: [cells()], tags: [], objects: [], groups: [], groupsHeader: 0, orphanPaths: [], hasPathSection: true, trailing: 0,
  };
  // Cells: 0 walkable floor, 1 floor blocking its middle, 2 walkable floor marked "unwalkable" in the DS1, 3 no floor.
  d.floors[0][0] = withTile(decodeCell(0), 1, 0, 0xc2);
  d.floors[0][1] = withTile(decodeCell(0), 1, 1, 0xc2);
  d.floors[0][2] = { ...withTile(decodeCell(0), 1, 0, 0xc2), prop3: 0x02 };
  return d;
}

/** The map after a plan, the way the app applies it: new floor layers, the edits, the walkability DT1 loaded. */
function apply(d: Ds1, plan: WalkPlan, walk: Uint8Array | null): { d: Ds1; lib: TileLibrary; walk: Uint8Array | null } {
  while (d.floors.length < plan.floors) d.floors.push(Array.from({ length: d.width * d.height }, () => decodeCell(0)));
  for (const e of plan.edits) (e.layer.kind === 'floor' ? d.floors : d.walls)[e.layer.index][e.y * d.width + e.x] = e.cell as never;
  const next = plan.dt1 ?? walk;
  const lib = new TileLibrary();
  lib.add(FLOOR, parseDt1(floorDt1));
  if (next) lib.add(WALK, parseDt1(next));
  return { d, lib, walk: next };
}

/** Walkability per cell as the overlay (and the game) sees it: sub-tiles with "block walk", in overlay order. */
const blocked = (d: Ds1, lib: TileLibrary, cell: number) => {
  const w = walkability(d, buildScene(d, lib), lib);
  return Array.from({ length: 25 }, (_, k) => k).filter((k) => w[cell * 25 + k] & 1);
};

describe('walkability editing (sub-tile by sub-tile, this map only)', () => {
  const mask = (ks: number[]) => ks.reduce((m, k) => m | (1 << k), 0);
  const plan = (d: Ds1, lib: TileLibrary, walk: Uint8Array | null, paint: WalkPaint, voidFlags?: Uint8Array) =>
    planWalkEdit({ ds1: d, lib, read: async (p) => (p === FLOOR ? floorDt1 : p === WALK ? walk : null), walkPath: WALK, walk, paint, voidFlags });

  it('blocks sub-tiles with a hidden blocker in a new floor layer, then clears them again', async () => {
    let s = apply(ds1(), { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    expect(blocked(s.d, s.lib, 0)).toEqual([]);
    const p1 = await plan(s.d, s.lib, s.walk, { mode: 'block', bits: 1, cells: new Map([[0, mask([0, 1, 2, 3, 4])]]) });
    expect(p1).toMatchObject({ floors: 2, changed: 5, skipped: [] });
    expect(p1.edits).toHaveLength(1);
    expect(p1.edits[0]).toMatchObject({ layer: { kind: 'floor', index: 1 }, x: 0, y: 0 });
    expect(p1.edits[0].cell.hidden).toBe(true);
    s = apply(s.d, p1, s.walk);
    expect(blocked(s.d, s.lib, 0)).toEqual([0, 1, 2, 3, 4]);
    // The blocker's tile: no graphics, a floor main index no other library uses.
    const blocker = parseDt1(s.walk!).tiles[0];
    expect(blocker).toMatchObject({ orientation: 0, blocks: [] });
    expect(blocker.mainIndex).not.toBe(1);
    // Blocking more of the same cell reuses its blocker; clearing all of it removes the blocker (a floor is there).
    const p2 = await plan(s.d, s.lib, s.walk, { mode: 'block', bits: 1, cells: new Map([[0, mask([24])]]) });
    expect(p2.edits.map((e) => e.layer)).toEqual([{ kind: 'floor', index: 1 }]);
    s = apply(s.d, p2, s.walk);
    expect(blocked(s.d, s.lib, 0)).toEqual([0, 1, 2, 3, 4, 24]);
    const p3 = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[0, mask([0, 1, 2, 3, 4, 24])]]) });
    s = apply(s.d, p3, s.walk);
    expect(blocked(s.d, s.lib, 0)).toEqual([]);
    expect(s.d.floors[1][0].prop1).toBe(0);
  });

  it("clears a sub-tile a floor tile blocks by giving this cell a copy of the tile without it (the original stays)", async () => {
    let s = apply(ds1(), { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    expect(blocked(s.d, s.lib, 1)).toEqual([12]);
    const p = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[1, mask([12])]]) });
    expect(p).toMatchObject({ floors: 1, changed: 1, skipped: [] });
    expect(p.edits).toEqual([expect.objectContaining({ layer: { kind: 'floor', index: 0 }, x: 1, y: 0 })]);
    const copySub = p.edits[0].cell.subIndex;
    expect(copySub).not.toBe(1);
    s = apply(s.d, p, s.walk);
    expect(blocked(s.d, s.lib, 1)).toEqual([]);
    // Same graphics key (main index 1), a new sub index; the original 1/1 still blocks its middle wherever it's used.
    expect(s.lib.variants(0, 1, 1)[0].subTileFlags[fileIndex(12)]).toBe(1);
    expect(s.lib.variants(0, 1, copySub)[0].subTileFlags.every((f) => f === 0)).toBe(true);
    // Doing it again elsewhere reuses the copy.
    s.d.floors[0][0] = withTile(decodeCell(0), 1, 1, 0xc2);
    const again = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[0, mask([12])]]) });
    expect(again.dt1).toBeNull();
    expect(again.edits[0].cell.subIndex).toBe(copySub);
  });

  it('clears part of a cell the DS1 marks unwalkable, and part of an empty cell a blocking blank tile fills (FillBlanks)', async () => {
    let s = apply(ds1(), { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    expect(blocked(s.d, s.lib, 2)).toHaveLength(25);
    expect(blocked(s.d, s.lib, 3)).toHaveLength(25);
    const p = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[2, mask([12])], [3, mask([6, 7])]]) }, new Uint8Array(25).fill(1));
    expect(p.skipped).toEqual([]);
    s = apply(s.d, p, s.walk);
    expect(s.d.floors[0][2].prop3 & 0x02).toBe(0);
    expect(blocked(s.d, s.lib, 2)).toEqual(Array.from({ length: 25 }, (_, k) => k).filter((k) => k !== 12));
    expect(blocked(s.d, s.lib, 3)).toEqual(Array.from({ length: 25 }, (_, k) => k).filter((k) => k !== 6 && k !== 7));
  });

  it('without FillBlanks, an empty cell is open ground: blocking it adds a hidden blocker, clearing it changes nothing', async () => {
    const s = apply(ds1(), { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    const block = await plan(s.d, s.lib, s.walk, { mode: 'block', bits: 1, cells: new Map([[3, 0x1ffffff]]) });
    expect(block).toMatchObject({ changed: 25, skipped: [] });
    expect(block.edits).toHaveLength(1);
    expect(block.edits[0].cell.hidden).toBe(true);
    const clear = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[3, 0x1ffffff]]) });
    expect(clear).toMatchObject({ changed: 0, edits: [] });
  });

  it('keeps hidden cells hidden when their tile is copied, and says which cells it skipped', async () => {
    const d = ds1();
    d.floors[0][1] = withFields(d.floors[0][1], { hidden: true });
    let s = apply(d, { floors: 1, edits: [], dt1: null, changed: 0, skipped: [] }, null);
    const p = await plan(s.d, s.lib, s.walk, { mode: 'clear', bits: 1, cells: new Map([[1, mask([12])]]) });
    expect(p.edits[0].cell.hidden).toBe(true);
    // Both floor layers taken by real tiles: no room for a blocker.
    s = apply(ds1(), { floors: 2, edits: [{ layer: { kind: 'floor', index: 1 }, x: 0, y: 0, cell: withTile(decodeCell(0), 1, 0, 0xc2) }], dt1: null, changed: 0, skipped: [] }, null);
    const full = await plan(s.d, s.lib, s.walk, { mode: 'block', bits: 1, cells: new Map([[0, mask([0])]]) });
    expect(full.skipped[0]).toMatch(/\(0, 0\): both floor layers are used/);
    expect(full.edits).toEqual([]);
  });
});


describe('collision regression coverage', () => {
  it('preserves weighted variant choice for every seed when flags are removed', async () => {
    const variants = [2, 7, 11].map((rarity, n) => {
      const r = blockerRecord(1, 1, new Uint8Array(25).fill(7));
      new DataView(r.header.buffer).setInt32(32, rarity, true);
      r.header[6] = n + 10; // distinguish artwork records without a decoder dependency
      return r;
    });
    const bytes = buildDt1(variants), lib = new TileLibrary(); lib.add(FLOOR, parseDt1(bytes));
    const d = ds1();
    const p = await planWalkEdit({ ds1: d, lib, walk: null, walkPath: WALK, read: async () => bytes, paint: { mode: 'clear', bits: 13, cells: new Map([[1, 1 << 12]]) } });
    expect(p.skipped).toEqual([]);
    const next = new TileLibrary(); next.add(FLOOR, parseDt1(bytes)); next.add(WALK, parseDt1(p.dt1!));
    const sub = p.edits.find(e => e.layer.index === 0)!.cell.subIndex;
    for (let seed = 0; seed < 2048; seed++) {
      const before = lib.pick(0, 1, 1, seed)!, after = next.pick(0, 1, sub, seed)!;
      expect(after.soundIndex).toBe(before.soundIndex);
      expect(after.rarity).toBe(before.rarity);
      expect(after.subTileFlags[12]).toBe(2);
    }
  });

  it('supports all 256 exact combinations without altering neighbouring sub-tiles', async () => {
    for (let bits = 0; bits <= 255; bits++) {
      const d = ds1(), bytes = buildDt1([blockerRecord(1, 1, new Uint8Array(25).fill(0xAD))]);
      const lib = new TileLibrary(); lib.add(FLOOR, parseDt1(bytes));
      const p = await planWalkEdit({ ds1: d, lib, walk: null, walkPath: WALK, read: async () => bytes, paint: { mode: 'replace', bits, cells: new Map([[1, 1 << 7]]) } });
      expect(p.skipped).toEqual([]);
      while (d.floors.length < p.floors) d.floors.push(Array.from({ length: 4 }, () => decodeCell(0)));
      for (const e of p.edits) d.floors[e.layer.index][e.x] = e.cell;
      if (p.dt1) lib.add(WALK, parseDt1(p.dt1));
      const combined = walkability(d, buildScene(d, lib), lib).slice(25, 50);
      expect(combined[7], `combination ${bits}`).toBe(bits);
      expect([...combined].filter((_, k) => k !== 7).every(f => f === 0xAD)).toBe(true);
    }
  });

  it('clears both DS1 whole-cell restrictions and tile flags together, retaining the unpainted area', async () => {
    const d = ds1(); d.floors[0][1] = { ...d.floors[0][1], prop3: 3 };
    const lib = new TileLibrary(); lib.add(FLOOR, parseDt1(floorDt1));
    const p = await planWalkEdit({ ds1: d, lib, walk: null, walkPath: WALK, read: async () => floorDt1, paint: { mode: 'clear', bits: 13, cells: new Map([[1, 1 << 12]]) } });
    expect(p.changed).toBe(1); expect(p.skipped).toEqual([]);
    const result = apply(d, p, null);
    expect(result.d.floors[0][1].prop3 & 3).toBe(0);
    const flags = walkability(d, buildScene(d, result.lib), result.lib).slice(25, 50);
    expect(flags[12]).toBe(0);
    expect([...flags].filter((_, k) => k !== 12).every(f => f === 5)).toBe(true);
  });

  it('rolls back an entire cell when preserving its unpainted flags needs an unavailable floor slot', async () => {
    const d = ds1(); d.floors[0][1] = { ...d.floors[0][1], prop3: 3 };
    d.floors.push(d.floors[0].map(c => ({ ...c })));
    const lib = new TileLibrary(); lib.add(FLOOR, parseDt1(floorDt1));
    const p = await planWalkEdit({ ds1: d, lib, walk: null, walkPath: WALK, read: async () => floorDt1, paint: { mode: 'clear', bits: 13, cells: new Map([[1, 1 << 12]]) } });
    expect(p.skipped).toHaveLength(1); expect(p.changed).toBe(0); expect(p.edits).toEqual([]); expect(p.dt1).toBeNull();
  });
});

describe('walkability when a cell has no room, and on the tiles themselves', () => {
  const ALL = 0x1ffffff;
  const libOf = () => {
    const lib = new TileLibrary();
    lib.add(FLOOR, parseDt1(floorDt1));
    return lib;
  };
  const full = () => {
    const d = ds1();
    // Cell 0: both floor layers used.
    d.floors.push(Array.from({ length: 4 }, () => decodeCell(0)));
    d.floors[1][0] = withTile(decodeCell(0), 1, 0, 0xc2);
    return d;
  };
  const plan = (d: Ds1, paint: WalkPaint) => planWalkEdit({ ds1: d, lib: libOf(), read: async (p) => (p === FLOOR ? floorDt1 : null), walkPath: WALK, walk: null, paint });

  it('blocks a whole cell with the DS1 whole-cell flag when both floor layers are used', async () => {
    const d = full();
    const p = await plan(d, { mode: 'block', bits: 1, cells: new Map([[0, ALL]]) });
    expect(p.skipped).toEqual([]);
    expect(p.dt1).toBeNull();
    expect(p.edits).toHaveLength(1);
    expect(p.edits[0].cell.prop3 & 2).toBe(2);
    const s = apply(d, p, null);
    expect(blocked(s.d, s.lib, 0)).toHaveLength(25);
  });

  it('still skips part of such a cell, saying what to do instead', async () => {
    const p = await plan(full(), { mode: 'block', bits: 1, cells: new Map([[0, 1]]) });
    expect(p.skipped[0]).toMatch(/whole cell/);
  });

  it('changes the tiles’ own flags, and counts the other cells that use them', () => {
    const d = ds1();
    const lib = libOf();
    const tile = lib.variants(0, 1, 0)[0];
    const p = planTileFlags(d, lib, { mode: 'block', bits: 1, cells: new Map([[0, 1 << 3]]) });
    expect(p.changed).toBe(1);
    expect(p.tiles).toHaveLength(1);
    expect(p.tiles[0].tile).toBe(tile);
    expect(p.tiles[0].flags[fileIndex(3)]).toBe(1);
    expect(tile.subTileFlags[fileIndex(3)]).toBe(0); // only planned
    expect(p.alsoAffects).toBe(1); // cell 2 uses floor 1/0 too
    // Removing takes it off the blocking tile.
    const c = planTileFlags(d, lib, { mode: 'clear', bits: 1, cells: new Map([[1, 1 << 12]]) });
    expect(c.tiles[0].flags[fileIndex(12)]).toBe(0);
    // A cell with no tile can't carry new flags.
    expect(planTileFlags(d, lib, { mode: 'block', bits: 1, cells: new Map([[3, 1]]) }).skipped).toHaveLength(1);
  });
});
