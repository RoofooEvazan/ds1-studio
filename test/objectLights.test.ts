import { describe, expect, it } from 'vitest';
import { objectLight } from '../src/game/objectCatalog';
import { MAX_LIGHTS, nearestLights, type SceneLight } from '../src/render/MapRenderer';
import { parseTxt } from '../src/formats/txt';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

const row = (o: Record<string, string>) => ({ Mode0: '1', Mode1: '0', Mode2: '0', CycleAnim2: '0', Red: '0', Green: '0', Blue: '0', Flicker: '0', ...o });

describe('object lights', () => {
  it('takes the light of the mode the object is shown in', () => {
    // A torch: lit in its looping ON mode.
    expect(objectLight(row({ Mode1: '1', Mode2: '1', CycleAnim2: '1', Lit0: '0', Lit1: '19', Lit2: '19', Red: '255', Green: '236', Blue: '176', Flicker: '1' }))).toEqual({ radius: 19, rgb: [255, 236, 176], flicker: true });
    // Candles: only a neutral mode, lit in it.
    expect(objectLight(row({ Lit0: '18', Red: '255', Green: '255', Blue: '213' }))?.radius).toBe(18);
    // A shrine: lit only once used (OP), so not as placed.
    expect(objectLight(row({ Mode1: '1', Mode2: '1', Lit0: '0', Lit1: '17' }))).toBeNull();
    // No colour given: white.
    expect(objectLight(row({ Lit0: '6' }))?.rgb).toEqual([255, 255, 255]);
  });

  it('draws the lights reaching into the view, nearest first, at most MAX_LIGHTS', () => {
    const at = (x: number, y: number, radius = 5): SceneLight => ({ x, y, radius, rgb: [255, 255, 255] });
    const cam = { x: 0, y: 0, zoom: 1 };
    const far = at(5000, 0, 5), reaching = at(650, 0, 10), centre = at(10, 10);
    expect(nearestLights([far, reaching, centre], cam, 1000, 600)).toEqual([centre, reaching]);
    const many = Array.from({ length: MAX_LIGHTS + 20 }, (_, i) => at(i * 5, 0));
    const picked = nearestLights(many, cam, 1000, 600);
    expect(picked.length).toBe(MAX_LIGHTS);
    expect(picked[0]).toBe(many[0]);
  });
});

if (hasD2)
  describe('object lights of the game', async () => {
    const fs = new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))));
    const rows = parseTxt((await fs.read('data/global/excel/objects.txt'))!).rows.filter((r) => r['Name'] !== 'Expansion');
    it('lights torches and candles as placed, not shrines or Cairn Stones', () => {
      const by = (name: string) => objectLight(rows.find((r) => [r['Name'], r['description - not loaded']].some((v) => (v ?? '').toLowerCase() === name.toLowerCase()))!);
      expect(by('Torch1 Tiki')).toMatchObject({ radius: 19, rgb: [255, 236, 176] });
      expect(by('Candles1')?.radius).toBe(18);
      expect(by('Shrine')).toBeNull();
      expect(by('StoneAlpha')).toBeNull();
    });
  });
