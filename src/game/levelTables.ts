import { colIndex, getCell, parseTxtTable, serializeTxtTable, setCell, type TxtTableDoc } from '../formats/txtTable';
import { normalizePath, type LayeredFs } from '../vfs/vfs';
import { appendAt, appendOwnType, dataRows, freeOffset, levelAct, levelsOfType, rowOfRecord } from './addToGame';

const EXCEL = 'data/global/excel/';

export interface TableWrite {
  table: string;
  path: string;
  bytes: Uint8Array;
  summary: string[];
}

/** A level type has no free "File N" slot left for a map's tile libraries. */
export class SlotsFullError extends Error {
  constructor(
    readonly typeId: number,
    readonly typeName: string,
    message: string,
  ) {
    super(message);
    this.name = 'SlotsFullError';
  }
}

export async function loadTable(fs: LayeredFs, name: string): Promise<TxtTableDoc | null> {
  const b = await fs.read(`${EXCEL}${name}`);
  return b ? parseTxtTable(b) : null;
}

const num = (s: string) => Number(s) || 0;
const tilesRel = (p: string) => normalizePath(p).replace(/^data\/global\/tiles\//, '');

/** Rows of LvlPrest that list `mapPath` in File1..File6. */
export function presetRowsFor(prest: TxtTableDoc, mapPath: string): number[] {
  const rel = tilesRel(mapPath);
  const out: number[] = [];
  prest.rows.forEach((_, i) => {
    for (let f = 1; f <= 6; f++) if (normalizePath(getCell(prest, i, `File${f}`)) === rel) return void out.push(i);
  });
  return out;
}

/** A DT1 path the way LvlTypes stores it: relative to data/global/tiles, case kept, the row's slash style. */
function asSlotValue(types: TxtTableDoc, row: number, path: string): string {
  const rel = path.replace(/\\/g, '/').replace(/^\/?data\/global\/tiles\//i, '');
  const backslash = Array.from({ length: 32 }, (_, i) => getCell(types, row, `File ${i + 1}`)).some((v) => v.includes('\\'));
  return backslash ? rel.replace(/\//g, '\\') : rel;
}

/**
 * Makes a LvlTypes row load `dt1s`: each DT1 already in a "File N" slot is reused, others go into free slots.
 * Returns the updated table, the slot of every DT1, and what changed. Throws when the row runs out of slots.
 */
export function ensureTypeSlots(types: TxtTableDoc, typeRow: number, dt1s: string[]): { types: TxtTableDoc; slots: Map<string, number>; added: string[] } {
  const slotPath = (t: TxtTableDoc, i: number) => {
    const v = getCell(t, typeRow, `File ${i}`);
    return v && v !== '0' ? normalizePath(`data/global/tiles/${v}`) : '';
  };
  const slots = new Map<string, number>();
  const added: string[] = [];
  const original = new Map(dt1s.map((p) => [normalizePath(p), p]));
  for (const dt1 of dt1s.map(normalizePath)) {
    let slot = 0;
    for (let i = 1; i <= 32 && !slot; i++) if (slotPath(types, i) === dt1) slot = i;
    if (!slot) {
      for (let i = 1; i <= 32 && !slot; i++) if (colIndex(types, `File ${i}`) >= 0 && !slotPath(types, i)) slot = i;
      if (!slot) throw new SlotsFullError(num(getCell(types, typeRow, 'Id')), getCell(types, typeRow, 'Name'), `LvlTypes "${getCell(types, typeRow, 'Name')}" has no free File slot for ${tilesRel(dt1)} (all 32 are used)`);
      const value = asSlotValue(types, typeRow, original.get(dt1) ?? dt1);
      types = setCell(types, typeRow, `File ${slot}`, value);
      added.push(`File ${slot} = ${value}`);
    }
    slots.set(dt1, slot);
  }
  return { types, slots, added };
}

export function maskOf(slots: Map<string, number>): number {
  let mask = 0;
  for (const s of slots.values()) mask |= 1 << (s - 1);
  return mask >>> 0;
}

/**
 * The Dt1Mask a preset needs for `dt1s`, starting from its current mask: bits of slots holding one of the DT1s stay
 * on (so duplicated slots the preset already uses are kept), a DT1 not yet selected turns on its first slot, bits of
 * slots holding other DT1s turn off, and bits of empty slots are left alone. Unchanged masks come back unchanged.
 */
export function maskFor(types: TxtTableDoc, typeRow: number, dt1s: string[], oldMask: number): number {
  const want = new Set(dt1s.map(normalizePath));
  const covered = new Set<string>();
  let mask = 0;
  for (let i = 1; i <= 32; i++) {
    const bit = 1 << (i - 1);
    const v = getCell(types, typeRow, `File ${i}`);
    const path = v && v !== '0' ? normalizePath(`data/global/tiles/${v}`) : '';
    if (!path) mask |= oldMask & bit;
    else if (want.has(path) && oldMask & bit) {
      mask |= bit;
      covered.add(path);
    }
  }
  for (let i = 1; i <= 32; i++) {
    const v = getCell(types, typeRow, `File ${i}`);
    const path = v && v !== '0' ? normalizePath(`data/global/tiles/${v}`) : '';
    if (path && want.has(path) && !covered.has(path)) {
      mask |= 1 << (i - 1);
      covered.add(path);
    }
  }
  return mask >>> 0;
}

/**
 * Brings the game's tables in line with a map's tile libraries: every DT1 is in its level type's LvlTypes row and the
 * map's LvlPrest Dt1Mask selects exactly those slots. `fallbackTypeId` is used for shared presets (LevelId 0), whose
 * level type comes from the level that places them.
 */
export async function syncLevelTables(fs: LayeredFs, mapPath: string, dt1s: string[], fallbackTypeId?: number): Promise<TableWrite[]> {
  return syncTablesIn(await loadLevelTables(fs), mapPath, dt1s, fallbackTypeId);
}

export interface LevelTables {
  prest: TxtTableDoc;
  levels: TxtTableDoc;
  types: TxtTableDoc;
}

export async function loadLevelTables(fs: LayeredFs): Promise<LevelTables> {
  const [prest, levels, types] = await Promise.all([loadTable(fs, 'LvlPrest.txt'), loadTable(fs, 'Levels.txt'), loadTable(fs, 'LvlTypes.txt')]);
  if (!prest || !levels || !types) throw new Error('LvlPrest.txt, Levels.txt or LvlTypes.txt not found');
  return { prest, levels, types };
}

/** syncLevelTables on tables already loaded (or changed in memory). */
/** `stay`: keep the map in its level type even when other levels use it (made room for it on purpose). */
export function syncTablesIn(tables: LevelTables, mapPath: string, dt1s: string[], fallbackTypeId?: number, stay = false): TableWrite[] {
  const { prest, levels, types: types0 } = tables;
  const rows = presetRowsFor(prest, mapPath);
  if (!rows.length) throw new Error('This map is not in LvlPrest.txt yet: use Game → Add to game first.');
  const { levelId, typeId } = mapLevelType(tables, mapPath, fallbackTypeId);
  const typeRow = types0.rows.findIndex((_, i) => num(getCell(types0, i, 'Id')) === typeId);
  if (typeRow < 0) throw new Error(`LvlTypes.txt has no level type ${typeId}`);
  // DT1s no slot holds yet (worked out before filling slots: a full type shared with other levels still gets the
  // level a type of its own below).
  const inSlots = new Set(Array.from({ length: 32 }, (_, i) => slotFile(types0, typeRow, i + 1)).filter(Boolean));
  const missing = dt1s.filter((d) => !inSlots.has(normalizePath(d)));
  const levelRow0 = levelId ? rowOfRecord(levels, levelId) : -1;
  const ownType = !stay && missing.length > 0 && levelRow0 >= 0 && levelsOfType(levels, typeId, levelId).length > 0 && dataRows(prest).filter((r) => num(getCell(prest, r, 'LevelId')) === levelId).every((r) => rows.includes(r));
  const { types, added } = ownType ? { types: types0, added: missing } : ensureTypeSlots(types0, typeRow, dt1s);
  let p = prest;
  const changedPresets: string[] = [];
  // New libraries for a level type other levels use too: the map's level gets a level type of its own instead, so
  // theirs keeps its tile list. Only when this map is the level's only preset (its type then affects nothing else).
  const levelRow = levelId ? rowOfRecord(levels, levelId) : -1;
  const levelPresets = levelId ? dataRows(prest).filter((r) => num(getCell(prest, r, 'LevelId')) === levelId) : [];
  if (ownType && added.length && levelRow >= 0 && levelsOfType(levels, typeId, levelId).length && levelPresets.every((r) => rows.includes(r))) {
    const name = getCell(levels, levelRow, 'Name');
    const own = appendOwnType(types0, typeRow, name, dt1s);
    const mask = maskOf(own.slots);
    for (const r of rows) {
      const old = num(getCell(p, r, 'Dt1Mask')) >>> 0;
      p = setCell(p, r, 'Dt1Mask', String(mask));
      changedPresets.push(`"${getCell(p, r, 'Name')}": Dt1Mask ${old} → ${mask}`);
    }
    return [
      { table: 'LvlTypes.txt', path: `${EXCEL}LvlTypes.txt`, bytes: serializeTxtTable(own.types), summary: [`New level type ${own.typeId} "${name}" with the map's ${own.slots.size} tile libraries (type ${typeId} "${getCell(types0, typeRow, 'Name')}" is also used by other levels, so it stays as it is)`] },
      { table: 'Levels.txt', path: `${EXCEL}Levels.txt`, bytes: serializeTxtTable(setCell(levels, levelRow, 'LevelType', String(own.typeId))), summary: [`"${name}": LevelType ${typeId} → ${own.typeId}`] },
      { table: 'LvlPrest.txt', path: `${EXCEL}LvlPrest.txt`, bytes: serializeTxtTable(p), summary: changedPresets },
    ];
  }
  for (const r of rows) {
    const old = num(getCell(p, r, 'Dt1Mask')) >>> 0;
    // A row the level generator places in many levels (LevelId 0) or that lists several maps has one mask for all of
    // them: only turn libraries on there, never off, or the other maps (and levels) lose tiles they use.
    const files = [1, 2, 3, 4, 5, 6].filter((f) => {
      const v = getCell(p, r, `File${f}`);
      return v && v !== '0';
    }).length;
    const shared = !levelId || files > 1;
    const mask = (shared ? maskFor(types, typeRow, dt1s, old) | old : maskFor(types, typeRow, dt1s, old)) >>> 0;
    if (old !== mask) {
      p = setCell(p, r, 'Dt1Mask', String(mask));
      changedPresets.push(`"${getCell(p, r, 'Name')}": Dt1Mask ${old} → ${mask}${shared ? ' (libraries only added: the row is shared with other maps)' : ''}`);
    }
  }
  const writes: TableWrite[] = [];
  if (added.length) writes.push({ table: 'LvlTypes.txt', path: `${EXCEL}LvlTypes.txt`, bytes: serializeTxtTable(types), summary: added.map((a) => `Type ${typeId} "${getCell(types, typeRow, 'Name')}": ${a}`) });
  if (changedPresets.length) writes.push({ table: 'LvlPrest.txt', path: `${EXCEL}LvlPrest.txt`, bytes: serializeTxtTable(p), summary: changedPresets });
  return writes;
}

/**
 * Sets the map's LvlPrest.txt Pops (how many roof/wall hide areas the game reads) and PopPad (their trigger padding in
 * sub-tiles) on every row that lists it. Empty when nothing changes.
 */
export async function setPopSettings(fs: LayeredFs, mapPath: string, pops: number, popPad: number): Promise<TableWrite[]> {
  const prest = await loadTable(fs, 'LvlPrest.txt');
  if (!prest) throw new Error('LvlPrest.txt not found');
  const rows = presetRowsFor(prest, mapPath);
  if (!rows.length) throw new Error('This map is not in LvlPrest.txt yet: use Game → Add to game first.');
  let p = prest;
  const summary: string[] = [];
  for (const r of rows)
    for (const [col, value] of [
      ['Pops', pops],
      ['PopPad', popPad],
    ] as const) {
      const old = getCell(p, r, col);
      if (num(old) === value && old !== '') continue;
      p = setCell(p, r, col, String(value));
      summary.push(`"${getCell(p, r, 'Name')}": ${col} ${old || '(empty)'} → ${value}`);
    }
  return summary.length ? [{ table: 'LvlPrest.txt', path: `${EXCEL}LvlPrest.txt`, bytes: serializeTxtTable(p), summary }] : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Importing a map's table rows into someone else's tables.

export interface PackageRow {
  table: string;
  key: string;
  columns: string[];
  row: string[];
}

const rowValue = (r: PackageRow, col: string) => {
  const i = r.columns.findIndex((c) => c.toLowerCase() === col.toLowerCase());
  return i >= 0 ? (r.row[i] ?? '') : '';
};

function appendFrom(doc: TxtTableDoc, r: PackageRow, overrides: Record<string, string>): TxtTableDoc {
  const values: Record<string, string> = {};
  r.columns.forEach((c, i) => {
    if (c && colIndex(doc, c) >= 0 && !(c in values)) values[c] = r.row[i] ?? '';
  });
  Object.assign(values, overrides);
  for (const k of Object.keys(values)) if (colIndex(doc, k) < 0) delete values[k];
  return appendAt(doc, values).doc;
}

/**
 * Merges a packaged map's LvlTypes / Levels / LvlPrest rows into the importer's tables so the game loads the map the
 * same way, without clobbering rows their other maps rely on:
 * - level type: reuse the row with the same Name (adding missing DT1s to free slots), else append it with a free Id;
 * - level: reuse the row with the same Name, else append it with a free Id pointing at that level type;
 * - preset: update the row already pointing at the map, else append one with a free Def;
 * - Dt1Mask is recomputed against the importer's LvlTypes slots.
 */
export interface MergeResult {
  writes: TableWrite[];
  /** Level ids of the package mapped to the ids they got here (only entries that changed). */
  levelIds: Map<string, string>;
  /** Level type ids of the package mapped to the ids they got here (only entries that changed). */
  typeIds: Map<string, string>;
}

export async function mergeMapRows(fs: LayeredFs, mapPath: string, rows: PackageRow[], dt1s: string[]): Promise<MergeResult> {
  let [prest, levels, types] = await Promise.all([loadTable(fs, 'LvlPrest.txt'), loadTable(fs, 'Levels.txt'), loadTable(fs, 'LvlTypes.txt')]);
  if (!prest || !levels || !types) throw new Error('LvlPrest.txt, Levels.txt or LvlTypes.txt not found');
  const summary: Record<string, string[]> = { 'LvlTypes.txt': [], 'Levels.txt': [], 'LvlPrest.txt': [] };
  const is = (r: PackageRow, t: string) => r.table.replace(/\.txt$/i, '').split('/').pop()!.toLowerCase() === t;
  const typeIn = rows.find((r) => is(r, 'lvltypes'));
  const levelIn = rows.find((r) => is(r, 'levels'));
  const prestIn = rows.find((r) => is(r, 'lvlprest'));
  // The game reads these tables by row position: a new row is always the next record, whatever id it had elsewhere.
  const nextRecord = (doc: TxtTableDoc) => dataRows(doc).length;
  const findByName = (doc: TxtTableDoc, name: string) => doc.rows.findIndex((_, i) => getCell(doc, i, 'Name').trim().toLowerCase() === name.trim().toLowerCase());

  // Level type
  let typeRow = -1;
  if (typeIn) {
    typeRow = findByName(types, rowValue(typeIn, 'Name'));
    if (typeRow < 0) {
      const id = nextRecord(types);
      types = appendFrom(types, typeIn, { Id: String(id) });
      typeRow = rowOfRecord(types, id);
      summary['LvlTypes.txt'].push(`New level type ${id} "${rowValue(typeIn, 'Name')}"`);
    }
  }
  if (typeRow < 0) throw new Error('The package has no level type row; open the map and use Game → Add to game.');
  const typeIds = new Map<string, string>();
  const fromId = typeIn ? String(num(rowValue(typeIn, 'Id'))) : '';
  if (typeIn && fromId !== getCell(types, typeRow, 'Id').trim()) typeIds.set(fromId, getCell(types, typeRow, 'Id').trim());
  const ensured = ensureTypeSlots(types, typeRow, dt1s);
  types = ensured.types;
  summary['LvlTypes.txt'].push(...ensured.added.map((a) => `"${getCell(types!, typeRow, 'Name')}": ${a}`));
  const typeId = num(getCell(types, typeRow, 'Id'));

  // Level
  let levelId = 0;
  const levelIds = new Map<string, string>();
  if (levelIn) {
    const existing = findByName(levels, rowValue(levelIn, 'Name'));
    if (existing >= 0) {
      levelId = num(getCell(levels, existing, 'Id'));
      if (num(getCell(levels, existing, 'LevelType')) !== typeId) {
        levels = setCell(levels, existing, 'LevelType', String(typeId));
        summary['Levels.txt'].push(`Level ${levelId} "${rowValue(levelIn, 'Name')}": LevelType → ${typeId}`);
      }
    } else {
      levelId = nextRecord(levels);
      // New levels are Act 5 in the game (it takes the act from the number); keep it clear of the other levels there.
      const off = freeOffset(levels, levelAct(levelId), { w: num(rowValue(levelIn, 'SizeX')) || 200, h: num(rowValue(levelIn, 'SizeY')) || 200 });
      const layer = Math.max(0, ...dataRows(levels).map((r) => num(getCell(levels!, r, 'Layer')))) + 1;
      levels = appendFrom(levels, levelIn, {
        Id: String(levelId),
        LevelType: String(typeId),
        Act: String(levelAct(levelId)),
        OffsetX: String(off.x),
        OffsetY: String(off.y),
        Depend: '0',
        Layer: String(layer),
      });
      summary['Levels.txt'].push(`New level ${levelId} "${rowValue(levelIn, 'Name')}" (level type ${typeId}, Act ${levelAct(levelId) + 1}, at ${off.x},${off.y})`);
    }
    if (String(levelId) !== String(num(rowValue(levelIn, 'Id')))) levelIds.set(String(num(rowValue(levelIn, 'Id'))), String(levelId));
  }

  // Preset
  const existing = presetRowsFor(prest, mapPath);
  const mask = maskOf(ensured.slots);
  if (existing.length) {
    for (const r of existing) {
      const oldMask = num(getCell(prest, r, 'Dt1Mask')) >>> 0;
      const newMask = maskFor(types, typeRow, dt1s, oldMask);
      const oldLevel = num(getCell(prest, r, 'LevelId'));
      const newLevel = levelIn ? levelId : oldLevel;
      if (oldMask === newMask && oldLevel === newLevel) continue;
      prest = setCell(prest, r, 'Dt1Mask', String(newMask));
      prest = setCell(prest, r, 'LevelId', String(newLevel));
      summary['LvlPrest.txt'].push(`Updated "${getCell(prest, r, 'Name')}": LevelId ${newLevel}, Dt1Mask ${newMask}`);
    }
  } else if (prestIn) {
    const def = nextRecord(prest);
    prest = appendFrom(prest, prestIn, { Def: String(def), LevelId: String(levelId), Dt1Mask: String(mask) });
    summary['LvlPrest.txt'].push(`New preset "${rowValue(prestIn, 'Name')}" (Def ${def}) → level ${levelId}, Dt1Mask ${mask}`);
  }

  const out: TableWrite[] = [];
  const push = (table: string, doc: TxtTableDoc) => summary[table].length && out.push({ table, path: `${EXCEL}${table}`, bytes: serializeTxtTable(doc), summary: summary[table] });
  push('LvlTypes.txt', types);
  push('Levels.txt', levels);
  push('LvlPrest.txt', prest);
  return { writes: out, levelIds, typeIds };
}

// ---------------------------------------------------------------------------------------------------------------
// A level type with no free File slot: what uses its slots, and ways to make room.

/** The level and level type a map's LvlPrest row belongs to (`fallbackTypeId` for shared presets, LevelId 0). */
export function mapLevelType(tables: LevelTables, mapPath: string, fallbackTypeId?: number): { levelId: number; typeId: number } {
  const { prest, levels } = tables;
  const rows = presetRowsFor(prest, mapPath);
  const levelId = rows.length ? num(getCell(prest, rows[0], 'LevelId')) : 0;
  let typeId = fallbackTypeId ?? 0;
  if (levelId) {
    const lv = levels.rows.findIndex((_, i) => num(getCell(levels, i, 'Id')) === levelId);
    if (lv >= 0) typeId = num(getCell(levels, lv, 'LevelType'));
  }
  return { levelId, typeId };
}

export interface SlotUse {
  slot: number;
  /** The DT1 (game path), '' for an empty slot. */
  path: string;
  /** Whether this map's own LvlPrest rows select it. */
  mine: boolean;
  /** Other LvlPrest rows (of levels using this type) that select it. */
  users: string[];
}

export interface TypeSlots {
  typeId: number;
  typeRow: number;
  name: string;
  slots: SlotUse[];
  free: number;
  /**
   * Every level of the type is a preset level (DrlgType 2), so its LvlPrest rows are all that load the slots and
   * slots can safely be removed. Maze and outdoor levels also build rooms from shared rows and pick tiles by slot.
   */
  allPreset: boolean;
  /** The levels using the type. */
  levelNames: string[];
}

const slotFile = (types: TxtTableDoc, row: number, i: number) => {
  const v = getCell(types, row, `File ${i}`);
  return v && v !== '0' ? normalizePath(`data/global/tiles/${v}`) : '';
};

/** LvlPrest rows of the levels using level type `typeId`. */
function rowsOfType(tables: LevelTables, typeId: number): number[] {
  const ids = new Set(levelsOfType(tables.levels, typeId).map((r) => num(getCell(tables.levels, r, 'Id'))));
  return dataRows(tables.prest).filter((r) => ids.has(num(getCell(tables.prest, r, 'LevelId'))));
}

/** What uses each slot of a map's level type. */
export function typeSlotUse(tables: LevelTables, mapPath: string, fallbackTypeId?: number): TypeSlots | null {
  const { prest, levels, types } = tables;
  const { typeId } = mapLevelType(tables, mapPath, fallbackTypeId);
  const typeRow = types.rows.findIndex((_, i) => num(getCell(types, i, 'Id')) === typeId);
  if (typeRow < 0) return null;
  const mine = new Set(presetRowsFor(prest, mapPath));
  const rows = rowsOfType(tables, typeId);
  const ofType = levelsOfType(levels, typeId);
  const slots: SlotUse[] = [];
  for (let i = 1; i <= 32; i++) {
    if (colIndex(types, `File ${i}`) < 0) continue;
    const bit = 1 << (i - 1);
    const sel = (r: number) => (num(getCell(prest, r, 'Dt1Mask')) >>> 0) & bit;
    slots.push({
      slot: i,
      path: slotFile(types, typeRow, i),
      mine: [...mine].some((r) => sel(r)),
      users: rows.filter((r) => !mine.has(r) && sel(r)).map((r) => getCell(prest, r, 'Name') || `row ${r}`),
    });
  }
  return {
    typeId,
    typeRow,
    name: getCell(types, typeRow, 'Name'),
    slots,
    free: slots.filter((s) => !s.path).length,
    allPreset: ofType.every((r) => num(getCell(levels, r, 'DrlgType')) === 2),
    levelNames: ofType.map((r) => getCell(levels, r, 'LevelName') || getCell(levels, r, 'Name')),
  };
}

/**
 * Takes `remove` out of a level type's File slots, moving the others up so the list stays without gaps (the server's
 * tile preload stops at the first empty slot), and renumbers the Dt1Mask bits of every LvlPrest row of its levels.
 */
export function removeTypeSlots(tables: LevelTables, typeId: number, remove: ReadonlySet<number>): { tables: LevelTables; summary: string[] } {
  const { types, prest } = tables;
  const typeRow = types.rows.findIndex((_, i) => num(getCell(types, i, 'Id')) === typeId);
  if (typeRow < 0 || !remove.size) return { tables, summary: [] };
  const kept: { from: number; value: string }[] = [];
  for (let i = 1; i <= 32; i++) {
    if (colIndex(types, `File ${i}`) < 0) continue;
    const v = getCell(types, typeRow, `File ${i}`);
    if (v && v !== '0' && !remove.has(i)) kept.push({ from: i, value: v });
  }
  let t = types;
  for (let i = 1; i <= 32; i++) if (colIndex(types, `File ${i}`) >= 0) t = setCell(t, typeRow, `File ${i}`, kept[i - 1]?.value ?? '0');
  const moved = new Map(kept.map((k, i) => [k.from, i + 1]));
  let p = prest;
  const removed = [...remove].sort((a, b) => a - b).map((i) => tilesRel(slotFile(types, typeRow, i)) || `File ${i}`);
  const summary = [`Type ${typeId} "${getCell(types, typeRow, 'Name')}": removed ${removed.join(', ')}; ${kept.length} libraries left, in File 1–${kept.length}`];
  for (const r of rowsOfType(tables, typeId)) {
    const old = num(getCell(prest, r, 'Dt1Mask')) >>> 0;
    let mask = 0;
    for (let i = 1; i <= 32; i++) if (old & (1 << (i - 1)) && moved.has(i)) mask |= 1 << (moved.get(i)! - 1);
    mask >>>= 0;
    if (mask !== old) {
      p = setCell(p, r, 'Dt1Mask', String(mask));
      summary.push(`"${getCell(prest, r, 'Name')}": Dt1Mask ${old} → ${mask}`);
    }
  }
  return { tables: { ...tables, types: t, prest: p }, summary };
}

function writesOf(before: LevelTables, after: LevelTables, summary: string[]): TableWrite[] {
  const out: TableWrite[] = [];
  if (after.types !== before.types) out.push({ table: 'LvlTypes.txt', path: `${EXCEL}LvlTypes.txt`, bytes: serializeTxtTable(after.types), summary: summary.slice(0, 1) });
  if (after.prest !== before.prest) out.push({ table: 'LvlPrest.txt', path: `${EXCEL}LvlPrest.txt`, bytes: serializeTxtTable(after.prest), summary: summary.slice(1) });
  return out;
}

/** Merges two lists of table writes: a later write of a table replaces an earlier one (it was built on top of it). */
function mergeWrites(a: TableWrite[], b: TableWrite[]): TableWrite[] {
  const out = new Map(a.map((w) => [w.table, w]));
  for (const w of b) out.set(w.table, { ...w, summary: [...(out.get(w.table)?.summary ?? []), ...w.summary] });
  return [...out.values()];
}

/** Frees slots no LvlPrest row of the type's levels selects, then brings the map's tables in line. */
export function planFreeSlots(tables: LevelTables, mapPath: string, dt1s: string[], remove: ReadonlySet<number>, fallbackTypeId?: number): TableWrite[] {
  const use = typeSlotUse(tables, mapPath, fallbackTypeId);
  if (!use) throw new Error('The map has no level type.');
  if (!use.allPreset) throw new Error(`Level type "${use.name}" is also used by maze or outdoor levels: its slots can't be removed safely.`);
  for (const i of remove) {
    const s = use.slots.find((x) => x.slot === i);
    if (s && (s.users.length || s.mine)) throw new Error(`File ${i} is still used (${s.mine ? 'by this map' : s.users.join(', ')}).`);
  }
  const freed = removeTypeSlots(tables, use.typeId, remove);
  return mergeWrites(writesOf(tables, freed.tables, freed.summary), syncTablesIn(freed.tables, mapPath, dt1s, fallbackTypeId, true));
}

/**
 * Replaces several of the map's DT1s with one combined DT1 (`combined`: the members' tiles in load order; the game pools
 * the tiles of every loaded DT1 anyway, so the map looks the same). The members' slots no other row uses are removed,
 * the combined DT1 goes in, and the map's Dt1Mask follows. Returns the table writes and the map's new library list.
 */
export function planCombine(tables: LevelTables, mapPath: string, dt1s: string[], members: string[], combined: string, fallbackTypeId?: number): { writes: TableWrite[]; dt1s: string[] } {
  const use = typeSlotUse(tables, mapPath, fallbackTypeId);
  if (!use) throw new Error('The map has no level type.');
  const mem = new Set(members.map(normalizePath));
  if (mem.size < 2) throw new Error('Choose at least two DT1s to combine.');
  const first = dt1s.findIndex((p) => mem.has(normalizePath(p)));
  if (first < 0) throw new Error('The DT1s to combine are not in the map.');
  const next = [...dt1s.slice(0, first), combined, ...dt1s.slice(first).filter((p) => !mem.has(normalizePath(p)))];
  const remove = use.allPreset ? new Set(use.slots.filter((s) => s.path && mem.has(s.path) && !s.users.length).map((s) => s.slot)) : new Set<number>();
  const freed = removeTypeSlots(tables, use.typeId, remove);
  return { writes: mergeWrites(writesOf(tables, freed.tables, freed.summary), syncTablesIn(freed.tables, mapPath, next, fallbackTypeId, true)), dt1s: next };
}

/**
 * Swaps two of the map's libraries in load order. The game loads a level's DT1s in the order of its level type's File
 * slots (the first one loaded wins when two have a tile of the same number), so the two slots trade places in
 * LvlTypes and the Dt1Mask bits of every LvlPrest row of the type's levels follow: each map keeps the same libraries.
 */
export function planSwapLibraries(tables: LevelTables, mapPath: string, a: string, b: string, fallbackTypeId?: number): TableWrite[] {
  const use = typeSlotUse(tables, mapPath, fallbackTypeId);
  if (!use) throw new Error('The map has no level type.');
  if (!use.allPreset) throw new Error(`Level type "${use.name}" is also used by maze or outdoor levels, which pick tiles by slot: its load order can't be changed safely.`);
  const slotOf = (p: string) => use.slots.find((s) => s.mine && s.path === normalizePath(p))?.slot;
  const sa = slotOf(a), sb = slotOf(b);
  if (!sa || !sb) throw new Error(`${tilesRel(sa ? b : a)} isn't one of the map's File slots in LvlTypes.txt.`);
  const { types, prest } = tables;
  const va = getCell(types, use.typeRow, `File ${sa}`), vb = getCell(types, use.typeRow, `File ${sb}`);
  const t = setCell(setCell(types, use.typeRow, `File ${sa}`, vb), use.typeRow, `File ${sb}`, va);
  const summary = [`Type ${use.typeId} "${use.name}": ${tilesRel(slotFile(types, use.typeRow, sa))} (File ${sa}) and ${tilesRel(slotFile(types, use.typeRow, sb))} (File ${sb}) trade places`];
  const ba = 1 << (sa - 1), bb = 1 << (sb - 1);
  let p = prest;
  for (const r of rowsOfType(tables, use.typeId)) {
    const old = num(getCell(prest, r, 'Dt1Mask')) >>> 0;
    const mask = ((old & ~(ba | bb)) | (old & ba ? bb : 0) | (old & bb ? ba : 0)) >>> 0;
    if (mask !== old) {
      p = setCell(p, r, 'Dt1Mask', String(mask));
      summary.push(`"${getCell(prest, r, 'Name')}": Dt1Mask ${old} → ${mask}`);
    }
  }
  return writesOf(tables, { ...tables, types: t, prest: p }, summary);
}
