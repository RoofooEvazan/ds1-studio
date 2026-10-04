import { automapLevelFor, GAME_AUTOMAP_LEVELS, parseAutomap, unknownAutomapLevels, type AutomapPiece } from './automap';
import { decodeTile, Orientation } from '../formats/dt1';
import { parseTxt, type TxtTable } from '../formats/txt';
import { SubTileFlag, walkability, type Scene } from '../render/scene';
import { MpqSource, normalizePath } from '../vfs/vfs';
import { GameData, TileLibrary } from './GameData';
import type { OpenMap } from './openMap';
import { isBuiltinPath } from './specialTiles';
import { overlayFlags, openVoid } from './mapOverlays';
import { presetRooms, roomAt } from './spawnRegions';
import { clashingDt1s, duplicateDt1s, mixedVersions } from './duplicateDt1s';
import { findPops, popProblems } from './pops';
import { ENTRY_IMAGE_DIR, levelAct, TOWNS, verifyInGame } from './addToGame';
import { ACT_TOWNS, exitProblems } from './exits';
import { loadTable } from './levelTables';
import { invalidAutomapRows } from './automapSafety';
import { serializeTxtTable } from '../formats/txtTable';
import { arrivalProblem, arrivalText } from './arrival';
import { dt1Act, loadAct0Palette } from './act0Palette';
import { neededDt1s } from './importMatch';
import { drawnPalettes, guessDrawnAct } from './openMap';
import type { Palette } from '../formats/palette';
import { blankObjectNames, nameStringsWrite, readStringTables } from './objectStrings';
import { directIdsOnGameRows, looseOnlyRows, modArchiveTable, objectRows, unpairedPads } from './objectChecks';
import { partlyNoSpawnRooms } from './spawnRegions';

export type Severity = 'error' | 'warning' | 'info' | 'ok';

/**
 * What identifies a check result between runs, for "accepted" (intended) warnings: its area and title, with the
 * numbers in it ignored (counts change as the map is edited).
 */
export function resultKey(r: Pick<CheckResult, 'area' | 'title'>): string {
  return `${r.area}|${r.title.replace(/\d+/g, '#').trim().toLowerCase()}`;
}

export interface CheckResult {
  severity: Severity;
  area: 'Tiles' | 'Tables' | 'Level' | 'Objects' | 'Map';
  title: string;
  detail?: string;
  /** Cells or sub-tiles to show on the map. */
  cells?: { x: number; y: number }[];
  /** Table columns the result is about (the UI explains them). */
  columns?: { table: string; col: string }[];
  /** One-click fixes the UI offers for this result, best first. */
  fixes?: Fix[];
}

/** A fix the check can suggest; the app carries it out (and it can be undone like any edit). */
export type Fix = { label: string } & (
  | { kind: 'open-table'; table: string; key?: string }
  | { kind: 'add-dt1s'; paths: string[] }
  | { kind: 'remove-dt1s'; paths: string[] }
  /** Convert these libraries to the Act 0 colours in the mod. */
  | { kind: 'act0-dt1s'; paths: string[] }
  | { kind: 'table-write'; writes: { table: string; path: string; bytes: Uint8Array; summary: string[] }[] }
  | { kind: 'clear-cells'; cells: { layer: 'floor' | 'wall' | 'shadow'; index: number; x: number; y: number }[] }
  /** Changes wall-layer special tiles (orientation 10/11) to another main/sub number, in place. */
  | { kind: 'set-special'; cells: { index: number; x: number; y: number; main: number; sub: number }[] }
  /** Moves wall-layer markers (special tiles) to other cells, onto the same wall layer when it is free there. */
  | { kind: 'move-special'; moves: { index: number; x: number; y: number; toX: number; toY: number }[] }
  | { kind: 'sync-tables' }
  | { kind: 'register' }
  | { kind: 'move-objects'; moves: { index: number; x: number; y: number }[] }
  | { kind: 'delete-objects'; indices: number[] }
  | { kind: 'place-object'; type: number; id: number }
  | { kind: 'set-act'; act: number }
  /** Crop the map: negative deltas remove cells from each edge. */
  | { kind: 'resize'; delta: { left: number; top: number; right: number; bottom: number } }
  | { kind: 'automap-editor' }
  /** Sets up warp link `vis` (Levels.txt VisN, in the link editor) and/or arms the brush with its warp tile. */
  | { kind: 'warp-link'; vis: number; edit: boolean; place: boolean; toTown?: number }
  /** Answers a check's question with "keep it as it is": remembered, so it isn't asked again. */
  | { kind: 'keep'; key: string }
  /** Shows two copies of the same tiles side by side to choose which to keep (the others leave the map). */
  | { kind: 'choose-copies'; pairs: { earlier: string; later: string; keys: number[] }[] }
  /** Pick one version of each tile number DS1 Studio's DT1s have in two colourings; the others are taken out of the file. */
  | { kind: 'choose-versions'; items: { path: string; key: number; indices: number[] }[] }
  /** Renames tile files whose paths are too long (relative to data/global/tiles), updating LvlTypes / LvlPrest. */
  | { kind: 'shorten-paths'; paths: string[] }
);

/**
 * DT1s (other than the loaded ones) that contain the given tile keys ("orientation|main|sub"): the map's own folders
 * first, then every DT1. Returns the fewest files that cover the most keys.
 */
