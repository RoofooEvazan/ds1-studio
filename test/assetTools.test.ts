import { describe, expect, it } from 'vitest';
import { newDs1 } from '../src/formats/ds1ops';
import { EMPTY_CELL, withTile, writeDs1 } from '../src/formats/ds1';
import { decodeTile, parseDt1 } from '../src/formats/dt1';
import { blockerRecord, buildDt1, changedRecord, dt1Records } from '../src/formats/dt1Write';
import { GameData, TileLibrary } from '../src/game/GameData';
import { LayeredFs, LooseSource } from '../src/vfs/vfs';
import { findManagedAsset } from '../src/vfs/assetFiles';
import { mapTileUses, scanAssetUsage, splitUnusedTiles } from '../src/game/assetUsage';
import { animationRecords, generateWater, replaceAnimation } from '../src/game/waterAnimation';
import { smartFloorReroll } from '../src/game/floorReroll';
import { prepareFloorLibrary } from '../src/game/floorLibrary';
import { MapDocument } from '../src/game/MapDocument';
import { cellKey } from '../src/game/clipboard';
import { selectTileIndices } from '../src/game/tileSelection';
import { canvasToWorld } from '../src/render/inputProjection';
import { DEFAULT_VISIBILITY, nextView, withMode } from '../src/ui/state';
import { planAutomapClear } from '../src/game/automapClear';
import { parseTxtTable } from '../src/formats/txtTable';
import { parseAutomap, findRule } from '../src/game/automap';
import { groupPaintTiles } from '../src/game/tileGroups';

const record = (main: number, sub = 0, flag = 0) => blockerRecord(main, sub, new Uint8Array(25).fill(flag));
const map = () => newDs1({ width: 3, height: 3, act: 0, floorLayers: 1, wallLayers: 1, tagType: 0, files: [] });
const palette = Uint8Array.from({ length: 1024 }, (_, i) => i % 4 === 3 ? 255 : Math.floor(i / 4));
const loose = (files: Record<string, Uint8Array>, label = 'test') => new LooseSource(label, new Map(Object.entries(files).map(([p,b]) => [p, async () => b])));
const options = { preserveWalkability: true, avoidRepeats: true, seed: 12 };

describe('cleanup and recovery planning', () => {
  it('shows one paint choice per tile identity, retaining every animation frame', () => {
    const tiles = parseDt1(buildDt1([...animationRecords([record(1), record(1)], 1, 0), record(2)])).tiles;
    const groups = groupPaintTiles(tiles);
    expect(groups.length).toBe(2);
    expect(groups[0].tiles).toEqual(tiles.slice(0, 2));
    expect(groups[1].main).toBe(2);
  });
  it('keeps whole animations and random variant groups; preserves header metadata and unrelated records', () => {
    const bytes = buildDt1([...animationRecords([record(1), record(1)], 1, 0), record(2)]);
    bytes[100] = 23;
    expect(() => splitUnusedTiles(bytes, [0])).toThrow(/every frame/);
    const split = splitUnusedTiles(bytes, [0, 1]);
    expect(parseDt1(split.remaining!).tiles.map(t => t.mainIndex)).toEqual([2]);
    expect(parseDt1(split.removed).tiles.map(t => t.rarity)).toEqual([0, 1]);
    expect(split.remaining![100]).toBe(23);
    expect(split.removed[100]).toBe(23);
    expect(splitUnusedTiles(bytes, [0,1,2]).remaining).toBeNull();
    expect(() => splitUnusedTiles(bytes, [-1])).toThrow();
  });
  it('finds hidden tiles, every layer and both north-corner halves', () => {
    const d = map();
    d.floors[0][0] = withTile(EMPTY_CELL, 1, 0, 0x81);
    d.walls[0][1] = { ...withTile(EMPTY_CELL, 2, 0, 1), orientation: 3, orientationHigh: 0 };
    expect([...mapTileUses(d).keys()].sort()).toEqual(['0|1|0', '3|2|0', '4|2|0']);
  });
  it('protects persisted map references even when removed by unsaved changes', async () => {
    const d = map(); d.files = ['data/global/tiles/a.dt1']; d.floors[0][0] = withTile(EMPTY_CELL, 1, 0, 0x81);
    const fs = new LayeredFs([loose({ 'data/global/tiles/a.ds1': writeDs1(d), 'data/global/tiles/a.dt1': buildDt1([record(1), record(2)]) })]);
    const gd = await GameData.load(fs);
    d.floors[0][0] = EMPTY_CELL; d.files = [];
    const scan = await scanAssetUsage(gd, { path: 'data/global/tiles/a.ds1', ds1: d, paths: [] });
    expect(scan.errors).toEqual([]);
    expect(scan.assets[0].unusedIndices).toEqual([1]);
    expect(scan.assets[0].maps).toEqual(['data/global/tiles/a.ds1']);
  });
  it('protects references in shadowed DS1s and flags an unreadable DS1', async () => {
    const old = map(); old.files = ['data/global/tiles/a.dt1']; old.floors[0][0] = withTile(EMPTY_CELL, 1, 0, 0x81);
    const fresh = map();
    const fs = new LayeredFs([loose({ 'data/global/tiles/a.ds1': writeDs1(fresh) }), loose({
      'data/global/tiles/a.ds1': writeDs1(old), 'data/global/tiles/a.dt1': buildDt1([record(1),record(2)]), 'data/global/tiles/broken.ds1': new Uint8Array([1]),
    }, 'base')]);
    const scan = await scanAssetUsage(await GameData.load(fs), null);
    expect(scan.assets[0].unusedIndices).toEqual([1]);
    expect(scan.errors.length).toBe(1);
  });
  it('matches canonical Windows roots without confusing similarly named folders', () => {
    const entry = { root: '\\\\?\\C:\\Mods\\PD2', path: 'data/global/tiles/a.dt1' };
    expect(findManagedAsset([entry], entry.path.toUpperCase(), 'C:/Mods/PD2/data')).toBe(entry);
    expect(findManagedAsset([entry], entry.path, 'C:/Mods/PD2other/data')).toBeUndefined();
  });
});

