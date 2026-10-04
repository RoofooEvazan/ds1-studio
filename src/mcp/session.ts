import { decodeCell, EMPTY_CELL, encodeCell, isEmptyCell, writeDs1, WRITE_VERSION, type Ds1Object, type WallCell } from '../formats/ds1';
import { embeddedFileName, newDs1, resizeDs1 } from '../formats/ds1ops';
import { Orientation } from '../formats/dt1';
import { clampRect, clearEdits, copyRect, MAX_FLOOR_LAYERS, MAX_WALL_LAYERS, pasteEdits, pasteObjects, type CellRect } from '../game/clipboard';
import { checkMap } from '../game/compat';
import { findTile, floodRegion, keyOf, objectInRect, paintEdits, rectCells, replaceEdits, rerollEdits, type TileKey } from '../game/editTools';
import { GameData } from '../game/GameData';
import { layerKey, layerLabel, MapDocument, type Brush, type CellEdit, type LayerRef } from '../game/MapDocument';
import { openMap, type OpenMap } from '../game/openMap';
import { specialTileInfo } from '../game/specialTiles';
import { noSpawnPlan, presetRooms, roomAt, roomRegions, spawns, UNWALKABLE, type PresetRoom, type RoomRegions } from '../game/spawnRegions';
import { OBJECTS_PER_ACT } from '../game/objectCatalog';
import type { Sprite } from '../game/sprites';
import { buildScene, type Scene } from '../render/scene';
import { overlayFlags, spawnLevelOf, spawnOverlay, walkableOverlay, type MapOverlay } from '../game/mapOverlays';
import { exportSize } from '../render/exportImage';
import type { SaveTarget } from '../vfs/save';
import { normalizePath } from '../vfs/vfs';
import { ORIENTATION_NAMES } from '../ui/state';

/**
 * The editing session behind DS1 Studio's MCP server (`ds1-studio --mcp`): one open map at a time, edited with the
 * same code as the editor (undo history included), saved into the mod folder only when asked. Every tool takes plain
 * JSON and returns text (or a PNG for render_map).
 */

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Things only the host (the hidden app window) can do. */
export interface SessionHost {
  saveTarget: SaveTarget | null;
  /** Lists the mod folders again (files added or removed since the server started). */
  refresh?: () => Promise<void>;
  /** PNG of part of the map (base64), or null when rendering isn't available. */
  render?: (scene: Scene, objects: Ds1Object[], sprites: Map<string, Sprite>, map: OpenMap, area: CellRect | null, scale: number, withObjects: boolean, specials: boolean, overlay?: MapOverlay | null) => Promise<string>;
}

class ToolError extends Error {}

/** The message of anything thrown: native calls reject with a plain string, not an Error. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e) ?? String(e));

/** Tools that look up files: the mod folders are listed again before them. */
const LISTS_FILES = new Set(['list_maps', 'open_map', 'new_map', 'check_map']);

const fail = (msg: string): never => {
  throw new ToolError(msg);
};

// ------------------------------------------------------------------------------------------------ small helpers

const LAYER_NAMES = ['floor1', 'floor2', 'wall1', 'wall2', 'wall3', 'wall4', 'shadow'];

function parseLayer(name: unknown): LayerRef {
  const m = /^(floor|wall)([1-4])$|^shadow$/i.exec(String(name ?? '').trim());
  if (!m) return fail(`Unknown layer "${name}". Use one of: ${LAYER_NAMES.join(', ')}.`);
  if (!m[1]) return { kind: 'shadow', index: 0 };
  return { kind: m[1].toLowerCase() as 'floor' | 'wall', index: Number(m[2]) - 1 };
}
const layerName = (l: LayerRef) => (l.kind === 'shadow' ? 'shadow' : `${l.kind}${l.index + 1}`);

const int = (v: unknown, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return fail(`${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)}).`);
  return n;
};

function parseRect(r: unknown, width: number, height: number): CellRect {
  const o = (r ?? {}) as Record<string, unknown>;
  const rect = { x0: int(o.x0, 'x0', 0, 9999), y0: int(o.y0, 'y0', 0, 9999), x1: int(o.x1, 'x1', 0, 9999), y1: int(o.y1, 'y1', 0, 9999) };
  const c = clampRect({ x0: Math.min(rect.x0, rect.x1), y0: Math.min(rect.y0, rect.y1), x1: Math.max(rect.x0, rect.x1), y1: Math.max(rect.y0, rect.y1) }, width, height);
  return c ?? fail(`The rectangle is outside the ${width}×${height} map.`);
}

/** A tile to paint on `layer`: floors/shadows ignore orientation; walls need one (default 1, left wall). */
function parseTile(t: unknown, layer: LayerRef): Brush {
  const o = (t ?? {}) as Record<string, unknown>;
  const orientation = layer.kind === 'floor' ? Orientation.Floor : layer.kind === 'shadow' ? Orientation.Shadow : o.orientation === undefined ? 1 : int(o.orientation, 'orientation', 1, 19);
  return { orientation, main: int(o.main, 'main', 0, 63), sub: int(o.sub, 'sub', 0, 255) };
}

const kindName = (o: number) => ORIENTATION_NAMES[o] ?? `kind ${o}`;
const tileText = (k: TileKey, wall: boolean) => `${k.main}/${k.sub}${wall ? `:${k.orientation}` : ''}`;
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

// ------------------------------------------------------------------------------------------------ tool list

