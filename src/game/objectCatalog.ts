import { COMPONENTS } from '../formats/cof';
import type { TxtTable } from '../formats/txt';
import type { SpriteSpec } from './sprites';
import { GAME_BINARY_FILES } from '../vfs/vfs';

/**
 * The placeable objects and NPCs of each act, worked out from the game itself (no WinDS1 needed):
 *
 * - Objects (DS1 type 2): the game maps a DS1 object id to an objects.txt row through a fixed table of 150 ids per act
 *   that isn't in any .txt file; it sits in the game's code (D2Common.dll up to 1.13, Game.exe in 1.14). It is found
 *   by searching the program file for its first entries. Names and sprites then come from objects.txt.
 * - NPCs (DS1 type 1): MonPreset.txt lists them per act; MonStats.txt / MonStats2.txt / SuperUniques.txt give the
 *   name and the sprite.
 */

/** The description the Custom object tool gives the objects.txt rows it makes (see customObject.ts). */
export const CUSTOM_OBJECT_MARK = 'DS1 Studio custom: ';

export const PRESET_ACTS = 5;
export const OBJECTS_PER_ACT = 150;

/** Act 1's first object ids: rogue fountain, tiki torch, rogue bonfire, two flags, a chest, two Cairn Stones. */
const SIGNATURE = [12, 37, 39, 35, 36, 5, 17, 18];

/** Where the game's program files are mounted in the virtual file system, most specific first. */
export const GAME_BINARIES = GAME_BINARY_FILES.map((f) => `bin/${f.toLowerCase()}`);

/** The act/id -> objects.txt row table (5 acts × 150 ids), or null if the file doesn't hold it. */
export function findObjectPresets(bin: Uint8Array): Int32Array[] | null {
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const size = PRESET_ACTS * OBJECTS_PER_ACT * 4;
  outer: for (let o = 0; o + size <= bin.length; o += 4) {
    if (dv.getInt32(o, true) !== SIGNATURE[0]) continue;
    for (let k = 1; k < SIGNATURE.length; k++) if (dv.getInt32(o + k * 4, true) !== SIGNATURE[k]) continue outer;
    const acts: Int32Array[] = [];
    for (let a = 0; a < PRESET_ACTS; a++) {
      const act = new Int32Array(OBJECTS_PER_ACT);
      for (let i = 0; i < OBJECTS_PER_ACT; i++) act[i] = dv.getInt32(o + (a * OBJECTS_PER_ACT + i) * 4, true);
      acts.push(act);
    }
    // Sanity: row numbers (or -1 for unused ids), nothing wild.
    if (acts.every((act) => act.every((v) => v >= -1 && v < 4096))) return acts;
  }
  return null;
}

export interface CatalogEntry {
  act: number; // 1-based
  type: 1 | 2;
  id: number;
  name: string;
  spec: SpriteSpec | null;
  /** Objects: the string-table key of the name the game shows on hover (objects.txt Name), and whether it shows one. */
  nameKey?: string;
  selectable?: boolean;
  /** Objects: the objects.txt row (record number). */
  row?: number;
  /** Objects: the light it gives off as placed. */
  light?: ObjectLight | null;
  /** Objects: where the game draws it relative to where it stands, in pixels (objects.txt Xoffset / Yoffset). */
  drawOffset?: [number, number];
}

