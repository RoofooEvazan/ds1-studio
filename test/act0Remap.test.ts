import { describe, expect, it } from 'vitest';
import { D2_DIR, hasD2 } from '../tools/testdata';
import { act0Remap } from '../src/game/act0Palette';

describe('Act 0 conversion', () => {
  it('snaps each colour to the nearest allowed one by plain RGB distance, ties to the lowest index', () => {
    const pal = new Uint8Array(256 * 4);
    const set = (i: number, r: number, g: number, b: number) => pal.set([r, g, b, 255], i * 4);
    set(1, 12, 12, 8); // allowed
    set(2, 24, 16, 8); // allowed, same RGB distance from slot 3 as slot 1 (a tie)
    set(3, 16, 20, 8); // act-specific
    set(4, 116, 100, 60); // allowed
    set(5, 100, 88, 52); // allowed: nearer by the perceptual measure, farther by plain RGB
    set(6, 112, 92, 52); // act-specific
    const usable = Array.from({ length: 256 }, (_, i) => [1, 2, 4, 5].includes(i));
    const r = act0Remap(pal, usable);
    expect(r[3]).toBe(1);
    expect(r[6]).toBe(4);
    // Allowed colours stay as they are.
    expect([r[1], r[2], r[4], r[5]]).toEqual([1, 2, 4, 5]);
  });
});

describe('the act a tile library was drawn for', () => {
  it('comes from its folder: ACT1-4 and expansion; other folders (Guild too) are judged by their art', async () => {
    const { dt1Act } = await import('../src/game/act0Palette');
    expect(dt1Act('data/global/tiles/ACT3/Kurast/huts.dt1')).toBe(2);
    expect(dt1Act('data/global/tiles/expansion/Siege/snow.dt1')).toBe(4);
    expect(dt1Act('data/global/tiles/Guild/outdoors/cliff.dt1')).toBeNull();
    expect(dt1Act('data/global/tiles/PD2assets/cust/int.dt1')).toBeNull();
  });

  it('picks the classic Act 5 palette only by a clear margin', async () => {
    const { pickDrawnAct } = await import('../src/game/openMap');
    // Act 1 art often scores a little better under the classic palette: still Act 1.
    expect(pickDrawnAct([10, 30, 30, 30, 30, 8.5])).toBe(0);
    expect(pickDrawnAct([10, 30, 30, 30, 30, 6])).toBe(5);
    // Without the sixth palette, as before.
    expect(pickDrawnAct([30, 30, 12, 30, 30])).toBe(2);
  });
});

// Only when the game is installed (the suite opens its MPQs while it is collected).
if (hasD2) describe('art drawn for the classic Act 5 palette', async () => {
  const { LayeredFs, MpqSource } = await import('../src/vfs/vfs');
  const { NodeFileAccess } = await import('../tools/nodeAccess');
  const { GameData } = await import('../src/game/GameData');
  const { parseDt1 } = await import('../src/formats/dt1');
  const { drawnPalettes, guessDrawnAct } = await import('../src/game/openMap');
  const fs = new LayeredFs(await Promise.all(['d2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))));
  const gd = await GameData.load(fs);
  const pals = await drawnPalettes(gd);
  const guess = async (p: string) => guessDrawnAct(parseDt1((await fs.read(p))!).tiles, pals);

  it("recognises Blizzard's unused guild tiles", async () => {
    for (const f of ['outdoors/floor', 'outdoors/trees', 'cottages/cottwalls', 'house2/roof']) expect(await guess(`data/global/tiles/guild/${f}.dt1`)).toBe(5);
  });

  it('keeps real Act 1 and Act 5 art in their own act', async () => {
    expect(await guess('data/global/tiles/act1/catacomb/floor.dt1')).toBe(0);
    expect(await guess('data/global/tiles/act1/court/outwall.dt1')).toBe(0);
    expect(await guess('data/global/tiles/expansion/siege/ground.dt1')).not.toBe(5);
  });
});