const RECT = {
  type: 'object',
  description: 'Cell rectangle, inclusive corners (x0,y0)-(x1,y1). Cells are numbered from 0 at the map’s top corner.',
  properties: { x0: { type: 'integer' }, y0: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' } },
  required: ['x0', 'y0', 'x1', 'y1'],
};
const TILE = {
  type: 'object',
  description: 'A DT1 tile by number: main (0-63), sub (0-255) and, on wall layers, orientation (1-19; see list_tiles).',
  properties: { main: { type: 'integer' }, sub: { type: 'integer' }, orientation: { type: 'integer' } },
  required: ['main', 'sub'],
};
const LAYER = { type: 'string', enum: LAYER_NAMES, description: 'Tile layer: floor1-2, wall1-4 or shadow.' };
const CELLS = { type: 'array', items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, description: '[[x, y], …]' };
const REGIONS = { ...CELLS, description: 'Cells [[x, y], …]: each stands for the whole spawn region it is in (its 8×8 room’s wall-bounded part; see the regions tool).' };
const roomText = (r: PresetRoom) => `${r.x0},${r.y0}-${r.x0 + r.w - 1},${r.y0 + r.h - 1}`;

export const TOOLS: ToolDef[] = [
  {
    name: 'list_maps',
    description: 'List the map presets (.ds1) in the game and mod, optionally filtered by a text in their path (e.g. "act1/town" or "arcane").',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' }, limit: { type: 'integer', description: 'Most results (default 200).' } } },
  },
  {
    name: 'open_map',
    description: 'Open a map for editing (replaces the one open, unsaved changes to it are lost). Returns its size, layers, tile libraries and objects count.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Game path, e.g. data/global/tiles/act1/town/townN1.ds1 (from list_maps).' } }, required: ['path'] },
  },
  {
    name: 'new_map',
    description: 'Create a new, empty map (not saved until save_map). Tile libraries come from the level type (see list_level_types).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where it will be saved, e.g. data/global/tiles/act1/mymaps/test.ds1' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        level_type_id: { type: 'integer', description: 'LvlTypes.txt Id (see list_level_types).' },
        floor_layers: { type: 'integer', description: '1-2 (default 1)' },
        wall_layers: { type: 'integer', description: '1-4 (default 2)' },
      },
      required: ['path', 'width', 'height', 'level_type_id'],
    },
  },
  { name: 'list_level_types', description: 'List the level types (LvlTypes.txt) with their act and DT1 files, optionally filtered by name.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'map_info', description: 'Summary of the open map: size, act, layers, level type, tile libraries, objects, unsaved changes.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'get_cells',
    description:
      'Read the tiles in a rectangle (at most 1600 cells), one grid per layer that has tiles. Each cell is "main/sub" (walls: "main/sub:orientation"), "." when empty, with "h" appended when hidden. Also lists the objects standing there.',
    inputSchema: { type: 'object', properties: { rect: RECT, layers: { type: 'array', items: LAYER } }, required: ['rect'] },
  },
  {
    name: 'list_tiles',
    description: 'The tiles this map’s DT1s provide for a layer kind, with their kind (orientation) names, variant counts and source DT1. Special tiles (warps, entries) are named.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['floor', 'wall', 'shadow'] }, dt1: { type: 'string', description: 'Only tiles from DT1s whose path contains this.' }, orientation: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['kind'],
    },
  },
  {
    name: 'paint',
    description:
      'Paint (or erase) tiles on one layer: a list of cells, a rectangle, or a flood fill from a cell (the connected area of the same tile, kept inside `within` when given). Give several tiles to paint a random mix. Leave `tiles` out to erase. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: LAYER,
        tiles: { type: 'array', items: TILE, description: 'Tile(s) to paint; each cell gets one at random. Omit to erase.' },
        cells: { type: 'array', items: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, description: '[[x, y], …]' },
        rect: RECT,
        fill_from: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[x, y] to flood fill from.' },
        within: RECT,
      },
      required: ['layer'],
    },
  },
  {
    name: 'set_cell',
    description: 'Set one cell of one layer precisely: tile numbers, orientation (walls), hidden flag, or raw prop1 byte (0 = empty). One undo step.',
    inputSchema: {
      type: 'object',
      properties: { layer: LAYER, x: { type: 'integer' }, y: { type: 'integer' }, main: { type: 'integer' }, sub: { type: 'integer' }, orientation: { type: 'integer' }, hidden: { type: 'boolean' }, prop1: { type: 'integer' } },
      required: ['layer', 'x', 'y'],
    },
  },
  {
    name: 'clear',
    description: 'Clear a rectangle: the given layers (default all), and the objects/NPCs standing in it when objects is true. One undo step.',
    inputSchema: { type: 'object', properties: { rect: RECT, layers: { type: 'array', items: LAYER }, objects: { type: 'boolean' } }, required: ['rect'] },
  },
  {
    name: 'copy_area',
    description:
      'Copy (or move, like cut + paste) a rectangle of every layer, with its objects, so its top-left cell lands at (to_x, to_y). Empty cells are transparent. Parts past the map edge are dropped. One undo step.',
    inputSchema: { type: 'object', properties: { rect: RECT, to_x: { type: 'integer' }, to_y: { type: 'integer' }, move: { type: 'boolean' } }, required: ['rect', 'to_x', 'to_y'] },
  },
  {
    name: 'find_replace',
    description: 'Replace every use of one tile with another on the layers of one kind (or one layer), in the whole map or a rectangle. One undo step.',
    inputSchema: { type: 'object', properties: { layer: { type: 'string', description: 'A layer name, or "floor"/"wall" for every layer of that kind.' }, from: TILE, to: TILE, rect: RECT }, required: ['layer', 'from', 'to'] },
  },
  {
    name: 'reroll',
    description: 'Mix up the tiles of one layer in a rectangle: each gets a random tile of its group (same main index) already used there, so repeats show less.',
    inputSchema: { type: 'object', properties: { layer: LAYER, rect: RECT }, required: ['layer', 'rect'] },
  },
  {
    name: 'resize_map',
    description: 'Add (positive) or remove (negative) cells on each side of the map. Objects move with the cells.',
    inputSchema: { type: 'object', properties: { left: { type: 'integer' }, top: { type: 'integer' }, right: { type: 'integer' }, bottom: { type: 'integer' } } },
  },
  {
    name: 'add_layer',
    description: 'Add empty floor or wall layers to the map (at most 2 floor and 4 wall layers). One undo step.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['floor', 'wall'] }, count: { type: 'integer', description: 'How many (default 1).' } }, required: ['kind'] },
  },
  {
    name: 'set_cell_flags',
    description:
      'Set or clear cell flags on one layer for many cells at once: hidden (not drawn in game, still collides), unwalkable (the DS1 cell bit 17, prop3 & 0x02: blocks walking on the whole cell), or raw prop1-prop4 bytes (applied first). Cells by list, rectangle or spawn region. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { ...LAYER, description: 'Layer (default floor1).' },
        cells: CELLS,
        rect: RECT,
        regions: REGIONS,
        only_tiles: { type: 'boolean', description: 'Skip cells with no tile on the layer.' },
        hidden: { type: 'boolean' },
        unwalkable: { type: 'boolean' },
        prop1: { type: 'integer' },
        prop2: { type: 'integer' },
        prop3: { type: 'integer' },
        prop4: { type: 'integer' },
      },
    },
  },
  {
    name: 'regions',
    description:
      'The spawn regions of the map’s 8×8 game rooms, as the game works them out with LvlPrest Logicals=1: parts of a room bounded by wall1 walls, each with its seed (first cell scanned). A region whose seed has a hidden floor1 tile (or main index 30) is a node: no random monsters there. Rooms with a level warp spawn nothing.',
    inputSchema: { type: 'object', properties: { rect: { ...RECT, description: 'Only rooms touching this rectangle (default: the whole map).' }, spawning_only: { type: 'boolean', description: 'Only list regions monsters can spawn in.' } } },
  },
  {
    name: 'no_spawn_area',
    description:
      'Stop random monsters spawning in an area while keeping it walkable and looking the same: every region of each 8×8 room touching the cells gets a hidden floor1 tile at its seed (a floored seed’s tile is copied to floor2 first; a seed without floor gets a hidden floor tile and the unwalkable bit). Adds floor2 when needed. Needs LvlPrest Logicals=1. Reports the rooms covered. One undo step.',
    inputSchema: { type: 'object', properties: { cells: CELLS, rect: RECT, whole_rooms: { type: 'boolean', description: 'Change every floored cell of the rooms, not only the region seeds.' } } },
  },
  { name: 'list_objects', description: 'The objects and NPCs placed in the map: index, type (1 NPC, 2 object), id, name, sub-tile position (cell = position / 5) and path length.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  {
    name: 'list_placeable',
    description:
      'Objects and NPCs that can be placed in this map (type, id, name), optionally filtered by name. With act, objects of another act, listed with the id that reaches them from this map: negative for earlier acts, 150 + their objects.txt row for later ones.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' }, type: { type: 'integer', description: '1 = NPCs, 2 = objects' }, act: { type: 'integer', description: '1-5 (default: the map’s act). NPCs only come from the map’s own act.' } } },
  },
  {
    name: 'add_object',
    description: 'Place an object or NPC at a sub-tile position (5 sub-tiles per cell; the middle of cell (cx, cy) is (cx*5+2, cy*5+2)). One undo step.',
    inputSchema: { type: 'object', properties: { type: { type: 'integer' }, id: { type: 'integer' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['type', 'id', 'x', 'y'] },
  },
  {
    name: 'edit_objects',
    description: 'Move and/or remove placed objects by index (from list_objects). Removal happens after moves. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        move: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['index', 'x', 'y'] } },
        remove: { type: 'array', items: { type: 'integer' } },
      },
    },
  },
  { name: 'undo', description: 'Undo the last edit(s).', inputSchema: { type: 'object', properties: { steps: { type: 'integer' } } } },
  { name: 'redo', description: 'Redo undone edit(s).', inputSchema: { type: 'object', properties: { steps: { type: 'integer' } } } },
  { name: 'history', description: 'The edits made since the map was opened (newest last).', inputSchema: { type: 'object', properties: {} } },
  { name: 'check_map', description: 'Run the compatibility check: will the map load and play in game (tiles, DT1s, tables, entries, objects)?', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'render_map',
    description: 'A picture (JPEG) of the map or a rectangle of it, as it looks in the editor, to see the result of edits. Scale is picked to fit ~1568 px unless given; render a rectangle at scale 1 to see details.',
    inputSchema: {
      type: 'object',
      properties: {
        rect: RECT,
        scale: { type: 'number', description: '1 = game pixels, 0.5 = half…' },
        objects: { type: 'boolean', description: 'Draw object sprites (default true).' },
        special_tiles: { type: 'boolean', description: 'Also draw special tiles (orientation 10/11) that have graphics, such as a warp’s arch (default false; drawn last, over the rest).' },
        overlay: {
          type: 'string',
          enum: ['walkable', 'spawn'],
          description:
            'Colour the map sub-tile by sub-tile, with a legend: "walkable" = where players can walk (green), monsters only (yellow, flag 0x08) or blocked (red; tile flag 0x01, the cell’s unwalkable bit), plus void players can walk into (magenta: in game a cell without a floor blocks nothing unless a tile there does) and the open edge where they walk off (orange); "spawn" = where random monsters can be placed (green) and why not elsewhere: blocked, node region, room with a level warp, or the level spawns none (LvlPrest Populate, Levels MonDen).',
        },
      },
    },
  },
  {
    name: 'save_map',
    description: 'Save the open map into the mod folder (the previous file is kept as .bak). Give a path to save under another name.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

// ------------------------------------------------------------------------------------------------ the session

export class McpSession {
  private map: OpenMap | null = null;
  private doc: MapDocument | null = null;

  constructor(
    private gd: GameData,
    private host: SessionHost,
  ) {}

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    try {
      const fn = (this as unknown as Record<string, (a: Record<string, unknown>) => Promise<ToolResult> | ToolResult>)[`t_${name}`];
      if (!fn || !TOOLS.some((t) => t.name === name)) return fail(`Unknown tool "${name}".`);
      if (LISTS_FILES.has(name)) await this.host.refresh?.();
      return await fn.call(this, args);
    } catch (e) {
      return { content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Error: ${errorText(e)}` }], isError: true };
    }
  }

  private need(): { map: OpenMap; doc: MapDocument } {
    if (!this.map || !this.doc) return fail('No map is open: use open_map or new_map first.');
    return { map: this.map, doc: this.doc };
  }

  private scene(): Scene {
    const { map } = this.need();
    return buildScene(map.ds1, map.lib);
  }

  private haveLayer(l: LayerRef) {
    const { doc } = this.need();
    if (!doc.layers().some((x) => layerKey(x) === layerKey(l))) fail(`This map has no ${layerName(l)} layer (it has ${doc.layers().map(layerName).join(', ')}).`);
    return l;
  }

  /** Cells from `cells`, `rect` and/or `regions` (each cell standing for its spawn region), without repeats. */
  private pickCells(a: Record<string, unknown>): [number, number][] {
    const { map } = this.need();
    const { width, height } = map.ds1;
    const out = new Map<number, [number, number]>();
    const add = (x: number, y: number) => out.set(y * width + x, [x, y]);
    const point = (c: unknown): [number, number] => {
      const [x, y] = c as number[];
      return [int(x, 'x', 0, width - 1), int(y, 'y', 0, height - 1)];
    };
    if (Array.isArray(a.cells)) for (const c of a.cells) add(...point(c));
    if (a.rect) {
      const r = parseRect(a.rect, width, height);
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) add(x, y);
    }
    if (Array.isArray(a.regions)) {
      const rooms = presetRooms(width, height);
      for (const c of a.regions) {
        const [x, y] = point(c);
        const room = roomAt(rooms, x, y) ?? fail(`${x},${y} is in no game room (the last row and column of a map only border rooms).`);
        const reg = roomRegions(map.ds1, room).regions.find((r) => r.cells.some((p) => p.x === x && p.y === y));
        for (const p of reg?.cells ?? []) add(p.x, p.y);
      }
    }
    if (!Array.isArray(a.cells) && !a.rect && !Array.isArray(a.regions)) fail('Give cells, rect or regions.');
    return [...out.values()];
  }

  private applied(changed: boolean, what: string): ToolResult {
    return text(changed ? `${what}. (undo with the undo tool)` : `${what}: nothing changed.`);
  }

  private summary(): string {
    const { map, doc } = this.need();
    const d = map.ds1;
    const r = map.resolution;
    const libs = map.lib.loaded.filter((l) => !l.path.startsWith('builtin/'));
    return [
      `${map.path}${doc.dirty ? ' (unsaved changes)' : ''}`,
      `Size ${d.width}×${d.height} cells, act ${d.act + 1}, DS1 version ${d.version}.`,
      `Layers: ${doc.layers().map(layerName).join(', ')}${d.tags.length ? ' + tag layer' : ''}.`,
      `Level type: ${r.lvlType ? `${r.lvlType.id} ${r.lvlType.name}` : 'unknown'} (${r.source})${r.preset ? `; LvlPrest "${r.preset.name}" (Def ${r.preset.def})` : ''}.`,
      `Tile libraries (${libs.length}): ${libs.map((l) => `${l.path.replace(/^data\/global\/tiles\//i, '')}${l.found ? '' : ' (NOT FOUND)'}`).join(', ')}.`,
      `Objects/NPCs: ${d.objects.length}.`,
    ].join('\n');
  }

  // --- maps -----------------------------------------------------------------------------------------------------

  t_list_maps(a: Record<string, unknown>): ToolResult {
    const f = String(a.filter ?? '').toLowerCase();
    const limit = Number(a.limit) || 200;
    // The filter is checked on the normalized path: the listed ones keep the game's capitals (expansion/Map/…).
    const all = this.gd.fs.list((p) => p.endsWith('.ds1') && p.startsWith('data/global/tiles/') && (!f || p.includes(f)));
    return text(`${all.length} map${all.length === 1 ? '' : 's'}${all.length > limit ? ` (first ${limit})` : ''}:\n${all.slice(0, limit).join('\n')}`);
  }

  async t_open_map(a: Record<string, unknown>): Promise<ToolResult> {
    const path = normalizePath(String(a.path ?? ''));
    if (!path.endsWith('.ds1')) fail('Give the .ds1 path (see list_maps).');
    if (!this.gd.fs.locate(path)) fail(`${path} was not found (see list_maps).`);
    this.map = await openMap(this.gd, path);
    this.doc = new MapDocument(path, this.map.ds1);
    return text(`Opened.\n${this.summary()}`);
  }

  async t_new_map(a: Record<string, unknown>): Promise<ToolResult> {
    const path = normalizePath(String(a.path ?? ''));
    if (!/^data\/global\/tiles\/.+\.ds1$/.test(path)) fail('path must look like data/global/tiles/<folder>/<name>.ds1');
    const type = this.gd.lvlType(int(a.level_type_id, 'level_type_id', 0, 9999)) ?? fail('Unknown level type (see list_level_types).');
    const paths = GameData.dt1sFor(type, 0xffffffff);
    const ds1 = newDs1({
      width: int(a.width, 'width', 1, 1000),
      height: int(a.height, 'height', 1, 1000),
      act: Math.max(0, (type.act || 1) - 1),
      floorLayers: a.floor_layers === undefined ? 1 : int(a.floor_layers, 'floor_layers', 1, 2),
      wallLayers: a.wall_layers === undefined ? 2 : int(a.wall_layers, 'wall_layers', 1, 4),
      tagType: 0,
      files: paths.map(embeddedFileName),
    });
    this.map = await openMap(this.gd, path, { source: 'manual', lvlType: type, paths }, ds1);
    this.doc = new MapDocument(path, this.map.ds1);
    this.doc.markUnsaved();
    return text(`New map (not saved yet).\n${this.summary()}`);
  }

  t_list_level_types(a: Record<string, unknown>): ToolResult {
    const f = String(a.filter ?? '').toLowerCase();
    const rows = this.gd.lvlTypes.filter((t) => t.id > 0 && (!f || t.name.toLowerCase().includes(f)));
    return text(rows.map((t) => `${t.id}: ${t.name} (act ${t.act}) — ${t.files.filter(Boolean).join(', ')}`).join('\n') || 'None found.');
  }

  t_map_info(): ToolResult {
    return text(this.summary());
  }

  // --- reading --------------------------------------------------------------------------------------------------

  t_get_cells(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const r = parseRect(a.rect, map.ds1.width, map.ds1.height);
    const [w, h] = [r.x1 - r.x0 + 1, r.y1 - r.y0 + 1];
    if (w * h > 1600) fail(`That is ${w * h} cells; read at most 1600 at a time (e.g. 40×40).`);
    const layers = Array.isArray(a.layers) && a.layers.length ? (a.layers as unknown[]).map((l) => this.haveLayer(parseLayer(l))) : doc.layers();
    const out: string[] = [`Cells x ${r.x0}-${r.x1}, y ${r.y0}-${r.y1} (rows are y, columns x).`];
    for (const layer of layers) {
      const rows: string[] = [];
      let any = false;
      for (let y = r.y0; y <= r.y1; y++) {
        const row: string[] = [];
        for (let x = r.x0; x <= r.x1; x++) {
          const c = doc.cell(layer, x, y);
          const k = keyOf(layer, c);
          if (k) any = true;
          row.push(k ? tileText(k, layer.kind === 'wall') + (c.hidden ? 'h' : '') : '.');
        }
        rows.push(`y${y}: ${row.join(' ')}`);
      }
      if (any) out.push(`\n[${layerName(layer)}]`, ...rows);
    }
    const objs = map.ds1.objects.map((o, i) => ({ o, i })).filter(({ o }) => objectInRect(o, r));
    if (objs.length) out.push('\nObjects here:', ...objs.map(({ o, i }) => `#${i} ${this.gd.objectName(map.ds1.act, o.type, o.id)} (type ${o.type} id ${o.id}) at sub-tile ${o.x},${o.y}`));
    return text(out.join('\n'));
  }

  t_list_tiles(a: Record<string, unknown>): ToolResult {
    const { map } = this.need();
    const kind = String(a.kind);
    const dt1 = String(a.dt1 ?? '').toLowerCase();
    const limit = Number(a.limit) || 400;
    const fits = (o: number) => (kind === 'floor' ? o === 0 : kind === 'shadow' ? o === 13 : o !== 0 && o !== 13 && o !== 4);
    const rows = map.lib
      .entries()
      .filter((e) => fits(e.orientation) && (a.orientation === undefined || e.orientation === Number(a.orientation)))
      .map((e) => ({ e, srcs: [...new Set(e.tiles.map((t) => map.lib.sourceOf(t)?.path.replace(/^data\/global\/tiles\//i, '') ?? '?'))] }))
      .filter(({ srcs }) => !dt1 || srcs.some((s) => s.toLowerCase().includes(dt1)));
    const lines = rows.slice(0, limit).map(({ e, srcs }) => {
      const special = e.orientation === 10 || e.orientation === 11 ? ` — ${specialTileInfo(e.main, e.sub).label}` : '';
      return `${e.main}/${e.sub}${kind === 'wall' ? ` orientation ${e.orientation} (${kindName(e.orientation)})` : ''}${e.tiles.length > 1 ? ` · ${e.tiles.length} variants` : ''} · ${srcs.join(', ')}${special}`;
    });
    return text(`${rows.length} tile${rows.length === 1 ? '' : 's'}${rows.length > limit ? ` (first ${limit})` : ''}:\n${lines.join('\n')}`);
  }

  // --- editing --------------------------------------------------------------------------------------------------

  t_paint(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const layer = this.haveLayer(parseLayer(a.layer));
    const tiles = Array.isArray(a.tiles) && a.tiles.length ? (a.tiles as unknown[]).map((t) => parseTile(t, layer)) : null;
    let cells: [number, number][] = [];
    let how = '';
    if (Array.isArray(a.fill_from)) {
      const [x, y] = a.fill_from as number[];
      const within = a.within ? parseRect(a.within, map.ds1.width, map.ds1.height) : null;
      cells = floodRegion(doc, layer, int(x, 'x', 0, 9999), int(y, 'y', 0, 9999), within);
      how = `flood fill of ${cells.length} connected cells`;
    } else if (a.rect) {
      const r = parseRect(a.rect, map.ds1.width, map.ds1.height);
      cells = rectCells(r);
      how = `rectangle ${r.x0},${r.y0}-${r.x1},${r.y1}`;
    } else if (Array.isArray(a.cells)) {
      cells = (a.cells as unknown[]).map((c) => {
        const [x, y] = c as number[];
        return [int(x, 'x', 0, 9999), int(y, 'y', 0, 9999)] as [number, number];
      });
      how = `${cells.length} cells`;
    } else fail('Give cells, rect or fill_from.');
    const verb = tiles ? 'Paint' : 'Erase';
    const changed = doc.apply(paintEdits(doc, layer, cells, tiles), `${verb} on ${layerLabel(layer)}`);
    return this.applied(changed, `${verb === 'Paint' ? 'Painted' : 'Erased'} ${layerName(layer)}: ${how}${tiles ? ` with ${tiles.map((t) => tileText(t, layer.kind === 'wall')).join(', ')}` : ''}`);
  }

  t_set_cell(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const layer = this.haveLayer(parseLayer(a.layer));
    const x = int(a.x, 'x', 0, map.ds1.width - 1);
    const y = int(a.y, 'y', 0, map.ds1.height - 1);
    let c = doc.cell(layer, x, y);
    if (a.main !== undefined || a.sub !== undefined) {
      const cur = keyOf(layer, c);
      c = MapDocument.painted(layer, c, {
        orientation: layer.kind === 'wall' ? (a.orientation === undefined ? (cur?.orientation ?? 1) : int(a.orientation, 'orientation', 1, 19)) : layer.kind === 'floor' ? 0 : 13,
        main: a.main === undefined ? (cur?.main ?? 0) : int(a.main, 'main', 0, 63),
        sub: a.sub === undefined ? (cur?.sub ?? 0) : int(a.sub, 'sub', 0, 255),
      });
    } else if (a.orientation !== undefined && layer.kind === 'wall') c = { ...(c as WallCell), orientation: int(a.orientation, 'orientation', 0, 19) };
    if (a.prop1 !== undefined) c = { ...c, prop1: int(a.prop1, 'prop1', 0, 255) };
    if (a.hidden !== undefined) c = { ...c, hidden: !!a.hidden, prop4: a.hidden ? c.prop4 | 0x80 : c.prop4 & 0x7f };
    if (isEmptyCell(c) && layer.kind === 'wall') c = { ...EMPTY_CELL, orientation: 0, orientationHigh: (c as WallCell).orientationHigh } as WallCell;
    const changed = doc.apply([{ layer, x, y, cell: c }], `Set ${layerLabel(layer)} ${x},${y}`);
    const k = keyOf(layer, c);
    return this.applied(changed, `${layerName(layer)} at ${x},${y} is now ${k ? tileText(k, layer.kind === 'wall') : 'empty'}${c.hidden ? ' (hidden)' : ''}`);
  }

  t_clear(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const r = parseRect(a.rect, map.ds1.width, map.ds1.height);
    const layers = Array.isArray(a.layers) && a.layers.length ? (a.layers as unknown[]).map((l) => this.haveLayer(parseLayer(l))) : doc.layers();
    const edits = clearEdits(doc, r, layers);
    const n = a.objects ? map.ds1.objects.filter((o) => objectInRect(o, r)).length : 0;
    if (!n) return this.applied(doc.apply(edits, 'Clear'), `Cleared ${layers.map(layerName).join(', ')} in ${r.x0},${r.y0}-${r.x1},${r.y1}`);
    doc.mutate((d) => {
      writeEdits(d, edits);
      d.objects = d.objects.filter((o) => !objectInRect(o, r));
    }, `Clear + ${n} objects`);
    return text(`Cleared ${layers.map(layerName).join(', ')} and ${n} object${n === 1 ? '' : 's'} in ${r.x0},${r.y0}-${r.x1},${r.y1}.`);
  }

  t_copy_area(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const r = parseRect(a.rect, map.ds1.width, map.ds1.height);
    const tx = int(a.to_x, 'to_x', -9999, 9999);
    const ty = int(a.to_y, 'to_y', -9999, 9999);
    const clip = copyRect(doc, r);
    const move = !!a.move;
    doc.mutate(
      (d) => {
        if (move) {
          writeEdits(d, clearEdits(doc, r, doc.layers()));
          d.objects = d.objects.filter((o) => !objectInRect(o, r));
        }
        writeEdits(d, pasteEdits(doc, clip, tx, ty));
        d.objects = [...d.objects, ...pasteObjects(doc, clip, tx, ty)];
      },
      `${move ? 'Move' : 'Copy'} ${r.x1 - r.x0 + 1}×${r.y1 - r.y0 + 1}`,
    );
    return text(`${move ? 'Moved' : 'Copied'} ${r.x0},${r.y0}-${r.x1},${r.y1} (${clip.objects?.length ?? 0} objects) to ${tx},${ty}.`);
  }

  t_find_replace(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const name = String(a.layer ?? '');
    const layers = name === 'floor' || name === 'wall' ? doc.layers().filter((l) => l.kind === name) : [this.haveLayer(parseLayer(name))];
    const from = parseTile(a.from, layers[0]);
    const to = parseTile(a.to, layers[0]);
    const within = a.rect ? parseRect(a.rect, map.ds1.width, map.ds1.height) : null;
    const n = findTile(doc, layers, from, within).length;
    const changed = doc.apply(replaceEdits(doc, layers, from, to, within), `Replace ${from.main}/${from.sub} → ${to.main}/${to.sub}`);
    return this.applied(changed, `Replaced ${n} use${n === 1 ? '' : 's'} of ${tileText(from, layers[0].kind === 'wall')} with ${tileText(to, layers[0].kind === 'wall')}`);
  }

  t_reroll(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const layer = this.haveLayer(parseLayer(a.layer));
    const r = parseRect(a.rect, map.ds1.width, map.ds1.height);
    const edits = rerollEdits(doc, r, [layer]);
    return this.applied(doc.apply(edits, `Re-roll ${layerLabel(layer)}`), `Re-rolled ${edits.length} tiles on ${layerName(layer)}`);
  }

  t_resize_map(a: Record<string, unknown>): ToolResult {
    const { doc } = this.need();
    const d = { left: Number(a.left) || 0, top: Number(a.top) || 0, right: Number(a.right) || 0, bottom: Number(a.bottom) || 0 };
    doc.mutate((ds1) => resizeDs1(ds1, d), 'Resize');
    return text(`Resized to ${doc.ds1.width}×${doc.ds1.height}.`);
  }

  t_add_layer(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const kind = a.kind === 'wall' ? 'wall' : a.kind === 'floor' ? 'floor' : fail('kind must be "floor" or "wall".');
    const max = kind === 'floor' ? MAX_FLOOR_LAYERS : MAX_WALL_LAYERS;
    const have = kind === 'floor' ? map.ds1.floors.length : map.ds1.walls.length;
    const n = a.count === undefined ? 1 : int(a.count, 'count', 1, max);
    if (have + n > max) fail(`The map has ${have} ${kind} layer${have === 1 ? '' : 's'}; a DS1 holds at most ${max}.`);
    doc.mutate((d) => {
      const cells = d.width * d.height;
      for (let i = 0; i < n; i++)
        if (kind === 'floor') d.floors.push(Array.from({ length: cells }, () => EMPTY_CELL));
        else d.walls.push(Array.from({ length: cells }, () => ({ ...EMPTY_CELL, orientation: 0, orientationHigh: 0 })));
    }, `Add ${n} ${kind} layer${n === 1 ? '' : 's'}`);
    return text(`Added ${n} ${kind} layer${n === 1 ? '' : 's'}. Layers: ${doc.layers().map(layerName).join(', ')}. (undo with the undo tool)`);
  }

  t_set_cell_flags(a: Record<string, unknown>): ToolResult {
    const { doc } = this.need();
    const layer = this.haveLayer(parseLayer(a.layer ?? 'floor1'));
    const raw = (['prop1', 'prop2', 'prop3', 'prop4'] as const).filter((k) => a[k] !== undefined).map((k) => [k, int(a[k], k, 0, 255)] as const);
    if (!raw.length && a.hidden === undefined && a.unwalkable === undefined) fail('Give hidden, unwalkable and/or prop1-prop4.');
    const edits: CellEdit[] = [];
    let empty = 0;
    for (const [x, y] of this.pickCells(a)) {
      const c = doc.cell(layer, x, y);
      if (a.only_tiles && isEmptyCell(c)) continue;
      const p = { prop1: c.prop1, prop2: c.prop2, prop3: c.prop3, prop4: c.prop4 };
      for (const [k, v] of raw) p[k] = v;
      if (a.unwalkable !== undefined) p.prop3 = a.unwalkable ? p.prop3 | UNWALKABLE : p.prop3 & ~UNWALKABLE;
      if (a.hidden !== undefined) p.prop4 = a.hidden ? p.prop4 | 0x80 : p.prop4 & 0x7f;
      const next = { ...c, ...decodeCell(encodeCell({ ...c, ...p })) };
      if (isEmptyCell(next)) empty++;
      edits.push({ layer, x, y, cell: next });
    }
    const what = [
      ...raw.map(([k, v]) => `${k}=${v}`),
      ...(a.hidden !== undefined ? [a.hidden ? 'hidden' : 'not hidden'] : []),
      ...(a.unwalkable !== undefined ? [a.unwalkable ? 'unwalkable' : 'walkable'] : []),
    ].join(', ');
    const changed = doc.apply(edits, `Cell flags on ${layerLabel(layer)}`);
    const note = empty ? ` (${empty} of them have no tile on ${layerName(layer)}: the game may ignore flags there)` : '';
    return this.applied(changed, `Set ${what} on ${edits.length} ${layerName(layer)} cell${edits.length === 1 ? '' : 's'}${note}`);
  }

  // --- spawning -------------------------------------------------------------------------------------------------

  t_regions(a: Record<string, unknown>): ToolResult {
    const { map } = this.need();
    const r = a.rect ? parseRect(a.rect, map.ds1.width, map.ds1.height) : null;
    const rooms = presetRooms(map.ds1.width, map.ds1.height).filter((m) => !r || (m.x0 <= r.x1 && m.x0 + m.w - 1 >= r.x0 && m.y0 <= r.y1 && m.y0 + m.h - 1 >= r.y0));
    const lines: string[] = [];
    let open = 0;
    for (const room of rooms) {
      const rr = roomRegions(map.ds1, room);
      open += rr.regions.filter((g) => spawns(rr, g)).length;
      const shown = rr.regions.filter((g) => !a.spawning_only || spawns(rr, g));
      if (!shown.length) continue;
      lines.push(`Room ${roomText(room)}${rr.warp ? ' (level warp: nothing spawns)' : ''}:`);
      for (const g of shown) lines.push(`  seed ${g.seed.x},${g.seed.y} · ${regionState(rr, g)} · ${g.cells.length} cells, ${g.floored} floored · ${cellsText(g.cells)}`);
    }
    const p = map.resolution.preset;
    const head =
      `${rooms.length} room${rooms.length === 1 ? '' : 's'}, ${open} region${open === 1 ? '' : 's'} monsters can spawn in.` +
      (p?.logicals === false ? ' Note: this map’s LvlPrest row has Logicals 0, so the game doesn’t split its rooms into regions: nodes do nothing there.' : '');
    const MAX = 600;
    return text([head, ...lines.slice(0, MAX), ...(lines.length > MAX ? [`… ${lines.length - MAX} more lines: give a rect.`] : [])].join('\n'));
  }

  t_no_spawn_area(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const plan = noSpawnPlan(map.ds1, this.pickCells(a), { wholeRooms: !!a.whole_rooms });
    if (!plan.rooms.length) fail('Those cells are in no game room (the last row and column of a map only border rooms).');
    const label = `No-spawn area (${plan.rooms.length} room${plan.rooms.length === 1 ? '' : 's'})`;
    if (plan.floors > map.ds1.floors.length)
      doc.mutate((d) => {
        while (d.floors.length < plan.floors) d.floors.push(Array.from({ length: d.width * d.height }, () => EMPTY_CELL));
        writeEdits(d, plan.edits);
      }, `${label}, adding floor2`);
    else doc.apply(plan.edits, label);
    const still = plan.rooms.flatMap((room) => {
      const rr = roomRegions(map.ds1, room);
      return rr.regions.filter((g) => spawns(rr, g)).map((g) => `${g.seed.x},${g.seed.y}`);
    });
    const p = map.resolution.preset;
    return text(
      [
        `${plan.rooms.length} room${plan.rooms.length === 1 ? '' : 's'} covered (cells ${plan.rooms.map(roomText).join('; ')}).`,
        `${plan.copied} seed floor${plan.copied === 1 ? '' : 's'} hidden under a floor2 copy, ${plan.voids} void seed${plan.voids === 1 ? '' : 's'} given a hidden unwalkable floor.`,
        ...(plan.skipped.length ? [`Not changed: ${plan.skipped.join('; ')}.`] : []),
        still.length ? `Regions that can still spawn monsters (seeds): ${still.join(' ')}.` : 'Every region of those rooms is now a node: no random monsters there.',
        p?.logicals === false ? 'Warning: this map’s LvlPrest row has Logicals 0; nodes only work with Logicals 1.' : !p ? 'The map’s LvlPrest row needs Logicals 1 for nodes to work.' : '',
        '(undo with the undo tool)',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  // --- objects --------------------------------------------------------------------------------------------------

  t_list_objects(a: Record<string, unknown>): ToolResult {
    const { map } = this.need();
    const f = String(a.filter ?? '').toLowerCase();
    const rows = map.ds1.objects
      .map((o, i) => ({ o, i, name: this.gd.objectName(map.ds1.act, o.type, o.id) }))
      .filter((r) => !f || r.name.toLowerCase().includes(f));
    return text(
      rows.map(({ o, i, name }) => `#${i} ${name} · type ${o.type} id ${o.id} · sub-tile ${o.x},${o.y} (cell ${Math.floor(o.x / 5)},${Math.floor(o.y / 5)})${o.path.length ? ` · path of ${o.path.length}` : ''}`).join('\n') ||
        'No objects.',
    );
  }

  t_list_placeable(a: Record<string, unknown>): ToolResult {
    const { map } = this.need();
    const f = String(a.filter ?? '').toLowerCase();
    const act = map.ds1.act;
    const from = a.act === undefined ? act : int(a.act, 'act', 1, 5) - 1;
    // The id that reaches another act's object from this map (as the Objects gallery places it): below 150 the map's
    // act table runs back into earlier acts'; 150 and up is an objects.txt row.
    const idHere = (o: { id: number; row?: number }) => (from === act ? o.id : from < act ? o.id + (from - act) * OBJECTS_PER_ACT : o.row !== undefined ? OBJECTS_PER_ACT + o.row : null);
    const rows = this.gd
      .objectList(from)
      .filter((o) => (from === act || o.type === 2) && (!a.type || o.type === Number(a.type)) && (!f || o.name.toLowerCase().includes(f)))
      .map((o) => ({ ...o, here: idHere(o) }))
      .filter((o) => o.here !== null);
    const head = from === act ? '' : `Act ${from + 1} objects, with the ids that place them in this act ${act + 1} map:\n`;
    return text(head + (rows.map((o) => `type ${o.type} id ${o.here}: ${o.name}${o.hasSprite ? '' : ' (no sprite)'}`).join('\n') || 'None found.'));
  }

  t_add_object(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const o: Ds1Object = { type: int(a.type, 'type', 1, 2), id: int(a.id, 'id', -600, 9999), x: int(a.x, 'x', 0, map.ds1.width * 5 - 1), y: int(a.y, 'y', 0, map.ds1.height * 5 - 1), flags: 0, path: [] };
    doc.setObjects([...map.ds1.objects, o], `Add ${this.gd.objectName(map.ds1.act, o.type, o.id)}`);
    return text(`Added #${map.ds1.objects.length - 1} ${this.gd.objectName(map.ds1.act, o.type, o.id)} at sub-tile ${o.x},${o.y}.`);
  }

  t_edit_objects(a: Record<string, unknown>): ToolResult {
    const { map, doc } = this.need();
    const next = map.ds1.objects.map((o) => ({ ...o, path: o.path.map((p) => ({ ...p })) }));
    for (const m of (a.move as { index: number; x: number; y: number }[] | undefined) ?? []) {
      const o = next[int(m.index, 'index', 0, next.length - 1)];
      const dx = int(m.x, 'x', 0, map.ds1.width * 5 - 1) - o.x;
      const dy = int(m.y, 'y', 0, map.ds1.height * 5 - 1) - o.y;
      o.x += dx;
      o.y += dy;
      o.path = o.path.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    }
    const remove = new Set(((a.remove as number[] | undefined) ?? []).map((i) => int(i, 'index', 0, next.length - 1)));
    doc.setObjects(
      next.filter((_, i) => !remove.has(i)),
      'Edit objects',
    );
    return text(`Moved ${((a.move as unknown[]) ?? []).length}, removed ${remove.size}. Indices after a removal shift down: use list_objects again.`);
  }

  // --- history / checks / output --------------------------------------------------------------------------------

  t_undo(a: Record<string, unknown>): ToolResult {
    const { doc } = this.need();
    let n = 0;
    for (let i = 0; i < (Number(a.steps) || 1) && doc.undo(); i++) n++;
    return text(`Undid ${n} step${n === 1 ? '' : 's'}.`);
  }

  t_redo(a: Record<string, unknown>): ToolResult {
    const { doc } = this.need();
    let n = 0;
    for (let i = 0; i < (Number(a.steps) || 1) && doc.redo(); i++) n++;
    return text(`Redid ${n} step${n === 1 ? '' : 's'}.`);
  }

  t_history(): ToolResult {
    const { doc } = this.need();
    const h = doc.history();
    return text([...h.done.map((s, i) => `${i + 1}. ${s.label}`), ...h.undone.map((s) => `(undone) ${s.label}`)].join('\n') || 'No edits yet.');
  }

  async t_check_map(): Promise<ToolResult> {
    const { map } = this.need();
    const results = await checkMap(this.gd, map, this.scene());
    return text(
      results.map((r) => `[${r.severity}] ${r.area}: ${r.title}${r.detail ? ` — ${r.detail}` : ''}${r.cells?.length ? ` (cells: ${r.cells.slice(0, 12).map((c) => `${c.x},${c.y}`).join(' ')}${r.cells.length > 12 ? ' …' : ''})` : ''}`).join('\n') ||
        'No problems found.',
    );
  }

  async t_render_map(a: Record<string, unknown>): Promise<ToolResult> {
    const { map } = this.need();
    if (!this.host.render) fail('Rendering is not available here.');
    const area = a.rect ? parseRect(a.rect, map.ds1.width, map.ds1.height) : null;
    const r = area ?? { x0: 0, y0: 0, x1: map.ds1.width - 1, y1: map.ds1.height - 1 };
    // Fit ~1568 px (what assistants show without shrinking), unless a scale is asked for.
    const [w, h] = exportSize(r, 1);
    const scale = a.scale !== undefined ? Math.min(1, Math.max(0.05, Number(a.scale))) : Math.min(1, 1568 / Math.max(w, h));
    const sprites = new Map<string, Sprite>();
    if (a.objects !== false)
      for (const o of map.ds1.objects) {
        const k = `${o.type}:${o.id}`;
        if (sprites.has(k)) continue;
        const s = await this.gd.objectSprite(map.ds1.act, o.type, o.id);
        if (s) sprites.set(k, s);
      }
    const scene = this.scene();
    if (a.overlay !== undefined && a.overlay !== 'walkable' && a.overlay !== 'spawn') fail('overlay must be "walkable" or "spawn".');
    const flags = a.overlay ? overlayFlags(map.ds1, scene, map.lib, map.resolution.preset) : null;
    const overlay = !flags ? null : a.overlay === 'walkable' ? walkableOverlay(map.ds1, flags) : spawnOverlay(map.ds1, flags, spawnLevelOf(this.gd, map));
    const data = await this.host.render!(scene, map.ds1.objects, sprites, map, area, scale, a.objects !== false, a.special_tiles === true, overlay);
    const legend = overlay
      ? ` ${overlay.title}: ${overlay.classes.map((c, i) => (overlay.counts[i] ? `${c.label} ${Math.round(overlay.counts[i] / 25)} tiles²` : '')).filter(Boolean).join(', ')}. ${overlay.notes.join(' ')}`
      : '';
    return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: `Rendered ${area ? `${r.x0},${r.y0}-${r.x1},${r.y1}` : 'the whole map'} at ${Math.round(scale * 100)}%.${legend}` }] };
  }

  async t_save_map(a: Record<string, unknown>): Promise<ToolResult> {
    const { doc } = this.need();
    if (!this.host.saveTarget) fail('No writable mod folder is set up: open DS1 Studio and choose your mod folder first.');
    if (a.path) {
      const p = normalizePath(String(a.path));
      if (!/^data\/global\/tiles\/.+\.ds1$/.test(p)) fail('path must look like data/global/tiles/<folder>/<name>.ds1');
      doc.path = p;
      this.map = { ...this.map!, path: p };
    }
    const bytes = writeDs1(doc.ds1);
    const where = await this.host.saveTarget!.save(doc.path, bytes);
    this.gd.fs.remember(doc.path, bytes, this.host.saveTarget!.label);
    doc.ds1.version = WRITE_VERSION;
    doc.markSaved();
    return text(`${where}. If this map is open in the DS1 Studio window, reopen it there to see the changes.`);
  }
}

/** A region's cells, shortened to their bounding box when there are many. */
function cellsText(cells: { x: number; y: number }[]): string {
  if (cells.length <= 6) return cells.map((c) => `${c.x},${c.y}`).join(' ');
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  return `within ${Math.min(...xs)},${Math.min(...ys)}-${Math.max(...xs)},${Math.max(...ys)}`;
}

const regionState = (rr: RoomRegions, g: RoomRegions['regions'][number]) => (g.node ? 'node (no spawns)' : rr.warp ? 'warp room' : !g.floored ? 'no floor' : 'SPAWNS');

/** Writes cell edits straight into a map (inside MapDocument.mutate). */
function writeEdits(d: OpenMap['ds1'], edits: CellEdit[]) {
  for (const e of edits) {
    const layers = e.layer.kind === 'floor' ? d.floors : e.layer.kind === 'wall' ? d.walls : d.shadows;
    if (layers[e.layer.index]) (layers[e.layer.index] as (typeof e.cell)[])[e.y * d.width + e.x] = e.cell;
  }
}
