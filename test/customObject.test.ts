import { describe, expect, it } from 'vitest';
import { parseCof, writeCof } from '../src/formats/cof';
import { parseTxtTable, serializeTxtTable, getCell } from '../src/formats/txtTable';
import { customObjectFiles, customObjectRow, freeToken, gameRows, guessFrames, rowRecord, startingPoint, objectSlots, presetRow, splitStrip, CUSTOM_MARK, type CustomObjectOptions } from '../src/game/customObject';
import { objectSpec } from '../src/game/objectCatalog';
import { loadSpriteDetailed } from '../src/game/sprites';
import { loadSpriteAnimation } from '../src/game/spriteAnim';
import { LayeredFs, LooseSource, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

const enc = (s: string) => new TextEncoder().encode(s);
/** A tiny objects.txt: a dummy row 0, a used row 1, the Expansion divider, a function row 2 and a plain row 3. */
const OBJECTS = [
  'Name\tdescription - not loaded\tId\tToken\tFrameCnt0\tFrameDelta0\tLit0\tMode0\tOperateFn\tTR\tSelectable0\tExtra',
  'dummy\ttest\t0\t\t0\t0\t0\t0\t0\t0\t0\tkeep',
  'Barrel\tBarrel\t1\tB1\t1\t256\t0\t1\t5\t1\t1\tkeep',
  'Expansion',
  'Portal\tportal\t2\tPP\t1\t256\t0\t1\t0\t1\t1\tkeep',
  'Unused\tunused thing\t3\tUU\t1\t256\t0\t1\t0\t1\t0\tkeep',
].join('\r\n') + '\r\n';
const doc = () => parseTxtTable(enc(OBJECTS));
const OPTS: CustomObjectOptions = { name: 'Lantern', token: 'zz', frames: 4, speed: 128, light: 6, lightColour: [255, 200, 120], flicker: true, blocks: true, size: 2, drawUnder: false, act0: 0 };

describe('custom objects', () => {
  it('numbers objects.txt rows like the game (the Expansion line does not count)', () => {
    expect(gameRows(doc())).toEqual([0, 1, 3, 4]);
  });

  it('resolves ids that spill into the next or previous act', () => {
    const presets = [Int32Array.from({ length: 150 }, (_, i) => i), Int32Array.from({ length: 150 }, (_, i) => 1000 + i)];
    expect(presetRow(presets, 0, 5)).toBe(5);
    expect(presetRow(presets, 0, 155)).toBe(1005);
    expect(presetRow(presets, 1, -145)).toBe(5);
  });

  it('offers only rows nothing uses: no map places them, no group spawns them, no game function', () => {
    const presets = [Int32Array.from({ length: 150 }, (_, i) => (i < 4 ? i : -1))];
    const slots = objectSlots(presets, doc(), 0, new Map([[1, 3]]), new Set([2]));
    expect(slots.map((s) => [s.id, s.row, s.free])).toEqual([[1, 1, false], [2, 2, false], [3, 3, true]]);
    expect(slots[0]).toMatchObject({ uses: 3, functions: true });
    expect(slots[1]).toMatchObject({ inGroup: true });
  });

  it('rewrites a row as a plain decoration and keeps columns it does not know', () => {
    const d = customObjectRow(doc(), 3, OPTS);
    const line = gameRows(d)[3];
    expect(getCell(d, line, 'Name')).toBe('Lantern');
    expect(getCell(d, line, 'description - not loaded')).toBe(CUSTOM_MARK + 'Lantern');
    expect(getCell(d, line, 'Token')).toBe('zz');
    expect(getCell(d, line, 'FrameCnt0')).toBe('4');
    expect(getCell(d, line, 'OperateFn')).toBe('0');
    expect(getCell(d, line, 'Selectable0')).toBe('0');
    expect(getCell(d, line, 'Extra')).toBe('keep');
    // Other rows and the file's line endings are untouched.
    expect(new TextDecoder().decode(serializeTxtTable(d)).split('\r\n').filter((l, i) => i !== 5)).toEqual(OBJECTS.split('\r\n').filter((l, i) => i !== 5));
    // The custom row is offered again (to edit) even if a map uses it now.
    const presets = [Int32Array.from({ length: 150 }, (_, i) => (i < 4 ? i : -1))];
    expect(objectSlots(presets, d, 0, new Map([[3, 2]]), new Set()).find((s) => s.row === 3)).toMatchObject({ custom: true, free: true, name: 'Lantern' });
  });

  it('guesses the frames of a strip from the gaps between them', () => {
    // Three 8-wide frames, each a 2-wide post in its middle (x 3-4): the 2-frame cut would split a post.
    const strip = (x: number) => x % 8 === 3 || x % 8 === 4;
    expect(guessFrames(24, 4, (x) => strip(x))).toBe(3);
    // Two drawings with a gap between them read as two frames (the preview shows it, and the count can be changed).
    expect(guessFrames(16, 16, (x) => x === 3 || x === 12)).toBe(2);
    expect(guessFrames(16, 8, (x) => x === 3 || x === 12)).toBe(2);
    expect(guessFrames(9, 9, () => true)).toBe(1);
  });

  it('cuts a strip into frames', () => {
    const px = Uint8Array.from({ length: 6 * 2 }, (_, i) => i);
    const f = splitStrip(6, 2, px, 3);
    expect(f.map((x) => [...x.pixels])).toEqual([[0, 1, 6, 7], [2, 3, 8, 9], [4, 5, 10, 11]]);
    expect(() => splitStrip(7, 2, new Uint8Array(14), 3)).toThrow(/divides/);
  });

  it('writes a COF that reads back the same', () => {
    const c = { directions: 1, framesPerDir: 3, animationRate: 256, box: { xMin: -20, xMax: 20, yMin: -40, yMax: 0 }, layers: [{ component: 1, shadow: true, selectable: false, transparent: false, drawEffect: 0, weaponClass: 'hth' }] };
    const back = parseCof(writeCof(c));
    expect(back).toMatchObject(c);
    expect([...back.priority]).toEqual([1, 1, 1]);
  });

  it('makes graphics the editor (and the game, the same way) loads: the picture comes back where it stands', async () => {
    const frames = splitStrip(8, 3, Uint8Array.from({ length: 24 }, (_, i) => (i % 8 < 4 ? 10 + (i % 4) : 20 + (i % 4))), 2);
    const files = customObjectFiles('zz', frames, 2);
    expect(files.map((f) => f.path)).toEqual(['data/global/objects/zz/cof/zznuhth.cof', 'data/global/objects/zz/tr/zztrlitnuhth.dc6']);
    const fs = new LayeredFs([new LooseSource('mod', new Map(files.map((f) => [f.path, async () => f.bytes])))]);
    const d = customObjectRow(doc(), 3, { ...OPTS, frames: 2 });
    const row = Object.fromEntries(d.columns.map((c, i) => [c, d.rows[gameRows(d)[3]][i] ?? '']));
    const spec = objectSpec(row)!;
    expect(spec).toMatchObject({ token: 'zz', mode: 'NU', cls: 'HTH', parts: { TR: 'LIT' } });
    const first = await loadSpriteDetailed(fs, spec, 0, 0);
    expect(first.missing).toEqual([]);
    expect(first.sprite).toMatchObject({ width: 4, height: 3, offsetX: -2, offsetY: -1 });
    expect([...first.sprite!.pixels]).toEqual([...frames[0].pixels]);
    const second = await loadSpriteDetailed(fs, spec, 0, 1);
    expect([...second.sprite!.pixels]).toEqual([...frames[1].pixels]);
  });
});

describe('starting from an existing object', () => {
  it('takes the settings of the mode the object is shown in', () => {
    const row = { FrameDelta2: '128', Lit2: '9', Red: '255', Green: '120', Blue: '40', Flicker: '1', HasCollision2: '1', SizeX: '3', DrawUnder: '0', Lit0: '0' };
    const p = startingPoint({ frames: [{ width: 20, height: 50, pixels: new Uint8Array(1000) }], offsetX: -10, offsetY: -40, height: 50, fps: 10 }, row, 'ON');
    expect(p).toMatchObject({ anchorX: 10, feet: 10, fps: 13, light: 9, lightColour: [255, 120, 40], flicker: true, blocks: true, size: 3, drawUnder: false });
  });

  it('reads one of yours back exactly: frames, spot and settings', async () => {
    const frames = splitStrip(12, 5, Uint8Array.from({ length: 60 }, (_, i) => (i % 6 ? 30 + (i % 4) : 0)), 2);
    const files = customObjectFiles('zq', frames, 3, 2);
    const fs = new LayeredFs([new LooseSource('mod', new Map(files.map((f) => [f.path, async () => f.bytes])))]);
    const d = customObjectRow(doc(), 3, { ...OPTS, token: 'zq', frames: 2, speed: 128, light: 4, flicker: false, blocks: false });
    const row = rowRecord(d, gameRows(d)[3]);
    const spec = objectSpec(row)!;
    const anim = (await loadSpriteAnimation(fs, spec, 0))!;
    const p = startingPoint(anim, row, spec.mode);
    expect(p).toMatchObject({ anchorX: 2, feet: 3, fps: 13, light: 4, flicker: false, blocks: false });
    expect(p.frames.map((f) => [...f.pixels])).toEqual(frames.map((f) => [...f.pixels]));
    // Saved again from that starting point, the graphics are the same files.
    expect(customObjectFiles('zq', p.frames, p.feet, p.anchorX)).toEqual(files);
  });
});

// Only when the game is installed (the suite opens its MPQs while it is collected).
if (hasD2) describe('custom objects and the game files', async () => {
  const fs = new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))));
  it('writes COFs laid out like the game’s own', async () => {
    const own = (await fs.read('data/global/objects/rb/cof/rbnuhth.cof'))!;
    expect(writeCof(parseCof(own))).toEqual(own);
  });
  it('picks a token no object uses', async () => {
    const objects = parseTxtTable((await fs.read('data/global/excel/objects.txt'))!);
    const t = freeToken(fs, objects);
    expect(t).toMatch(/^[a-z0-9]{2}$/);
    expect(objects.rows.some((_, i) => getCell(objects, i, 'Token').toLowerCase() === t)).toBe(false);
  });
});
