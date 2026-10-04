import { describe, expect, it } from 'vitest';
import { decodeTile, parseDt1 } from '../src/formats/dt1';
import { cropToTile, droppedPixelCount, editedDt1Problem, setManyTilePixels } from '../src/formats/dt1Paint';
import { getCell, parseTxtTable } from '../src/formats/txtTable';
import { loadLevelTables, planSwapLibraries } from '../src/game/levelTables';
import { LayeredFs, LooseSource, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

const enc = (s: string) => new TextEncoder().encode(s);
const EX = 'data/global/excel/';
const MAP = 'data/global/tiles/Act1/Test/mymap.ds1';
const fileCols = Array.from({ length: 32 }, (_, i) => `File ${i + 1}`);

/** Level type 1 with a, b, c; my map (level 5) loads all three, another level's map (6) loads a and c. */
function tables(drlgType = 2) {
  const files = ['Act1/Test/a.dt1', 'Act1/Test/b.dt1', 'Act1/Test/c.dt1'];
  const types = `Name\tId\t${fileCols.join('\t')}\r\nTest\t1\t${fileCols.map((_, i) => files[i] ?? '0').join('\t')}\r\n`;
  const levels = `Name\tId\tLevelType\tDrlgType\r\nMine\t5\t1\t2\r\nOther\t6\t1\t${drlgType}\r\n`;
  const prest = 'Name\tDef\tLevelId\tFile1\tFile2\tFile3\tFile4\tFile5\tFile6\tDt1Mask\r\nMy Map\t10\t5\tAct1/Test/mymap.ds1\t0\t0\t0\t0\t0\t7\r\nOther Map\t11\t6\tAct1/Test/other.ds1\t0\t0\t0\t0\t0\t5\r\n';
  return new LayeredFs([new LooseSource('test', new Map([[`${EX}LvlTypes.txt`, async () => enc(types)], [`${EX}Levels.txt`, async () => enc(levels)], [`${EX}LvlPrest.txt`, async () => enc(prest)]]))]);
}
const tile = (p: string) => `data/global/tiles/${p}`;

describe('library load order', () => {
  it('swaps two libraries in the level type, and every map of the type keeps its libraries', async () => {
    const writes = planSwapLibraries(await loadLevelTables(tables()), MAP, tile('Act1/Test/a.dt1'), tile('Act1/Test/b.dt1'));
    const types = parseTxtTable(writes.find((w) => w.table === 'LvlTypes.txt')!.bytes);
    expect([getCell(types, 0, 'File 1'), getCell(types, 0, 'File 2'), getCell(types, 0, 'File 3')]).toEqual(['Act1/Test/b.dt1', 'Act1/Test/a.dt1', 'Act1/Test/c.dt1']);
    const prest = parseTxtTable(writes.find((w) => w.table === 'LvlPrest.txt')!.bytes);
    // My map loads all three either way; the other map's a.dt1 moved from bit 0 to bit 1 (a + c = 2 + 4).
    expect([getCell(prest, 0, 'Dt1Mask'), getCell(prest, 1, 'Dt1Mask')]).toEqual(['7', '6']);
  });

  it("won't reorder a type maze or outdoor levels use (they pick tiles by slot)", async () => {
    await expect(async () => planSwapLibraries(await loadLevelTables(tables(1)), MAP, tile('Act1/Test/a.dt1'), tile('Act1/Test/b.dt1'))).rejects.toThrow(/maze or outdoor/);
  });
});

if (hasD2)
  describe('floor pictures and the save check', async () => {
    const fs = new LayeredFs([await MpqSource.open('d2data.mpq', new NodeFileAccess(`${D2_DIR}/d2data.mpq`))]);
    const bytes = (await fs.read('data/global/tiles/act1/town/floor.dt1'))!;
    const dt1 = parseDt1(bytes);
    const full = (i: number) => {
      const g = decodeTile(dt1.tiles[i])!;
      return { ...g, pixels: new Uint8Array(g.width * g.height).fill(7) };
    };

    it('cuts a floor picture to its diamond, so the preview is what gets saved', () => {
      const image = full(0);
      expect(droppedPixelCount(dt1.tiles[0], image)).toBeGreaterThan(0);
      const cut = cropToTile(dt1.tiles[0], image);
      expect(droppedPixelCount(dt1.tiles[0], cut)).toBe(0);
      const saved = decodeTile(parseDt1(setManyTilePixels(bytes, [{ tileIndex: 0, image: cut }])).tiles[0])!;
      expect([...saved.pixels]).toEqual([...cut.pixels]);
    });

    it('passes a good edit and stops a broken or overreaching one before it is written', () => {
      const out = setManyTilePixels(bytes, [{ tileIndex: 0, image: cropToTile(dt1.tiles[0], full(0)) }]);
      expect(editedDt1Problem(bytes, out, new Set([0]))).toBeNull();
      expect(editedDt1Problem(bytes, out, new Set([1]))).toMatch(/tile 0 changed although/);
      expect(editedDt1Problem(bytes, out.slice(0, 200), new Set([0]))).toMatch(/doesn't read back/);
      const fewer = out.slice();
      new DataView(fewer.buffer).setInt32(268, dt1.tiles.length - 1, true);
      expect(editedDt1Problem(bytes, fewer, new Set([0]))).toMatch(/tiles instead of/);
    });
  });
