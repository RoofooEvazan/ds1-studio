import { DEFAULT_PROP1, EMPTY_CELL, isEmptyCell, withTile, type Ds1, type TileCell } from '../formats/ds1';
import { Orientation } from '../formats/dt1';
import type { CellEdit } from './MapDocument';

/**
 * Where the game spawns random monsters in a preset map, as D2Common decides it (D2MOO's DrlgDrlgLogic.cpp and
 * DrlgPreset.cpp, checked against the 1.13c D2Common the layer test comes from; PD2 may differ, so test in game):
 *
 * - The map is cut into game rooms of 8×8 cells from its top corner (DRLGPRESET_BuildArea; the game's map size is the
 *   DS1 size minus one, so the last row and column of cells only ever border a room).
 * - With LvlPrest Logicals=1, each room's grid of (8+1)×(8+1) cells (its own cells plus the row and column it shares
 *   with the next rooms) is split into regions bounded by the walls of the first wall layer
 *   (DRLGLOGIC_InitializeDrlgCoordList): cells are taken row by row (y, then x), and each cell no region has reached
 *   yet starts a new one (its seed), flooded through open cells and through walls by their orientation.
 * - A region whose seed has a hidden first-layer floor tile, or one with main index 30, is a "node", and monster
 *   population (PopulateRoom) skips nodes. Cells without a floor join regions too; their seed is never a node.
 * - A room with a level warp (special tile, orientation 10/11, main index 0-7) gets no population at all.
 *
 * Walls made of props (a DT1 material flag) don't bound regions in game; that flag isn't read here.
 */

export const ROOM_CELLS = 8;

export interface PresetRoom {
  /** First cell of the room. */
  x0: number;
  y0: number;
  /** Its own cells (up to 8); the grid adds one more row and column, shared with the next rooms. */
  w: number;
  h: number;
}

/** The game rooms a map is cut into. */
export function presetRooms(width: number, height: number): PresetRoom[] {
  const out: PresetRoom[] = [];
  const [mw, mh] = [width - 1, height - 1];
  for (let y0 = 0; y0 < mh; y0 += ROOM_CELLS) for (let x0 = 0; x0 < mw; x0 += ROOM_CELLS) out.push({ x0, y0, w: Math.min(ROOM_CELLS, mw - x0), h: Math.min(ROOM_CELLS, mh - y0) });
  return out;
}

/** The room a cell belongs to (its own cells, not the shared border). */
export function roomAt(rooms: PresetRoom[], x: number, y: number): PresetRoom | undefined {
  return rooms.find((r) => x >= r.x0 && x < r.x0 + r.w && y >= r.y0 && y < r.y0 + r.h);
}

export interface LogicRegion {
  /** The first cell scanned: its first-layer floor decides whether the region is a node. */
  seed: { x: number; y: number };
  /** No random monsters are placed in it. */
  node: boolean;
  /** The room's own cells in the region (the shared border row and column left out, as the game does). */
  cells: { x: number; y: number }[];
  /** How many of those have a floor tile (on any floor layer): only those can hold monsters. */
  floored: number;
}

export interface RoomRegions {
  room: PresetRoom;
  regions: LogicRegion[];
  /** A level warp is in the room: the game spawns nothing in it. */
  warp: boolean;
}

/** What each wall orientation lets through, per direction it is entered from (D2Common's tables, 0x6FDCE5EC/650). */
const WALL_CLASS = [-1, 0, 1, 2, 2, 0, 1, 3, 0, 1, 0, 1, 4, -1, 4, 0, 0, 0, 0, 0];
const WALL_FLOW = [23, 0, 5, 21, 17, 15, 3, 0, 9, 7, 39, 0, 0, 5, 3, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31];
const STEPS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** The game's node test: a hidden first-layer floor, or main index 30 (with no layer bits in the word). */
export const isNodeFloor = (c: TileCell | undefined) => !!c && (c.hidden || (c.mainIndex === 30 && (c.prop3 & 0x0c) === 0 && !isEmptyCell(c)));

/** A first-wall-layer tile that bounds regions: any wall but roofs (and the "floor-like" orientation 0). */
const isBarrier = (ds1: Ds1, x: number, y: number) => {
  const c = ds1.walls[0]?.[y * ds1.width + x];
  return !!c && !isEmptyCell(c) && c.orientation !== 0 && c.orientation !== Orientation.Shadow && c.orientation !== Orientation.Roof;
};

