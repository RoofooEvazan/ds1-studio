import { writeCof } from '../formats/cof';
import { parseDs1 } from '../formats/ds1';
import { writeDc6 } from '../formats/dc6';
import { colIndex, getCell, setCell, type TxtTableDoc } from '../formats/txtTable';
import type { LayeredFs } from '../vfs/vfs';
import { CUSTOM_OBJECT_MARK, OBJECTS_PER_ACT } from './objectCatalog';
import VANILLA_USE from '../data/vanillaObjectUse.json';

/**
 * Custom objects: a picture of your own placed in maps like any object.
 *
 * Which objects.txt row a DS1 object id means is fixed by a table in the game's program files (150 ids per act; see
 * objectCatalog), so a new object can't get a new id: it takes over an objects.txt row one of those ids points to.
 * Only rows nothing else uses are offered as free: no map in the game or the mod places them, no ObjGroup.txt group
 * spawns them, and they have no game functions (OperateFn / InitFn / PopulateFn / ClientFn), which is how the game
 * spawns its own objects in code (portals, waypoints, shrines…).
 *
 * The row becomes a plain decoration, set up like the game's own "banner 1" (an Act 5 decoration): one mode (NU),
 * optionally animated, with optional light and collision. Its graphics: a COF and one DC6 layer (TR), which the game
 * loads like its DCC layers (vanilla ships 68 such DC6 layers itself), under data/global/objects/<token>/.
 */

const GAME_FUNCTIONS = ['OperateFn', 'InitFn', 'PopulateFn', 'ClientFn'];
/** The description given to rows made here, so the tool can find (and edit) them again. */
export const CUSTOM_MARK = CUSTOM_OBJECT_MARK;
const OBJECTS = 'data/global/objects/';

/** objects.txt data-line indices in the game's row numbering (the "Expansion" divider line doesn't count). */
export function gameRows(doc: TxtTableDoc): number[] {
  const name = colIndex(doc, 'Name');
  const out: number[] = [];
  doc.rows.forEach((r, i) => {
    if (r.length > 1 && (r[name] ?? '') !== 'Expansion') out.push(i);
  });
  return out;
}

/**
 * The objects.txt row (game numbering) a DS1 object id resolves to in an act (0-based). An id of 150 or more is the row
 * id - 150 directly (D2Common, D2MOO DrlgPreset.cpp); a lower one goes through the act's table, negative ids reaching
 * back into earlier acts'.
 */
export function presetRow(presets: Int32Array[], act0: number, id: number): number {
  if (id >= OBJECTS_PER_ACT) return id - OBJECTS_PER_ACT;
  let act = act0;
  let n = id;
  while (n < 0) (act--, (n += OBJECTS_PER_ACT));
  return presets[act]?.[n] ?? -1;
}

/** The game's own archives: their maps are known (vanillaObjectUse.json, made by tools/vanilla-object-use.ts). */
const GAME_ARCHIVES = ['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq', 'd2char.mpq'];
export const fromGameArchive = (fs: LayeredFs, path: string) => GAME_ARCHIVES.includes((fs.locate(path) ?? '').toLowerCase());

/** The objects.txt rows the game's own maps place (one count per object id they use). */
export function vanillaRowUse(presets: Int32Array[], used: Record<string, number[]> = VANILLA_USE): Map<number, number> {
  const uses = new Map<number, number>();
  for (const [act, ids] of Object.entries(used))
    for (const id of ids) {
      const row = presetRow(presets, Number(act), id);
      if (row > 0) uses.set(row, (uses.get(row) ?? 0) + 1);
    }
  return uses;
}

/**
 * How many objects every objects.txt row has placed in the DS1 maps `paths`, by reading their object lists, added to
 * `uses` (start from vanillaRowUse and read only the maps not straight from the game's archives).
 */
