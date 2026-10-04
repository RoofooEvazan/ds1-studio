import { colIndex, getCell, serializeTxtTable, setCell, type TxtTableDoc } from '../formats/txtTable';
import { normalizePath } from '../vfs/vfs';
import { ensureTypeSlots, maskFor, maskOf, type TableWrite } from './levelTables';

/**
 * "Add to game": the table rows that make the game load a map. The rules come from the game's own table loaders and
 * level builder (D2Common, as reimplemented by D2MOO) and are checked against the vanilla tables (test/addToGame.test):
 *
 * - Levels.txt, LvlPrest.txt and LvlTypes.txt are read by row position: a level's Id, a preset's Def and a level
 *   type's Id must equal the row's index, counting data rows only (the "Expansion" separator row and blank lines are
 *   skipped). So rows are only ever appended, never inserted.
 * - A preset level (Levels DrlgType 2) uses the FIRST LvlPrest row whose LevelId is the level; a second row is ignored.
 *   The game then loads that preset by its Def.
 * - The act comes from the level Id, not the Act column: from 109 on it is Act 5. New levels go at the end, so they
 *   are Act 5 levels (Act = 4). Pal picks the palette, so tiles drawn for another act keep their colours (the game's
 *   own Act 5 levels 133-136 reuse Act 1, 2 and 4 tiles with Pal 0, 1 and 3).
 * - The level's size is Levels SizeX/SizeY (per difficulty) = the DS1's size minus one; LvlPrest SizeX/SizeY stay 0 so
 *   the preset fills the level. OffsetX/OffsetY place it in the act's world and must not overlap other levels.
 * - LvlPrest / LvlTypes file paths are copied with DATA\GLOBAL\TILES\ in front into a 60-byte buffer: at most 41
 *   characters (the game's longest is 40).
 */

const EXCEL = 'data/global/excel/';
export const MAX_TILE_PATH = 41;
export const MAX_LEVEL_STRING = 39;

const num = (s: string) => Number(s) || 0;

/**
 * Levels.txt Layer (automap layer): 100 is the highest the game takes (a level with 101 or 102 crashes it as players
 * arrive, checked in PD2; 100 loads). The game's own levels use 0-99; PD2's maps all share 98.
 */