/** "RogueFountain" -> "Rogue Fountain", "Torch1 Tiki" -> "Torch 1 Tiki", "place_champion" -> "Place champion". */
export function prettyName(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Column lookup ignoring case (MonStats2 spells some as "Rav"/"Lav"). */
function getter(row: Record<string, string>) {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  return (col: string) => (lower.get(col.toLowerCase()) ?? '').trim();
}

/** The mode a placed object is shown in: "ON" for torches and fires that loop in it, "OP" with no neutral mode, else "NU". */
function objectMode(get: (col: string) => string): 'ON' | 'OP' | 'NU' {
  return get('Mode2') === '1' && get('CycleAnim2') === '1' ? 'ON' : get('Mode0') !== '1' && get('Mode1') === '1' ? 'OP' : 'NU';
}
const MODE_INDEX = { NU: 0, OP: 1, ON: 2 } as const;

/** Sprite of an objects.txt row: its default look (lit "ON" mode for torches and fires that loop in it, else "NU"). */
export function objectSpec(row: Record<string, string>): SpriteSpec | null {
  const get = getter(row);
  const token = get('Token');
  if (!token) return null;
  const parts: Record<string, string> = {};
  for (const c of COMPONENTS) if (get(c) === '1') parts[c] = 'LIT';
  if (!Object.keys(parts).length) parts.TR = 'LIT';
  return { base: 'Data\\Global\\Objects', token, mode: objectMode(get), cls: 'HTH', parts };
}

/** Light an object gives off: radius in sub-tiles (the unit of a player's light radius), colour and flicker. */
export interface ObjectLight {
  radius: number;
  rgb: [number, number, number];
  flicker: boolean;
}

/**
 * The light of an objects.txt row in the mode a placed object is shown in (Lit0-Lit7 by mode, Red/Green/Blue, Flicker):
 * torches and braziers glow in their lit "ON" mode, candles in neutral; shrines and Cairn Stones only once used, so not
 * as placed. Null when it gives none. Objects without graphics can be light sources too.
 */
export function objectLight(row: Record<string, string>): ObjectLight | null {
  const get = getter(row);
  const radius = Number(get(`Lit${MODE_INDEX[objectMode(get)]}`)) || 0;
  if (radius <= 0) return null;
  const c = (col: string) => Math.max(0, Math.min(255, Number(get(col)) || 0));
  const rgb: [number, number, number] = [c('Red'), c('Green'), c('Blue')];
  return { radius, rgb: rgb.some((v) => v) ? rgb : [255, 255, 255], flicker: get('Flicker') === '1' };
}

/** Sprite of a monster (MonStats row + its MonStats2 row), standing in its neutral mode. */
export function monsterSpec(stats: Record<string, string>, art: Record<string, string> | undefined): SpriteSpec | null {
  const token = getter(stats)('Code');
  if (!token || !art) return null;
  const get = getter(art);
  const parts: Record<string, string> = {};
  for (const c of COMPONENTS) {
    if (get(c) !== '1') continue;
    // The first real look ("nil" = nothing drawn for that part).
    const values = get(`${c}v`).replace(/"/g, '').split(/[,\s]+/).filter(Boolean);
    const look = values.length ? values.find((v) => v.toLowerCase() !== 'nil') : 'lit';
    if (look) parts[c] = look.toUpperCase();
  }
  return { base: 'Data\\Global\\Monsters', token, mode: 'NU', cls: (get('BaseW') || 'hth').toUpperCase(), parts };
}

export interface CatalogTables {
  objects: TxtTable | null;
  monPreset: TxtTable | null;
  monStats: TxtTable | null;
  monStats2: TxtTable | null;
  superUniques: TxtTable | null;
}

export type ObjectRowEntry = Omit<CatalogEntry, 'act' | 'type' | 'id'>;

/**
 * Every objects.txt row by record number. The game numbers rows by position, without the "Expansion" divider (the
 * Id column drifts after it). A DS1 object id of 150 or more names a row directly: row = id - 150.
 */
export function objectRowsByNumber(t: Pick<CatalogTables, 'objects'>): Map<number, ObjectRowEntry> {
  const out = new Map<number, ObjectRowEntry>();
  (t.objects?.rows ?? [])
    .filter((r) => r['Name'] !== 'Expansion')
    .forEach((r, row) => {
      const desc = r['description - not loaded'] || r['Name'] || `Object ${row}`;
      // A custom object goes by the name it was given there.
      const custom = desc.startsWith(CUSTOM_OBJECT_MARK) ? desc.slice(CUSTOM_OBJECT_MARK.length) : null;
      out.set(row, { name: custom ? `${custom} (custom, ${row})` : `${prettyName(desc)} (${row})`, spec: objectSpec(r), nameKey: r['Name'] ?? '', selectable: (r['Selectable0'] ?? '').trim() === '1', row, light: objectLight(r), drawOffset: [Number(r['Xoffset']) || 0, Number(r['Yoffset']) || 0] });
    });
  return out;
}

export function buildCatalog(presets: Int32Array[] | null, t: CatalogTables): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const objByRow = objectRowsByNumber(t);
  presets?.forEach((ids, a) =>
    ids.forEach((row, id) => {
      if (row <= 0) return; // unused slot (row 0 is objects.txt's "test data" dummy)
      const r = objByRow.get(row);
      if (!r) return void out.push({ act: a + 1, type: 2, id, name: `Object row ${row} (not in objects.txt)`, spec: null });
      out.push({ act: a + 1, type: 2, id, ...r });
    }),
  );

  const lc = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  const stats = new Map((t.monStats?.rows ?? []).map((r) => [lc(r['Id']), r]));
  const art = new Map((t.monStats2?.rows ?? []).map((r) => [lc(r['Id']), r]));
  const supers = new Map((t.superUniques?.rows ?? []).map((r) => [lc(r['Superunique']), r]));
  const perAct = new Map<number, number>();
  for (const r of t.monPreset?.rows ?? []) {
    const act = Number(r['Act']);
    const id = perAct.get(act) ?? 0;
    perAct.set(act, id + 1);
    const place = (r['Place'] ?? '').trim();
    if (!place) continue;
    const sup = supers.get(lc(place));
    let m = stats.get(lc(sup ? sup['Class'] : place));
    // NameStr is a string-table key: readable for most, but "Dummy" for critters and helpers (use the id then).
    const nameStr = m?.['NameStr'] && !/^dummy$/i.test(m['NameStr']) ? m['NameStr'] : null;
    let name = sup ? sup['Superunique'] : m ? nameStr || m['Id'] : place;
    // "place_fallen", "place_fetishshaman", "place_impgroup"…: spawn spots for a monster kind; show its first monster.
    const spot = /^place_(.+)$/i.exec(place);
    if (!m && spot) {
      const key = lc(spot[1]).replace(/[\s_]+/g, '').replace(/group$/, '');
      m = stats.get(key) ?? [...stats.values()].find((r) => lc(r['Id']).startsWith(key));
      name = `${spot[1]} (spawn spot)`;
    }
    out.push({ act, type: 1, id, name: prettyName(name), spec: m ? monsterSpec(m, art.get(lc(m['MonStatsEx'] || m['Id']))) : null });
  }
  return out;
}