export async function scanRowUse(
  fs: LayeredFs,
  presets: Int32Array[],
  paths: string[],
  onProgress?: (done: number, total: number) => void,
  uses = new Map<number, number>(),
): Promise<Map<number, number>> {
  let done = 0;
  for (const p of paths) {
    const bytes = await fs.read(p).catch(() => null);
    if (bytes) {
      try {
        const ds1 = parseDs1(bytes);
        for (const o of ds1.objects) {
          if (o.type !== 2) continue;
          const row = presetRow(presets, ds1.act, o.id);
          if (row > 0) uses.set(row, (uses.get(row) ?? 0) + 1);
        }
      } catch {
        // not a readable DS1: nothing placed
      }
    }
    if (++done % 25 === 0 || done === paths.length) onProgress?.(done, paths.length);
  }
  return uses;
}

/** objects.txt rows ObjGroup.txt groups spawn (its ID0…ID7 columns). */
export function objGroupRows(doc: TxtTableDoc | null): Set<number> {
  const out = new Set<number>();
  if (!doc) return out;
  const cols = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => colIndex(doc, `ID${i}`)).filter((c) => c >= 0);
  for (const r of doc.rows) for (const c of cols) if (Number(r[c]) > 0) out.add(Number(r[c]));
  return out;
}

export interface ObjectSlot {
  /** DS1 object id in the act. */
  id: number;
  /** objects.txt row (game numbering). */
  row: number;
  name: string;
  token: string;
  /** Objects placed with this row in the maps. */
  uses: number;
  /** An ObjGroup.txt group spawns it. */
  inGroup: boolean;
  /** It has a game function (the game spawns or runs it in code). */
  functions: boolean;
  /** Made with this tool before. */
  custom: boolean;
  /** Nothing uses it: safe to take over. */
  free: boolean;
}

/** The object ids of an act (0-based) with the row each points to, and whether that row is free to take over. */
export function objectSlots(presets: Int32Array[], objects: TxtTableDoc, act0: number, uses: Map<number, number>, groups: Set<number>): ObjectSlot[] {
  const rows = gameRows(objects);
  const out: ObjectSlot[] = [];
  for (let id = 0; id < OBJECTS_PER_ACT; id++) {
    const row = presets[act0]?.[id] ?? -1;
    if (row <= 0 || row >= rows.length) continue;
    const line = rows[row];
    const desc = getCell(objects, line, 'description - not loaded');
    const custom = desc.startsWith(CUSTOM_MARK);
    const functions = GAME_FUNCTIONS.some((c) => Number(getCell(objects, line, c)) > 0);
    const n = uses.get(row) ?? 0;
    const inGroup = groups.has(row);
    out.push({
      id,
      row,
      name: custom ? desc.slice(CUSTOM_MARK.length) : desc || getCell(objects, line, 'Name') || `row ${row}`,
      token: getCell(objects, line, 'Token'),
      uses: n,
      inGroup,
      functions,
      custom,
      free: !inGroup && !functions && (custom || n === 0),
    });
  }
  return out;
}

/** A two-character token no objects.txt row uses and no folder under data/global/objects/ has. */
export function freeToken(fs: LayeredFs, objects: TxtTableDoc): string {
  const used = new Set(objects.rows.map((_, i) => getCell(objects, i, 'Token').toLowerCase()).filter(Boolean));
  const folders = new Set(fs.list((p) => p.startsWith(OBJECTS)).map((p) => p.slice(OBJECTS.length).split('/')[0].toLowerCase()));
  const chars = 'zyxwvutsrqponmlkjihgfedcba0123456789';
  for (const a of chars) for (const b of chars) if (!used.has(a + b) && !folders.has(a + b)) return a + b;
  throw new Error('No free two-character object token left.');
}

export interface CustomObjectOptions {
  name: string;
  /** Two characters (see freeToken). */
  token: string;
  frames: number;
  /** Animation speed: frames per game frame × 256 (256 = 25 per second, 128 = 12.5). */
  speed: number;
  /** Light radius (0 = no light) and its colour. */
  light: number;
  lightColour: [number, number, number];
  flicker: boolean;
  /** Blocks walking, over this many sub-tiles (5 per cell) each way. */
  blocks: boolean;
  size: number;
  /** Drawn under units (rugs, decals). */
  drawUnder: boolean;
  act0: number;
}

