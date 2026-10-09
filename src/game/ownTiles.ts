import { buildDt1, dt1Records, recordInfo, type Dt1Record } from '../formats/dt1Write';
import { normalizePath } from '../vfs/vfs';
import { tileIdentity } from './assetUsage';
import type { GameData, LvlTypeInfo } from './GameData';
import { loadedWithPaths } from './reassignTiles';
import { MAX_TILE_PATH } from './addToGame';

/**
 * Where DS1 Studio puts the tiles it makes for maps (automap pieces, walkability blockers and copies, floor rerolls,
 * pasted preset tiles): ONE file per level type, in the folder that type's own libraries live in — for example
 * `Guilds/guild_custom.dt1` for level type 46 "Guild". Every map of the type adds to it, so the type spends one File
 * slot on it however many maps and edits there are, and the files stay where the level's other libraries are.
 *
 * Tiles are only ever added (so undo never leaves a cell on a tile that is gone), and their numbers are picked free
 * across every library of the level type, so maps of the type that load it never see each other's tiles.
 *
 * A map not in the game yet (no level type) uses `<map>_custom.dt1` next to it until it is added.
 */

const TILES = 'data/global/tiles/';
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom';

/** The type's libraries that are loose mod files (not in an MPQ), relative to data/global/tiles. */
function modFiles(gd: GameData, type: LvlTypeInfo): string[] {
  return type.files.filter((f) => {
    if (!f) return false;
    const from = gd.fs.locate(normalizePath(TILES + f)) ?? '';
    return !!from && !/\.mpq$/i.test(from);
  });
}

/** The level type's home folder (relative to data/global/tiles): where most of its own (else its) libraries are. */
export function typeHome(gd: GameData, type: LvlTypeInfo): string | null {
  const count = new Map<string, number>();
  // The mod's own libraries decide; a type made only of the game's libraries uses their usual folder.
  const own = modFiles(gd, type);
  for (const f of own.length ? own : type.files.filter(Boolean)) {
    const d = dirOf(f.replace(/\\/g, '/'));
    if (d) count.set(d, (count.get(d) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return best?.[0] ?? null;
}

/**
 * `<home>/<slug>_custom.dt1`, kept within the game's tile path limit (MAX_TILE_PATH): the slug loses its underscores,
 * then letters from the end ("PD2assets/dtprivate/dark_temple_custom.dt1" -> ".../darktemple_custom.dt1").
 */
export function customName(home: string, name: string): string {
  const room = MAX_TILE_PATH - `${home}/_custom.dt1`.length;
  const short = name.length <= room ? name : name.replace(/_/g, '').slice(0, Math.max(1, room));
  return `${home}/${short}_custom.dt1`;
}

/** The file the map's generated tiles go into (game path, data/global/tiles/...). */
export function ownTilesPath(gd: GameData, mapPath: string, type: LvlTypeInfo | null | undefined): string {
  const home = type ? typeHome(gd, type) : null;
  if (type && home) {
    // Keep a file the type already lists, whatever its case.
    const name = customName(home, slug(type.name));
    const listed = type.files.find((f) => f && normalizePath(f) === normalizePath(name));
    return TILES + (listed ?? name);
  }
  return mapPath.replace(/\.ds1$/i, '_custom.dt1');
}

/** Tile numbers ("o|main|sub") used by any library of the level type (and the given extra DT1s). */
export async function typeTakenKeys(gd: GameData, type: LvlTypeInfo | null | undefined, extra: string[] = []): Promise<Set<string>> {
  const taken = new Set<string>();
  const paths = [...(type?.files.filter(Boolean).map((f) => TILES + f) ?? []), ...extra];
  for (const p of paths) {
    const d = await gd.dt1(normalizePath(p)).catch(() => null);
    for (const t of d?.tiles ?? []) taken.add(tileIdentity(t.orientation, t.mainIndex, t.subIndex));
  }
  return taken;
}

/**
 * Tile numbers used by the DT1s loaded together with `dt1Path`: the open map's other libraries (`mapLibs`) and those
 * of every level type that lists it. A tile given one of these numbers could be drawn from the other DT1 instead
 * (the first-loaded wins), so new numbers for its tiles avoid them.
 */
export async function sharedTakenKeys(gd: GameData, dt1Path: string, mapLibs: string[] = []): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const p of loadedWithPaths(gd, dt1Path, mapLibs)) {
    const d = await gd.dt1(p).catch(() => null);
    for (const t of d?.tiles ?? []) taken.add(tileIdentity(t.orientation, t.mainIndex, t.subIndex));
  }
  return taken;
}

/** The own-tiles file with `records` added after what it already holds; also the index of the first new tile. */
export function appendTiles(existing: Uint8Array | null, records: Dt1Record[]): { bytes: Uint8Array; first: number } {
  const before = existing ? dt1Records(existing) : [];
  return { bytes: buildDt1([...before, ...records]), first: before.length };
}

/** Tile numbers already in the own-tiles file. */
export function keysOf(bytes: Uint8Array | null): Set<string> {
  if (!bytes) return new Set();
  return new Set(dt1Records(bytes).map((r) => {
    const i = recordInfo(r);
    return tileIdentity(i.orientation, i.main, i.sub);
  }));
}

