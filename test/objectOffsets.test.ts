import { describe, expect, it } from 'vitest';
import { GameData } from '../src/game/GameData';
import { objectRowsByNumber } from '../src/game/objectCatalog';
import type { TxtTable } from '../src/formats/txt';
import { loadObjectSprite } from '../src/game/sprites';
import { loadSpriteAnimation } from '../src/game/spriteAnim';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { binarySource, D2_DIR, hasD2 } from '../tools/testdata';

describe('objects.txt draw offsets', () => {
  it('reads Xoffset / Yoffset for each row (0 when blank)', () => {
    const objects = { rows: [{ Name: 'chan', Token: '2z', Xoffset: '', Yoffset: '-130' }, { Name: 'Expansion' }, { Name: 'door', Token: 'D1', Xoffset: '1', Yoffset: '4' }] } as unknown as TxtTable;
    const rows = objectRowsByNumber({ objects });
    expect([rows.get(0)?.drawOffset, rows.get(1)?.drawOffset]).toEqual([[0, -130], [1, 4]]);
  });
});

if (hasD2)
  describe('objects drawn where the game draws them (objects.txt Xoffset / Yoffset)', async () => {
    const fs = new LayeredFs([binarySource(), ...(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))]);
    const gd = await GameData.load(fs);
    // The chandelier is objects.txt row 442 (Yoffset -130): placed by id 150 + 442 in any act.
    const CHANDELIER = 150 + 442;

    it('hangs the chandelier 130 pixels up, sprite and animation alike', async () => {
      const spec = gd.objectSpec(0, 2, CHANDELIER)!;
      expect(spec.token.toLowerCase()).toBe('2z');
      const raw = (await loadObjectSprite(fs, spec))!;
      const drawn = (await gd.objectSprite(0, 2, CHANDELIER))!;
      expect([drawn.offsetX - raw.offsetX, drawn.offsetY - raw.offsetY]).toEqual([0, -130]);
      const rawAnim = (await loadSpriteAnimation(fs, spec))!;
      const anim = (await gd.objectAnimation(0, 2, CHANDELIER))!;
      expect(anim.offsetY - rawAnim.offsetY).toBe(-130);
      expect(anim.parts[0][0].image.offsetY - rawAnim.parts[0][0].image.offsetY).toBe(-130);
      expect(anim.frames[0].offsetY - rawAnim.frames[0].offsetY).toBe(-130);
    });
  });