/** The objects.txt row set up as a custom decoration (every known column; unknown extra columns are left as they are). */
export function customObjectRow(objects: TxtTableDoc, row: number, o: CustomObjectOptions): TxtTableDoc {
  const line = gameRows(objects)[row];
  if (line === undefined) throw new Error(`objects.txt has no row ${row}.`);
  const v: Record<string, string | number> = {
    Name: o.name,
    'description - not loaded': CUSTOM_MARK + o.name,
    Token: o.token,
    SpawnMax: 0,
    TrapProb: 0,
    SizeX: o.blocks ? o.size : 0,
    SizeY: o.blocks ? o.size : 0,
    FrameCnt0: o.frames,
    FrameDelta0: o.speed,
    CycleAnim0: o.frames > 1 ? 1 : 0,
    Lit0: o.light,
    HasCollision0: o.blocks ? 1 : 0,
    Mode0: 1,
    Orientation: 1,
    Draw: 1,
    Red: o.lightColour[0],
    Green: o.lightColour[1],
    Blue: o.lightColour[2],
    TR: 1,
    TotalPieces: 1,
    NameOffset: -80,
    OperateRange: 2,
    Restore: 1,
    Act: 1 << o.act0,
    Flicker: o.light && o.flicker ? 1 : 0,
    Damage: 100,
    DrawUnder: o.drawUnder ? 1 : 0,
  };
  // Everything else a vanilla column: off. (Per-mode columns for modes 1-7, selection, functions, sub-class…)
  const zero = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((m) => [`Selectable${m}`, `FrameCnt${m}`, `FrameDelta${m}`, `CycleAnim${m}`, `Lit${m}`, `BlocksLight${m}`, `HasCollision${m}`, `Start${m}`, `OrderFlag${m}`, `Mode${m}`, `Parm${m}`]),
    'nTgtFX', 'nTgtFY', 'nTgtBX', 'nTgtBY', 'IsAttackable0', 'EnvEffect', 'IsDoor', 'BlocksVis', 'Trans', 'PreOperate', 'Yoffset', 'Xoffset',
    'HD', 'LG', 'RA', 'LA', 'RH', 'LH', 'SH', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8',
    'SubClass', 'Xspace', 'Yspace', 'MonsterOK', 'ShrineFunction', 'Lockable', 'Gore', 'Sync', 'Beta', 'Overlay', 'CollisionSubst',
    'Left', 'Top', 'Width', 'Height', 'OperateFn', 'PopulateFn', 'InitFn', 'ClientFn', 'RestoreVirgins', 'BlockMissile', 'OpenWarp', 'AutoMap',
  ];
  let doc = objects;
  for (const c of zero) if (colIndex(doc, c) >= 0 && !(c in v)) doc = setCell(doc, line, c, '0');
  for (const [c, x] of Object.entries(v)) if (colIndex(doc, c) >= 0) doc = setCell(doc, line, c, String(x));
  return doc;
}

/** One frame of the picture: palette indices, 0 = transparent. */
export interface ObjectFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** A picture cut into `count` frames side by side (a strip), each the same width. */
export function splitStrip(width: number, height: number, pixels: Uint8Array, count: number): ObjectFrame[] {
  const w = Math.floor(width / count);
  if (w < 1 || w * count !== width) throw new Error(`The picture is ${width} pixels wide: ${count} frames side by side need a width that divides by ${count}.`);
  return Array.from({ length: count }, (_, k) => {
    const out = new Uint8Array(w * height);
    for (let y = 0; y < height; y++) out.set(pixels.subarray(y * width + k * w, y * width + k * w + w), y * w);
    return { width: w, height, pixels: out };
  });
}

/**
 * The object's graphics files: its COF (one TR layer, one direction) and the DC6 holding the frames. The object's spot
 * is `anchorX` pixels from the picture's left edge (its centre unless given) and `feet` pixels above its bottom edge.
 */