/** The regions of one room, as the game floods them. */
export function roomRegions(ds1: Ds1, room: PresetRoom): RoomRegions {
  const { width, height } = ds1;
  const gw = room.w + 1;
  const gh = room.h + 1;
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const barrier = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) if (inMap(room.x0 + i, room.y0 + j) && isBarrier(ds1, room.x0 + i, room.y0 + j)) barrier[j * gw + i] = 1;
  const owner = new Int32Array(gw * gh).fill(-1);
  const orientation = (i: number, j: number) => ds1.walls[0]?.[(room.y0 + j) * width + room.x0 + i]?.orientation ?? 0;

  // DRLGLOGIC_SetTileGridFlags: open cells spread to all four sides; a wall passes on by its kind and the side it was
  // entered from, and may continue diagonally.
  const fill = (id: number, x: number, y: number, from: number) => {
    while (x >= 0 && y >= 0 && x < gw && y < gh) {
      const k = y * gw + x;
      if (owner[k] >= 0) return;
      if (!barrier[k]) {
        owner[k] = id;
        STEPS.forEach(([dx, dy], dir) => fill(id, x + dx, y + dy, dir));
        return;
      }
      const cls = WALL_CLASS[orientation(x, y)] ?? 0;
      const flow = cls < 0 ? 0 : (WALL_FLOW[from + 5 * cls + 1] ?? 0);
      if (flow & 1) owner[k] = id;
      if (flow & 2 && from !== 2) fill(id, x + 1, y, 0);
      if (flow & 4 && from !== 3) fill(id, x, y + 1, 1);
      if (flow & 8 && from !== 0) fill(id, x - 1, y, 2);
      if (flow & 16 && from !== 1) fill(id, x, y - 1, 3);
      if (!(flow & 32)) return;
      x++;
      y++;
      from = -1;
    }
  };

  const all: LogicRegion[] = [];
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      if (owner[j * gw + i] >= 0) continue;
      const [x, y] = [room.x0 + i, room.y0 + j];
      all.push({ seed: { x, y }, node: inMap(x, y) && isNodeFloor(ds1.floors[0]?.[y * width + x]), cells: [], floored: 0 });
      fill(all.length - 1, i, j, -1);
    }
  for (let j = 0; j < room.h; j++)
    for (let i = 0; i < room.w; i++) {
      const id = owner[j * gw + i];
      if (id < 0) continue;
      const [x, y] = [room.x0 + i, room.y0 + j];
      all[id].cells.push({ x, y });
      if (ds1.floors.some((l) => !isEmptyCell(l[y * width + x]))) all[id].floored++;
    }
  let warp = false;
  for (let j = 0; j < room.h && !warp; j++)
    for (let i = 0; i < room.w && !warp; i++)
      warp = ds1.walls.some((l) => {
        const c = l[(room.y0 + j) * width + room.x0 + i];
        return !isEmptyCell(c) && (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) && c.mainIndex < 8;
      });
  return { room, regions: all.filter((r) => r.cells.length), warp };
}

/** Whether monsters can be placed in a region: not a node, in a room without a warp, with floor to stand on. */
export const spawns = (rr: RoomRegions, r: LogicRegion) => !rr.warp && !r.node && r.floored > 0;

export interface NoSpawnPlan {
  /** Floor layers the map needs (a second one is added for the floor copies). */
  floors: number;
  edits: CellEdit[];
  rooms: PresetRoom[];
  /** Seeds changed: a floor moved up to floor 2 over a hidden copy, or a hidden floor + unwalkable mark on void. */
  copied: number;
  voids: number;
  /** Region seeds that couldn't be changed, and why. */
  skipped: string[];
}

const FLOOR1 = { kind: 'floor' as const, index: 0 };
const FLOOR2 = { kind: 'floor' as const, index: 1 };
/** DS1 cell flag "unwalkable" (bit 17 of the cell word): blocks walking on the whole cell. */
export const UNWALKABLE = 0x02;

/**
 * Makes the rooms touching `cells` spawn no random monsters while staying walkable and looking the same: every
 * region's seed gets a hidden first-layer floor. A floored seed's tile is copied to floor 2 first (drawn the same,
 * same collision); a seed without a floor gets a hidden floor tile plus the unwalkable mark, so nothing new can be
 * walked on. With `wholeRooms`, every floored cell of the rooms is changed the same way, not only the seeds.
 * The seed of a region can be in the row or column a room shares with the next one; changing it there can also turn
 * a region of that room into a node.
 */
