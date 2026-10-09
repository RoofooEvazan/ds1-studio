import { describe, expect, it } from 'vitest';
import { parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1 } from '../src/formats/dt1Write';
import { parseTxtTable, getCell } from '../src/formats/txtTable';
import type { GameData, LvlTypeInfo } from '../src/game/GameData';
import { appendTiles, customName, keysOf, ownTilesPath, typeHome } from '../src/game/ownTiles';
import { gatheredName, planGatherType } from '../src/game/typePackage';
import { LayeredFs, LooseSource } from '../src/vfs/vfs';

const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const dt1 = (...keys: [number, number][]) => buildDt1(keys.map(([m, s]) => blockerRecord(m, s, new Uint8Array(25))));
const fakeGd = (loose: string[]) => ({ fs: { locate: (p: string) => (loose.some((l) => p.toLowerCase() === `data/global/tiles/${l}`.toLowerCase()) ? 'mod data' : 'd2data.mpq') } }) as unknown as GameData;
const type = (files: string[]): LvlTypeInfo => ({ id: 46, name: 'Guild', act: 5, files });

describe("the level type's own tiles file", () => {
  it('goes in the folder most of its own libraries are in, named after the type', () => {
    const t = type(['Guilds/floor.dt1', 'Guilds/trees.dt1', 'act1/outdoors/river.dt1', 'Other/x.dt1']);
    const gd = fakeGd(['Guilds/floor.dt1', 'Guilds/trees.dt1', 'Other/x.dt1']);
    expect(typeHome(gd, t)).toBe('Guilds');
    expect(ownTilesPath(gd, 'data/global/tiles/expansion/Map/guild1.ds1', t)).toBe('data/global/tiles/Guilds/guild_custom.dt1');
  });
  it("stays within the game's 41-character tile path limit", () => {
    expect(customName('PD2assets/dtprivate', 'dark_temple')).toBe('PD2assets/dtprivate/darktemple_custom.dt1');
    expect(customName('PD2assets/dtprivate', 'the_longest_level_type_name')).toBe('PD2assets/dtprivate/thelongest_custom.dt1');
    expect(customName('Guilds', 'guild')).toBe('Guilds/guild_custom.dt1');
  });
  it('keeps the case the level type already lists it with', () => {
    const t = type(['Guilds/floor.dt1', 'Guilds/Guild_Custom.dt1']);
    expect(ownTilesPath(fakeGd(['Guilds/floor.dt1', 'Guilds/Guild_Custom.dt1']), 'x.ds1', t)).toBe('data/global/tiles/Guilds/Guild_Custom.dt1');
  });
  it("uses the game libraries' folder for a type made only of them", () => {
    expect(ownTilesPath(fakeGd([]), 'data/global/tiles/act1/town/townn1.ds1', type(['ACT1/Town/floor.dt1', 'ACT1/Town/fence.dt1', 'ACT1/Outdoors/river.dt1']))).toBe('data/global/tiles/ACT1/Town/guild_custom.dt1');
  });
  it('sits next to a map that is not in the game yet', () => {
    expect(ownTilesPath(fakeGd([]), 'data/global/tiles/expansion/Map/new.ds1', null)).toBe('data/global/tiles/expansion/Map/new_custom.dt1');
  });
  it('only ever gains tiles: new ones go after the old, which keep their place', () => {
    const first = appendTiles(null, [blockerRecord(63, 0, new Uint8Array(25))]);
    expect(first.first).toBe(0);
    const second = appendTiles(first.bytes, [blockerRecord(63, 1, new Uint8Array(25)), blockerRecord(63, 2, new Uint8Array(25))]);
    expect(second.first).toBe(1);
    expect(parseDt1(second.bytes).tiles.map((t) => t.subIndex)).toEqual([0, 1, 2]);
    expect([...keysOf(second.bytes)]).toEqual(['0|63|0', '0|63|1', '0|63|2']);
  });
});

describe('gathering a level type into one folder', () => {
  it('names files readably and uniquely', () => {
    const taken = new Set<string>();
    expect(gatheredName('data/global/tiles/Guild/PD2/house2/int.dt1', taken)).toBe('int.dt1');
    expect(gatheredName('data/global/tiles/PD2assets/cust/int.dt1', taken)).toBe('cust_int.dt1');
    expect(gatheredName('data/global/tiles/studio/amunfnj05.dt1', taken)).toBe('automap.dt1');
    expect(gatheredName('data/global/tiles/studio/amung00um.dt1', taken)).toBe('automap_2.dt1');
    expect(gatheredName('data/global/tiles/studio/pmunqo2l8.dt1', taken)).toBe('tiles.dt1');
  });

  it('copies the libraries and points the slots at the copies, in the same slots', async () => {
    const files = new Map<string, () => Promise<Uint8Array>>([
      ['data/global/tiles/A/house/int.dt1', async () => dt1([1, 0])],
      ['data/global/tiles/B/int.dt1', async () => dt1([2, 0])],
      ['data/global/tiles/Home/floor.dt1', async () => dt1([3, 0])],
    ]);
    const fs = new LayeredFs([new LooseSource('mod data', files)]);
    const cols = Array.from({ length: 32 }, (_, i) => `File ${i + 1}`);
    const vals = ['A/house/int.dt1', 'B/int.dt1', 'Home/floor.dt1', ...Array(29).fill('0')];
    const types = parseTxtTable(enc(`Name\tId\t${cols.join('\t')}\r\nGuild\t46\t${vals.join('\t')}\r\n`));
    const plan = await planGatherType(fs, types, 46, 'Home', true);
    expect(plan.already).toBe(1);
    expect(plan.copies.map((c) => [c.slot, c.to])).toEqual([
      [1, 'data/global/tiles/Home/int.dt1'],
      [2, 'data/global/tiles/Home/b_int.dt1'],
    ]);
    expect([1, 2, 3, 4].map((i) => getCell(plan.types, 0, `File ${i}`))).toEqual(['Home/int.dt1', 'Home/b_int.dt1', 'Home/floor.dt1', '0']);
  });
});
