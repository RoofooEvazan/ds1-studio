export type Tool = 'select' | 'paint' | 'erase' | 'pick' | 'object';

export const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'select', label: 'Select', key: 'v', hint: 'Click or drag to select combined cells. Only Shift+wheel selects individual tiles; scroll zooms. Shift+click/drag adds cells' },
  { id: 'paint', label: 'Paint', key: 'b', hint: 'Paint the chosen tile on the active layer (Alt+drag: on the first free layer, stacking onto tiles already there)' },
  { id: 'erase', label: 'Erase', key: 'e', hint: 'Clear cells on the active layer' },
  { id: 'pick', label: 'Pick', key: 'i', hint: 'Copy a tile from the map into the brush' },
  { id: 'object', label: 'Objects', key: 'o', hint: 'Select, move, add and delete objects/NPCs and edit NPC paths' },
];

export interface Visibility {
  floors: boolean[];
  walls: boolean[];
  shadows: boolean;
  roofs: boolean;
  lowerWalls: boolean;
  upperWalls: boolean;
  wallCategories?: import('../game/wallCategories').WallCategories;
  specials: boolean;
  /**
   * Objects and NPCs (markers, sprites, paths) on the map. Off: hidden, and copying, cutting or clearing an area leaves
   * them where they are. The Objects tool shows them whatever this is.
   */
  objectsLayer: boolean;
  /** Each placed object's light drawn as a ring around it (how far it reaches), in any mode. */
  lightRings: boolean;
  /** Level light preview: objects' lights (torches, fires…) brighten the map around them. */
  objectLights: boolean;
  objects: boolean;
  paths: boolean;
  groups: boolean;
  missing: boolean;
  grid: boolean;
  walkable: boolean;
  /** A colour-coded overview over the map: where players can walk, or where random monsters can spawn. */
  overview: import('../game/mapOverlays').OverlayKind | null;
  animate: boolean;
  sprites: boolean;
  rooms: boolean;
  /** Show the in-game automap over the map. */
  automap: boolean;
  /** Overview of the whole map in a corner of the view. */
  minimap: boolean;
  /** Roof/wall hide areas ("pops"), and showing the map as if a player stood in them (their tiles hidden). */
  pops: boolean;
  popsInside: boolean;
  /** Draw the map in its level's light (Levels.txt Intensity and Red/Green/Blue), as dark or tinted as in game. */
  light: boolean;
}

export const DEFAULT_VISIBILITY: Visibility = {
  floors: [true, true],
  walls: [true, true, true, true],
  shadows: true,
  roofs: true,
  lowerWalls: true,
  upperWalls: true,
  specials: true,
  objectsLayer: true,
  lightRings: false,
  objectLights: true,
  objects: true,
  paths: true,
  groups: false,
  missing: true,
  grid: false,
  walkable: false,
  overview: null,
  animate: true,
  sprites: true,
  rooms: false,
  automap: false,
  minimap: true,
  pops: false,
  popsInside: false,
  light: false,
};

/**
 * What the right-hand panel is for. Views with options of their own are modes, one at a time: each replaces the
 * side panel with just its options. Plain overlays (grid, rooms, sprites…) are not modes and combine freely.
 */
export type ViewMode = 'tiles' | 'objects' | 'walk' | 'automap' | 'light' | 'roofs';

/** The views in the order Tab steps through them. */
export const VIEW_CYCLE: ViewMode[] = ['tiles', 'objects', 'walk', 'automap', 'light', 'roofs'];
export const VIEW_NAMES: Record<ViewMode, string> = { tiles: 'Tiles', objects: 'Objects', walk: 'Walkability', automap: 'Automap', light: 'Level light', roofs: 'Roof hiding' };

/** The view after (dir 1) or before (dir -1) `mode`. */
export function nextView(mode: ViewMode, dir: 1 | -1): ViewMode {
  return VIEW_CYCLE[(VIEW_CYCLE.indexOf(mode) + dir + VIEW_CYCLE.length) % VIEW_CYCLE.length];
}

