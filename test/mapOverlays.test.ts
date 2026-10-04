import { describe, expect, it } from 'vitest';
import { EMPTY_CELL, withTile, type Ds1 } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { levelNoSpawn, openVoid, spawnOverlay, SPAWN_CLASSES, walkableOverlay, WALK_CLASSES } from '../src/game/mapOverlays';
import { blankFillFlags, buildScene, SubTileFlag, walkability } from '../src/render/scene';
import { TileLibrary } from '../src/game/GameData';

/**
 * A 17×9 map (two 8×8 game rooms and the last row and column) floored everywhere but cell 6,6, with a line of left
 * walls down x = 4 splitting the first room in two.
 */
function map(): Ds1 {
  const d = newDs1({ width: 17, height: 9, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
  d.floors[0] = d.floors[0].map((c) => withTile(c, 1, 0, 0xc2));
  d.floors[0][6 * 17 + 6] = EMPTY_CELL;
  for (let y = 0; y < 9; y++) d.walls[0][y * 17 + 4] = { ...withTile(d.walls[0][y * 17 + 4], 2, 0, 0x81), orientation: 1 };
  return d;
}

/** Sub-tile flags as `walkability` would give them: void cells blocked, plus `extra` per cell. */
function flags(d: Ds1, extra: Record<string, number> = {}): Uint8Array {
  const out = new Uint8Array(d.width * d.height * 25);
  for (let i = 0; i < d.width * d.height; i++) {
    const f = (d.floors[0][i].prop1 ? 0 : SubTileFlag.BlockWalk) | (extra[`${i % d.width},${Math.floor(i / d.width)}`] ?? 0);
    out.fill(f, i * 25, i * 25 + 25);
  }
  return out;
}

/** The class key of a cell's middle sub-tile ('' = not coloured). */
const at = (ov: ReturnType<typeof spawnOverlay>, d: Ds1, x: number, y: number) => {
  const c = ov.sub[(y * d.width + x) * 25 + 12];
  return c ? ov.classes[c - 1].key : '';
};

describe('walkable overview', () => {
  it('colours walkable, player-blocked and blocked sub-tiles; void walled in by blocked tiles stays clear', () => {
    const d = map();
    const ov = walkableOverlay(d, flags(d, { '1,1': SubTileFlag.BlockWalk, '2,2': SubTileFlag.BlockPlayerWalk, '3,3': SubTileFlag.BlockWalk | SubTileFlag.BlockPlayerWalk }));
    expect(ov.classes).toBe(WALK_CLASSES);
    expect([at(ov, d, 0, 0), at(ov, d, 1, 1), at(ov, d, 2, 2), at(ov, d, 3, 3), at(ov, d, 6, 6)]).toEqual(['walk', 'blocked', 'players', 'blocked', '']);
    expect(ov.counts).toEqual([(17 * 9 - 4) * 25, 25, 50, 0, 0]);
  });
});

describe('void the game lets players walk into', () => {
  /** The map with its void cell (6,6) free, as the game leaves a cell without a floor: no tile, no flags. */
  const open = () => {
    const d = map();
    return { d, f: flags(d, {}).map((v, i) => (Math.floor(i / 25) === 6 * 17 + 6 ? 0 : v)) };
  };

  it('marks void reachable from walkable floor, and the floor edge next to it', () => {
    const { d, f } = open();
    const ov = walkableOverlay(d, f);
    expect(at(ov, d, 6, 6)).toBe('void');
    // The four floor neighbours' sub-tiles touching it are the open edge; a cell's middle isn't.
    expect(ov.sub[(6 * 17 + 5) * 25 + 2 * 5 + 4]).toBe(5);
    expect(at(ov, d, 5, 6)).toBe('walk');
    expect(openVoid(d, f).edgeCells).toEqual([
      { x: 6, y: 5 },
      { x: 5, y: 6 },
      { x: 7, y: 6 },
      { x: 6, y: 7 },
    ]);
    expect(ov.notes[0]).toMatch(/4 floor cells border void/);
  });

  it('void walled off by blocked floor is not reachable', () => {
    const { d, f } = open();
    for (const [x, y] of [[6, 5], [5, 6], [7, 6], [6, 7]]) f.fill(SubTileFlag.BlockWalk, (y * 17 + x) * 25, (y * 17 + x) * 25 + 25);
    const ov = walkableOverlay(d, f);
    expect(at(ov, d, 6, 6)).toBe('');
    expect(openVoid(d, f).edgeCells).toEqual([]);
  });

  it('monsters can be placed in reachable void of a spawning region', () => {
    const { d, f } = open();
    expect(at(spawnOverlay(d, f, { populate: true, logicals: true }), d, 6, 6)).toBe('void');
  });

  it('walkability in game mode: void blocks nothing unless the FillBlanks blank tile does', () => {
    const d = map();
    const lib = new TileLibrary();
    const scene = buildScene(d, lib);
    const i = (6 * 17 + 6) * 25 + 12;
    expect(walkability(d, scene, lib)[i] & SubTileFlag.BlockWalk).toBe(SubTileFlag.BlockWalk);
    expect(walkability(d, scene, lib, { blank: null })[i]).toBe(0);
    expect(walkability(d, scene, lib, { blank: new Uint8Array(25).fill(SubTileFlag.BlockWalk) })[i]).toBe(SubTileFlag.BlockWalk);
    // No blank tile in the level's DT1s: nothing.
    expect([...blankFillFlags(lib, 0)].every((v) => v === 0)).toBe(true);
  });
});

describe('monster spawn overview', () => {
  it('spawns in open regions; blocked sub-tiles, node regions, warp rooms and the last row/column do not', () => {
    const d = map();
    // The region right of the wall (seed 4,0) becomes a node; the second room gets a level warp.
    d.floors[0][4] = { ...d.floors[0][4], hidden: true, prop4: 0x80 };
    d.walls[0][2 * 17 + 10] = { ...withTile(d.walls[0][2 * 17 + 10], 0, 0, 0x81), orientation: 10 };
    const ov = spawnOverlay(d, flags(d, { '1,1': SubTileFlag.BlockWalk, '2,2': SubTileFlag.BlockPlayerWalk }), { populate: true, logicals: true });
    expect(ov.classes).toBe(SPAWN_CLASSES);
    expect(at(ov, d, 0, 0)).toBe('spawn');
    expect(at(ov, d, 1, 1)).toBe('blocked');
    // 0x08 only stops players: monsters are still placed there.
    expect(at(ov, d, 2, 2)).toBe('spawn');
    expect(at(ov, d, 5, 3)).toBe('node');
    expect(at(ov, d, 6, 6)).toBe('');
    expect(at(ov, d, 12, 5)).toBe('warp');
    expect([at(ov, d, 16, 3), at(ov, d, 3, 8)]).toEqual(['edge', 'edge']);
  });

  it('with Logicals 0 nodes do nothing', () => {
    const d = map();
    d.floors[0][4] = { ...d.floors[0][4], hidden: true, prop4: 0x80 };
    const ov = spawnOverlay(d, flags(d), { populate: true, logicals: false });
    expect(at(ov, d, 5, 3)).toBe('spawn');
    expect(ov.notes.join(' ')).toMatch(/Logicals is 0/);
  });

  it('Populate 0, MonDen 0 or no monsters listed: the whole level spawns none', () => {
    const d = map();
    const level = { name: 'Test', monDen: [600, 600, 600] as [number, number, number], monsters: [3, 3] as [number, number] };
    expect(levelNoSpawn({ populate: true, level })).toBeNull();
    for (const lv of [{ populate: false }, { populate: true, level: { ...level, monDen: [0, 0, 0] as [number, number, number] } }, { populate: true, level: { ...level, monsters: [0, 0] as [number, number] } }]) {
      const ov = spawnOverlay(d, flags(d, { '1,1': SubTileFlag.BlockWalk }), lv);
      expect([at(ov, d, 0, 0), at(ov, d, 1, 1), at(ov, d, 12, 5)]).toEqual(['off', 'blocked', 'off']);
      // Warp rooms and nodes still show as such.
      const marked = map();
      marked.floors[0][4] = { ...marked.floors[0][4], hidden: true, prop4: 0x80 };
      marked.walls[0][2 * 17 + 10] = { ...withTile(marked.walls[0][2 * 17 + 10], 0, 0, 0x81), orientation: 10 };
      const ov2 = spawnOverlay(marked, flags(marked), lv);
      expect([at(ov2, marked, 0, 0), at(ov2, marked, 5, 3), at(ov2, marked, 12, 5)]).toEqual(['off', 'node', 'warp']);
      expect(ov.counts[0]).toBe(0);
      expect(ov.notes[0]).toMatch(/no random monsters/);
    }
    // MonDen 0 on one difficulty only: still spawns, with a note.
    const ov = spawnOverlay(d, flags(d), { populate: true, level: { ...level, monDen: [600, 0, 600] } });
    expect(at(ov, d, 0, 0)).toBe('spawn');
    expect(ov.notes.join(' ')).toMatch(/MonDen 0 on Nightmare/);
  });
});