describe('water creation and editing', () => {
  it('creates full isometric water frames, playable in sequence, with blocked ground', () => {
    const frames = generateWater(palette, { main: 3, sub: 2, frames: 8, dark: '#202020', light: '#dddddd', blocked: true, direction: 'right' });
    const tiles = parseDt1(buildDt1(frames)).tiles;
    expect(TileLibrary.isAnimation(tiles)).toBe(true);
    expect(tiles.map(t => t.rarity)).toEqual([0,1,2,3,4,5,6,7]);
    expect(decodeTile(tiles[0])).toMatchObject({ width: 160, height: 79 });
    expect([...tiles[0].subTileFlags]).toEqual(new Array(25).fill(1));
    expect(decodeTile(tiles[0])!.pixels).not.toEqual(decodeTile(tiles[1])!.pixels);
    expect(dt1Records(buildDt1(frames))).toHaveLength(8);
  });
  it('replaces only the requested identity and rejects invalid frame counts', () => {
    const before = [record(1), record(2)];
    const frames = animationRecords([record(1), record(1), record(1)], 1, 0);
    const after = parseDt1(replaceAnimation(before, [1,0], frames)).tiles;
    expect(after.map(t => t.mainIndex)).toEqual([1,1,1,2]);
    expect(after[3]).toEqual(parseDt1(buildDt1([before[1]])).tiles[0]);
    expect(() => animationRecords([record(1)], 1, 0)).toThrow();
    expect(() => replaceAnimation(before, [8,0], frames)).toThrow();
  });
});

describe('floor reroll', () => {
  it('respects irregular selection, empty cells, blocked edges, other layers and undo', () => {
    const d = map(); d.floors[0] = d.floors[0].map(() => withTile(EMPTY_CELL, 1, 0, 0x81));
    d.floors[0][1] = EMPTY_CELL;
    d.floors[0][3] = withTile(EMPTY_CELL, 2, 0, 0x81);
    const lib = new TileLibrary(), tiles = parseDt1(buildDt1([record(1), record(2,0,1), record(3), record(4)])).tiles;
    lib.add('a', { version: [7,6], tiles });
    const choices = tiles.slice(2).map((tile,index) => ({ path:'a',index:index+2,tile,brush:{orientation:0,main:tile.mainIndex,sub:0} }));
    const doc = new MapDocument('a.ds1',d), before = writeDs1(d);
    const area = { x0:0,y0:0,x1:2,y1:2,cells:new Set([cellKey(0,0),cellKey(1,0),cellKey(0,1),cellKey(2,2)]) };
    const result = smartFloorReroll(doc,lib,area,0,choices,options);
    expect(result.skipped).toBe(1);
    expect(result.edits.map(e=>[e.x,e.y])).toEqual([[0,0],[2,2]]);
    expect(result).toEqual(smartFloorReroll(doc,lib,area,0,choices,options));
    doc.apply(result.edits,'Reroll'); doc.undo();
    expect(writeDs1(d)).toEqual(before);
  });
  it('assigns separate IDs to individually chosen variants and preserves animation frames', () => {
    const records = [record(1), changedRecord(record(1),{flags:new Uint8Array(25).fill(1)}), ...animationRecords([record(2),record(2)],2,0)];
    const bytes = buildDt1(records), tiles = parseDt1(bytes).tiles;
    const choices = tiles.map((tile,index)=>({path:'a',index,tile,brush:{orientation:0,main:tile.mainIndex,sub:0}}));
    const plan = prepareFloorLibrary(choices,new Map([['a',bytes]]),new Set(['0|1|0','0|2|0']));
    const out = parseDt1(buildDt1(plan.records)).tiles;
    expect(out).toHaveLength(4);
    expect(out[0].mainIndex + '/' + out[0].subIndex).not.toBe(out[1].mainIndex + '/' + out[1].subIndex);
    expect(TileLibrary.isAnimation(out.slice(2))).toBe(true);
    expect(new Set(out.map(t=>t.mainIndex+'/'+t.subIndex)).size).toBe(3);
  });
});