export function noSpawnPlan(ds1: Ds1, cells: [number, number][], opts: { wholeRooms?: boolean; voidTile?: { main: number; sub: number } } = {}): NoSpawnPlan {
  const { width, height } = ds1;
  const all = presetRooms(width, height);
  const rooms = all.filter((r) => cells.some(([x, y]) => x >= r.x0 && x <= r.x0 + r.w && y >= r.y0 && y <= r.y0 + r.h));
  const f1 = ds1.floors[0];
  const f2 = ds1.floors[1];
  // A floor tile the map uses, for void seeds (hidden, so it is never drawn): the most common one in the rooms.
  let voidTile = opts.voidTile ?? null;
  if (!voidTile && f1) {
    const count = new Map<string, number>();
    for (const r of rooms)
      for (let y = r.y0; y < r.y0 + r.h; y++)
        for (let x = r.x0; x < r.x0 + r.w; x++) {
          const c = f1[y * width + x];
          if (!isEmptyCell(c) && !c.hidden) count.set(`${c.mainIndex}/${c.subIndex}`, (count.get(`${c.mainIndex}/${c.subIndex}`) ?? 0) + 1);
        }
    const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? [...new Map(f1.filter((c) => !isEmptyCell(c)).map((c) => [`${c.mainIndex}/${c.subIndex}`, 1]))][0]?.[0];
    if (best) {
      const [main, sub] = best.split('/').map(Number);
      voidTile = { main, sub };
    }
  }
  const edits: CellEdit[] = [];
  const done = new Set<number>();
  const skipped: string[] = [];
  let copied = 0;
  let voids = 0;
  const hideAt = (x: number, y: number, why: string) => {
    const k = y * width + x;
    if (done.has(k)) return;
    done.add(k);
    if (x >= width || y >= height) return void skipped.push(`${x},${y} (${why}) is past the map's edge`);
    const c1 = f1?.[k] ?? EMPTY_CELL;
    if (isNodeFloor(c1)) return;
    if (!isEmptyCell(c1)) {
      if (f2 && !isEmptyCell(f2[k])) return void skipped.push(`${x},${y} (${why}) has a floor 2 tile already, so its floor 1 can't be hidden without changing the look`);
      edits.push({ layer: FLOOR2, x, y, cell: { ...c1 } });
      edits.push({ layer: FLOOR1, x, y, cell: { ...c1, hidden: true, prop4: c1.prop4 | 0x80 } });
      copied++;
      return;
    }
    // Only a floor 2 tile here: a hidden copy of it under it (same look, same collision).
    if (f2 && !isEmptyCell(f2[k])) {
      edits.push({ layer: FLOOR1, x, y, cell: { ...f2[k], hidden: true, prop4: f2[k].prop4 | 0x80 } });
      copied++;
      return;
    }
    if (!voidTile) return void skipped.push(`${x},${y} (${why}) has no floor and the map has no floor tile to hide there`);
    const hidden = withTile(EMPTY_CELL, voidTile.main, voidTile.sub, DEFAULT_PROP1.floor);
    edits.push({ layer: FLOOR1, x, y, cell: { ...hidden, hidden: true, prop4: hidden.prop4 | 0x80, prop3: hidden.prop3 | UNWALKABLE } });
    voids++;
  };
  for (const r of rooms) {
    for (const reg of roomRegions(ds1, r).regions) hideAt(reg.seed.x, reg.seed.y, 'a region seed');
    if (opts.wholeRooms)
      for (let y = r.y0; y < r.y0 + r.h; y++) for (let x = r.x0; x < r.x0 + r.w; x++) if (f1 && !isEmptyCell(f1[y * width + x])) hideAt(x, y, 'a floored cell');
  }
  return { floors: Math.max(ds1.floors.length, edits.some((e) => e.layer.index === 1) ? 2 : 1), edits, rooms, copied, voids, skipped };
}

/**
 * Rooms that look meant to spawn nothing (some region seed has a hidden first-layer floor tile, as no_spawn_area
 * leaves it) but still have regions monsters can be placed in.
 */
export function partlyNoSpawnRooms(ds1: Ds1): { rr: RoomRegions; open: LogicRegion[] }[] {
  const out: { rr: RoomRegions; open: LogicRegion[] }[] = [];
  const f1 = ds1.floors[0];
  if (!f1) return out;
  for (const room of presetRooms(ds1.width, ds1.height)) {
    const rr = roomRegions(ds1, room);
    if (rr.warp) continue;
    const marked = rr.regions.some((r) => f1[r.seed.y * ds1.width + r.seed.x]?.hidden);
    const open = rr.regions.filter((r) => spawns(rr, r));
    if (marked && open.length) out.push({ rr, open });
  }
  return out;
}
