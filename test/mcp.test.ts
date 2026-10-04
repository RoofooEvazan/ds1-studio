import { beforeAll, describe, expect, it } from 'vitest';
import { parseDs1 } from '../src/formats/ds1';
import { GameData } from '../src/game/GameData';
import { handleLine } from '../src/mcp/protocol';
import { McpSession, TOOLS, type ToolResult } from '../src/mcp/session';
import { LayeredFs, MpqSource } from '../src/vfs/vfs';
import { NodeFileAccess } from '../tools/nodeAccess';
import { binarySource, D2_DIR, hasD2 } from '../tools/testdata';

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');

describe('MCP protocol', () => {
  const noSession = () => Promise.reject(new Error('not needed'));
  it('answers the handshake and lists the tools', async () => {
    const init = JSON.parse((await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }), '9.9.9'))!);
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.serverInfo).toMatchObject({ name: 'ds1-studio', version: '9.9.9' });
    expect(init.result.capabilities.tools).toBeDefined();
    expect(await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), '1')).toBeNull();
    const list = JSON.parse((await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), '1'))!);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object');
    const bad = JSON.parse((await handleLine(noSession, '{oops', '1'))!);
    expect(bad.error.code).toBe(-32700);
    const unknown = JSON.parse((await handleLine(noSession, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }), '1'))!);
    expect(unknown.error.code).toBe(-32601);
  });
});

describe('MCP list_maps', () => {
  it("finds maps in folders with capitals (a mod's expansion/Map/…) whatever case the filter has", async () => {
    const { LooseSource } = await import('../src/vfs/vfs');
    const file = async () => new Uint8Array();
    const fs = new LayeredFs([new LooseSource('mod', new Map([['data/global/tiles/expansion/Map/guild3.ds1', file], ['data/global/tiles/act1/town/townN1.ds1', file]]))]);
    const s = new McpSession({ fs } as unknown as GameData, { saveTarget: null });
    expect(textOf(await s.call('list_maps', { filter: 'expansion/map/guild' }))).toMatch(/1 map:\ndata\/global\/tiles\/expansion\/Map\/guild3\.ds1/);
    expect(textOf(await s.call('list_maps', { filter: 'Expansion/Map' }))).toMatch(/1 map:/);
    expect(textOf(await s.call('list_maps', {}))).toMatch(/2 maps:/);
  });
});