export const MAX_LAYER = 100;
/** A layer for a new level: the one most mod-added preset levels share (PD2's maps: 98), else 98. */
export function safeLayer(levels: TxtTableDoc): number {
  const count = new Map<number, number>();
  for (const r of dataRows(levels)) {
    const l = num(getCell(levels, r, 'Layer'));
    if (num(getCell(levels, r, 'Id')) >= 137 && num(getCell(levels, r, 'DrlgType')) === 2 && l <= MAX_LAYER) count.set(l, (count.get(l) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 98;
}
const has = (doc: TxtTableDoc, col: string) => colIndex(doc, col) >= 0;

/** Rows the game compiles into records: not blank and not the "Expansion" separator. */
export function dataRows(doc: TxtTableDoc): number[] {
  return doc.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => c.trim() !== '') && (r[0] ?? '').trim().toLowerCase() !== 'expansion').map(({ i }) => i);
}

/** Row index (in doc.rows) of the record with the given index, or -1. */
export const rowOfRecord = (doc: TxtTableDoc, record: number) => dataRows(doc)[record] ?? -1;

/** Appends a record: before trailing blank lines, so it stays a record (its index = the old record count). */
export function appendAt(doc: TxtTableDoc, values: Record<string, string>): { doc: TxtTableDoc; row: number } {
  let at = doc.rows.length;
  while (at > 0 && !doc.rows[at - 1].some((c) => c.trim() !== '')) at--;
  const row = new Array<string>(doc.columns.length).fill('');
  for (const [k, v] of Object.entries(values)) {
    const c = colIndex(doc, k);
    if (c >= 0) row[c] = v;
  }
  const rows = doc.rows.slice();
  rows.splice(at, 0, row);
  return { doc: { ...doc, rows }, row: at };
}

/** A tile path the game can hold (see MAX_TILE_PATH); null when fine. */
export function tilePathProblem(rel: string): string | null {
  return rel.length > MAX_TILE_PATH
    ? `"${rel}" is ${rel.length} characters. The game copies tile paths into a 60-byte buffer after DATA\\GLOBAL\\TILES\\, so it holds at most ${MAX_TILE_PATH}: a longer one can crash the game or fail to load. Use shorter folder or file names.`
    : null;
}

/** The game's towns (the only levels whose LvlPrest AutoMap is 1). */
export const TOWNS = new Set([1, 40, 75, 103, 109]);

/**
 * Levels EntryFile is the loading-screen image shown while a level is entered: Act 5 levels (109 on, which is every
 * added level) load data/local/ui/<language>/expansion/<EntryFile>.dc6. A missing or empty one halts D2CMP on the
 * loading screen ("Error opening file: DATA\LOCAL\UI\ENG\EXPANSION\.dc6", then an access violation reading it).
 */
export const ENTRY_IMAGE_DIR = 'data/local/ui/eng/expansion/';
export const DEFAULT_ENTRY_FILE = 'A5L1';

export const levelAct = (id: number) => (id >= 109 ? 4 : id >= 103 ? 3 : id >= 75 ? 2 : id >= 40 ? 1 : 0);

export interface FieldChange {
  table: string;
  /** Row label, e.g. `Level 137 "My Map"`. */
  row: string;
  column: string;
  from: string;
  to: string;
  why?: string;
}

export interface AddToGameInput {
  mode: 'new' | 'existing';
  /** new: the level to copy settings from; existing: the preset level that should use this map. */
  levelId: number;
  name: string;
  /** Map path relative to data/global/tiles, with its own capitals. */
  mapRel: string;
  /** DS1 size as DS1 Studio reads it (the file stores one less). */
  width: number;
  height: number;
  /** Full paths (data/global/tiles/...) of the DT1s the map's tiles come from. */
  usedDt1s: string[];
  /** Roof hide areas in the map. */
  popCount: number;
  /** new: the act whose palette the level uses (0-4); default: the act of the template's tiles. */
  palAct?: number;
  /** A level type of its own even when the template's type already lists every tile library the map uses. */
  newType?: boolean;
}

export interface AddToGamePlan {
  writes: TableWrite[];
  changes: FieldChange[];
  warnings: string[];
  newLevelId?: number;
}

/** The act (0-4) a level type's tiles belong to (LvlTypes Act is 1-5). */
export function typeAct(types: TxtTableDoc, typeId: number): number | null {
  const row = rowOfRecord(types, typeId);
  const act = row >= 0 ? num(getCell(types, row, 'Act')) : 0;
  return act >= 1 && act <= 5 ? act - 1 : null;
}

/** Rows of the levels other than `except` whose LevelType is `typeId`. */
export function levelsOfType(levels: TxtTableDoc, typeId: number, except = -1): number[] {
  return dataRows(levels).filter((r) => num(getCell(levels, r, 'LevelType')) === typeId && num(getCell(levels, r, 'Id')) !== except);
}

/**
 * A level type of the map's own, appended as the next record: File 1… are `dt1s` (full or tiles-relative paths), every
 * other column (Act, Expansion…) is copied from `fromRow`. Used instead of adding a map's tile libraries to a level type
 * other levels use, whose tile list then stays theirs.
 */
export function appendOwnType(types: TxtTableDoc, fromRow: number, name: string, dt1s: string[]): { types: TxtTableDoc; typeRow: number; typeId: number; slots: Map<string, number> } {
  const files = [...new Map(dt1s.map((p) => [normalizePath(p.replace(/^\/?data\/global\/tiles\//i, '')), p.replace(/\\/g, '/').replace(/^\/?data\/global\/tiles\//i, '')])).values()];
  if (files.length > 32) throw new Error(`The map uses ${files.length} tile libraries; a level type holds at most 32.`);
  const typeId = dataRows(types).length;
  const values = Object.fromEntries(types.columns.map((c, i) => [c, types.rows[fromRow][i] ?? ''])) as Record<string, string>;
  values.Name = name;
  values.Id = String(typeId);
  const slots = new Map<string, number>();
  for (let i = 1; i <= 32; i++) if (has(types, `File ${i}`)) values[`File ${i}`] = files[i - 1] ?? '0';
  files.forEach((f, i) => slots.set(normalizePath(`data/global/tiles/${f}`), i + 1));
  const appended = appendAt(types, values);
  return { types: appended.doc, typeRow: appended.row, typeId, slots };
}

/**
 * How far out a level can sit in its act's world. D2Client keeps automap positions in 16 bits: a unit's marker is at
 * its isometric position ((x - y) * 16, (x + y) * 8 in sub-tiles) / 10, and it halts ("Unrecoverable internal error",
 * D2Client automap line 965-967) when that leaves -32768…32767. In tiles: |x - y| ≤ 4095 and x + y ≤ 8191, for every
 * corner of the level. The game's and PD2's own levels stay inside (PD2's farthest: x - y 4043, x + y 8098).
 */
export const AUTOMAP_MAX_DIFF = 4095;
export const AUTOMAP_MAX_SUM = 8191;

/** Whether a level at (x, y) sized w×h tiles stays inside the automap's range (less `margin` tiles). */
export function automapFits(x: number, y: number, w: number, h: number, margin = 0): boolean {
  return x >= 0 && y >= 0 && x + w - y <= AUTOMAP_MAX_DIFF - margin && y + h - x <= AUTOMAP_MAX_DIFF - margin && x + w + y + h <= AUTOMAP_MAX_SUM - margin;
}

/** A level's fixed place in its act's world (Levels OffsetX/OffsetY and its largest size), or null when placed by the game. */
function levelBox(levels: TxtTableDoc, row: number): { x: number; y: number; w: number; h: number } | null {
  const x = num(getCell(levels, row, 'OffsetX'));
  const y = num(getCell(levels, row, 'OffsetY'));
  const w = Math.max(...['SizeX', 'SizeX(N)', 'SizeX(H)'].map((c) => num(getCell(levels, row, c))));
  const h = Math.max(...['SizeY', 'SizeY(N)', 'SizeY(H)'].map((c) => num(getCell(levels, row, c))));
  return x >= 0 && y >= 0 && !num(getCell(levels, row, 'Depend')) && w > 0 ? { x, y, w, h } : null;
}

/**
 * Suggested world position for a level of `size` in an act: clear of every other level there (by 100 tiles) and
 * 100 tiles inside the automap's range (no farther out than PD2's own levels), as far out as that allows, like the game's own extra levels. `except` is the level's own
 * row when moving it.
 */
export function freeOffset(levels: TxtTableDoc, act: number, size: { w: number; h: number } = { w: 200, h: 200 }, except = -1): { x: number; y: number } {
  const gap = 100;
  const boxes = dataRows(levels)
    .filter((r) => r !== except && levelAct(num(getCell(levels, r, 'Id'))) === act)
    .map((r) => levelBox(levels, r))
    .filter((b): b is NonNullable<typeof b> => !!b);
  let best: { x: number; y: number } | null = null;
  for (let y = 0; y <= AUTOMAP_MAX_SUM; y += 50)
    for (let x = 0; x <= AUTOMAP_MAX_SUM; x += 50) {
      if (!automapFits(x, y, size.w, size.h, 100)) continue;
      if (boxes.some((b) => x < b.x + b.w + gap && b.x < x + size.w + gap && y < b.y + b.h + gap && b.y < y + size.h + gap)) continue;
      if (!best || x + y > best.x + best.y || (x + y === best.x + best.y && x > best.x)) best = { x, y };
    }
  return best ?? { x: 1000, y: 1000 };
}

export function planAddToGame(tables: { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc }, input: AddToGameInput): AddToGamePlan | string {
  let { prest, levels, types } = tables;
  const changes: FieldChange[] = [];
  const warnings: string[] = [];
  const touched = new Set<string>();
  const set = (table: 'Levels.txt' | 'LvlPrest.txt' | 'LvlTypes.txt', row: number, rowLabel: string, column: string, to: string, why?: string) => {
    const doc = table === 'Levels.txt' ? levels : table === 'LvlPrest.txt' ? prest : types;
    if (!has(doc, column)) return;
    const from = getCell(doc, row, column);
    if (from === to) return;
    const next = setCell(doc, row, column, to);
    if (table === 'Levels.txt') levels = next;
    else if (table === 'LvlPrest.txt') prest = next;
    else types = next;
    changes.push({ table, row: rowLabel, column, from, to, why });
    touched.add(table);
  };

  const name = input.name.trim();
  if (!name) return 'Give the level a name.';
  const pathIssue = tilePathProblem(input.mapRel);
  if (pathIssue) return pathIssue;
  // The tables must already follow the one-record-per-row rule, or every Id we'd write would be off.
  for (const [t, doc, col] of [
    ['Levels.txt', levels, 'Id'],
    ['LvlPrest.txt', prest, 'Def'],
    ['LvlTypes.txt', types, 'Id'],
  ] as const) {
    const bad = dataRows(doc).findIndex((r, i) => getCell(doc, r, col).trim() !== String(i));
    if (bad >= 0) return `${t}: record ${bad} has ${col} ${getCell(doc, dataRows(doc)[bad], col) || '(empty)'}. The game reads these tables by row position, so ${col} must count up 0, 1, 2… Use the fix above to put the rows back in order.`;
  }

  const levelRow = rowOfRecord(levels, input.levelId);
  if (levelRow < 0) return 'Pick a level.';
  const levelName = (id: number) => getCell(levels, rowOfRecord(levels, id), 'Name');
  let typeId = num(getCell(levels, levelRow, 'LevelType'));
  let typeRow = rowOfRecord(types, typeId);
  if (typeRow < 0) return `LvlTypes.txt has no level type ${typeId}.`;
  let typeName = getCell(types, typeRow, 'Name');
  const sizeX = String(input.width - 1);
  const sizeY = String(input.height - 1);

  // Tile libraries: every DT1 the map uses in the level type's File slots (path limit checked).
  for (const p of input.usedDt1s) {
    const rel = p.replace(/^data\/global\/tiles\//i, '');
    const issue = tilePathProblem(rel);
    if (issue) return `LvlTypes: ${issue}`;
  }
  let slots: Map<string, number>;
  // A level type other levels use keeps its tile list: when the map needs libraries it doesn't have, the map gets a
  // level type of its own (the new level's template, or the existing level, then points at it).
  let ownType = false;
  try {
    const before = types;
    const r = ensureTypeSlots(types, typeRow, input.usedDt1s);
    const sharers = levelsOfType(levels, typeId, input.mode === 'existing' ? input.levelId : -1);
    if ((r.added.length || input.newType) && sharers.length) {
      const own = appendOwnType(types, typeRow, name, input.usedDt1s);
      const users = sharers.map((x) => `${getCell(levels, x, 'Id')} ${getCell(levels, x, 'Name')}`);
      warnings.push(
        `Level type ${typeId} "${typeName}" is also used by ${users.slice(0, 3).join(', ')}${users.length > 3 ? ` and ${users.length - 3} more` : ''}, so the map gets its own level type ${own.typeId} "${name}" with just its ${own.slots.size} tile libraries. The level loses that type's AutoMap.txt entries: add its own with the Automap editor.`,
      );
      changes.push({ table: 'LvlTypes.txt', row: `Type ${own.typeId} "${name}"`, column: '(new row)', from: '', to: `copy of ${typeId} "${typeName}" (Act, Expansion), appended as record ${own.typeId}` });
      for (const s of own.slots.values())
        changes.push({ table: 'LvlTypes.txt', row: `Type ${own.typeId} "${name}"`, column: `File ${s}`, from: '', to: getCell(own.types, own.typeRow, `File ${s}`), why: s === 1 ? 'the tile libraries the map uses' : undefined });
      types = own.types;
      typeRow = own.typeRow;
      typeId = own.typeId;
      typeName = name;
      slots = own.slots;
      ownType = true;
      touched.add('LvlTypes.txt');
    } else {
      types = r.types;
      slots = r.slots;
      for (const a of r.added) {
        const [col, value] = a.split(' = ');
        changes.push({ table: 'LvlTypes.txt', row: `Type ${typeId} "${typeName}"`, column: col, from: getCell(before, typeRow, col), to: value, why: 'a tile library the map uses' });
        touched.add('LvlTypes.txt');
      }
    }
  } catch (e) {
    return (e as Error).message;
  }

  let newLevelId: number | undefined;
  let targetLevel = input.levelId;
  const prestRows = dataRows(prest);

  if (input.mode === 'new') {
    if (num(getCell(levels, levelRow, 'DrlgType')) === 0) return 'Pick a real level to copy from.';
    newLevelId = dataRows(levels).length;
    if (newLevelId >= 1024) return 'Levels.txt already has 1024 levels, the most the game allows.';
    if (newLevelId > 255) warnings.push(`The new level is number ${newLevelId}. Levels.txt's Id column is stored in one byte, so numbers above 255 need a mod that supports them (PD2 does).`);
    // Append a copy of the template, then set everything that makes it its own level.
    const template = levels.rows[levelRow];
    const values = Object.fromEntries(levels.columns.map((c, i) => [c, template[i] ?? ''])) as Record<string, string>;
    const appended = appendAt(levels, values);
    levels = appended.doc;
    const row = appended.row;
    const label = `Level ${newLevelId} "${name}"`;
    changes.push({ table: 'Levels.txt', row: label, column: '(new row)', from: '', to: `copy of ${input.levelId} ${levelName(input.levelId)}, appended as record ${newLevelId}` });
    touched.add('Levels.txt');
    const tilesAct = typeAct(types, typeId) ?? levelAct(input.levelId);
    const pal = input.palAct ?? tilesAct;
    const off = freeOffset(levels, 4, { w: input.width - 1, h: input.height - 1 }, row);
    const shorten = (s: string) => s.slice(0, MAX_LEVEL_STRING);
    if (name.length > MAX_LEVEL_STRING) warnings.push(`The name is cut to ${MAX_LEVEL_STRING} characters in LevelName/LevelWarp (the game's limit).`);
    set('Levels.txt', row, label, 'Name', name);
    set('Levels.txt', row, label, 'Id', String(newLevelId), 'its row number: the game reads Levels.txt by row');
    set('Levels.txt', row, label, 'Act', '4', 'levels from 109 on are Act 5 in the game');
    set('Levels.txt', row, label, 'Pal', String(pal), `the palette of the act the tiles were drawn for (${typeName})`);
    set('Levels.txt', row, label, 'QuestFlag', '', 'no quest needed to enter');
    set('Levels.txt', row, label, 'QuestFlagEx', '', 'no quest needed to enter');
    set('Levels.txt', row, label, 'Quest', '');
    // Layer (the automap layer) stays the template's, as PD2's own maps all share one (98): counting up past 100
    // crashes the game as players arrive (confirmed in PD2: 101 and 102 crashed, set back to 98 they load).
    if (num(getCell(levels, row, 'Layer')) > MAX_LAYER) set('Levels.txt', row, label, 'Layer', String(safeLayer(levels)), `the game's levels use 0-${MAX_LAYER}`);
    for (const s of ['', '(N)', '(H)']) {
      set('Levels.txt', row, label, `SizeX${s}`, sizeX, 'the map is one cell bigger than the level');
      set('Levels.txt', row, label, `SizeY${s}`, sizeY, 'the map is one cell bigger than the level');
    }
    set('Levels.txt', row, label, 'OffsetX', String(off.x), "a free spot in Act 5, away from the other levels and inside the automap's range");
    set('Levels.txt', row, label, 'OffsetY', String(off.y));
    set('Levels.txt', row, label, 'Depend', '0');
    set('Levels.txt', row, label, 'DrlgType', '2', 'a preset level: its map comes from LvlPrest');
    if (ownType) set('Levels.txt', row, label, 'LevelType', String(typeId), 'its own level type (see LvlTypes)');
    for (let i = 0; i < 8; i++) {
      set('Levels.txt', row, label, `Vis${i}`, '0', i === 0 ? 'no links yet (see Warps)' : undefined);
      set('Levels.txt', row, label, `Warp${i}`, '-1');
    }
    set('Levels.txt', row, label, 'Waypoint', '255', 'no waypoint');
    set('Levels.txt', row, label, 'LevelName', shorten(name));
    set('Levels.txt', row, label, 'LevelWarp', shorten(name));
    // EntryFile names the loading-screen image (not a string): keep the template's when it is an Act 5 level's, whose
    // images are where an Act 5 level looks; otherwise use Harrogath's, which every game install has.
    const entry = getCell(levels, row, 'EntryFile').trim();
    if (levelAct(input.levelId) !== 4 || !entry) set('Levels.txt', row, label, 'EntryFile', DEFAULT_ENTRY_FILE, `the loading screen (${ENTRY_IMAGE_DIR}${DEFAULT_ENTRY_FILE}.dc6, Harrogath's)`);
    targetLevel = newLevelId;
    if (pal !== 4)
      warnings.push(
        `The level is in Act 5 but uses the ${['Act 1', 'Act 2', 'Act 3', 'Act 4', 'Act 5'][pal]} palette (Pal ${pal}), because ${typeName}'s tiles were drawn for that act. In PD2, new levels in the Act 5 slot were seen drawn with the Act 5 palette whatever Pal said: if the tiles show bright green, blue or red specks in game, convert them to the Act 5 palette.`,
      );
  } else {
    if (num(getCell(levels, levelRow, 'DrlgType')) !== 2)
      return `${levelName(input.levelId)} is built at random (DrlgType ${getCell(levels, levelRow, 'DrlgType')}), not from one map, so it can't use this map. Make a new level instead.`;
    const cur = [num(getCell(levels, levelRow, 'SizeX')), num(getCell(levels, levelRow, 'SizeY'))];
    if (cur[0] !== input.width - 1 || cur[1] !== input.height - 1) {
      const label = `Level ${input.levelId} "${levelName(input.levelId)}"`;
      for (const s of ['', '(N)', '(H)']) {
        set('Levels.txt', levelRow, label, `SizeX${s}`, sizeX, 'the map is one cell bigger than the level');
        set('Levels.txt', levelRow, label, `SizeY${s}`, sizeY);
      }
      warnings.push(`The level's size changes from ${cur[0]}×${cur[1]} to ${sizeX}×${sizeY}. If it grows, check it doesn't overlap a neighbouring level (OffsetX/OffsetY).`);
    }
    if (ownType) set('Levels.txt', levelRow, `Level ${input.levelId} "${levelName(input.levelId)}"`, 'LevelType', String(typeId), 'its own level type (see LvlTypes)');
  }

  // LvlPrest: the level's claiming row (existing) or a new one (new level). Def = record number.
  const claiming = prestRows.find((r) => num(getCell(prest, r, 'LevelId')) === targetLevel && getCell(prest, r, 'Def').trim() !== '');
  let pRow: number;
  let pLabel: string;
  if (input.mode === 'existing' && claiming !== undefined) {
    pRow = claiming;
    pLabel = `Preset ${getCell(prest, pRow, 'Def')} "${getCell(prest, pRow, 'Name')}"`;
    const files = [1, 2, 3, 4, 5, 6].map((i) => getCell(prest, pRow, `File${i}`)).filter((f) => f && f !== '0');
    const listed = files.some((f) => normalizePath(f) === normalizePath(input.mapRel));
    if (!listed) {
      warnings.push(`${levelName(targetLevel)} will use this map instead of ${files.join(', ') || 'its current map'} (that's the preset row the game reads for it).`);
      set('LvlPrest.txt', pRow, pLabel, 'File1', input.mapRel, 'the level now loads this map');
      for (let i = 2; i <= 6; i++) set('LvlPrest.txt', pRow, pLabel, `File${i}`, '0');
      set('LvlPrest.txt', pRow, pLabel, 'Files', '1');
    }
  } else {
    if (input.mode === 'existing') return `No LvlPrest row claims ${levelName(targetLevel)}.`;
    // Flags: from the template level's own preset when it has one, else what the game's whole-level presets use.
    const tpl = prestRows.find((r) => num(getCell(prest, r, 'LevelId')) === input.levelId);
    const flag = (col: string, fallback: string) => (tpl !== undefined ? getCell(prest, tpl, col) || fallback : fallback);
    const def = prestRows.length;
    const outdoors = getCell(levels, levelRow, 'IsInside') === '1' ? '0' : '1';
    const values: Record<string, string> = {
      Name: name,
      Def: String(def),
      LevelId: String(targetLevel),
      Populate: flag('Populate', '1'),
      Logicals: flag('Logicals', '1'),
      Outdoors: flag('Outdoors', outdoors),
      Animate: flag('Animate', '0'),
      KillEdge: flag('KillEdge', '1'),
      FillBlanks: '1',
      SizeX: '0',
      SizeY: '0',
      AutoMap: '0',
      Scan: '1',
      Pops: '0',
      PopPad: '0',
      Files: '1',
      File1: input.mapRel,
      File2: '0',
      File3: '0',
      File4: '0',
      File5: '0',
      File6: '0',
      Dt1Mask: '0',
      Beta: '0',
      Expansion: '1',
    };
    const appended = appendAt(prest, values);
    prest = appended.doc;
    pRow = appended.row;
    pLabel = `Preset ${def} "${name}"`;
    changes.push({ table: 'LvlPrest.txt', row: pLabel, column: '(new row)', from: '', to: `record ${def} for level ${targetLevel}` });
    for (const [k, v] of Object.entries(values))
      if (has(prest, k))
        changes.push({
          table: 'LvlPrest.txt',
          row: pLabel,
          column: k,
          from: '',
          to: v,
          why: {
            Def: 'its row number: the game loads presets by Def',
            LevelId: 'the level it builds',
            FillBlanks: 'as every game preset level',
            SizeX: '0 = fill the level',
            AutoMap: '1 would reveal the whole automap on entry (towns)',
            Scan: 'finds warps and special tiles',
            Files: 'one map',
            Expansion: 'an Act 5 level',
            Populate: tpl !== undefined ? 'as the template level' : 'spawn monsters',
          }[k],
        });
    touched.add('LvlPrest.txt');
  }

  // Dt1Mask and hide areas on the preset row.
  const oldMask = num(getCell(prest, pRow, 'Dt1Mask')) >>> 0;
  const mask = input.mode === 'new' || ownType ? maskOf(slots) : maskFor(types, typeRow, input.usedDt1s, oldMask);
  set('LvlPrest.txt', pRow, pLabel, 'Dt1Mask', String(mask >>> 0), `LvlTypes "${typeName}" File slots ${[...slots.values()].sort((a, b) => a - b).join(', ')}`);
  if (input.popCount > num(getCell(prest, pRow, 'Pops'))) {
    set('LvlPrest.txt', pRow, pLabel, 'Pops', String(input.popCount), 'the map\'s roof hide areas');
    if (!getCell(prest, pRow, 'PopPad') || getCell(prest, pRow, 'PopPad') === '0') set('LvlPrest.txt', pRow, pLabel, 'PopPad', '-4', 'as the game\'s houses');
  }

  const writes: TableWrite[] = [];
  for (const [t, doc] of [
    ['LvlPrest.txt', prest],
    ['Levels.txt', levels],
    ['LvlTypes.txt', types],
  ] as const)
    if (touched.has(t))
      writes.push({
        table: t,
        path: `${EXCEL}${t}`,
        bytes: serializeTxtTable(doc),
        summary: changes.filter((c) => c.table === t).map((c) => `${c.row}: ${c.column} ${c.from || '(empty)'} → ${c.to}${c.why ? ` (${c.why})` : ''}`),
      });
  return { writes, changes, warnings, newLevelId };
}

export interface TableIssue {
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
  columns?: { table: string; col: string }[];
  /** A safe one-click fix: the table(s) as they should be. */
  fix?: TableFix;
  /** A question the map maker answers once: this answer ("keep it as it is") is remembered under `key`. */
  keep?: { key: string; label: string };
  /** A tile path (relative to data/global/tiles) too long for the game: the check offers to rename it. */
  longPath?: string;
}

/** Quest names by the number Levels.txt's QuestFlag uses (the game's quest state ids). */
export const QUEST_NAMES: Record<number, string> = {
  1: 'Den of Evil', 2: "Sisters' Burial Grounds", 3: 'Tools of the Trade', 4: 'The Search for Cain', 5: 'The Forgotten Tower', 6: 'Sisters to the Slaughter (Andariel)',
  9: "Radament's Lair", 10: 'The Horadric Staff', 11: 'The Tainted Sun', 12: 'The Arcane Sanctuary', 13: 'The Summoner', 14: 'The Seven Tombs (Duriel)',
  17: "Lam Esen's Tome", 18: "Khalim's Will", 19: 'The Blade of the Old Religion', 20: 'The Golden Bird', 21: 'The Blackened Temple', 22: 'The Guardian (Mephisto)',
  25: 'The Fallen Angel', 26: "Terror's End (Diablo)", 27: "Hell's Forge",
  35: 'Siege on Harrogath', 36: 'Rescue on Mount Arreat', 37: 'Prison of Ice', 38: 'Betrayal of Harrogath', 39: 'Rite of Passage (the Ancients)', 40: 'Eve of Destruction (Baal)',
};

export interface TableFix {
  label: string;
  writes: TableWrite[];
}

type TableName = 'Levels.txt' | 'LvlPrest.txt' | 'LvlTypes.txt';

/** A fix that sets cells of one table. */
export function cellFix(table: TableName, doc: TxtTableDoc, label: string, cells: { row: number; col: string; value: string }[]): TableFix {
  let d = doc;
  const summary: string[] = [];
  for (const c of cells) {
    if (!has(d, c.col) || getCell(d, c.row, c.col) === c.value) continue;
    summary.push(`"${getCell(d, c.row, 'Name')}": ${c.col} ${getCell(d, c.row, c.col) || '(empty)'} → ${c.value}`);
    d = setCell(d, c.row, c.col, c.value);
  }
  return { label, writes: [{ table, path: `${EXCEL}${table}`, bytes: serializeTxtTable(d), summary }] };
}

/**
 * Puts a table's rows back in Id/Def order, when that is all that's wrong: every number 0…n-1 is there exactly once, so
 * no Id changes and nothing that refers to one breaks. The "Expansion" line and blank lines stay where they are.
 * null = already in order; a string = why it can't be fixed by reordering.
 */
export function recordOrderFix(table: TableName, doc: TxtTableDoc, col: string): TableFix | string | null {
  const rows = dataRows(doc);
  const ids = rows.map((r) => getCell(doc, r, col).trim());
  if (ids.every((id, i) => id === String(i))) return null;
  const nums = ids.map((id) => (/^\d+$/.test(id) ? Number(id) : NaN));
  const seen = new Set<number>();
  const dupes = nums.filter((n) => !Number.isNaN(n) && (seen.has(n) || !seen.add(n)));
  const missing = rows.map((_, i) => i).filter((i) => !seen.has(i));
  if (nums.some(Number.isNaN) || dupes.length || missing.length)
    return `The ${col}s aren't simply out of order (${[
      nums.some(Number.isNaN) ? 'some are empty or not numbers' : '',
      dupes.length ? `used twice: ${[...new Set(dupes)].slice(0, 5).join(', ')}` : '',
      missing.length ? `missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : '',
    ]
      .filter(Boolean)
      .join('; ')}), so they can't be fixed by moving rows. Fix them in Game → Data tables.`;
  // Records sorted by id; every other line (the "Expansion" separator, blank lines) stays just before the record that
  // followed it, or at the end.
  const isRecord = new Set(rows);
  const before = new Map<number, string[][]>();
  const tail: string[][] = [];
  let pending: string[][] = [];
  doc.rows.forEach((row, i) => {
    if (!isRecord.has(i)) return void pending.push(row);
    if (pending.length) before.set(Number(getCell(doc, i, col)), pending);
    pending = [];
  });
  tail.push(...pending);
  const byId = new Map(rows.map((r) => [Number(getCell(doc, r, col)), doc.rows[r]]));
  const out: string[][] = [];
  for (let i = 0; i < rows.length; i++) out.push(...(before.get(i) ?? []), byId.get(i)!);
  out.push(...tail);
  const moved = rows.filter((r, i) => getCell(doc, r, col).trim() !== String(i));
  const fixed = { ...doc, rows: out };
  const first = rows.findIndex((r, i) => getCell(doc, r, col).trim() !== String(i));
  return {
    label: `Put ${table}'s rows back in ${col} order (${moved.length} rows move, no ${col} changes)`,
    writes: [
      {
        table,
        path: `${EXCEL}${table}`,
        bytes: serializeTxtTable(fixed),
        summary: [`Rows put back in ${col} order from record ${first} (${moved.length} moved); every ${col} stays the same`],
      },
    ],
  };
}

/**
 * Checks that the game's tables load a map the way Add to game sets it up (the rules at the top of this file). Used by
 * the compatibility check and the tests; `ds1` sizes as DS1 Studio reads them.
 */
/**
 * The level-size cells to change after a map is resized: for every whole-level preset built from this map (the first
 * LvlPrest row of its level lists the map, the level is DrlgType 2 and the row's SizeX/SizeY are 0), Levels SizeX/SizeY
 * for all difficulties must be the DS1 size minus one — D2Common halts building the level otherwise (line 2239/2240).
 * null when nothing needs changing.
 */
export function levelSizeFix(tables: { prest: TxtTableDoc; levels: TxtTableDoc }, mapRel: string, ds1: { width: number; height: number }): TableFix | null {
  const { prest, levels } = tables;
  const want = normalizePath(mapRel);
  const cells: { row: number; col: string; value: string }[] = [];
  const names: string[] = [];
  for (const r of dataRows(prest)) {
    if (![1, 2, 3, 4, 5, 6].some((i) => normalizePath(getCell(prest, r, `File${i}`)) === want)) continue;
    if (num(getCell(prest, r, 'SizeX')) || num(getCell(prest, r, 'SizeY'))) continue;
    const levelId = num(getCell(prest, r, 'LevelId'));
    if (!levelId || dataRows(prest).find((x) => num(getCell(prest, x, 'LevelId')) === levelId) !== r) continue;
    const lRow = rowOfRecord(levels, levelId);
    if (lRow < 0 || num(getCell(levels, lRow, 'DrlgType')) !== 2) continue;
    const before = cells.length;
    for (const s of ['', '(N)', '(H)']) {
      for (const [c, v] of [[`SizeX${s}`, ds1.width - 1], [`SizeY${s}`, ds1.height - 1]] as const)
        if (has(levels, c) && num(getCell(levels, lRow, c)) !== v) cells.push({ row: lRow, col: c, value: String(v) });
    }
    if (cells.length > before) names.push(`${levelId} "${getCell(levels, lRow, 'Name')}"`);
  }
  return cells.length ? cellFix('Levels.txt', levels, `Set level ${names.join(', ')} to the map's size ${ds1.width - 1}×${ds1.height - 1}`, cells) : null;
}

export function verifyInGame(
  tables: { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc },
  mapRel: string,
  ds1: { width: number; height: number },
  /** Whether a loading-screen image exists (ENTRY_IMAGE_DIR + name + .dc6); without it only empty EntryFiles are flagged. */
  opts: {
    entryImageExists?: (entryFile: string) => boolean;
    /** Questions already answered "keep it" (TableIssue.keep). */
    kept?: (key: string) => boolean;
    /**
     * The act the level's tiles were drawn for, judged from their art (null: they only use colours every act shares,
     * so any Pal is right). Given, it replaces the level type's Act column as the palette the level should use.
     */
    tilesAct?: number | null;
    /**
     * Whether a level is new to the mod (its Id isn't in the mod's own MPQ copy of Levels.txt). PD2 was seen drawing new
     * levels in the Act 5 slot with the Act 5 palette whatever their Pal said.
     */
    isNewLevel?: (levelId: number) => boolean;
  } = {},
): TableIssue[] {
  const { prest, levels, types } = tables;
  const out: TableIssue[] = [];
  for (const [t, doc, col] of [
    ['Levels', levels, 'Id'],
    ['LvlPrest', prest, 'Def'],
    ['LvlTypes', types, 'Id'],
  ] as const) {
    const rows = dataRows(doc);
    const bad = rows.findIndex((r, i) => getCell(doc, r, col).trim() !== String(i));
    if (bad >= 0) {
      const fix = recordOrderFix(`${t}.txt`, doc, col);
      out.push({
        severity: 'error',
        title: `${t}.txt: row ${bad} has ${col} ${getCell(doc, rows[bad], col) || '(empty)'}, not ${bad}`,
        detail: `The game reads ${t}.txt by row position (the "Expansion" line and blank lines don't count), so ${col} must count up 0, 1, 2… A row inserted or removed shifts every one after it, so the game uses the wrong row for each of them.${typeof fix === 'string' ? ` ${fix}` : ''}`,
        columns: [{ table: t, col }],
        fix: fix && typeof fix !== 'string' ? fix : undefined,
      });
    }
  }
  // Until the rows are in order, every lookup below would read the wrong row.
  if (out.length) return out;
  const want = normalizePath(mapRel);
  const pRows = dataRows(prest).filter((r) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(getCell(prest, r, `File${i}`)) === want));
  for (const r of pRows) {
    const label = `Preset ${getCell(prest, r, 'Def')} "${getCell(prest, r, 'Name')}"`;
    for (let i = 1; i <= 6; i++) {
      const f = getCell(prest, r, `File${i}`);
      const p = f && f !== '0' ? tilePathProblem(f) : null;
      if (p) out.push({ severity: 'error', title: `${label}: File${i} path too long`, detail: p, columns: [{ table: 'LvlPrest', col: `File${i}` }], longPath: f });
    }
    const files = [1, 2, 3, 4, 5, 6].filter((i) => (getCell(prest, r, `File${i}`) || '0') !== '0').length;
    const filesCol = num(getCell(prest, r, 'Files'));
    if (filesCol > files)
      out.push({
        severity: 'error',
        title: `${label}: Files is ${filesCol} but only ${files} File column${files === 1 ? ' is' : 's are'} set`,
        detail: 'The game picks one of the first Files maps at random; an empty one fails to load.',
        columns: [{ table: 'LvlPrest', col: 'Files' }],
        fix: cellFix('LvlPrest.txt', prest, `Set Files to ${files}`, [{ row: r, col: 'Files', value: String(files) }]),
      });
    const levelId = num(getCell(prest, r, 'LevelId'));
    if (!levelId) continue;
    // Every whole-level preset of the game has FillBlanks 1 (fill empty cells); Scan varies (the Monastery has 0).
    const flags = (['FillBlanks'] as const).filter((c) => has(prest, c) && getCell(prest, r, c).trim() !== '1');
    if (flags.length)
      out.push({
        severity: 'warning',
        title: `${label}: ${flags.map((c) => `${c} is ${getCell(prest, r, c).trim() || 'empty'}`).join(', ')}`,
        detail: 'Every preset level of the game has FillBlanks 1 (empty cells of the map are filled in).',
        columns: flags.map((c) => ({ table: 'LvlPrest', col: c })),
        fix: cellFix('LvlPrest.txt', prest, `Set ${flags.join(' and ')} to 1`, flags.map((c) => ({ row: r, col: c, value: '1' }))),
      });
    // AutoMap 1 reveals the whole automap when the level is built — the game does that only for its towns. For other
    // levels it halts D2Client while entering (seen in PD2 1.13c: D2Common InitLevel → D2Client RevealAutomapRoom).
    if (!TOWNS.has(levelId) && getCell(prest, r, 'AutoMap').trim() === '1')
      out.push({
        severity: 'error',
        title: `${label}: AutoMap is 1, so the game crashes when a player enters`,
        detail: 'AutoMap 1 reveals the whole automap as the level is built. The game does that only for its five towns; for any other level it halts while entering (D2Client, while revealing the automap). Every other preset level has AutoMap 0.',
        columns: [{ table: 'LvlPrest', col: 'AutoMap' }],
        fix: cellFix('LvlPrest.txt', prest, 'Set AutoMap to 0', [{ row: r, col: 'AutoMap', value: '0' }]),
      });
    const lRow = rowOfRecord(levels, levelId);
    if (lRow < 0) {
      // A level with the preset's name is probably the one meant.
      const pName = getCell(prest, r, 'Name').trim().toLowerCase();
      const byName = dataRows(levels).find((x) => [getCell(levels, x, 'Name'), getCell(levels, x, 'LevelName')].some((n) => n.trim().toLowerCase() === pName));
      const id = byName !== undefined ? getCell(levels, byName, 'Id') : null;
      out.push({
        severity: 'error',
        title: `${label} builds level ${levelId}, which Levels.txt doesn't have`,
        detail: `Levels.txt has ${dataRows(levels).length} levels (0-${dataRows(levels).length - 1}).${id !== null ? ` Level ${id} "${getCell(levels, byName!, 'Name')}" has this preset's name.` : ''}`,
        columns: [{ table: 'LvlPrest', col: 'LevelId' }],
        fix: id !== null ? cellFix('LvlPrest.txt', prest, `Point it at level ${id} "${getCell(levels, byName!, 'Name')}"`, [{ row: r, col: 'LevelId', value: id }]) : undefined,
      });
      continue;
    }
    const lName = getCell(levels, lRow, 'Name');
    const layer = num(getCell(levels, lRow, 'Layer'));
    if (layer > MAX_LAYER) {
      const to = safeLayer(levels);
      out.push({
        severity: 'error',
        title: `Level ${levelId} "${lName}" has automap Layer ${layer}: the game crashes as players arrive`,
        detail: `Levels.txt Layer is the level's automap layer; the game takes 0-${MAX_LAYER} (its own levels use 0-99, PD2's maps all share 98). A higher one crashes the game the moment a player enters the level. Use the layer the other added levels share.`,
        columns: [{ table: 'Levels', col: 'Layer' }],
        fix: cellFix('Levels.txt', levels, `Set Layer to ${to} (as the other added levels)`, [{ row: lRow, col: 'Layer', value: String(to) }]),
      });
    }
    const drlg = num(getCell(levels, lRow, 'DrlgType'));
    if (drlg !== 2) {
      out.push({
        severity: 'warning',
        title: `${label}: level ${levelId} "${lName}" is built at random (DrlgType ${drlg})`,
        detail: 'Only preset levels (DrlgType 2) load a map from their LvlPrest row; this row is probably not used as a whole level.',
        columns: [{ table: 'Levels', col: 'DrlgType' }],
      });
      continue;
    }
    const first = dataRows(prest).find((x) => num(getCell(prest, x, 'LevelId')) === levelId);
    if (first !== r)
      out.push({
        severity: 'error',
        title: `${label} is ignored: level ${levelId} "${lName}" uses preset ${getCell(prest, first!, 'Def')} "${getCell(prest, first!, 'Name')}"`,
        detail: 'The game builds a preset level from the first LvlPrest row with its LevelId. Point that row at this map, or give this map its own level (Add to game → new level).',
        columns: [{ table: 'LvlPrest', col: 'LevelId' }],
      });
    if (!num(getCell(prest, r, 'SizeX')) || !num(getCell(prest, r, 'SizeY'))) {
      const sizes = ['', '(N)', '(H)'].map((s) => `${num(getCell(levels, lRow, `SizeX${s}`))}×${num(getCell(levels, lRow, `SizeY${s}`))}`);
      const need = `${ds1.width - 1}×${ds1.height - 1}`;
      if (sizes.some((s) => s !== need))
        out.push({
          severity: 'error',
          title: `Level ${levelId} size ${[...new Set(sizes)].join(' / ')} doesn't match the map (${need}): the game crashes building it`,
          detail: 'The level size (Levels SizeX/SizeY, per difficulty) must be the DS1 size minus one, as in every game preset level. D2Common checks it when it builds the level (entering it, or opening a portal to it) and stops the game if it differs. Resizing the map changes the DS1 size; saving it in DS1 Studio updates the level too.',
          columns: [{ table: 'Levels', col: 'SizeX' }],
          fix: cellFix(
            'Levels.txt',
            levels,
            `Set the level size to ${need} (all difficulties)`,
            ['', '(N)', '(H)'].flatMap((s) => [
              { row: lRow, col: `SizeX${s}`, value: String(ds1.width - 1) },
              { row: lRow, col: `SizeY${s}`, value: String(ds1.height - 1) },
            ]),
          ),
        });
    }
    const act = num(getCell(levels, lRow, 'Act'));
    if (act !== levelAct(levelId))
      out.push({
        severity: 'warning',
        title: `Level ${levelId} says Act ${act + 1}, but the game treats it as Act ${levelAct(levelId) + 1}`,
        detail: 'The game takes the act from the level number (1-39 Act 1, 40-74 Act 2, 75-102 Act 3, 103-108 Act 4, 109 and up Act 5), not from the Act column.',
        columns: [{ table: 'Levels', col: 'Act' }],
        fix: cellFix('Levels.txt', levels, `Set Act to ${levelAct(levelId)} (Act ${levelAct(levelId) + 1})`, [{ row: lRow, col: 'Act', value: String(levelAct(levelId)) }]),
      });
    const tilesAct = opts.tilesAct !== undefined ? opts.tilesAct : typeAct(types, num(getCell(levels, lRow, 'LevelType')));
    const pal = num(getCell(levels, lRow, 'Pal'));
    if (levelAct(levelId) === 4 && opts.isNewLevel?.(levelId)) {
      // Observed in PD2: such a level is drawn with the Act 5 palette, so Pal can't make another act's tiles right.
      // Only said when the tiles' art (not the level type's Act column) shows the act they were drawn for.
      const artAct = opts.tilesAct;
      if (artAct !== undefined && artAct !== null && artAct !== 4)
        out.push({
          severity: 'warning',
          title: `Level ${levelId} is a new level in the Act 5 slot, but its tiles are Act ${artAct + 1} tiles`,
          detail: `Seen in PD2: new levels in the Act 5 slot (Ids past the mod's own Levels.txt) were drawn with the Act 5 palette whatever Pal said. Tiles drawn for another act showed bright green, blue and red specks there even with Pal set to that act, and converting the DT1s to the Act 5 palette fixed it. Make this level's tiles for the Act 5 palette (Pal 4).`,
          columns: [{ table: 'Levels', col: 'Pal' }],
        });
    } else if (tilesAct !== null && pal !== tilesAct)
      out.push({
        severity: 'warning',
        title: `Level ${levelId} uses the Act ${pal + 1} palette but its tiles are Act ${tilesAct + 1} tiles`,
        detail: `Pal picks the colours. Tiles drawn for another act show wrong colours (often red or purple). Set Pal to ${tilesAct}, as the game's own Act 5 levels that reuse other acts' tiles do.`,
        columns: [{ table: 'Levels', col: 'Pal' }],
        fix: cellFix('Levels.txt', levels, `Set Pal to ${tilesAct} (Act ${tilesAct + 1} colours)`, [{ row: lRow, col: 'Pal', value: String(tilesAct) }]),
      });
    // A quest the level is locked behind: a question for the map maker, asked once. Every map level of the game's
    // endgame (Worldstone Keep) and of PD2 needs Rite of Passage, so that's the usual answer for a map.
    const quest = num(getCell(levels, lRow, 'QuestFlag'));
    if (quest) {
      const key = `quest:${levelId}:${quest}`;
      const name = QUEST_NAMES[quest] ?? `quest ${quest}`;
      const remove = cellFix('Levels.txt', levels, 'No, remove it (special areas only)', [
        { row: lRow, col: 'QuestFlag', value: '' },
        { row: lRow, col: 'QuestFlagEx', value: '' },
      ]);
      if (opts.kept?.(key))
        out.push({ severity: 'info', title: `Players need ${name} done to enter (you chose to keep this)`, columns: [{ table: 'Levels', col: 'QuestFlag' }], fix: remove });
      else
        out.push({
          severity: 'info',
          title: `Should players have to finish ${name} before entering this map?`,
          detail:
            quest === 39
              ? "The level is locked until a character has beaten the three Ancients on Mount Arreat (the Rite of Passage quest) in that difficulty. The game's own Worldstone Keep and every PD2 map work this way, so for a typical map, keep it. Only remove it for a special area everyone should reach earlier: a town, a guild hall, a meeting place."
              : `The level is locked until a character has finished ${name} in that difficulty (a level copied from another one keeps its requirement). Keep it if that's intended; remove it for an area everyone should reach.`,
          columns: [{ table: 'Levels', col: 'QuestFlag' }],
          fix: remove,
          keep: { key, label: quest === 39 ? 'Yes, keep it (usual for maps)' : 'Yes, keep it' },
        });
    }
    // The loading screen (see ENTRY_IMAGE_DIR): an Act 5 level whose image the game can't open crashes while loading.
    const entry = getCell(levels, lRow, 'EntryFile').trim();
    const noImage = !entry ? 'empty' : opts.entryImageExists && !opts.entryImageExists(entry) ? 'missing' : null;
    if (levelAct(levelId) === 4 && has(levels, 'EntryFile') && noImage)
      out.push({
        severity: 'error',
        title:
          noImage === 'empty'
            ? `Level ${levelId}: EntryFile is empty, so the game crashes on the loading screen`
            : `Level ${levelId}: its loading-screen image ${entry}.dc6 doesn't exist, so the game crashes on the loading screen`,
        detail: `EntryFile is the image shown while the level loads: ${ENTRY_IMAGE_DIR}<EntryFile>.dc6 (not a text string). The game halts when it can't open it. Use an image the game has (Harrogath's is ${DEFAULT_ENTRY_FILE}) or put your own DC6 in that folder.`,
        columns: [{ table: 'Levels', col: 'EntryFile' }],
        fix: cellFix('Levels.txt', levels, `Use Harrogath's loading screen (${DEFAULT_ENTRY_FILE})`, [{ row: lRow, col: 'EntryFile', value: DEFAULT_ENTRY_FILE }]),
      });
    for (const c of ['LevelName', 'LevelWarp', 'EntryFile'])
      if (getCell(levels, lRow, c).length > MAX_LEVEL_STRING)
        out.push({ severity: 'warning', title: `Level ${levelId}: ${c} is longer than ${MAX_LEVEL_STRING} characters (the game cuts it)`, columns: [{ table: 'Levels', col: c }] });
    const me = levelBox(levels, lRow);
    const moveTo = () => freeOffset(levels, levelAct(levelId), me ?? undefined, lRow);
    // Too far out for the automap (see AUTOMAP_MAX_DIFF): the game halts once a unit's automap marker is placed there.
    // Judged by the level's middle, where its players and NPCs are: the Arcane Sanctuary's empty far corner is past the
    // line, and it works.
    const mid = me && { x: me.x + Math.floor(me.w / 2), y: me.y + Math.floor(me.h / 2) };
    if (me && mid && !automapFits(mid.x, mid.y, 0, 0)) {
      const off = moveTo();
      out.push({
        severity: 'error',
        title: `Level ${levelId} is too far out in the act's world (${me.x}, ${me.y}), so the game crashes after a few steps`,
        detail: `The automap stores positions in 16 bits: OffsetX − OffsetY must stay within ±${AUTOMAP_MAX_DIFF} tiles and OffsetX + OffsetY up to ${AUTOMAP_MAX_SUM} (at this level's middle: ${mid.x - mid.y} and ${mid.x + mid.y}). Past that, D2Client halts ("Unrecoverable internal error") as soon as a player, NPC or object is put on the automap. The game's and PD2's own levels stay inside.`,
        columns: [{ table: 'Levels', col: 'OffsetX' }],
        fix: cellFix('Levels.txt', levels, `Move it to a free spot inside the range (${off.x}, ${off.y})`, [
          { row: lRow, col: 'OffsetX', value: String(off.x) },
          { row: lRow, col: 'OffsetY', value: String(off.y) },
        ]),
      });
    }
    // Overlap with other fixed-position levels of the same act.
    if (me)
      for (const other of dataRows(levels)) {
        const id = num(getCell(levels, other, 'Id'));
        if (other === lRow || levelAct(id) !== levelAct(levelId)) continue;
        const b = levelBox(levels, other);
        if (b && me.x < b.x + b.w && b.x < me.x + me.w && me.y < b.y + b.h && b.y < me.y + me.h) {
          const off = moveTo();
          out.push({
            severity: 'warning',
            title: `Level ${levelId} overlaps level ${id} "${getCell(levels, other, 'Name')}" in the act's world`,
            detail: 'Levels of one act share one world; OffsetX/OffsetY must keep them apart.',
            columns: [{ table: 'Levels', col: 'OffsetX' }],
            fix: cellFix('Levels.txt', levels, `Move it to a free spot (${off.x}, ${off.y})`, [
              { row: lRow, col: 'OffsetX', value: String(off.x) },
              { row: lRow, col: 'OffsetY', value: String(off.y) },
            ]),
          });
          break;
        }
      }
    // Level type files this preset loads.
    const tRow = rowOfRecord(types, num(getCell(levels, lRow, 'LevelType')));
    const mask = num(getCell(prest, r, 'Dt1Mask')) >>> 0;
    if (tRow >= 0)
      for (let i = 1; i <= 32; i++) {
        const f = getCell(types, tRow, `File ${i}`);
        const p = mask & (1 << (i - 1)) && f && f !== '0' ? tilePathProblem(f) : null;
        if (p) out.push({ severity: 'error', title: `LvlTypes "${getCell(types, tRow, 'Name')}" File ${i} path too long`, detail: p, columns: [{ table: 'LvlTypes', col: `File ${i}` }], longPath: f });
      }
    if (tRow >= 0 && first === r) {
      const shared = sharedTypeIssue(tables, lRow, r, tRow);
      if (shared) out.push(shared);
    }
  }
  return out;
}

/** The game's own levels end here (Baal's world stone chamber is 132, the Uber levels 133-136). */
export const LAST_GAME_LEVEL = 136;

/**
 * A level added to the game (past its own levels) that uses a level type an earlier level owns, holding tile libraries
 * only it loads: libraries added to someone else's level type for this map. The game's own levels share types that way
 * too (Courtyard 1 and 2), so only added levels that aren't the type's first user are flagged. The fix gives the level
 * its own type with exactly the libraries it loads and clears those slots from the shared row. Types that random levels
 * (DrlgType 1/3) use are left alone: their tiles come from shared presets that can select any slot.
 */
function sharedTypeIssue(tables: { prest: TxtTableDoc; levels: TxtTableDoc; types: TxtTableDoc }, lRow: number, pRow: number, tRow: number): TableIssue | null {
  const { prest, levels, types } = tables;
  const levelId = num(getCell(levels, lRow, 'Id'));
  const typeId = num(getCell(types, tRow, 'Id'));
  const others = levelsOfType(levels, typeId, levelId);
  if (levelId <= LAST_GAME_LEVEL || !others.length || others.some((o) => num(getCell(levels, o, 'DrlgType')) !== 2)) return null;
  if (Math.min(...others.map((o) => num(getCell(levels, o, 'Id')))) > levelId) return null; // it is the type's owner
  const presetOf = (id: number) => dataRows(prest).find((x) => num(getCell(prest, x, 'LevelId')) === id);
  let othersMask = 0;
  for (const o of others) {
    const p = presetOf(num(getCell(levels, o, 'Id')));
    if (p !== undefined) othersMask |= num(getCell(prest, p, 'Dt1Mask'));
  }
  const mask = num(getCell(prest, pRow, 'Dt1Mask')) >>> 0;
  const file = (i: number) => {
    const f = getCell(types, tRow, `File ${i}`);
    return f && f !== '0' ? f : '';
  };
  const loads = Array.from({ length: 32 }, (_, i) => i + 1).filter((i) => mask & (1 << (i - 1)) && file(i));
  const onlyMine = loads.filter((i) => !(othersMask & (1 << (i - 1))));
  if (!onlyMine.length) return null;
  const lName = getCell(levels, lRow, 'Name');
  const tName = getCell(types, tRow, 'Name');
  const users = others.map((o) => `${getCell(levels, o, 'Id')} "${getCell(levels, o, 'Name')}"`);
  // Fix: own type with the files this level loads, the level pointed at it, its mask = those slots, and the slots only
  // it used cleared from the shared row.
  const own = appendOwnType(types, tRow, lName, loads.map(file));
  let t = own.types;
  for (const i of onlyMine) t = setCell(t, tRow, `File ${i}`, '0');
  const ownMask = maskOf(own.slots);
  // A note, not a warning: the game loads the right files either way (PD2's own Kanemith levels share a type like this).
  return {
    severity: 'info',
    title: `Level ${levelId} "${lName}" shares level type ${typeId} "${tName}" with ${users.slice(0, 2).join(', ')}${users.length > 2 ? ` and ${users.length - 2} more` : ''}`,
    detail: `Slots ${onlyMine.join(', ')} of that level type hold tile libraries only this level loads. The game still loads the right files (each level's Dt1Mask picks its own slots), but the levels share one tile list and the type's AutoMap.txt entries, and adding libraries for one fills the other's row. If they were added to another level's type for this map, give the level its own level type, as mods do for their own areas; it then has no AutoMap entries until you add them in the Automap editor.`,
    columns: [
      { table: 'Levels', col: 'LevelType' },
      { table: 'LvlPrest', col: 'Dt1Mask' },
    ],
    fix: {
      label: `Give it its own level type ${own.typeId} "${lName}" (${loads.length} tile libraries) and clear ${onlyMine.length} slot${onlyMine.length === 1 ? '' : 's'} from "${tName}"`,
      writes: [
        { table: 'LvlTypes.txt', path: `${EXCEL}LvlTypes.txt`, bytes: serializeTxtTable(t), summary: [`New level type ${own.typeId} "${lName}": ${loads.map(file).join(', ')}`, `"${tName}": File ${onlyMine.join(', ')} cleared (only level ${levelId} used them)`] },
        { table: 'Levels.txt', path: `${EXCEL}Levels.txt`, bytes: serializeTxtTable(setCell(levels, lRow, 'LevelType', String(own.typeId))), summary: [`"${lName}": LevelType ${typeId} → ${own.typeId}`] },
        { table: 'LvlPrest.txt', path: `${EXCEL}LvlPrest.txt`, bytes: serializeTxtTable(setCell(prest, pRow, 'Dt1Mask', String(ownMask))), summary: [`"${getCell(prest, pRow, 'Name')}": Dt1Mask ${mask} → ${ownMask}`] },
      ],
    },
  };
}