/** Each mode's visibility flag. */
const MODE_FLAGS = { walk: 'walkable', automap: 'automap', light: 'light', roofs: 'pops' } as const;

export function modeOf(v: Visibility): ViewMode {
  for (const [mode, flag] of Object.entries(MODE_FLAGS)) if (v[flag]) return mode as ViewMode;
  return 'tiles';
}

/** `v` in mode `mode` (the others off). */
export function withMode(v: Visibility, mode: ViewMode): Visibility {
  const out = { ...v };
  for (const [m, flag] of Object.entries(MODE_FLAGS)) out[flag] = m === mode;
  return out;
}

/** A visibility change that keeps one mode at a time: a mode just switched on switches the one before off. */
export function oneMode(prev: Visibility, next: Visibility): Visibility {
  const turnedOn = (Object.entries(MODE_FLAGS) as [ViewMode, keyof typeof prev][]).find(([, flag]) => next[flag] && !prev[flag]);
  return turnedOn ? withMode(next, turnedOn[0]) : next;
}

export const ORIENTATION_NAMES: Record<number, string> = {
  0: 'Floor',
  1: 'Left wall',
  2: 'Right wall',
  3: 'North corner (right)',
  4: 'North corner (left)',
  5: 'Left end wall',
  6: 'Right end wall',
  7: 'South corner',
  8: 'Left wall + door',
  9: 'Right wall + door',
  10: 'Special tile',
  11: 'Special tile',
  12: 'Pillar / standalone',
  13: 'Shadow',
  14: 'Tree',
  15: 'Roof',
  16: 'Lower wall (left)',
  17: 'Lower wall (right)',
  18: 'Lower wall (north)',
  19: 'Lower wall (south)',
};

/**
 * One map layer in the layer bar: a floor or wall layer by number, or one of the tile groups shown across the wall
 * layers (upper walls, lower walls, roofs) and the shadow and special-tile layers.
 */
export type LayerSlot = { floor: number } | { wall: number } | 'upperWalls' | 'lowerWalls' | 'roofs' | 'shadows' | 'specials';

const GROUPS = ['upperWalls', 'lowerWalls', 'roofs', 'shadows', 'specials'] as const;

/** `v` with every layer shown (the other view settings kept). */
export function allLayersShown(v: Visibility): Visibility {
  return { ...v, floors: v.floors.map(() => true), walls: v.walls.map(() => true), upperWalls: true, lowerWalls: true, roofs: true, shadows: true, specials: true, objectsLayer: true };
}

/** `v` showing only `slot` (a wall group shows across every wall layer; a wall layer shows all its groups). */
export function soloLayer(v: Visibility, slot: LayerSlot): Visibility {
  const out: Visibility = { ...v, floors: v.floors.map(() => false), walls: v.walls.map(() => false), upperWalls: false, lowerWalls: false, roofs: false, shadows: false, specials: false };
  if (typeof slot === 'object') {
    if ('floor' in slot) out.floors = v.floors.map((_, i) => i === slot.floor);
    else {
      out.walls = v.walls.map((_, i) => i === slot.wall);
      out.upperWalls = out.lowerWalls = out.roofs = true;
    }
  } else {
    out[slot] = true;
    if (slot === 'upperWalls' || slot === 'lowerWalls' || slot === 'roofs') out.walls = v.walls.map(() => true);
  }
  return out;
}

/** Whether `v` shows `slot` alone (as soloLayer leaves it). */
export function isSolo(v: Visibility, slot: LayerSlot): boolean {
  const s = soloLayer(v, slot);
  return s.floors.every((x, i) => x === (v.floors[i] ?? true)) && s.walls.every((x, i) => x === (v.walls[i] ?? true)) && GROUPS.every((k) => s[k] === v[k]);
}