describe('MCP file list and errors', () => {
  it('lists the mod folders again before looking up files, and reports native errors by their message', async () => {
    const { LooseSource } = await import('../src/vfs/vfs');
    const files = new Map<string, () => Promise<Uint8Array>>([['data/global/tiles/act1/a.ds1', () => Promise.reject('The system cannot find the file specified. (os error 2)')]]);
    const src = new LooseSource('mod', files);
    const fs = new LayeredFs([src]);
    let refreshed = 0;
    const s = new McpSession({ fs } as unknown as GameData, {
      saveTarget: null,
      refresh: async () => {
        refreshed++;
        src.replaceFiles(new Map([...files, ['data/global/tiles/act1/b.ds1', async () => new Uint8Array()]]));
      },
    });
    expect(textOf(await s.call('list_maps', {}))).toMatch(/2 maps:[\s\S]*b\.ds1/);
    expect(refreshed).toBe(1);
    const r = await s.call('open_map', { path: 'data/global/tiles/act1/a.ds1' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Error: The system cannot find the file specified. (os error 2)');
    expect(refreshed).toBe(2);
  });
});

describe.runIf(hasD2)('MCP session', () => {
  let s: McpSession;
  const saved = new Map<string, Uint8Array>();
  beforeAll(async () => {
    const fs = new LayeredFs([binarySource(), ...(await Promise.all(['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq'].map((m) => MpqSource.open(m, new NodeFileAccess(`${D2_DIR}/${m}`)))))]);
    const gd = await GameData.load(fs);
    s = new McpSession(gd, { saveTarget: { label: 'memory', save: async (p, b) => (saved.set(p, b), `Saved ${p}`) } });
  });

  it('opens, reads, edits, undoes and saves a map', async () => {
    expect(textOf(await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 1, y1: 1 } }))).toMatch(/No map is open/);
    expect(textOf(await s.call('list_maps', { filter: 'act1/town/townn1' }))).toMatch(/townn1\.ds1/);
    const opened = textOf(await s.call('open_map', { path: 'data/global/tiles/act1/town/townN1.ds1' }));
    expect(opened).toMatch(/57×41 cells, act 1/);
    const cells = textOf(await s.call('get_cells', { rect: { x0: 20, y0: 20, x1: 23, y1: 21 }, layers: ['floor1'] }));
    expect(cells).toMatch(/\[floor1\]/);
    expect(cells.split('\n').filter((l) => l.startsWith('y2')).length).toBe(2);

    expect(textOf(await s.call('paint', { layer: 'floor1', rect: { x0: 0, y0: 0, x1: 2, y1: 2 }, tiles: [{ main: 0, sub: 5 }] }))).toMatch(/Painted floor1: rectangle/);
    expect(textOf(await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 2, y1: 0 }, layers: ['floor1'] }))).toMatch(/y0: 0\/5 0\/5 0\/5/);
    expect(textOf(await s.call('find_replace', { layer: 'floor', from: { main: 0, sub: 5 }, to: { main: 0, sub: 6 }, rect: { x0: 0, y0: 0, x1: 2, y1: 2 } }))).toMatch(/Replaced 9 uses/);
    expect(textOf(await s.call('set_cell', { layer: 'wall1', x: 1, y: 1, main: 0, sub: 3, orientation: 1 }))).toMatch(/wall1 at 1,1 is now 0\/3:1/);

    const objects = textOf(await s.call('list_objects', {}));
    const first = /#0 .* sub-tile (\d+),(\d+)/.exec(objects)!;
    expect(textOf(await s.call('add_object', { type: 2, id: 1, x: 7, y: 7 }))).toMatch(/Added #\d+ Torch/);
    expect(textOf(await s.call('copy_area', { rect: { x0: 0, y0: 0, x1: 2, y1: 2 }, to_x: 10, to_y: 0, move: true }))).toMatch(/Moved .*\(1 objects\)/);
    expect(textOf(await s.call('get_cells', { rect: { x0: 10, y0: 0, x1: 12, y1: 0 }, layers: ['floor1'] }))).toMatch(/0\/6 0\/6 0\/6/);
    expect(textOf(await s.call('history', {}))).toMatch(/Move 3×3/);
    expect(textOf(await s.call('undo', { steps: 2 }))).toBe('Undid 2 steps.');
    expect(textOf(await s.call('get_cells', { rect: { x0: 7, y0: 0, x1: 7, y1: 0 } }))).not.toMatch(/Torch/);
    expect(objects).toContain(`sub-tile ${first[1]},${first[2]}`);

    expect(textOf(await s.call('list_tiles', { kind: 'wall', orientation: 10 }))).toMatch(/Warp · Vis 0|Town entry/);
    expect(textOf(await s.call('list_placeable', { filter: 'waypoint' }))).toMatch(/type 2 id \d+: Waypoint/i);
    expect(textOf(await s.call('check_map', {}))).toMatch(/\[(ok|info|warning|error)\]/);

    const save = await s.call('save_map', { path: 'data/global/tiles/act1/mymaps/copy.ds1' });
    expect(save.isError).toBeFalsy();
    const bytes = saved.get('data/global/tiles/act1/mymaps/copy.ds1')!;
    expect(parseDs1(bytes).width).toBe(57);
    expect(textOf(await s.call('map_info', {}))).not.toMatch(/unsaved/);
  });

  it('reports bad input as tool errors', async () => {
    const r = await s.call('paint', { layer: 'wall9', cells: [[0, 0]] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Unknown layer/);
    expect((await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 50, y1: 40 } })).isError).toBe(true);
    expect((await s.call('nope', {})).isError).toBe(true);
    expect(textOf(await s.call('new_map', { path: 'data/global/tiles/act1/x/new.ds1', width: 8, height: 6, level_type_id: 2 }))).toMatch(/8×6 cells/);
    expect(textOf(await s.call('map_info', {}))).toMatch(/unsaved/);
  });
  it('adds layers, sets cell flags, lists spawn regions and makes a no-spawn area, each one undo step', async () => {
    expect(textOf(await s.call('new_map', { path: 'data/global/tiles/act1/x/spawn.ds1', width: 17, height: 9, level_type_id: 2 }))).toMatch(/17×9 cells/);
    expect(textOf(await s.call('paint', { layer: 'floor1', rect: { x0: 0, y0: 0, x1: 16, y1: 8 }, tiles: [{ main: 0, sub: 0 }] }))).toMatch(/Painted/);
    expect(textOf(await s.call('paint', { layer: 'wall1', rect: { x0: 4, y0: 0, x1: 4, y1: 8 }, tiles: [{ main: 0, sub: 0, orientation: 1 }] }))).toMatch(/Painted/);
    const regions = textOf(await s.call('regions', {}));
    expect(regions).toMatch(/^2 rooms, 3 regions monsters can spawn in\./);
    expect(regions).toMatch(/Room 0,0-7,7:\n  seed 0,0 · SPAWNS · 32 cells, 32 floored/);

    expect(textOf(await s.call('set_cell_flags', { regions: [[1, 1]], unwalkable: true, hidden: false }))).toMatch(/^Set not hidden, unwalkable on 32 floor1 cells\. \(undo/);
    expect(textOf(await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, layers: ['floor1'] }))).toMatch(/y0: 0\/0/);
    expect(textOf(await s.call('undo', {}))).toBe('Undid 1 step.');

    const done = textOf(await s.call('no_spawn_area', { rect: { x0: 1, y0: 1, x1: 2, y1: 2 } }));
    expect(done).toMatch(/1 room covered \(cells 0,0-7,7\)/);
    expect(done).toMatch(/2 seed floors hidden under a floor2 copy/);
    expect(done).toMatch(/Every region of those rooms is now a node/);
    expect(textOf(await s.call('map_info', {}))).toMatch(/Layers: floor1, floor2/);
    expect(textOf(await s.call('get_cells', { rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, layers: ['floor1', 'floor2'] }))).toMatch(/\[floor1\]\ny0: 0\/0h\n\n\[floor2\]\ny0: 0\/0/);
    expect(textOf(await s.call('regions', { spawning_only: true }))).toMatch(/^2 rooms, 1 region monsters can spawn in\.\nRoom 8,0-15,7:/);
    expect(textOf(await s.call('undo', {}))).toBe('Undid 1 step.');
    expect(textOf(await s.call('map_info', {}))).toMatch(/Layers: floor1, wall1, wall2, shadow\./);

    expect(textOf(await s.call('add_layer', { kind: 'wall', count: 2 }))).toMatch(/Added 2 wall layers\. Layers: floor1, wall1, wall2, wall3, wall4, shadow\./);
    expect((await s.call('add_layer', { kind: 'wall' })).isError).toBe(true);
    expect(textOf(await s.call('list_placeable', { act: 2, filter: 'waypoint' }))).toMatch(/type 2 id \d{3}: Waypoint/i);
  });
});
