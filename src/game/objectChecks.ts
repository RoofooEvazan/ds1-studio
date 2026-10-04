import type { Ds1Object } from '../formats/ds1';
import { parseTxt, type TxtTable } from '../formats/txt';
import { CLASSIC_MPQS, MpqSource, type LayeredFs } from '../vfs/vfs';
import { OBJECTS_PER_ACT } from './objectCatalog';

/** objects.txt rows in the game's numbering (the "Expansion" divider line doesn't count). */
export const objectRows = (t: TxtTable | null): Record<string, string>[] => (t?.rows ?? []).filter((r) => r['Name'] !== 'Expansion');

const num = (v: string | undefined) => Number((v ?? '').trim()) || 0;
const rowName = (r: Record<string, string>) => (r['description - not loaded'] || r['Name'] || '').trim();

/** OperateFn 27: a teleportation pad, which takes players to another pad of the same row nearby. */
export const TELEPORT_PAD_FN = 27;

/** OperateFns of portals and waypoints (town portal, waypoint, Arcane Sanctuary portal, Duriel / guild portals). */
const PORTAL_FNS = [15, 23, 34, 43];
/**
 * OperateFns of quest objects: Tower Tome, Cairn Stones, Cain's gibbet, Inifuss tree, Malus, the tainted sun altar,
 * the Horadric staff orifice, Lam Esen's tome, the Horadric chests and tome.
 */
const QUEST_FNS = [6, 9, 10, 12, 21, 24, 25, 28, 39, 40, 41, 42];

/**
 * What the game does with an objects.txt row, when it runs code for it: "portal" (portals, waypoints), "quest", or
 * "operable" (players can click it, and it has an OperateFn: chests, doors, shrines, corpses…). Null for decorations.
 */
export function rowRole(r: Record<string, string> | undefined): 'portal' | 'quest' | 'operable' | null {
  if (!r) return null;
  const fn = num(r['OperateFn']);
  const name = `${rowName(r)} ${r['Name'] ?? ''}`;
  if (/portal|waypoint/i.test(name) || PORTAL_FNS.includes(fn)) return 'portal';
  if (/quest/i.test(name) || QUEST_FNS.includes(fn)) return 'quest';
  // Torches and fires have an OperateFn too (their light), but players can't click them.
  return fn > 0 && (r['Selectable0'] ?? '').trim() === '1' ? 'operable' : null;
}

/**
 * DS1 objects whose id is 150 or more (read by the game as objects.txt row id - 150, in any act) and land on a row the
 * game runs code for (teleportation pads aside). Placed with the old "id + 150 = next act's object" idea, such an id
 * becomes a Tower Tome, a Cairn Stone or a Town portal instead.
 */
export function directIdsOnGameRows(objects: Ds1Object[], rows: Record<string, string>[]): { index: number; row: number; role: 'portal' | 'quest' | 'operable'; name: string }[] {
  const out: { index: number; row: number; role: 'portal' | 'quest' | 'operable'; name: string }[] = [];
  objects.forEach((o, index) => {
    if (o.type !== 2 || o.id < OBJECTS_PER_ACT) return;
    const row = o.id - OBJECTS_PER_ACT;
    // Teleportation pads are checked for their partner instead (unpairedPads).
    if (num(rows[row]?.['OperateFn']) === TELEPORT_PAD_FN) return;
    const role = rowRole(rows[row]);
    if (role) out.push({ index, row, role, name: rowName(rows[row]) || `row ${row}` });
  });
  return out;
}

/**
 * Objects whose objects.txt row the loose table has but the mod MPQ's table doesn't (or has as another object, by its
 * Token): `rowOf` gives an object's row.
 */
export function looseOnlyRows(
  objects: Ds1Object[],
  rowOf: (o: Ds1Object) => number | null,
  loose: Record<string, string>[],
  archived: Record<string, string>[],
): { index: number; row: number; loose: string; archived: string | null }[] {
  const out: { index: number; row: number; loose: string; archived: string | null }[] = [];
  objects.forEach((o, index) => {
    if (o.type !== 2) return;
    const row = rowOf(o);
    if (row === null || row < 0 || !loose[row]) return;
    const a = archived[row];
    if (a && (a['Token'] ?? '').trim().toLowerCase() === (loose[row]['Token'] ?? '').trim().toLowerCase()) return;
    out.push({ index, row, loose: rowName(loose[row]) || `row ${row}`, archived: a ? rowName(a) || `row ${row}` : null });
  });
  return out;
}

/**
 * Teleportation pads (OperateFn 27) with no other pad of the same row in their own 8×8 room or a touching one
 * (40 sub-tiles): the game looks for the partner pad there.
 */
export function unpairedPads(objects: Ds1Object[], rowOf: (o: Ds1Object) => number | null, rows: Record<string, string>[]): number[] {
  const pads = objects
    .map((o, index) => ({ o, index, row: o.type === 2 ? rowOf(o) : null }))
    .filter((p): p is typeof p & { row: number } => p.row !== null && num(rows[p.row]?.['OperateFn']) === TELEPORT_PAD_FN);
  const block = (v: number) => Math.floor(v / 40);
  return pads
    .filter((p) => !pads.some((q) => q !== p && q.row === p.row && Math.abs(block(q.o.x) - block(p.o.x)) <= 1 && Math.abs(block(q.o.y) - block(p.o.y)) <= 1))
    .map((p) => p.index);
}

/**
 * A table as the mod's own MPQ has it (an MPQ that isn't one of the game's), and whether that copy is the one this
 * editor reads (false when a loose copy overrides it). PD2 was seen to use its MPQ's objects.txt and ignore a loose
 * one. Null when no such MPQ has the table.
 */
export async function modArchiveTable(fs: LayeredFs, name: string): Promise<{ table: TxtTable; label: string; inUse: boolean } | null> {
  const path = `data/global/excel/${name}`;
  const mpq = fs.baseSources.find((s) => s instanceof MpqSource && s.has(path));
  const label = mpq?.label.split(/[\\/]/).pop() ?? '';
  if (!mpq || CLASSIC_MPQS.includes(label.toLowerCase())) return null;
  const bytes = await mpq.read(path).catch(() => null);
  return bytes ? { table: parseTxt(bytes), label, inUse: fs.locate(path) === mpq.label } : null;
}
