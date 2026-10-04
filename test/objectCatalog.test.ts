import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalog, CUSTOM_OBJECT_MARK, findObjectPresets, objectRowsByNumber, OBJECTS_PER_ACT, prettyName, PRESET_ACTS } from '../src/game/objectCatalog';
import type { TxtTable } from '../src/formats/txt';
import { D2_DIR, hasD2 } from '../tools/testdata';

const table = (rows: Record<string, string>[]): TxtTable => ({ columns: Object.keys(rows[0] ?? {}), rows }) as unknown as TxtTable;

/** A fake program file: junk, then the table (Act 1 starting with the signature), then junk. */
function fakeBinary(): Uint8Array {
  const ids = new Int32Array(PRESET_ACTS * OBJECTS_PER_ACT).fill(-1);
  [12, 37, 39, 35, 36, 5, 17, 18].forEach((v, i) => (ids[i] = v));
  ids[OBJECTS_PER_ACT + 3] = 1; // Act 2 id 3 -> row 1
  const out = new Uint8Array(1000 + ids.byteLength + 400);
  out.set(new Uint8Array([12, 0, 0, 0, 37, 0, 0, 0]), 100); // a partial match to skip
  out.set(new Uint8Array(ids.buffer), 1000);
  return out;
}

describe('object catalogue', () => {
  it('finds the object id table in a program file', () => {
    const acts = findObjectPresets(fakeBinary())!;
    expect(acts).toHaveLength(5);
    expect([...acts[0].slice(0, 3)]).toEqual([12, 37, 39]);
    expect(acts[1][3]).toBe(1);
    expect(findObjectPresets(new Uint8Array(5000))).toBeNull();
  });

  it('makes readable names', () => {
    expect(prettyName('RogueFountain')).toBe('Rogue Fountain');
    expect(prettyName('Torch1 Tiki')).toBe('Torch 1 Tiki');
    expect(prettyName('place_fallen')).toBe('Place fallen');
    expect(prettyName('LargeChestR')).toBe('Large Chest R');
  });

  it('numbers objects.txt rows like the game (skipping the Expansion divider) and builds sprites', () => {
    const presets = findObjectPresets(fakeBinary());
    const objects = table([
      { Name: 'Dummy', 'description - not loaded': 'test', Token: 'NU0', Mode0: '1', TR: '1' },
      { Name: 'Expansion', 'description - not loaded': '', Token: '' },
      { Name: 'fire', 'description - not loaded': 'RogueBonfire', Token: 'RB', Mode0: '1', Mode2: '1', CycleAnim2: '1', TR: '1' },
    ]);
    const cat = buildCatalog(presets, { objects, monPreset: null, monStats: null, monStats2: null, superUniques: null });
    const fire = cat.find((e) => e.act === 2 && e.type === 2 && e.id === 3)!;
    // Row 1 counts without the divider: the bonfire, lit (it loops in "ON").
    expect(fire.name).toBe('Rogue Bonfire (1)');
    expect(fire.spec).toMatchObject({ token: 'RB', mode: 'ON', cls: 'HTH', parts: { TR: 'LIT' } });
  });

  it('lists every objects.txt row by number (DS1 ids of 150+ name them directly), custom rows by their own name', () => {
    const objects = table([
      { Name: 'Dummy', 'description - not loaded': 'test', Token: '' },
      { Name: 'Expansion', 'description - not loaded': '', Token: '' },
      { Name: 'fire', 'description - not loaded': 'RogueBonfire', Token: 'RB', TR: '1' },
      { Name: 'dummy', 'description - not loaded': `${CUSTOM_OBJECT_MARK}Lantern`, Token: 'zz', TR: '1' },
    ]);
    const rows = objectRowsByNumber({ objects });
    expect(rows.get(1)).toMatchObject({ name: 'Rogue Bonfire (1)', row: 1 });
    expect(rows.get(2)?.name).toBe('Lantern (custom, 2)');
    expect(rows.has(3)).toBe(false);
  });

  it('names NPCs from MonPreset / MonStats / SuperUniques, and shows spawn spots as their monster', () => {
    const monPreset = table([
      { Act: '1', Place: 'gheed' },
      { Act: '1', Place: 'Bishibosh' },
      { Act: '1', Place: 'place_fallen' },
    ]);
    const monStats = table([
      { Id: 'gheed', NameStr: 'Gheed', Code: 'GH', MonStatsEx: 'gheed' },
      { Id: 'fallen1', NameStr: 'Fallen', Code: 'FA', MonStatsEx: 'fallen1' },
      { Id: 'fallenshaman', NameStr: 'FallenShaman', Code: 'FS', MonStatsEx: 'fallenshaman' },
    ]);
    const monStats2 = table([
      { Id: 'gheed', BaseW: 'hth', TR: '1', TRv: 'lit' },
      { Id: 'fallen1', BaseW: 'hth', TR: '1', TRv: '"lit,med"', RH: '1', RHv: 'axe' },
    ]);
    const superUniques = table([{ Superunique: 'Bishibosh', Class: 'fallenshaman' }]);
    const cat = buildCatalog(null, { objects: null, monPreset, monStats, monStats2, superUniques });
    expect(cat.map((e) => [e.id, e.name])).toEqual([
      [0, 'Gheed'],
      [1, 'Bishibosh'],
      [2, 'Fallen (spawn spot)'],
    ]);
    expect(cat[0].spec).toMatchObject({ base: 'Data\\Global\\Monsters', token: 'GH', mode: 'NU', cls: 'HTH', parts: { TR: 'LIT' } });
    expect(cat[2].spec).toMatchObject({ token: 'FA', parts: { TR: 'LIT', RH: 'AXE' } });
  });
});

describe.runIf(hasD2)('object catalogue from the game', () => {
  it('reads the table from the installed game', () => {
    const exe = `${D2_DIR}/Game.exe`;
    const dll = `${D2_DIR}/D2Common.dll`;
    let bytes: Uint8Array | null = null;
    for (const f of [dll, exe]) {
      try {
        bytes = new Uint8Array(readFileSync(f));
        if (findObjectPresets(bytes)) break;
      } catch {
        // not in this install
      }
    }
    const acts = findObjectPresets(bytes!)!;
    expect(acts).not.toBeNull();
    // Act 1 id 1 is the tiki torch (row 37); every act has entries.
    expect(acts[0][1]).toBe(37);
    for (const act of acts) expect(act.filter((v) => v > 0).length).toBeGreaterThan(50);
  });
});