export function customObjectFiles(token: string, frames: ObjectFrame[], feet = 0, anchorX?: number): { path: string; bytes: Uint8Array }[] {
  const t = token.toLowerCase();
  const w = frames[0].width;
  const h = frames[0].height;
  const left = -(anchorX ?? Math.floor(w / 2));
  const cof = writeCof({
    directions: 1,
    framesPerDir: frames.length,
    animationRate: 256,
    box: { xMin: left, xMax: left + w, yMin: feet - h, yMax: feet },
    layers: [{ component: 1, shadow: true, selectable: false, transparent: false, drawEffect: 0, weaponClass: 'hth' }],
  });
  const dc6 = writeDc6(frames.map((f) => ({ ...f, offsetX: left, offsetY: feet })));
  return [
    { path: `${OBJECTS}${t}/cof/${t}nuhth.cof`, bytes: cof },
    { path: `${OBJECTS}${t}/tr/${t}trlitnuhth.dc6`, bytes: dc6 },
  ];
}

/**
 * How many frames a strip probably holds: the fewest equal frames (2-64) whose edges all fall on see-through columns,
 * with something drawn in each; square frames first when the width allows them. 1 when nothing fits.
 */
export function guessFrames(width: number, height: number, alpha: (x: number, y: number) => boolean): number {
  const clear = (x: number) => {
    for (let y = 0; y < height; y++) if (alpha(x, y)) return false;
    return true;
  };
  const fits = (n: number) => {
    if (width % n) return false;
    const w = width / n;
    for (let k = 1; k < n; k++) if (!clear(k * w - 1) || !clear(k * w)) return false;
    // Each frame shows something.
    for (let k = 0; k < n; k++) {
      let any = false;
      for (let x = k * w; x < (k + 1) * w && !any; x++) any = !clear(x);
      if (!any) return false;
    }
    return true;
  };
  if (width > height && width % height === 0 && width / height <= 64 && fits(width / height)) return width / height;
  for (let n = 2; n <= 64; n++) if (fits(n)) return n;
  return 1;
}

/** An objects.txt data line as a column → value record (what objectSpec reads). */
export function rowRecord(objects: TxtTableDoc, line: number): Record<string, string> {
  return Object.fromEntries(objects.columns.map((c, i) => [c, objects.rows[line]?.[i] ?? '']));
}

/** The mode column suffix of the animation an object shows (objectSpec's NU / OP / ON). */
const MODE_INDEX: Record<string, number> = { NU: 0, OP: 1, ON: 2 };

/** What a picture to start from carries: frames on one canvas, the spot it stands on, and the row's settings. */
export interface StartingPoint {
  frames: ObjectFrame[];
  /** The spot: pixels from the canvas's left edge, and above its bottom edge. */
  anchorX: number;
  feet: number;
  fps: number;
  light: number;
  lightColour: [number, number, number];
  flicker: boolean;
  blocks: boolean;
  size: number;
  drawUnder: boolean;
}

/**
 * An object's frames (as loadSpriteAnimation gives them: one canvas, its top-left `offsetX/offsetY` from the feet)
 * and its objects.txt row's settings for the mode it is shown in, as a starting point for a custom object.
 */
export function startingPoint(
  anim: { frames: { width: number; height: number; pixels: Uint8Array }[]; offsetX: number; offsetY: number; height: number; fps: number },
  row: Record<string, string>,
  mode: string,
): StartingPoint {
  const m = MODE_INDEX[mode] ?? 0;
  const n = (c: string) => Number((row[c] ?? '').trim()) || 0;
  const delta = n(`FrameDelta${m}`);
  return {
    frames: anim.frames.map((f) => ({ width: f.width, height: f.height, pixels: f.pixels })),
    anchorX: -anim.offsetX,
    feet: anim.offsetY + anim.height,
    fps: Math.max(1, Math.min(25, Math.round(delta ? (delta / 256) * 25 : anim.fps))),
    light: n(`Lit${m}`),
    lightColour: [n('Red') || 255, n('Green') || 255, n('Blue') || 255],
    flicker: n('Flicker') === 1,
    blocks: n(`HasCollision${m}`) === 1,
    size: Math.max(1, n('SizeX') || 1),
    drawUnder: n('DrawUnder') === 1,
  };
}