async function dt1sContaining(gd: GameData, keys: Set<string>, loaded: Set<string>, preferred: string[]): Promise<{ paths: string[]; covered: number }> {
  const all = gd.fs.list((p) => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')).filter((p) => !loaded.has(normalizePath(p)));
  const folderOf = (p: string) => normalizePath(p).replace(/[^/]+$/, '');
  const pref = new Set(preferred.map(folderOf));
  const ordered = [...all.filter((p) => pref.has(folderOf(p))), ...all.filter((p) => !pref.has(folderOf(p)))];
  const has = new Map<string, Set<string>>();
  for (const p of ordered) {
    const dt1 = await gd.dt1(p).catch(() => null);
    if (!dt1) continue;
    const hit = new Set(dt1.tiles.map((t) => `${t.orientation}|${t.mainIndex}|${t.subIndex}`).filter((k) => keys.has(k)));
    if (hit.size) has.set(p, hit);
    // The map's folders usually hold them; stop early once everything is found there.
    if (pref.has(folderOf(p)) && [...keys].every((k) => [...has.values()].some((h) => h.has(k)))) break;
  }
  // Greedy cover: fewest DT1s for the most tiles.
  const left = new Set(keys);
  const paths: string[] = [];
  while (left.size) {
    let best: string | null = null;
    let bestN = 0;
    for (const [p, h] of has) {
      const n = [...h].filter((k) => left.has(k)).length;
      if (n > bestN) [best, bestN] = [p, n];
    }
    if (!best) break;
    paths.push(best);
    for (const k of has.get(best)!) left.delete(k);
  }
  return { paths, covered: keys.size - left.size };
}

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

async function table(gd: GameData, name: string): Promise<TxtTable | null> {
  const b = await gd.fs.read(`data/global/excel/${name}`);
  return b ? parseTxt(b) : null;
}

/**
 * Checks that a map will load and play in game: every placed tile has a graphic *in the libraries the game loads*,
 * the map is reachable through LvlPrest/Levels/LvlTypes, it has entry/warp markers, and objects stand on walkable
 * ground. Pure read-only analysis; results are ordered errors first.
 */
export async function checkMap(gd: GameData, map: OpenMap, scene: Scene, automap?: { pieces: AutomapPiece[] }, kept?: (key: string) => boolean): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { ds1, lib } = map;
  // The act a library's folder names: only trusted for the game's and the mod's archived files. A loose file in an
  // act folder may have been made or recoloured for another palette (PD2's new Act 5 levels), so its art decides.
  const folderAct = (path: string) => (gd.fs.sources.find((s) => s.has(path)) instanceof MpqSource ? dt1Act(path) : null);

  // --- Tiles -------------------------------------------------------------------------------------------------------
  const notFound = lib.loaded.filter((l) => !l.found && !isBuiltinPath(l.path));
  if (notFound.length)
    out.push({
      severity: 'error',
      area: 'Tiles',
      title: `${notFound.length} tile librar${notFound.length > 1 ? 'ies' : 'y'} not found`,
      detail: `${notFound.map((l) => short(l.path)).join(', ')}. The game cannot load ${notFound.length > 1 ? 'them' : 'it'} either.`,
      fixes: [{ kind: 'remove-dt1s', label: `Remove ${notFound.length > 1 ? 'them' : 'it'} from the map's libraries`, paths: notFound.map((l) => l.path) }],
    });
  const dups = duplicateDt1s(lib);
  if (dups.length) {
    const shared = new Set(dups.flatMap((d) => [...d.shared]));
    const cells: { x: number; y: number }[] = [];
    for (let i = 0; i < ds1.width * ds1.height; i++) {
      const used =
        ds1.floors.some((l) => l[i].prop1 !== 0 && shared.has(TileLibrary.key(Orientation.Floor, l[i].mainIndex, l[i].subIndex))) ||
        ds1.walls.some((l) => l[i].prop1 !== 0 && shared.has(TileLibrary.key(l[i].orientation, l[i].mainIndex, l[i].subIndex)));
      if (used) cells.push({ x: i % ds1.width, y: Math.floor(i / ds1.width) });
    }
    const earlier = [...new Set(dups.map((d) => d.earlier))];
    const later = [...new Set(dups.map((d) => d.later))];
    out.push({
      severity: 'warning',
      area: 'Tiles',
      title: `${dups.length} tile librar${dups.length > 1 ? 'ies are' : 'y is'} loaded twice`,
      detail: `${dups.map((d) => `${short(d.earlier)} and ${short(d.later)}`).join('; ')} provide the same tiles. Where a tile has random variants, the game picks among both copies, so the map shows a random mix of them (odd colours on some cells, for example) — in game too. Keep one copy of each.`,
      cells,
      fixes: [
        {
          kind: 'choose-copies',
          label: 'Compare the copies and choose…',
          // Sample tiles for each pair: ones the map places whose pictures differ between the copies first.
          pairs: dups.map((d) => {
            const used = new Set<number>();
            for (let i = 0; i < ds1.width * ds1.height; i++) {
              for (const l of ds1.floors) if (l[i].prop1 !== 0) used.add(TileLibrary.key(Orientation.Floor, l[i].mainIndex, l[i].subIndex));
              for (const l of ds1.walls) if (l[i].prop1 !== 0) used.add(TileLibrary.key(l[i].orientation, l[i].mainIndex, l[i].subIndex));
            }
            const pic = (path: string, k: number) => {
              const t = lib.tilesOf(path).find((x) => TileLibrary.key(x.orientation, x.mainIndex, x.subIndex) === k);
              const img = t ? decodeTile(t) : null;
              return img ? img.pixels.join(',') : '';
            };
            const shared = [...d.shared];
            const differ = shared.filter((k) => pic(d.earlier, k) !== pic(d.later, k));
            const order = [...differ.filter((k) => used.has(k)), ...differ.filter((k) => !used.has(k)), ...shared.filter((k) => !differ.includes(k))];
            return { earlier: d.earlier, later: d.later, keys: order.slice(0, 6) };
          }),
        },
        { kind: 'remove-dt1s', label: `Keep the later ones: remove ${earlier.map(short).join(', ')}`, paths: earlier },
        { kind: 'remove-dt1s', label: `Keep the earlier ones: remove ${later.map(short).join(', ')}`, paths: later },
      ],
    });
  }
  const clash = clashingDt1s(lib, ds1, (p) => /\.mpq$/i.test(gd.fs.locate(normalizePath(p)) ?? ''));
  if (clash) {
    const pairs = [...clash.pairs].sort((a, b) => b[1] - a[1]);
    out.push({
      severity: 'warning',
      area: 'Tiles',
      title: `${clash.cells.length} cells use tile numbers that two of the map's DT1s both have`,
      detail: `${pairs
        .slice(0, 4)
        .map(([p, n]) => `${p.split('|').map(short).join(' and ')} (${n})`)
        .join('; ')}. Where those tiles have random variants (a rarity), the game picks among all of them for each cell, so the map looks jumbled in game; where they have none, it always shows the one in the DT1 loaded first (lowest LvlTypes File slot), and DS1 Studio shows the same. ${
        clash.removable.length ? `Every tile the map uses from ${clash.removable.map(short).join(', ')} is in another loaded DT1 too, so removing ${clash.removable.length > 1 ? 'them' : 'it'} leaves one choice per cell.` : 'Each DT1 has tiles only it provides, so keep them and change the clashing cells instead.'
      }`,
      cells: clash.cells,
      fixes: clash.removable.length ? [{ kind: 'remove-dt1s', label: `Remove ${clash.removable.map(short).join(', ')} from the map's libraries`, paths: clash.removable }] : [],
    });
  }
  const mixed = mixedVersions(lib);
  if (mixed.length) {
    const keys = new Set(mixed.map((m) => m.key));
    const cells: { x: number; y: number }[] = [];
    for (let i = 0; i < ds1.width * ds1.height; i++) {
      const used =
        ds1.floors.some((l) => l[i].prop1 !== 0 && keys.has(TileLibrary.key(Orientation.Floor, l[i].mainIndex, l[i].subIndex))) ||
        ds1.walls.some((l) => l[i].prop1 !== 0 && keys.has(TileLibrary.key(l[i].orientation, l[i].mainIndex, l[i].subIndex)));
      if (used) cells.push({ x: i % ds1.width, y: Math.floor(i / ds1.width) });
    }
    const files = [...new Set(mixed.map((m) => short(m.path)))];
    out.push({
      severity: 'warning',
      area: 'Tiles',
      title: `${mixed.length} tile${mixed.length === 1 ? ' has' : 's have'} two versions in different colours`,
      detail: `In ${files.join(', ')} (made by DS1 Studio: an automap edit or a custom DT1). They were copied while the map loaded two copies of the same library, so each copy's version came along. The game picks a version at random for every cell, so ${cells.length} cell${cells.length === 1 ? '' : 's'} sometimes show the wrong colours (purple doors, for example) — in game too. The act-safe check can't tell: both versions use only colours every act shares. Keep the version that looks right.`,
      cells,
      fixes: [{ kind: 'choose-versions', label: 'Compare the versions and choose…', items: mixed }],
    });
  }
  if (scene.missing.length) {
    // The libraries the map itself names (its embedded list, written by WinDS1 and DS1 Studio).
    const named = neededDt1s(ds1, (p) => !!gd.fs.locate(p));
    const keys = new Set(scene.missing.map((m) => `${m.orientation}|${m.main}|${m.sub}`));
    const loadedSet = new Set(lib.loaded.map((l) => normalizePath(l.path)));
    const found = await dt1sContaining(gd, keys, loadedSet, lib.loaded.map((l) => l.path));
    const fixes: Fix[] = [];
    if (found.paths.length)
      fixes.push({
        kind: 'add-dt1s',
        label: `Add ${found.paths.map(short).join(', ')} (${found.covered === keys.size ? 'has all' : `has ${found.covered} of ${keys.size}`} of the missing tile numbers; the graphics may not be the ones meant)`,
        paths: found.paths,
      });
    fixes.push({
      kind: 'clear-cells',
      label: `Clear those ${scene.missing.length} tile${scene.missing.length === 1 ? '' : 's'} (they are gone from the map)`,
      cells: scene.missing.map((m) => ({ layer: m.kind === 'floor' ? 'floor' : m.kind === 'shadow' ? 'shadow' : 'wall', index: m.layer, x: m.cellX, y: m.cellY })),
    });
    out.push({
      severity: 'error',
      area: 'Tiles',
      title: `${scene.missing.length} placed tiles have no graphic`,
      detail: `These cells use tiles (orientation/main/sub) that no loaded DT1 contains. In game they are invisible and may break walkability.${found.paths.length ? '' : ' No DT1 in the game or your mod has them.'}${
        named.length
          ? ` The map names the tile libraries it was made with: ${named.map((n) => `${n.rel}${n.found ? '' : ' (not in your game or mod)'}`).join(', ')}.${
              named.every((n) => n.found)
                ? " You have all of them, so your copies differ from the ones it was made with (edited versions, or an Act 0 pack): the tiles it needs are in the maker's copies. Ask them for those files before adding other libraries with the same tile numbers or clearing the cells."
                : " Ask the map's maker for the ones you don't have."
            }`
          : ''
      }`,
      cells: scene.missing.map((m) => ({ x: m.cellX, y: m.cellY })),
      fixes,
    });
  }
  else out.push({ severity: 'ok', area: 'Tiles', title: 'Every placed tile has a graphic' });


  // DT1s the placed tiles actually come from.
  const used = new Map<string, number>();
  for (const it of scene.items) {
    const src = lib.sourceOf(it.tile);
    if (src && !isBuiltinPath(src.path)) used.set(normalizePath(src.path), (used.get(normalizePath(src.path)) ?? 0) + 1);
  }

  // --- Arrival: where the game puts players who come in without a warp (a map item's portal) ----------------------
  // A waypoint anchors it (the game's first choice), wherever the map's tiles are; without one (and without warps) it
  // is the room at the level's centre. The Map entry tile isn't used.
  {
    const isWp = (type: number, id: number) => gd.isWaypoint(ds1.act, type, id);
    const hasWaypoint = ds1.objects.some((o) => isWp(o.type, o.id));
    const hasWarp = ds1.walls.some((l) => l.some((c) => (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) && c.mainIndex <= 7));
    const wp = gd.waypointFor(ds1.act);
    const placeWp: Fix[] = wp ? [{ kind: 'place-object', label: 'Place a waypoint where players should arrive', type: 2, id: wp.id }] : [];
    const p = arrivalProblem(ds1, isWp);
    if (p)
      out.push({
        severity: 'error',
        area: 'Level',
        title: 'Players arriving by portal (a map item) land in the empty middle of the map, and the game stops',
        detail: `${arrivalText(p)} A waypoint fixes it without resizing: the game puts arrivals at the waypoint first, wherever it is. Save afterwards.`,
        cells: [{ x: p.room.x + 4, y: p.room.y + 4 }],
        fixes: [...placeWp, ...(p.crop ? [{ kind: 'resize' as const, label: `Or crop the map to what's painted (${p.cropped!.w}×${p.cropped!.h}, 2 cells around)`, delta: p.crop }] : [])],
      });
    else if (!hasWaypoint && !hasWarp)
      out.push({
        severity: 'warning',
        area: 'Level',
        title: 'No waypoint: players arriving by portal (a map item) are put at the centre of the level',
        detail: "With no waypoint and no warp tile, the game puts players who arrive through a map item's portal in the room at the level's centre (it has floor, so this works). Place a waypoint where they should arrive: the game uses it first, so the map's tiles can be anywhere. The Map entry tile doesn't change this.",
        fixes: placeWp,
      });
  }

  // --- Tables: is the map part of a level? --------------------------------------------------------------------------
  const [prest, levels, types] = await Promise.all([table(gd, 'LvlPrest.txt'), table(gd, 'Levels.txt'), table(gd, 'LvlTypes.txt')]);
  const rel = normalizePath(map.path).replace(/^data\/global\/tiles\//, '');
  // A map can be listed by several rows (a shared room and its own level): check the one that builds a level first.
  const listing = prest?.rows.filter((r) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(r[`File${i}`] ?? '') === rel)) ?? [];
  const prestRow = listing.find((r) => Number(r['LevelId']) > 0) ?? listing[0];
  if (!prest) out.push({ severity: 'warning', area: 'Tables', title: 'LvlPrest.txt not found', detail: 'Cannot check how the game loads this map.' });
  else if (!prestRow)
    out.push({
      severity: 'error',
      area: 'Tables',
      title: 'Not referenced by LvlPrest.txt',
      detail: `No LvlPrest row lists "${rel}" in File1–File6, so the game never loads this map. Add a row (Name, Def, LevelId, File1, Dt1Mask).`,
      columns: [{ table: 'LvlPrest', col: 'File1' }, { table: 'LvlPrest', col: 'LevelId' }, { table: 'LvlPrest', col: 'Dt1Mask' }],
      fixes: [
        { kind: 'register', label: 'Add to game... (creates the LvlPrest / Levels / LvlTypes rows)' },
        { kind: 'open-table', label: 'Open LvlPrest.txt', table: 'LvlPrest.txt' },
      ],
    });
  else {
    out.push({ severity: 'ok', area: 'Tables', title: `LvlPrest: "${prestRow['Name']}" (Def ${prestRow['Def']})` });
    // The rules the game's table loaders and level builder follow (row = record, first claiming row, sizes, act,
    // palette, overlaps, path lengths); see game/addToGame.ts.
    const [p2, l2, t2] = await Promise.all([loadTable(gd.fs, 'LvlPrest.txt'), loadTable(gd.fs, 'Levels.txt'), loadTable(gd.fs, 'LvlTypes.txt')]);
    // The act this map's tiles were drawn for, from their art: what Pal should name. Libraries using only the colours
    // every act shares look right under any Pal; when the rest disagree (or need the classic Act 5 palette, which no
    // Pal names), the level type's act is the guess, as before.
    const tilesAct = await (async (): Promise<number | null | undefined> => {
      const a0 = await loadAct0Palette(gd.fs).catch(() => null);
      if (!a0) return undefined;
      const acts = new Set<number>();
      for (const l of lib.loaded) {
        if (!l.found || isBuiltinPath(l.path)) continue;
        const dt1 = await gd.dt1(l.path).catch(() => null);
        if (!dt1 || !dt1.tiles.some((t) => decodeTile(t)?.pixels.some((px) => px && !a0.usable[px]))) continue;
        const act = folderAct(l.path) ?? guessDrawnAct(dt1.tiles, await drawnPalettes(gd));
        if (act === null || act > 4) return undefined;
        acts.add(act);
      }
      return acts.size === 0 ? null : acts.size === 1 ? [...acts][0] : undefined;
    })();
    // Levels the mod's own MPQ doesn't list (added in a loose Levels.txt): PD2 draws new Act 5 ones in the Act 5 palette.
    const modLevels = await modArchiveTable(gd.fs, 'Levels.txt');
    const modLevelIds = modLevels && !modLevels.inUse ? new Set(modLevels.table.rows.map((r) => Number(r['Id']))) : null;
    const isNewLevel = (id: number) => !!modLevelIds && !modLevelIds.has(id);
    const issues = p2 && l2 && t2
      ? verifyInGame({ prest: p2, levels: l2, types: t2 }, map.path.replace(/^data\/global\/tiles\//i, ''), ds1, {
          entryImageExists: (name) => !!gd.fs.locate(normalizePath(`${ENTRY_IMAGE_DIR}${name}.dc6`)),
          kept,
          tilesAct,
          isNewLevel,
        })
      : [];
    // Every too-long path together, so one dialog renames them all.
    const longPaths = [...new Map(issues.filter((i) => i.longPath).map((i) => [normalizePath(i.longPath!), i.longPath!])).values()];
    for (const issue of issues)
        out.push({
          severity: issue.severity,
          title: issue.title,
          detail: issue.detail,
          columns: issue.columns,
          area: issue.columns?.[0]?.table === 'Levels' ? 'Level' : 'Tables',
          fixes: [
            ...(issue.longPath ? [{ kind: 'shorten-paths' as const, label: longPaths.length > 1 ? `Rename the ${longPaths.length} long paths…` : 'Rename it…', paths: longPaths }] : []),
            ...(issue.keep ? [{ kind: 'keep' as const, label: issue.keep.label, key: issue.keep.key }] : []),
            ...(issue.fix ? [{ kind: 'table-write' as const, label: issue.fix.label, writes: issue.fix.writes }] : []),
            { kind: 'open-table' as const, label: `Open ${issue.columns?.[0]?.table ?? 'LvlPrest'}.txt`, table: `${issue.columns?.[0]?.table ?? 'LvlPrest'}.txt` },
          ],
        });
    const levelId = Number(prestRow['LevelId']);
    const mask = Number(prestRow['Dt1Mask']) >>> 0;
    if (!levelId) {
      out.push({
        severity: 'info',
        area: 'Level',
        title: 'Shared preset (LevelId 0)',
        columns: [{ table: 'LvlPrest', col: 'LevelId' }],
        detail: 'Placed by a level generator (LvlMaze/LvlSub or another level), not a level on its own. Level checks are skipped.',
      });
    } else {
      const level = levels?.rows.find((r) => Number(r['Id']) === levelId);
      if (!level)
        out.push({
          severity: 'error',
          area: 'Level',
          title: `Levels.txt has no level ${levelId}`,
          fixes: [
            { kind: 'open-table', label: 'Open Levels.txt', table: 'Levels.txt' },
            { kind: 'register', label: 'Add to game... (pick or create the level)' },
          ],
        });
      else {
        const typeId = Number(level['LevelType']);
        const typeRow = types?.rows.find((r) => Number(r['Id']) === typeId);
        out.push({ severity: 'ok', area: 'Level', title: `Level ${levelId} "${level['LevelName'] || level['Name']}" (Act ${Number(level['Act']) + 1})` });
        // Colours: tiles drawn for another act show that act's act-specific colours wrong in this level's palette
        // (red, purple, cyan patches). Act 0 libraries use only the colours every act shares.
        {
          const pal = Number(level['Pal']);
          // A new level in the Act 5 slot: PD2 was seen drawing it with the Act 5 palette whatever its Pal.
          const palAct = levelAct(levelId) === 4 && isNewLevel(levelId) ? 4 : pal === 5 ? 4 : Math.min(4, Math.max(0, pal));
          const a0 = await loadAct0Palette(gd.fs).catch(() => null);
          let pals: Palette[] | null = null;
          const actPalettes = async () => (pals ??= await drawnPalettes(gd));
          if (a0) {
            const unsafe: { path: string; share: number }[] = [];
            for (const l of lib.loaded) {
              if (!l.found || isBuiltinPath(l.path)) continue;
              const dt1 = await gd.dt1(l.path).catch(() => null);
              if (!dt1) continue;
              // Drawn for this level's act (by its folder, else by its art): its colours are right here.
              if ((folderAct(l.path) ?? guessDrawnAct(dt1.tiles, await actPalettes())) === palAct) continue;
              let bad = 0, all = 0;
              for (const t of dt1.tiles) {
                const img = decodeTile(t);
                if (img) for (const px of img.pixels) if (px) { all++; if (!a0.usable[px]) bad++; }
              }
              if (bad) unsafe.push({ path: l.path, share: all ? bad / all : 0 });
            }
            if (unsafe.length)
              out.push({
                severity: 'warning',
                area: 'Tiles',
                title: `${unsafe.length} tile ${unsafe.length === 1 ? 'library uses' : 'libraries use'} colours that change between acts: wrong colours (often red) in this Act ${palAct + 1} level`,
                detail: `${unsafe.map((u) => `${short(u.path)} ${Math.round(u.share * 100)}%`).join(', ')} of their pixels. Converted to Act 0 (the colours every act shares) they look right in any act. If the map came from someone who works with an Act 0 tile pack (such as Gimli's), their copies of these files are the exact match: ask for them, or use the same pack.`,
                fixes: [{ kind: 'act0-dt1s', label: `Convert ${unsafe.length === 1 ? 'it' : 'them'} to Act 0 colours (in your mod; originals kept as .bak)`, paths: unsafe.map((u) => u.path) }],
              });
          }
        }
        if (!typeRow) out.push({ severity: 'error', area: 'Level', title: `LvlTypes.txt has no type ${typeId}`, fixes: [{ kind: 'open-table', label: 'Open LvlTypes.txt', table: 'LvlTypes.txt' }] });
        else {
          // Libraries the game loads for this level vs the ones the map's tiles need.
          const info = gd.lvlType(typeId);
          const loaded = new Set(info ? GameData.dt1sFor(info, mask) : []);
          const notLoaded = [...used.keys()].filter((p) => !loaded.has(p));
          if (notLoaded.length)
            out.push({
              severity: 'error',
              area: 'Level',
              title: `${notLoaded.length} tile librar${notLoaded.length > 1 ? 'ies are' : 'y is'} used but not loaded in game`,
              detail: `${notLoaded.map((p) => `${short(p)} (${used.get(p)} tiles)`).join(', ')}. Add ${notLoaded.length > 1 ? 'them' : 'it'} to LvlTypes "${typeRow['Name']}" (File 1–32) and set the matching bits in this preset's Dt1Mask (${mask}).`,
              fixes: [
                { kind: 'sync-tables', label: `Update LvlTypes "${typeRow['Name']}" and the Dt1Mask automatically` },
                { kind: 'open-table', label: 'Open LvlTypes.txt', table: 'LvlTypes.txt', key: typeRow['Name'] },
              ],
              columns: [{ table: 'LvlTypes', col: 'File 1' }, { table: 'LvlPrest', col: 'Dt1Mask' }],
            });
          else out.push({ severity: 'ok', area: 'Level', title: 'Every tile library the map uses is loaded by its level type' });
          for (const f of info?.files.filter(Boolean) ?? []) {
            const p = normalizePath(`data/global/tiles/${f}`);
            if (loaded.has(p) && !gd.fs.locate(p))
              out.push({
                severity: 'error',
                area: 'Level',
                title: `LvlTypes file missing: ${f}`,
                detail: 'The game fails to load this level type. Fix the path or remove it from the row.',
                fixes: [{ kind: 'open-table', label: 'Open LvlTypes.txt', table: 'LvlTypes.txt', key: typeRow['Name'] }],
              });
          }
        }
        // Palette: the level's act decides it.
        const act = Number(level['Act']);
        if (act !== ds1.act)
          out.push({
            severity: 'info',
            area: 'Level',
            title: `Level is in Act ${act + 1}, DS1 header says Act ${ds1.act + 1}`,
            detail: 'The game places the map’s objects and NPCs from the level’s act (by its number), so the object numbers in the DS1 should be that act’s. The colours come from the level’s Pal. Matching the header keeps object names here and in other editors right.',
            columns: [{ table: 'Levels', col: 'Act' }],
            fixes: [{ kind: 'set-act', label: `Set the DS1 header to Act ${act + 1}`, act }],
          });
        if (Number(level['Waypoint']) && Number(level['Waypoint']) !== 255 && !ds1.objects.some((o) => gd.isWaypoint(ds1.act, o.type, o.id))) {
          const wp = gd.waypointFor(ds1.act);
          out.push({
            severity: 'warning',
            area: 'Level',
            title: 'Level has a waypoint slot but no waypoint object on this map',
            detail: 'Players cannot use the waypoint unless one of the level’s presets has a waypoint object.',
            columns: [{ table: 'Levels', col: 'Waypoint' }],
            fixes: wp ? [{ kind: 'place-object', label: `Place a waypoint (${wp.name})`, type: 2, id: wp.id }] : undefined,
          });
        }
        // Ways out: warps that lead somewhere, or a waypoint.
        const hasWaypoint = ds1.objects.some((o) => gd.isWaypoint(ds1.act, o.type, o.id));
        const presets = prest?.rows.filter((r) => Number(r['LevelId']) === levelId).length ?? 0;
        const levelName = (id: number) => {
          const r = levels?.rows.find((x) => Number(x['Id']) === id);
          return r ? r['LevelName'] || r['Name'] || `level ${id}` : `level ${id}`;
        };
        for (const p of exitProblems(ds1, level, { hasWaypoint, onlyPreset: presets <= 1, isTown: TOWNS.has(levelId), levelName }))
          out.push({
            severity: p.severity,
            area: 'Map',
            title: p.title,
            detail: p.detail,
            cells: p.cells,
            columns: [{ table: 'Levels', col: 'Vis0' }],
            fixes: p.fix ? [{ kind: 'warp-link', label: p.fix.label, vis: p.fix.vis, edit: p.fix.edit, place: p.fix.place, toTown: ACT_TOWNS[act] }] : undefined,
          });
      }
    }
  }

  // --- Entry points ------------------------------------------------------------------------------------------------
  const specials: { x: number; y: number }[] = [];
  ds1.walls.forEach((layer) =>
    layer.forEach((c, i) => {
      if (c.prop1 && (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2)) specials.push({ x: i % ds1.width, y: Math.floor(i / ds1.width) });
    }),
  );
  if (!specials.length)
    out.push({
      severity: 'warning',
      area: 'Map',
      title: 'No entry or warp markers',
      detail: 'The map has no special tiles (orientation 10/11), which mark where players arrive (town entries, warps, portals). Players entering from another level may be placed at the map edge or not at all.',
    });
  else out.push({ severity: 'ok', area: 'Map', title: `${specials.length} entry/warp marker tiles`, cells: specials });

  // Arriving by portal (red portals, PD2 map items) puts players on the Map entry marker (10/30/11): every level of the
  // game that is reached through a portal has one (Tristram, Nihlathak's Temple, the Worldstone Chamber, Uber Tristram…),
  // and no town does. Town entries (30/0, 31/0) are only used in towns; without a Map entry the game places players
  // wherever it likes.
  const presetLevel = prestRow ? Number(prestRow['LevelId']) || 0 : 0;
  if (presetLevel && !TOWNS.has(presetLevel)) {
    const marks: { index: number; x: number; y: number; main: number; sub: number }[] = [];
    ds1.walls.forEach((layer, index) =>
      layer.forEach((c, i) => {
        if (c.prop1 && (c.orientation === Orientation.SpecialTile1 || c.orientation === Orientation.SpecialTile2) && c.mainIndex >= 30)
          marks.push({ index, x: i % ds1.width, y: Math.floor(i / ds1.width), main: c.mainIndex, sub: c.subIndex });
      }),
    );
    const townEntry = marks.find((m) => m.main === 30 && m.sub === 0) ?? marks.find((m) => m.main === 31 && m.sub === 0);
    if (!marks.some((m) => m.main === 30 && m.sub === 11))
      out.push({
        severity: townEntry ? 'warning' : 'info',
        area: 'Map',
        title: townEntry ? `A town entry marker (${townEntry.main}/${townEntry.sub}) in a level that is not a town` : 'No Map entry marker (10/30/11)',
        detail: `Players arriving by portal (a red portal or a PD2 map item) appear on the Map entry marker, special tile 10/30/11, as in every portal level of the game (Tristram, Nihlathak's Temple, the Worldstone Chamber…). Town entries (30/0, 31/0) only work in towns. Without a Map entry the game puts arriving players wherever it likes.${townEntry ? ` Turning the town entry at (${townEntry.x}, ${townEntry.y}) into a Map entry makes players arrive there.` : ' Place one where players should arrive (Special tiles → Map entry).'}`,
        cells: townEntry ? [{ x: townEntry.x, y: townEntry.y }] : undefined,
        fixes: townEntry ? [{ kind: 'set-special', label: `Make the marker at (${townEntry.x}, ${townEntry.y}) the Map entry (30/11)`, cells: [{ ...townEntry, main: 30, sub: 11 }] }] : [],
      });
  }

  // --- Roof hiding ("pops") -----------------------------------------------------------------------------------------
  const pops = findPops(ds1);
  for (const p of popProblems(ds1, pops, prestRow ? Number(prestRow['Pops']) || 0 : null, prestRow ? Number(prestRow['PopPad']) || 0 : 0))
    out.push({
      severity: p.severity,
      area: 'Map',
      title: p.text,
      cells: p.area?.markers.map((m) => ({ x: m.x, y: m.y })),
      columns: p.area ? undefined : [{ table: 'LvlPrest', col: 'Pops' }],
      fixes: p.moves
        ? [{ kind: 'move-special', label: `Move the corner marker${p.moves.length === 1 ? '' : 's'}: ${p.moves.map((m) => `(${m.from.x},${m.from.y}) → (${m.x},${m.y})`).join(', ')}`, moves: p.moves.map((m) => ({ index: m.from.layer, x: m.from.x, y: m.from.y, toX: m.x, toY: m.y })) }]
        : p.area
          ? undefined
          : [{ kind: 'open-table', label: 'Open LvlPrest.txt (or use Map → Roof hiding → Set Pops)', table: 'LvlPrest.txt', key: prestRow?.['Name'] }],
    });

  // --- Open edges: void the game lets players walk into ------------------------------------------------------------
  const open = openVoid(ds1, overlayFlags(ds1, scene, lib, map.resolution.preset));
  if (open.edgeCells.length) {
    const rooms = presetRooms(ds1.width, ds1.height);
    const byRoom = new Map<string, { x: number; y: number }[]>();
    for (const c of open.edgeCells) {
      const r = roomAt(rooms, c.x, c.y);
      const key = r ? `room ${r.x0},${r.y0}-${r.x0 + r.w - 1},${r.y0 + r.h - 1}` : 'last row/column';
      byRoom.set(key, [...(byRoom.get(key) ?? []), c]);
    }
    const list = (cells: { x: number; y: number }[]) => cells.slice(0, 12).map((c) => `${c.x},${c.y}`).join(' ') + (cells.length > 12 ? ` … (+${cells.length - 12})` : '');
    out.push({
      severity: 'warning',
      area: 'Map',
      title: `Walkable edge borders void (players can walk off): ${open.edgeCells.length} cells in ${byRoom.size} room${byRoom.size === 1 ? '' : 's'}`,
      detail:
        'In game a cell without a floor blocks nothing unless a tile there does (with LvlPrest FillBlanks, the hidden blank floor 30 the game puts there), so players walk off the art into the void. Put blocking tiles or walls along these edges, or a blocking blank tile in the level’s DT1s. ' +
        [...byRoom].map(([room, cells]) => `${room}: ${cells.length} (${list(cells)})`).join('; '),
      cells: open.edgeCells,
    });
  }

  // --- Objects -----------------------------------------------------------------------------------------------------
  const walk = walkability(ds1, scene, lib);
  const W = ds1.width * 5;
  const H = ds1.height * 5;
  const walkable = (sx: number, sy: number) =>
    sx >= 0 && sy >= 0 && sx < W && sy < H && !(walk[(Math.floor(sy / 5) * ds1.width + Math.floor(sx / 5)) * 25 + (sy % 5) * 5 + (sx % 5)] & (SubTileFlag.BlockWalk | SubTileFlag.BlockPlayerWalk));
  const taken = new Set(ds1.objects.map((o) => `${o.x},${o.y}`));
  /** Nearest free walkable sub-tile (growing rings), not already used by another object. */
  const nearestFree = (sx: number, sy: number): [number, number] | null => {
    for (let r = 1; r <= 25; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (walkable(x, y) && !taken.has(`${x},${y}`)) return [x, y];
        }
    return null;
  };
  const blocked: { x: number; y: number }[] = [];
  const blockedMoves: { index: number; x: number; y: number }[] = [];
  const offMap: string[] = [];
  const offMapIdx: number[] = [];
  const spots = new Map<string, number[]>();
  ds1.objects.forEach((o, i) => {
    const cx = Math.floor(o.x / 5);
    const cy = Math.floor(o.y / 5);
    if (cx < 0 || cy < 0 || cx >= ds1.width || cy >= ds1.height) {
      offMap.push(gd.objectName(ds1.act, o.type, o.id));
      offMapIdx.push(i);
      return;
    }
    if (o.type === 1 && !walkable(o.x, o.y)) {
      blocked.push({ x: cx, y: cy });
      const to = nearestFree(o.x, o.y);
      if (to) {
        taken.add(`${to[0]},${to[1]}`);
        blockedMoves.push({ index: i, x: to[0], y: to[1] });
      }
    }
    const k = `${o.x},${o.y}`;
    spots.set(k, [...(spots.get(k) ?? []), i]);
  });
  if (offMap.length)
    out.push({
      severity: 'error',
      area: 'Objects',
      title: `${offMap.length} objects outside the map`,
      detail: offMap.join(', '),
      fixes: [{ kind: 'delete-objects', label: `Delete ${offMap.length > 1 ? 'them' : 'it'}`, indices: offMapIdx }],
    });
  if (blocked.length)
    out.push({
      severity: 'warning',
      area: 'Objects',
      title: `${blocked.length} NPCs/monsters stand on unwalkable ground`,
      detail: 'They may be stuck or fail to spawn.',
      cells: blocked,
      fixes: blockedMoves.length
        ? [{ kind: 'move-objects', label: `Move ${blockedMoves.length === blocked.length ? 'them' : `${blockedMoves.length} of them`} to the nearest walkable spot`, moves: blockedMoves }]
        : undefined,
    });
  const stackedSpots = [...spots.values()].filter((list) => list.length > 1);
  if (stackedSpots.length) {
    const moves: { index: number; x: number; y: number }[] = [];
    for (const list of stackedSpots)
      for (const i of list.slice(1)) {
        const o = ds1.objects[i];
        const to = nearestFree(o.x, o.y);
        if (to) {
          taken.add(`${to[0]},${to[1]}`);
          moves.push({ index: i, x: to[0], y: to[1] });
        }
      }
    out.push({
      severity: 'warning',
      area: 'Objects',
      title: `${stackedSpots.length} spots with several objects on the same sub-tile`,
      detail: 'NPC paths attached to such spots are dropped by the game and by WinDS1.',
      cells: stackedSpots.map((l) => ({ x: Math.floor(ds1.objects[l[0]].x / 5), y: Math.floor(ds1.objects[l[0]].y / 5) })),
      fixes: moves.length ? [{ kind: 'move-objects', label: 'Spread them onto free neighbouring spots', moves }] : undefined,
    });
  }
  const stacked = stackedSpots.length;
  if (!offMap.length && !blocked.length && !stacked) out.push({ severity: 'ok', area: 'Objects', title: `${ds1.objects.length} objects placed on valid ground` });

  // objects.txt rows the map's objects resolve to.
  const objTable = objectRows(await table(gd, 'objects.txt'));
  const rowOf = (o: { type: number; id: number }) => gd.objectRowNumber(ds1.act, o.type, o.id);
  const at = (indices: number[]) => indices.map((i) => ({ x: Math.floor(ds1.objects[i].x / 5), y: Math.floor(ds1.objects[i].y / 5) }));
  // Ids of 150+ on portal / quest rows are the likely "next act" mistakes; other clickable rows are listed, quieter.
  const direct = directIdsOnGameRows(ds1.objects, objTable);
  for (const group of [direct.filter((d) => d.role !== 'operable'), direct.filter((d) => d.role === 'operable')]) {
    if (!group.length) continue;
    const serious = group[0].role !== 'operable';
    out.push({
      severity: serious ? 'warning' : 'info',
      area: 'Objects',
      title: `${group.length} object${group.length === 1 ? '' : 's'} with an id of 150 or more ${group.length === 1 ? 'is' : 'are'} ${serious ? [...new Set(group.map((d) => d.role))].join(' / ') : 'operable'} object${group.length === 1 ? '' : 's'}: ${[...new Set(group.map((d) => `${ds1.objects[d.index].id} = ${d.name}`))].join(', ')}`,
      detail: `The game reads an object id of 150 or more as the objects.txt row id − 150 itself, in any act (not as the next act’s object), and these rows are ones the game runs code for${serious ? ': a stray Town portal or Cairn Stone can break warps or crash the game' : ' (players can click them)'}. Check each is the object you meant; a later act’s object is placed as 150 + its objects.txt row, an earlier act’s with a negative id.`,
      cells: at(group.map((d) => d.index)),
    });
  }
  const modObjects = await modArchiveTable(gd.fs, 'objects.txt');
  if (modObjects && !modObjects.inUse) {
    const loose = looseOnlyRows(ds1.objects, rowOf, objTable, objectRows(modObjects.table));
    if (loose.length) {
      const rows = [...new Map(loose.map((l) => [l.row, l])).values()];
      out.push({
        severity: 'warning',
        area: 'Objects',
        title: `${loose.length} object${loose.length === 1 ? ' uses an objects.txt row' : 's use objects.txt rows'} only the loose objects.txt has`,
        detail: `${rows.map((l) => `row ${l.row} "${l.loose}" (${l.archived ? `"${l.archived}" in ${modObjects.label}` : `not in ${modObjects.label}`})`).join('; ')}. Seen in PD2: the game used the objects.txt inside ${modObjects.label} and ignored the loose one, so objects on such rows showed junk graphics or crashed the game. Use rows ${modObjects.label}'s table has, or test in game.`,
        cells: at(loose.map((l) => l.index)),
        columns: [{ table: 'objects', col: 'Token' }],
      });
    }
  }
  const pads = unpairedPads(ds1.objects, rowOf, objTable);
  if (pads.length)
    out.push({
      severity: 'warning',
      area: 'Objects',
      title: `${pads.length} teleport pad${pads.length === 1 ? ' has' : 's have'} no partner nearby`,
      detail: 'A teleportation pad (objects.txt OperateFn 27) takes players to another pad of the same row in its own 8×8 room or a touching one (40 sub-tiles). Place its partner within that range.',
      cells: at(pads),
    });

  // Names shown on hover: an objects.txt Name whose string is missing or only spaces shows as an empty box in game.
  const nameKeys = ds1.objects.filter((o) => o.type === 2).map((o) => gd.objectNameKey(ds1.act, o.type, o.id)).filter((k): k is string => !!k);
  if (nameKeys.length) {
    const blanks = blankObjectNames(await readStringTables(gd.fs), nameKeys);
    if (blanks.length) {
      const write = await nameStringsWrite(gd.fs, Object.fromEntries(blanks.map((b) => [b.key, b.suggested])));
      out.push({
        severity: 'warning',
        area: 'Objects',
        title: `${blanks.length === 1 ? 'An object shows' : `${blanks.length} kinds of object show`} an empty name box in game: ${blanks.map((b) => `"${b.key}"`).join(', ')}`,
        detail: `Pointing at ${blanks.length === 1 ? 'it' : 'them'} shows a box with no text: the name's string ${blanks.every((b) => b.blank) ? 'is only spaces' : 'is missing or blank'} in the game's string tables (objects.txt Name is looked up in patchstring.tbl, expansionstring.tbl, then string.tbl). The guild objects Blizzard cut (Guild Vault, Steeg Stone) are like this. Adding the names to your mod's patchstring.tbl fixes it; edit the text there afterwards if you want other names.`,
        columns: [{ table: 'objects', col: 'Name' }],
        fixes: write ? [{ kind: 'table-write', label: `Add ${blanks.map((b) => `"${b.suggested}"`).join(', ')} to patchstring.tbl`, writes: [write] }] : undefined,
      });
    }
  }

  // --- Monster spawning: rooms made no-spawn (region seeds with a hidden floor 1) that still have spawning regions ----
  const partly = partlyNoSpawnRooms(ds1);
  if (partly.length) {
    const logicals = prestRow ? Number(prestRow['Logicals']) === 1 : null;
    out.push({
      severity: 'warning',
      area: 'Map',
      title: `${partly.length} room${partly.length === 1 ? ' is' : 's are'} only partly no-spawn: monsters can still spawn in ${partly.reduce((n, p) => n + p.open.length, 0)} region${partly.reduce((n, p) => n + p.open.length, 0) === 1 ? '' : 's'}`,
      detail: `${partly
        .slice(0, 12)
        .map((p) => `room ${p.rr.room.x0},${p.rr.room.y0}: seeds ${p.open.map((r) => `${r.seed.x},${r.seed.y}`).join(' ')}`)
        .join('; ')}${partly.length > 12 ? '; …' : ''}. Each 8×8 room is split into regions by the first wall layer; a region gets no random monsters only when its first cell (seed) has a hidden floor1 tile. Some regions of these rooms have one, these don't: give every region seed of the room a hidden floor1 tile to make the whole room no-spawn.${logicals === false ? ' Also, the map’s LvlPrest row has Logicals 0, so the game doesn’t use regions at all: set Logicals to 1.' : ''}`,
      cells: partly.flatMap((p) => p.open.map((r) => r.seed)),
      columns: logicals === false ? [{ table: 'LvlPrest', col: 'Logicals' }] : undefined,
    });
  }

  // --- Automap ------------------------------------------------------------------------------------------------------
  const automapDoc = await loadTable(gd.fs, 'AutoMap.txt');
  const amTable = automapDoc ? parseAutomap(automapDoc) : null;
  let noEntries = false;
  if (automapDoc) {
    // Rows with no picture (Cel1 -1 or empty after a -1 clear) stop the game while it loads AutoMap.txt.
    let bad: number[] = [];
    try {
      bad = invalidAutomapRows(automapDoc);
    } catch {
      bad = [];
    }
    if (bad.length) {
      const drop = new Set(bad);
      const fixed = { ...automapDoc, rows: automapDoc.rows.filter((_, i) => !drop.has(i)) };
      out.push({
        severity: 'error',
        area: 'Tables',
        title: `AutoMap.txt has ${bad.length} rule${bad.length === 1 ? '' : 's'} with no picture (Cel1 -1): the game crashes while loading`,
        detail: `Line${bad.length === 1 ? '' : 's'} ${bad.slice(0, 12).map((i) => i + 2).join(', ')}${bad.length > 12 ? '…' : ''}. The game's automap loader needs a picture in Cel1 of every rule, so a row whose Cel1 is -1 stops it at start-up. Removing those rows leaves those tiles with no automap piece, which is what they were meant to have. Earlier versions of DS1 Studio's "Clear piece" wrote such rows.`,
        columns: [{ table: 'AutoMap', col: 'Cel1' }],
        fixes: [
          {
            kind: 'table-write',
            label: `Remove the ${bad.length} row${bad.length === 1 ? '' : 's'} (AutoMap.txt is backed up first)`,
            writes: [{ table: 'AutoMap.txt', path: 'data/global/excel/AutoMap.txt', bytes: serializeTxtTable(fixed), summary: [`removed ${bad.length} row${bad.length === 1 ? '' : 's'} with Cel1 -1`] }],
          },
          { kind: 'open-table', label: 'Open AutoMap.txt', table: 'AutoMap.txt' },
        ],
      });
    }
  }
  if (amTable) {
    const unknown = unknownAutomapLevels(amTable);
    if (unknown.length)
      out.push({
        severity: 'warning',
        area: 'Tables',
        title: `AutoMap.txt names level${unknown.length === 1 ? '' : 's'} the game doesn't know: ${unknown.slice(0, 4).map((u) => `"${u}"`).join(', ')}`,
        detail: `The game only accepts its own ${GAME_AUTOMAP_LEVELS.length} automap level names ("1 Town" … "5 Lava"), and mods like PD2 also a level type's number ("47"). An unknown name stops the game with an error at start-up. Rename those rows to the level type's number (Map panel: Level type).`,
        columns: [{ table: 'AutoMap', col: 'LevelName' }],
        fixes: [{ kind: 'open-table', label: 'Open AutoMap.txt', table: 'AutoMap.txt' }],
      });
    const type = map.resolution.lvlType;
    const level = type ? automapLevelFor(amTable, type.name, ds1.act + 1, type.id) : null;
    if (type && level && !amTable.doc.rows.some((r) => (r[0] ?? '').trim() === level)) {
      noEntries = true;
      out.push({
        severity: 'warning',
        area: 'Map',
        title: `This level type (${type.id} "${type.name}") has no automap entries, so the automap stays empty here`,
        detail: `AutoMap.txt gives each tile of a level type the piece the automap draws for it, under the level type's number ("${level}"). This one has none yet. In the automap editor, "Select missing" then "Suggest" picks pieces for every tile from look-alike tiles the game already maps; save to add them.`,
        columns: [{ table: 'AutoMap', col: 'LevelName' }],
        fixes: [{ kind: 'automap-editor', label: 'Open the automap editor (then Suggest)' }],
      });
    } else if (type && !level && type.id >= GAME_AUTOMAP_LEVELS.length)
      out.push({
        severity: 'info',
        area: 'Map',
        title: `The automap can't show this level type (${type.id} "${type.name}")`,
        detail: `The game only knows automap entries for its own ${GAME_AUTOMAP_LEVELS.length} level types. Mods like PD2 read a level type's number too; this install's AutoMap.txt doesn't use numbers, so it probably doesn't.`,
      });
  }
  if (automap && !noEntries) {
    const missingWalls = automap.pieces.filter((p) => p.layer === 'wall' && !p.rule);
    if (missingWalls.length)
      out.push({
        severity: 'info',
        area: 'Map',
        title: `${missingWalls.length} walls have no automap entry`,
        detail: 'They will not show on the in-game automap. Give them pieces, or mark them hidden if they should not show.',
        cells: missingWalls.map((p) => ({ x: p.cellX, y: p.cellY })),
        fixes: [{ kind: 'automap-editor', label: 'Open the automap editor' }],
      });
  }

  // --- Compiled tables ---------------------------------------------------------------------------------------------
  const compiled = ['LvlPrest', 'Levels', 'LvlTypes'].filter((name) => {
    const txt = gd.fs.locate(`data/global/excel/${name}.txt`);
    return txt && txt === gd.fs.locate(`data/global/excel/${name}.bin`);
  });
  if (compiled.length)
    out.push({
      severity: 'info',
      area: 'Tables',
      title: `Compiled .bin files sit next to ${compiled.join(', ')}.txt`,
      detail: 'The game reads the .bin files. After editing the .txt tables, start the game once with -direct -txt (or run your mod’s tool) so the .bin files are rebuilt.',
    });

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2, ok: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
