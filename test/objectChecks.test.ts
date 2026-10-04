import { describe, expect, it } from 'vitest';
import type { Ds1Object } from '../src/formats/ds1';
import type { TxtTable } from '../src/formats/txt';
import { directIdsOnGameRows, looseOnlyRows, objectRows, rowRole, unpairedPads } from '../src/game/objectChecks';

const table = (rows: Record<string, string>[]): TxtTable => ({ columns: Object.keys(rows[0] ?? {}), rows }) as unknown as TxtTable;
const obj = (id: number, x = 0, y = 0): Ds1Object => ({ type: 2, id, x, y, flags: 0, path: [] });

const ROWS = objectRows(
  table([
    { Name: 'test data', 'description - not loaded': 'test data', Token: '00', OperateFn: '0' },
    { Name: 'torch', 'description - not loaded': 'Torch1 Tiki', Token: 'TO', OperateFn: '0' },
    { Name: 'Expansion', 'description - not loaded': '', Token: '', OperateFn: '' },
    { Name: 'Town Portal', 'description - not loaded': 'Town portal', Token: 'TP', OperateFn: '15' },
    { Name: 'Cairn Stone', 'description - not loaded': 'StoneAlpha', Token: 'S1', OperateFn: '9', Selectable0: '1' },
    { Name: 'altar', 'description - not loaded': 'tainted sun altar quest', Token: 'ZA', OperateFn: '24' },
    { Name: 'teleport pad', 'description - not loaded': 'teleportation pad', Token: 'GZ', OperateFn: '27', Selectable0: '1' },
    { Name: 'torch', 'description - not loaded': 'Torch2 Wall', Token: 'WT', OperateFn: '11', Selectable0: '0' },
  ]),
);

describe('object checks', () => {
  it('tells portals, quest objects and other operable rows from decorations', () => {
    expect(ROWS.map(rowRole)).toEqual([null, null, 'portal', 'quest', 'quest', 'operable', null]);
  });

  it('flags ids of 150 and up that land on rows the game runs code for', () => {
    // Ids 155 (a teleportation pad: checked for its partner instead) and 156 (a torch nobody clicks) are left alone.
    const found = directIdsOnGameRows([obj(151), obj(152), obj(3), obj(153), obj(155), obj(156)], ROWS);
    expect(found.map((f) => [f.index, f.row, f.role])).toEqual([
      [1, 2, 'portal'],
      [3, 3, 'quest'],
    ]);
  });

  it('finds objects whose row only the loose objects.txt has (or the MPQ has as another object)', () => {
    const archived = ROWS.slice(0, 4).map((r, i) => (i === 3 ? { ...r, Token: 'XX', 'description - not loaded': 'other' } : r));
    const objects = [obj(150 + 1), obj(150 + 3), obj(150 + 5), obj(150 + 9)];
    const found = looseOnlyRows(objects, (o) => o.id - 150, ROWS, archived);
    expect(found).toEqual([
      { index: 1, row: 3, loose: 'StoneAlpha', archived: 'other' },
      { index: 2, row: 5, loose: 'teleportation pad', archived: null },
    ]);
  });

  it('finds teleport pads with no partner of their row in their own or a touching 8×8 room', () => {
    const pad = (x: number, y: number) => obj(150 + 5, x, y);
    // Rooms are 40 sub-tiles: 10 and 45 touch; 10 and 95 don't.
    expect(unpairedPads([pad(10, 10), pad(45, 10)], (o) => o.id - 150, ROWS)).toEqual([]);
    expect(unpairedPads([pad(10, 10), pad(95, 10), obj(151, 12, 10)], (o) => o.id - 150, ROWS)).toEqual([0, 1]);
  });
});
