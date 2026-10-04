import { describe, expect, it } from 'vitest';
import { parseDs1 } from '../src/formats/ds1';
import { getCell, parseTxtTable, serializeTxtTable, type TxtTableDoc } from '../src/formats/txtTable';
import { dataRows, ENTRY_IMAGE_DIR, levelSizeFix, planAddToGame, rowOfRecord, verifyInGame, type AddToGamePlan } from '../src/game/addToGame';
import { GameData } from '../src/game/GameData';
import { LayeredFs, MpqSource, normalizePath } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { D2_DIR, hasD2 } from '../tools/testdata';

describe.runIf(hasD2)('Add to game, checked against the vanilla tables', async () => {
  const fs = hasD2
    ? new LayeredFs(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))
    : null!;
  const load = async (n: string) => parseTxtTable((await fs.read(`data/global/excel/${n}`))!);
  const tables = hasD2 ? { prest: await load('LvlPrest.txt'), levels: await load('Levels.txt'), types: await load('LvlTypes.txt') } : null!;
  const gd = hasD2 ? await GameData.load(fs) : null!;
  const ds1Of = async (rel: string) => parseDs1((await fs.read(`data/global/tiles/${rel}`))!);
  const num = (s: string) => Number(s) || 0;
  /** The DT1s a map loads in game: its level type's File slots selected by its preset's Dt1Mask. */
  const dt1sOf = (rel: string) => {
    const r = dataRows(tables.prest).find((x) => [1, 2, 3, 4, 5, 6].some((i) => normalizePath(getCell(tables.prest, x, `File${i}`)) === normalizePath(rel)))!;
    const level = rowOfRecord(tables.levels, num(getCell(tables.prest, r, 'LevelId')));
    const type = gd.lvlType(num(getCell(tables.levels, level, 'LevelType')))!;
    return GameData.dt1sFor(type, num(getCell(tables.prest, r, 'Dt1Mask')) >>> 0);
  };
  const apply = (plan: AddToGamePlan) => {
    const next = { ...tables };
    for (const w of plan.writes) {
      const doc = parseTxtTable(w.bytes);
      if (w.table === 'LvlPrest.txt') next.prest = doc;
      if (w.table === 'Levels.txt') next.levels = doc;
      if (w.table === 'LvlTypes.txt') next.types = doc;
    }
    return next;
  };
  const same = (a: TxtTableDoc, b: TxtTableDoc, except: number[]) => a.rows.every((r, i) => except.includes(i) || r.join('\t') === b.rows[i]?.join('\t'));
  const entryImageExists = (name: string) => !!fs.locate(normalizePath(`${ENTRY_IMAGE_DIR}${name}.dc6`));

  it('the rules hold for every preset level of the game (no false alarms)', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const lr of dataRows(tables.levels)) {
      if (getCell(tables.levels, lr, 'DrlgType') !== '2') continue;
      const id = num(getCell(tables.levels, lr, 'Id'));
      const pr = dataRows(tables.prest).find((r) => num(getCell(tables.prest, r, 'LevelId')) === id)!;
      const rel = getCell(tables.prest, pr, 'File1');
      if (!rel || rel === '0') continue; // Lut Gholein picks its map in code
      const ds1 = await ds1Of(rel);
      checked++;
      for (const p of verifyInGame(tables, rel, ds1, { entryImageExists })) if (p.severity !== 'info') problems.push(`${id} ${rel}: ${p.title}`);
    }
    expect(checked).toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });

  it('catches what the old Add to game wrote (row inserted mid-table, size = DS1 size, Act 1 row in Act 5)', async () => {
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const { cloneRow, setCell, appendRow } = await import('../src/formats/txtTable');
    const tpl = rowOfRecord(tables.levels, 38);
    let levels = cloneRow(tables.levels, tpl);
    levels = setCell(levels, tpl + 1, 'Id', '137');
    levels = setCell(levels, tpl + 1, 'SizeX', String(ds1.width));
    const prest = appendRow(tables.prest, { Name: 'x', Def: String(dataRows(tables.prest).length), LevelId: '137', Files: '1', File1: rel, Dt1Mask: '1' });
    // Inserted after its template: every later level shifts (the game would read record 137 as the old level 136).
    expect(verifyInGame({ ...tables, levels, prest }, rel, ds1).map((p) => p.title).join(' | ')).toMatch(/Levels\.txt: row 39 has Id 137/);
    // Appended correctly but copied as-is: DS1 size and the template's Act 1 values.
    const values = Object.fromEntries(tables.levels.columns.map((c, i) => [c, tables.levels.rows[tpl][i] ?? '']));
    let appended = appendRow(tables.levels, { ...values, Id: '137', SizeX: String(ds1.width), 'SizeX(N)': String(ds1.width), 'SizeX(H)': String(ds1.width) });
    appended = setCell(appended, appended.rows.length - 1, 'Pal', '4');
    const titles = verifyInGame({ ...tables, levels: appended, prest }, rel, ds1).map((p) => p.title).join(' | ');
    expect(titles).toMatch(/size .* doesn't match/);
    expect(titles).toMatch(/says Act 1, but the game treats it as Act 5/);
    expect(titles).toMatch(/Act 5 palette but its tiles are Act 1 tiles/);
    expect(titles).toMatch(/overlaps level 136 "Act 5 - Pandemonium Finale"/);
    // A level the mod's own MPQ doesn't have, in the Act 5 slot: PD2 drew such levels in the Act 5 palette whatever Pal
    // said, so the advice is the tiles, not Pal (and Pal 0 doesn't silence it). Said only when the art shows the act.
    for (const pal of ['4', '0']) {
      const pick = { ...tables, levels: setCell(appended, appended.rows.length - 1, 'Pal', pal), prest };
      const newLevel = verifyInGame(pick, rel, ds1, { isNewLevel: (id) => id === 137, tilesAct: 0 }).map((p) => p.title).join(' | ');
      expect(newLevel).toMatch(/Level 137 is a new level in the Act 5 slot, but its tiles are Act 1 tiles/);
      expect(newLevel).not.toMatch(/palette but its tiles are/);
      expect(verifyInGame(pick, rel, ds1, { isNewLevel: (id) => id === 137 }).map((p) => p.title).join(' | ')).not.toMatch(/its tiles are/);
    }
  });

  it('offers to put a table back in order when a row was inserted mid-table, without changing any Id', async () => {
    const { cloneRow, setCell, appendRow } = await import('../src/formats/txtTable');
    const { recordOrderFix, appendAt } = await import('../src/game/addToGame');
    const tpl = rowOfRecord(tables.levels, 38);
    // What the old Add to game did: a copy of level 38, numbered 137, inserted right after it.
    const broken = setCell(cloneRow(tables.levels, tpl), tpl + 1, 'Id', '137');
    // What it should have done: the same row at the end.
    const values = Object.fromEntries(tables.levels.columns.map((c, i) => [c, tables.levels.rows[tpl][i] ?? '']));
    const right = appendAt(tables.levels, { ...values, Id: '137' }).doc;
    const fix = recordOrderFix('Levels.txt', broken, 'Id');
    if (!fix || typeof fix === 'string') throw new Error(String(fix));
    const fixed = parseTxtTable(fix.writes[0].bytes);
    expect(fixed.rows.map((r) => r.join('\t'))).toEqual(right.rows.map((r) => r.join('\t')));
    expect(dataRows(fixed).every((r, i) => getCell(fixed, r, 'Id') === String(i))).toBe(true);
    expect(fix.label).toMatch(/99 rows move, no Id changes/);
    // The verifier offers it.
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    expect(verifyInGame({ ...tables, levels: broken }, rel, await ds1Of(rel))[0].fix?.label).toBe(fix.label);
    // Duplicated or missing Ids can't be fixed by moving rows: explained instead.
    expect(recordOrderFix('Levels.txt', setCell(tables.levels, rowOfRecord(tables.levels, 5), 'Id', '4'), 'Id')).toMatch(/used twice: 4.*missing: 5/);
    expect(recordOrderFix('Levels.txt', tables.levels, 'Id')).toBeNull();
  });

  it('offers fixes for a wrong level size and a preset pointing at a level that does not exist', async () => {
    const { setCell } = await import('../src/formats/txtTable');
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const L = rowOfRecord(tables.levels, 38);
    const levels = setCell(tables.levels, L, 'SizeX', '44');
    const size = verifyInGame({ ...tables, levels }, rel, ds1).find((i) => /size/.test(i.title))!;
    const fixedLevels = parseTxtTable(size.fix!.writes[0].bytes);
    expect(['', '(N)', '(H)'].map((s) => `${getCell(fixedLevels, L, `SizeX${s}`)}x${getCell(fixedLevels, L, `SizeY${s}`)}`)).toEqual(['43x48', '43x48', '43x48']);
    // A preset named like a level but pointing past the end of Levels.txt.
    const P = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '38')!;
    let prest = setCell(tables.prest, P, 'LevelId', '999');
    prest = setCell(prest, P, 'Name', 'Act 1 - Tristram');
    const missing = verifyInGame({ ...tables, prest }, rel, ds1).find((i) => /doesn't have/.test(i.title))!;
    expect(missing.fix?.label).toBe('Point it at level 38 "Act 1 - Tristram"');
    expect(getCell(parseTxtTable(missing.fix!.writes[0].bytes), P, 'LevelId')).toBe('38');
  });

  it('asks whether a quest should lock the level (Rite of Passage: keep it for maps), once', async () => {
    const { setCell } = await import('../src/formats/txtTable');
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const L = rowOfRecord(tables.levels, 38);
    const levels = setCell(setCell(tables.levels, L, 'QuestFlag', '39'), L, 'QuestFlagEx', '39');
    const ask = verifyInGame({ ...tables, levels }, rel, ds1).find((i) => /Rite of Passage/.test(i.title))!;
    expect(ask.title).toBe('Should players have to finish Rite of Passage (the Ancients) before entering this map?');
    expect(ask.detail).toMatch(/for a typical map, keep it/);
    expect(ask.keep).toEqual({ key: 'quest:38:39', label: 'Yes, keep it (usual for maps)' });
    const removed = parseTxtTable(ask.fix!.writes[0].bytes);
    expect([getCell(removed, L, 'QuestFlag'), getCell(removed, L, 'QuestFlagEx')]).toEqual(['', '']);
    // Answered "keep": not asked again, only noted (removing stays possible).
    const kept = verifyInGame({ ...tables, levels }, rel, ds1, { kept: (k) => k === 'quest:38:39' }).find((i) => /Rite of Passage/.test(i.title))!;
    expect(kept.title).toMatch(/you chose to keep this/);
    expect(kept.keep).toBeUndefined();
    // The game's own quest-locked levels use the quests these names say.
    const { QUEST_NAMES } = await import('../src/game/addToGame');
    const names = dataRows(tables.levels).map((r) => [getCell(tables.levels, r, 'Name'), QUEST_NAMES[num(getCell(tables.levels, r, 'QuestFlag'))]]).filter(([, q]) => q);
    expect(names).toContainEqual(['Act 5 - Baal Temple 1', 'Rite of Passage (the Ancients)']);
    expect(names).toContainEqual(['Act 2 - Valley of the Kings', 'The Summoner']);
    expect(names).toContainEqual(['Act 1 - Moo Moo Farm', "Terror's End (Diablo)"]);
    expect(names).toContainEqual(['Act 3 - Mephisto 1', 'The Blackened Temple']);
  });

  it('flags AutoMap 1 on a level that is not a town (it crashes the game on entry), with a fix', async () => {
    const { setCell } = await import('../src/formats/txtTable');
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const P = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '38')!;
    const issue = verifyInGame({ ...tables, prest: setCell(tables.prest, P, 'AutoMap', '1') }, rel, await ds1Of(rel)).find((i) => /AutoMap/.test(i.title))!;
    expect(issue.severity).toBe('error');
    expect(getCell(parseTxtTable(issue.fix!.writes[0].bytes), P, 'AutoMap')).toBe('0');
    // Towns keep theirs.
    const town = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '1')!;
    expect(getCell(tables.prest, town, 'AutoMap')).toBe('1');
  });

  it('a new level: appended as the next record, every field set, and it passes the checks', async () => {
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const levelCount = dataRows(tables.levels).length;
    const prestCount = dataRows(tables.prest).length;
    const plan = planAddToGame(tables, { mode: 'new', levelId: 109, name: 'My Town', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.newLevelId).toBe(levelCount);
    const next = apply(plan);
    // Nothing else moved: every old row is unchanged, the new ones are the next records.
    expect(same(tables.levels, next.levels, [])).toBe(true);
    expect(same(tables.prest, next.prest, [])).toBe(true);
    expect(dataRows(next.levels)).toHaveLength(levelCount + 1);
    expect(dataRows(next.prest)).toHaveLength(prestCount + 1);
    const L = rowOfRecord(next.levels, levelCount);
    const cell = (c: string) => getCell(next.levels, L, c);
    expect(cell('Id')).toBe(String(levelCount));
    expect(cell('Name')).toBe('My Town');
    expect(cell('Act')).toBe('4');
    expect(cell('Pal')).toBe('4');
    expect(cell('DrlgType')).toBe('2');
    expect(cell('LevelType')).toBe(getCell(tables.levels, rowOfRecord(tables.levels, 109), 'LevelType'));
    for (const s of ['', '(N)', '(H)']) expect([cell(`SizeX${s}`), cell(`SizeY${s}`)]).toEqual(['40', '40']);
    expect(cell('Waypoint')).toBe('255');
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => cell(`Vis${i}`))).toEqual(Array(8).fill('0'));
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => cell(`Warp${i}`))).toEqual(Array(8).fill('-1'));
    expect(cell('QuestFlag')).toBe('');
    expect(cell('Depend')).toBe('0');
    // The automap layer stays the template's (level 109), within the game's 0-100: counting up past 100 crashes the game.
    expect(cell('Layer')).toBe(getCell(tables.levels, rowOfRecord(tables.levels, 109), 'Layer'));
    expect(Number(cell('Layer'))).toBeLessThanOrEqual(100);
    expect([cell('LevelName'), cell('LevelWarp'), cell('EntryFile')]).toEqual(['My Town', 'My Town', 'A5L1']); // EntryFile is an image: Harrogath's, kept
    const P = rowOfRecord(next.prest, prestCount);
    const pc = (c: string) => getCell(next.prest, P, c);
    expect([pc('Def'), pc('LevelId'), pc('File1'), pc('Files'), pc('FillBlanks'), pc('Scan'), pc('AutoMap'), pc('SizeX'), pc('SizeY'), pc('Expansion')]).toEqual([
      String(prestCount),
      String(levelCount),
      rel,
      '1',
      '1',
      '1',
      '0',
      '0',
      '0',
      '1',
    ]);
    // Flags come from the template level's preset (Harrogath's).
    const town = dataRows(tables.prest).find((r) => getCell(tables.prest, r, 'LevelId') === '109')!;
    for (const c of ['Populate', 'Logicals', 'Outdoors', 'Animate', 'KillEdge']) expect(pc(c)).toBe(getCell(tables.prest, town, c));
    expect(pc('Dt1Mask')).toBe(getCell(tables.prest, town, 'Dt1Mask'));
    // The game would load it: the checks find nothing.
    expect(verifyInGame(next, rel, ds1).filter((p) => p.severity !== 'info')).toEqual([]);
    // Every change is listed for the dialog.
    expect(plan.changes.some((c) => c.table === 'Levels.txt' && c.column === 'OffsetX')).toBe(true);
  });

  it('keeps new levels inside the automap range and flags one too far out (the game halts once a unit is put on the automap)', async () => {
    const { setCell } = await import('../src/formats/txtTable');
    const { automapFits } = await import('../src/game/addToGame');
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const plan = planAddToGame(tables, { mode: 'new', levelId: 109, name: 'Far', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const L = rowOfRecord(next.levels, plan.newLevelId!);
    const at = (d: TxtTableDoc) => ['OffsetX', 'OffsetY'].map((c) => num(getCell(d, L, c)));
    const [x, y] = at(next.levels);
    expect(automapFits(x, y, ds1.width - 1, ds1.height - 1)).toBe(true);
    // Where DS1 Studio used to put guild3: x - y is 7040 tiles, past the 16-bit automap range.
    const far = { ...next, levels: setCell(setCell(next.levels, L, 'OffsetX', '8000'), L, 'OffsetY', '1000') };
    const issue = verifyInGame(far, rel, ds1).find((i) => /too far out/.test(i.title))!;
    expect(issue.severity).toBe('error');
    const moved = parseTxtTable(issue.fix!.writes[0].bytes);
    const [mx, my] = at(moved);
    expect(automapFits(mx, my, ds1.width - 1, ds1.height - 1)).toBe(true);
    expect(verifyInGame({ ...far, levels: moved }, rel, ds1).filter((p) => p.severity !== 'info')).toEqual([]);
    // The middle of every level of the game is inside (the Arcane Sanctuary's empty far corner is not: 4200 > 4095).
    for (const r of dataRows(tables.levels)) {
      const [ox, oy, w, h] = ['OffsetX', 'OffsetY', 'SizeX', 'SizeY'].map((c) => num(getCell(tables.levels, r, c)));
      if (ox > 0 && !num(getCell(tables.levels, r, 'Depend'))) expect(automapFits(ox + Math.floor(w / 2), oy + Math.floor(h / 2), 0, 0)).toBe(true);
    }
  });

  it('flags a loading-screen image the game cannot open (empty or missing EntryFile crashes on the loading screen), with a fix', async () => {
    const { setCell } = await import('../src/formats/txtTable');
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const L = rowOfRecord(tables.levels, 109);
    expect(entryImageExists(getCell(tables.levels, L, 'EntryFile'))).toBe(true); // Harrogath's A5L1 is in the game
    for (const [value, title] of [
      ['', /EntryFile is empty/],
      ['guild3', /loading-screen image guild3\.dc6 doesn't exist/],
    ] as const) {
      const levels = setCell(tables.levels, L, 'EntryFile', value);
      const issue = verifyInGame({ ...tables, levels }, rel, ds1, { entryImageExists }).find((i) => /loading screen/.test(i.title))!;
      expect(issue.title).toMatch(title);
      expect(issue.severity).toBe('error');
      expect(getCell(parseTxtTable(issue.fix!.writes[0].bytes), L, 'EntryFile')).toBe('A5L1');
    }
    // Without a way to look images up, only the empty one is flagged.
    expect(verifyInGame({ ...tables, levels: setCell(tables.levels, L, 'EntryFile', 'guild3') }, rel, ds1).some((i) => /loading screen/.test(i.title))).toBe(false);
  });

  it('a new level from an Act 1-4 template gets an Act 5 loading screen (its own image is not where Act 5 levels look)', async () => {
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const plan = planAddToGame(tables, { mode: 'new', levelId: 38, name: 'Old Tristram', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const entry = getCell(next.levels, rowOfRecord(next.levels, plan.newLevelId!), 'EntryFile');
    expect(entry).toBe('A5L1');
    expect(entryImageExists(entry)).toBe(true);
    expect(entryImageExists(getCell(tables.levels, rowOfRecord(tables.levels, 38), 'EntryFile'))).toBe(false); // A1L39: not there
  });

  it('a new level with another act\'s tiles keeps their palette (like the game\'s Uber Tristram)', async () => {
    const rel = 'Act1/Tristram/Tri_Town4.ds1';
    const ds1 = await ds1Of(rel);
    const plan = planAddToGame(tables, { mode: 'new', levelId: 38, name: 'Old Tristram', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const L = rowOfRecord(next.levels, plan.newLevelId!);
    expect([getCell(next.levels, L, 'Act'), getCell(next.levels, L, 'Pal')]).toEqual(['4', '0']);
    expect(plan.warnings.join(' ')).toMatch(/Act 1 palette/);
    expect(verifyInGame(next, rel, ds1).filter((p) => p.severity !== 'info')).toEqual([]);
  });

  const filesOf = (types: TxtTableDoc, row: number) => Array.from({ length: 32 }, (_, i) => getCell(types, row, `File ${i + 1}`)).filter((f) => f && f !== '0');

  it('a new level that needs a new tile library gets its own level type; the template\'s stays as it is', async () => {
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const extra = 'data/global/tiles/PD2assets/mine/floor.dt1';
    const plan = planAddToGame(tables, { mode: 'new', levelId: 109, name: 'X', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: [...dt1sOf(rel), extra], popCount: 2 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const typeId = num(getCell(next.levels, rowOfRecord(next.levels, plan.newLevelId!), 'LevelType'));
    expect(typeId).toBe(dataRows(tables.types).length); // appended as the next record
    const T = rowOfRecord(next.types, typeId);
    const files = filesOf(next.types, T);
    const rels = (paths: string[]) => paths.map((p) => normalizePath(p.replace(/^data\/global\/tiles\//i, '')));
    expect(rels(files)).toEqual(rels([...dt1sOf(rel), extra]));
    const templateType = rowOfRecord(tables.types, num(getCell(tables.levels, rowOfRecord(tables.levels, 109), 'LevelType')));
    expect(getCell(next.types, T, 'Act')).toBe(getCell(tables.types, templateType, 'Act'));
    const P = rowOfRecord(next.prest, dataRows(tables.prest).length);
    expect(Number(getCell(next.prest, P, 'Dt1Mask')) >>> 0).toBe(2 ** files.length - 1);
    expect([getCell(next.prest, P, 'Pops'), getCell(next.prest, P, 'PopPad')]).toEqual(['2', '-4']);
    // No existing LvlTypes row changed; the template level keeps its type.
    expect(same(tables.types, next.types, tables.types.rows.map((_, i) => i).filter((i) => i >= T))).toBe(true);
    expect(getCell(next.levels, rowOfRecord(next.levels, 109), 'LevelType')).toBe(getCell(tables.levels, rowOfRecord(tables.levels, 109), 'LevelType'));
    expect(plan.warnings.join(' ')).toMatch(/its own level type/);
    expect(verifyInGame(next, rel, ds1).filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('an existing level sharing its level type gets its own when the map needs a new library (Courtyard 2 shares with Courtyard 1)', async () => {
    const rel = 'Act1/Court/Cat_Court.ds1';
    const ds1 = await ds1Of(rel);
    const extra = 'data/global/tiles/PD2assets/mine/floor.dt1';
    const plan = planAddToGame(tables, { mode: 'existing', levelId: 32, name: 'Courtyard 2', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: [...dt1sOf(rel), extra], popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const typeId = num(getCell(next.levels, rowOfRecord(next.levels, 32), 'LevelType'));
    expect(typeId).toBe(dataRows(tables.types).length);
    expect(filesOf(next.types, rowOfRecord(next.types, typeId))).toHaveLength(dt1sOf(rel).length + 1);
    // Courtyard 1 and type 6 are untouched.
    expect(getCell(next.levels, rowOfRecord(next.levels, 27), 'LevelType')).toBe('6');
    expect(next.types.rows[rowOfRecord(next.types, 6)]).toEqual(tables.types.rows[rowOfRecord(tables.types, 6)]);
    // Without a new library the level keeps its (shared) type, as the game has it.
    const plain = planAddToGame(tables, { mode: 'existing', levelId: 32, name: 'Courtyard 2', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof plain === 'string') throw new Error(plain);
    expect(plain.writes.map((w) => w.table)).not.toContain('LvlTypes.txt');
  });

  it("notes an added level whose libraries were put in another level's type, and moves it to its own", async () => {
    const { ensureTypeSlots, maskOf } = await import('../src/game/levelTables');
    const { setCell } = await import('../src/formats/txtTable');
    const rel = 'Act1/Court/Cat_Court.ds1';
    const ds1 = await ds1Of(rel);
    // A new level 137 made from Courtyard 2 (type 6), then a library added to type 6 for it (the old behaviour).
    const made = planAddToGame(tables, { mode: 'new', levelId: 32, name: 'My Court', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf(rel), popCount: 0 });
    if (typeof made === 'string') throw new Error(made);
    const base = apply(made);
    const T6 = rowOfRecord(base.types, 6);
    const extra = 'data/global/tiles/PD2assets/mine/floor.dt1';
    const slotted = ensureTypeSlots(base.types, T6, [...dt1sOf(rel), extra]);
    const P = rowOfRecord(base.prest, dataRows(tables.prest).length);
    const broken = { ...base, types: slotted.types, prest: setCell(base.prest, P, 'Dt1Mask', String(maskOf(slotted.slots))) };
    const issue = verifyInGame(broken, rel, ds1).find((i) => /shares level type 6/.test(i.title))!;
    expect(issue.severity).toBe('info');
    expect(issue.title).toMatch(/Level 137 "My Court" shares level type 6 "Act 1 - Courtyard" with 27 .*32/);
    // The fix: its own type with the files it loads, the slot added for it cleared from type 6.
    const fixed = { ...broken };
    for (const w of issue.fix!.writes) {
      const doc = parseTxtTable(w.bytes);
      if (w.table === 'LvlPrest.txt') fixed.prest = doc;
      if (w.table === 'Levels.txt') fixed.levels = doc;
      if (w.table === 'LvlTypes.txt') fixed.types = doc;
    }
    const own = num(getCell(fixed.levels, rowOfRecord(fixed.levels, 137), 'LevelType'));
    expect(own).toBe(dataRows(tables.types).length);
    expect(filesOf(fixed.types, rowOfRecord(fixed.types, own))).toContain('PD2assets/mine/floor.dt1');
    expect(fixed.types.rows[rowOfRecord(fixed.types, 6)]).toEqual(tables.types.rows[rowOfRecord(tables.types, 6)]);
    expect(verifyInGame(fixed, rel, ds1).filter((p) => p.severity !== 'info' || /shares/.test(p.title))).toEqual([]);
  });

  it('refuses paths the game cannot hold, and random levels for "existing"', async () => {
    const long = 'PD2assets/a-rather-long-folder-name/my_map.ds1';
    expect(planAddToGame(tables, { mode: 'new', levelId: 109, name: 'X', mapRel: long, width: 10, height: 10, usedDt1s: [], popCount: 0 })).toMatch(/at most 41/);
    expect(planAddToGame(tables, { mode: 'existing', levelId: 2, name: 'X', mapRel: 'Act1/Tristram/Tri_Town4.ds1', width: 44, height: 49, usedDt1s: [], popCount: 0 })).toMatch(/built at random/);
  });

  it('an existing preset level: its own (first) preset row points at the map', async () => {
    const rel = 'Expansion/Town/townWest.ds1';
    const ds1 = await ds1Of(rel);
    const plan = planAddToGame(tables, { mode: 'existing', levelId: 38, name: 'Tristram', mapRel: rel, width: ds1.width, height: ds1.height, usedDt1s: dt1sOf('Act1/Tristram/Tri_Town4.ds1'), popCount: 0 });
    if (typeof plan === 'string') throw new Error(plan);
    const next = apply(plan);
    const first = dataRows(next.prest).find((r) => getCell(next.prest, r, 'LevelId') === '38')!;
    expect([getCell(next.prest, first, 'File1'), getCell(next.prest, first, 'Files')]).toEqual([rel, '1']);
    expect(dataRows(next.prest)).toHaveLength(dataRows(tables.prest).length); // no row added
    expect(plan.warnings.join(' ')).toMatch(/instead of/);
    const L = rowOfRecord(next.levels, 38);
    expect([getCell(next.levels, L, 'SizeX'), getCell(next.levels, L, 'SizeY')]).toEqual(['40', '40']);
    // Unchanged tables serialize to the same bytes.
    expect(serializeTxtTable(tables.types)).toEqual(serializeTxtTable(parseTxtTable(serializeTxtTable(tables.types))));
  });

});

describe('level size after a resize', () => {
  const tab = (lines: string[]) => parseTxtTable(new TextEncoder().encode(lines.map((l) => l.join('\t')).join('\r\n') + '\r\n'));

  it('keeps a whole-level preset the size of its resized map (Levels SizeX/SizeY = DS1 size - 1)', () => {
    const prest = tab([
      ['Name', 'Def', 'LevelId', 'SizeX', 'SizeY', 'File1'],
      ['a', '0', '0', '0', '0', '0'],
      ['guild3', '1', '1', '0', '0', 'expansion/Map/guild3.ds1'],
      ['fixed', '2', '2', '30', '30', 'expansion/Map/guild3.ds1'],
    ]);
    const levels = tab([
      ['Name', 'Id', 'DrlgType', 'SizeX', 'SizeY', 'SizeX(N)', 'SizeY(N)', 'SizeX(H)', 'SizeY(H)'],
      ['Null', '0', '0', '0', '0', '0', '0', '0', '0'],
      ['guild3', '1', '2', '40', '40', '40', '40', '40', '40'],
      ['other', '2', '2', '40', '40', '40', '40', '40', '40'],
    ]);
    const fix = levelSizeFix({ prest, levels }, 'Expansion/Map/Guild3.ds1', { width: 56, height: 58 })!;
    expect(fix.label).toBe('Set level 1 "guild3" to the map\'s size 55×57');
    const out = parseTxtTable(fix.writes[0].bytes);
    expect(['SizeX', 'SizeY', 'SizeX(N)', 'SizeY(N)', 'SizeX(H)', 'SizeY(H)'].map((c) => getCell(out, 1, c))).toEqual(['55', '57', '55', '57', '55', '57']);
    // The preset with its own size (row "fixed") leaves its level alone; a map already the right size needs nothing.
    expect(getCell(out, 2, 'SizeX')).toBe('40');
    expect(levelSizeFix({ prest, levels: out }, 'expansion/Map/guild3.ds1', { width: 56, height: 58 })).toBeNull();
  });
});