describe('selection and mode regression checks', () => {
  it('clears only selected automap cells while preserving artwork and undo', async () => {
    const bytes=buildDt1([record(1)]);
    const gd=await GameData.load(new LayeredFs([loose({'a.dt1':bytes})]));
    const lib=new TileLibrary(); lib.add('a.dt1',parseDt1(bytes));
    const d=map(); d.floors[0]=d.floors[0].map(()=>withTile(EMPTY_CELL,1,0,0x81));
    const table=parseTxtTable(new TextEncoder().encode('LevelName\tTileName\tStyle\tStartSequence\tEndSequence\tType1\tCel1\tType2\tCel2\tType3\tCel3\tType4\tCel4\nTown\tfl\t1\t0\t0\t\t12\t\t-1\t\t-1\t\t-1\n'));
    const pieces=[0,1].map(cellX=>({cellX,cellY:0,orientation:0,main:1,sub:0,rule:null,cel:12,layer:'floor' as const}));
    const plan=await planAutomapClear(gd,lib,d,{x0:0,y0:0,x1:0,y1:0},pieces,table,'Town');
    expect(plan?.edits).toHaveLength(1);
    const doc=new MapDocument('a.ds1',d), before=writeDs1(d);
    doc.apply(plan!.edits);
    const cell=d.floors[0][0];
    expect(cell.mainIndex+'/'+cell.subIndex).not.toBe('1/0');
    expect(d.floors[0][1].mainIndex).toBe(1);
    expect(findRule(parseAutomap(plan!.table),'Town',0,1,0)?.cels.some(c=>c.cel===12)).toBe(true);
    expect(findRule(parseAutomap(plan!.table),'Town',0,cell.mainIndex,cell.subIndex)).toBeNull();
    expect(parseDt1(plan!.bytes).tiles[0].subTileFlags).toEqual(parseDt1(bytes).tiles[0].subTileFlags);
    doc.undo(); expect(writeDs1(d)).toEqual(before);
  });
  it('keeps quarantined files out of active DT1 lists', () => {
    const fs=new LayeredFs([loose({'data/global/tiles/PD2assets/unused/id/a.dt1':buildDt1([record(1)]),'data/global/tiles/a.dt1':buildDt1([record(1)])})]);
    expect(fs.list(p=>p.endsWith('.dt1'))).toEqual(['data/global/tiles/a.dt1']);
  });
  it('replaces ordinary clicks, toggles Ctrl clicks and keeps a stable Shift range anchor', () => {
    expect([...selectTileIndices(new Set([1,2,3]),7,1,10,{shift:false,toggle:false})]).toEqual([7]);
    expect([...selectTileIndices(new Set([1,2]),2,1,10,{shift:false,toggle:true})]).toEqual([1]);
    expect([...selectTileIndices(new Set([1,2,3]),5,2,10,{shift:true,toggle:false})]).toEqual([2,3,4,5]);
  });
  it('includes Objects in forward and reverse Tab cycling, clearing incompatible overlays', () => {
    expect(nextView('tiles',1)).toBe('objects');
    expect(nextView('walk',-1)).toBe('objects');
    expect(withMode({...DEFAULT_VISIBILITY,automap:true},'objects').automap).toBe(false);
  });
  it('maps the rendered position back to the pointer through CSS scaling and camera snapping', () => {
    const rect={left:14,top:93,width:901,height:503}, canvas={width:1126,height:629}, cam={x:12.3,y:-4.7,zoom:0.37};
    const world=[240,120];
    const x=rect.left+((world[0]-Math.round(cam.x*cam.zoom)/cam.zoom)*cam.zoom+Math.floor(canvas.width/2))*rect.width/canvas.width;
    const y=rect.top+((world[1]-Math.round(cam.y*cam.zoom)/cam.zoom)*cam.zoom+Math.floor(canvas.height/2))*rect.height/canvas.height;
    const actual=canvasToWorld(x,y,rect,canvas,cam);
    expect(actual[0]).toBeCloseTo(world[0]); expect(actual[1]).toBeCloseTo(world[1]);
  });
  it('puts the middle of each screen pixel on the middle of a tile pixel at 100%, also on an odd-sized canvas', () => {
    // Tile pixels meet on screen pixel edges, so no screen pixel samples exactly between two of them (where drivers
    // round differently and drop pixels).
    for (const canvas of [{width:1127,height:629},{width:1126,height:630}]) {
      const rect={left:0,top:0,width:canvas.width,height:canvas.height}, cam={x:40.2,y:-17.6,zoom:1};
      for (const px of [0,1,2,563,1000]) {
        const [wx,wy]=canvasToWorld(px+0.5,px%600+0.5,rect,canvas,cam);
        expect(Math.abs(wx-Math.floor(wx)-0.5)).toBeLessThan(1e-9);
        expect(Math.abs(wy-Math.floor(wy)-0.5)).toBeLessThan(1e-9);
      }
    }
  });
  it('rejects truncated DT1 regions before editing them', () => {
    const bytes=buildDt1([record(1)]);
    new DataView(bytes.buffer).setInt32(268,100,true);
    expect(()=>dt1Records(bytes)).toThrow(/headers/);
  });
});
