import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Ds1Object } from '../formats/ds1';
import type { Dt1Tile } from '../formats/dt1';
import type { Sprite } from '../game/sprites';
import type { ResizeDelta } from '../formats/ds1ops';
import { cellKey, type CellRect, type CellSelection } from '../game/clipboard';
import type { OpenMap } from '../game/openMap';
import { TileAtlas } from '../render/atlas';
import { blendFlag, InstanceFlag, MapRenderer, type Camera, type Instance, type SceneLight } from '../render/MapRenderer';
import type { SpriteAnimation } from '../game/spriteAnim';
import { AUTOMAP_CODES, AUTOMAP_SCALE, type AutomapPiece } from '../game/automap';
import { automapCanvas, type AutomapKind, type AutomapStyle, type DrawPiece } from '../game/automapStyle';
import type { SpriteFrame } from '../formats/dc6';
import { cellToWorld, SubTileFlag, subTileToWorld, worldToCell, worldToSubTile, type DrawItem, type Scene } from '../render/scene';
import type { Tool, Visibility } from './state';
import { specialTileInfo } from '../game/specialTiles';
import { Minimap } from './Minimap';
import { hideRect, popTargets, triggerRect, type PopArea } from '../game/pops';
import type { Ds1 } from '../formats/ds1';
import { canvasToWorld } from '../render/inputProjection';
import { combinedCellAt, cycleWithWheel, tileEmphasis } from '../game/mapSelection';
import { wallCategory } from '../game/wallCategories';
import { stepAtOrBelow, stepZoom, WheelSteps } from './zoomSteps';
import { overlayFlags, type MapOverlay } from '../game/mapOverlays';
import { drawSubTilePaths, overlayPaths, subTilePaths, type SubTilePaths } from '../render/overlay';

export interface HoverInfo {
  cellX: number;
  cellY: number;
  world?: [number, number];
}

/** A tile drawn translucently as a brush preview. */
export interface GhostTile {
  tile: Dt1Tile;
  x: number;
  y: number;
  /** A wall being placed on this wall layer of this cell: drawn behind the cell's tiles on higher wall layers. */
  depth?: { cellX: number; cellY: number; wallLayer: number };
}

export type StrokePhase = 'start' | 'move' | 'end';
/** Modifier keys held when the stroke started. */
export interface StrokeMods {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
}

interface Props {
  map: OpenMap;
  scene: Scene;
  visibility: Visibility;
  hover: HoverInfo | null;
  tool: Tool;
  ghost: GhostTile[];
  /** Display name for an object marker. */
  objectLabel: (o: Ds1Object) => string;
  selectedObject: number | null;
  /** Bumped while objects move (a drag): redraws them without rebuilding the tiles. */
  objectsRevision?: number;
  /** More objects selected with it (double-click selects every one of a kind), highlighted too. */
  selectedObjects?: ReadonlySet<number> | null;
  /** A double click on the map, at this world point. */
  onDoubleClick?: (world: [number, number]) => void;
  /** Object sprites by "type:id". */
  sprites: Map<string, Sprite>;
  /** Object animations by "type:id" (drawn instead of the still sprite while animation is on). */
  animations?: Map<string, SpriteAnimation>;
  /** Cells to call out (e.g. problems found by the compatibility check). */
  marks?: { x: number; y: number }[];
  /** Cells whose existing tiles the pending paste would replace (drawn red). */
  doomed?: { x: number; y: number }[] | null;
  /** Show edge handles that resize the map by dragging. */
  resizeMode: boolean;
  onResize: (delta: ResizeDelta) => void;
  selection: CellSelection | null;
  /** Footprint of a pending paste, drawn as an outline. */
  pasteRect: CellRect | null;
  onHover: (h: HoverInfo | null) => void;
  onZoom: (zoom: number) => void;
  /** Tool strokes in cell coordinates; `cells` are all cells crossed since the last event, `world` is the cursor. */
  onStroke: (phase: StrokePhase, cells: [number, number][], world: [number, number], mods?: StrokeMods) => void;
  /** Bumped by the parent to request "fit map to view". */
  fitSignal: number;
  /** A right-click that didn't drag (a drag pans): the screen point, the cell under it and its world position. */
  /** Right-click on the map (`mods`: Ctrl / Shift held, for Ctrl+Shift+right-click). */
  onContextMenu?: (screen: [number, number], cell: [number, number], world: [number, number], mods?: { ctrl: boolean; shift: boolean }) => void;
  /** Receives a function that pictures the view exactly as shown (map, overlays, minimap) as a canvas. */
  snapshotRef?: MutableRefObject<(() => HTMLCanvasElement | null) | null>;
  /**
   * Game view: when `signal` changes, zoom so the game's 800×600 screen fills the viewport (centred on `center`, a
   * world point, when given); while `on`, everything outside that screen is shaded.
   */
  gameView?: { on: boolean; signal: number; center?: [number, number] | null; width: number; height: number };
  /** One tile of a stack of overlapping tiles, chosen with Shift+wheel: highlighted and outlined. */
  focus: { item: DrawItem; index: number; count: number; label: string; anchor?: [number, number] } | null;
  /** An area selection narrowed to one layer with Shift+scroll (only its tiles are highlighted). */
  areaLayer?: { kind: 'floor' | 'wall' | 'shadow'; index: number } | null;
  hittable: (item: DrawItem) => boolean;
  /** The in-game automap drawn over the map (dimmed underneath). */
  automap?: { pieces: AutomapPiece[]; cels: SpriteFrame[]; palette: Uint8Array; style: AutomapStyle; kindOf: (orientation: number, main: number, sub: number) => AutomapKind } | null;
  /** Shift+wheel over the map: step through the tiles under the cursor (+1 = further back). */
  onCycle: (dir: 1 | -1, world: [number, number]) => void;
  /** Input and label preferences: wheel-zoom and arrow-key speeds (1 = normal), what Shift+wheel does, object names. */
  input?: { zoomSpeed: number; smoothZoom?: boolean; arrowSpeed: number; shiftWheel: 'layers' | 'zoom'; objectLabels: boolean };
  /**
   * When `signal` changes: zoom a step in (1) or out (-1), to 100% ('100'), or to exactly 10% ('10': the automap is
   * drawn a tenth of the map's size, so there one automap pixel is one screen pixel), around the middle of the view.
   */
  zoomCommand?: { to: 1 | -1 | '100' | '10'; signal: number } | null;
  /** When `signal` changes, centre the view on this world point (zooming in if far out). */
  centerOn?: { x: number; y: number; signal: number } | null;
  /** Label of a special tile (e.g. where a warp leads); defaults to what the tile is. */
  specialLabel?: (main: number, sub: number) => string;
  /**
   * Roof/wall hide areas ("pops"): drawn when `show`; with `inside`, the tiles they hide are left out, as the game
   * shows them while a player is inside. `hidden` = "wallLayer:x:y" of those tiles.
   */
  pops?: { areas: PopArea[]; popPad: number; show: boolean; inside: boolean; hidden: Set<string> };
  /** Sub-tiles being painted in walkability mode (keys sy * 65536 + sx), and whether they get blocked or cleared. */
  walkMarks?: { keys: ReadonlySet<number>; mode: 'block' | 'clear' | 'replace' } | null;
  /**
   * Walkability mode's brush: the cursor shows its footprint on the sub-tile grid instead of a whole cell, and strokes
   * report every new sub-tile the cursor reaches (not just new cells).
   */
  walkBrush?: { size: 1 | 3 | 5 | 'cell'; mode: 'block' | 'clear' | 'replace' } | null;
  /**
   * Objects on the cursor after Ctrl+C / Ctrl+X in object mode (positions relative to the cursor's sub-tile): drawn
   * tinted, green for a copy, red for a cut, until they're placed.
   */
  objectGhost?: { objects: Ds1Object[]; cut: boolean } | null;
  /** A colour-coded overview over the map (walkable sub-tiles, monster spawns), or null. */
  overview?: MapOverlay | null;
  /** Draw the map in this light (multiplies every colour), or as stored when null. */
  light?: [number, number, number] | null;
  /** With `light`: a player's light radius (sub-tiles) around the cursor, as a player standing there would see. */
  playerLight?: number;
  /** The placed objects' lights (for the rings, and the light preview). */
  objectLights?: SceneLight[] | null;
  /** With `light`: the objects' lights brighten the map around them. */
  objectLightsLit?: boolean;
  /** Draw each object light's reach as a ring (any mode: for placing light sources). */
  lightRings?: boolean;
}

const BACKGROUND: [number, number, number] = [0.043, 0.047, 0.059];

export function isVisible(it: DrawItem, v: Visibility): boolean {
  if (it.kind === 'wall' || it.kind === 'lowerWall') {
    const category = it.tile ? wallCategory(it.tile.orientation, it.sourcePath, v.wallCategories) : null;
    return (category === 'lower' || (!category && it.kind === 'lowerWall') ? v.lowerWalls : v.upperWalls) && (v.walls[it.layer] ?? true);
  }
  switch (it.kind) {
    case 'floor':
      return v.floors[it.layer] ?? true;
    case 'shadow':
      return v.shadows;
    case 'roof':
      return v.roofs && (v.walls[it.layer] ?? true);
    case 'special':
      return v.specials;
  }
}

type Side = keyof ResizeDelta;
const SIDES: Side[] = ['left', 'top', 'right', 'bottom'];

/** Midpoint of a map edge, in cell coordinates. */
function sideAnchor(side: Side, w: number, h: number): [number, number] {
  return side === 'left' ? [0, h / 2] : side === 'right' ? [w, h / 2] : side === 'top' ? [w / 2, 0] : [w / 2, h];
}

/** The delta produced by dragging `side` to fractional cell (fx, fy). Keeps at least one cell. */
function dragDelta(side: Side, fx: number, fy: number, w: number, h: number): ResizeDelta {
  const d: ResizeDelta = { left: 0, top: 0, right: 0, bottom: 0 };
  if (side === 'left') d.left = Math.min(-Math.round(fx), w - 1);
  if (side === 'right') d.right = Math.max(Math.round(fx) - w, 1 - w);
  if (side === 'top') d.top = Math.min(-Math.round(fy), h - 1);
  if (side === 'bottom') d.bottom = Math.max(Math.round(fy) - h, 1 - h);
  return d;
}

/** Cells on the grid line from a to b (inclusive), so fast drags don't skip cells. */
function cellLine([x0, y0]: [number, number], [x1, y1]: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function MapView(props: Props) {
  const { map, scene, visibility, hover, tool, ghost, selection, pasteRect, objectLabel, selectedObject, sprites, fitSignal, focus } = props;
  const popsInside = props.pops?.inside ? props.pops.hidden : null;
  const lastPreview = useRef<[number, number] | null>(null);
  const previewCell = useMemo(() => {
    const next = hover
      ? tool === 'select' && hover.world
        ? combinedCellAt(scene, hover.world, [hover.cellX, hover.cellY], props.hittable)
        : ([hover.cellX, hover.cellY] as [number, number])
      : null;
    // The same array while the pointer stays in one cell, so moving within it redraws nothing.
    const prev = lastPreview.current;
    if (next && prev && next[0] === prev[0] && next[1] === prev[1]) return prev;
    lastPreview.current = next;
    return next;
  }, [scene, hover, tool, props.hittable]);
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const atlas = useRef(new TileAtlas());
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  /** Arrow keys currently held ('Shift' too while one is). */
  const arrows = useRef(new Set<string>());
  const dirty = useRef(true);
  const minimapDraw = useRef<(() => void) | null>(null);
  const [frame, setFrame] = useState(0);
  const automapImage = useMemo(() => (props.automap ? renderAutomap(map.ds1.width, map.ds1.height, props.automap) : null), [props.automap, map]);
  // Built once per scene, not per frame: a 150×150 map has 562,500 sub-tiles.
  // As the game builds collision: an empty cell is open ground unless LvlPrest FillBlanks puts a blocking blank tile there.
  const walk = useMemo(() => (visibility.walkable ? walkPaths(overlayFlags(map.ds1, scene, map.lib, map.resolution.preset), map.ds1.width, map.ds1.height) : null), [visibility.walkable, map, scene]);
  const overviewPaths = useMemo(() => (props.overview ? overlayPaths(props.overview, map.ds1.width) : null), [props.overview, map]);
  const resizeDrag = useRef<{ side: Side; delta: ResizeDelta } | null>(null);
  /** The sub-tile under the cursor in walkability mode (drawn as the brush's footprint). */
  const walkCursor = useRef<[number, number] | null>(null);
  /** The cursor in world space (for the player's light preview). */
  const cursorWorld = useRef<[number, number] | null>(null);
  const latest = useRef({ ...props, walk, overviewPaths, resizeDrag, automapImage, walkCursor, cursorWorld });
  latest.current = { ...props, walk, overviewPaths, resizeDrag, automapImage, walkCursor, cursorWorld };

  // Animation clock in game ticks (25 per second, like the game). Animated floors advance every 2.5 ticks (10 fps);
  // objects at their own rate. Without animated objects the clock only needs the floors' 10 fps.
  const animations = props.animations;
  const hasObjectAnims = useMemo(() => visibility.sprites && [...(animations?.values() ?? [])].some((an) => an.parts.length > 1), [animations, visibility.sprites]);
  useEffect(() => {
    if (!visibility.animate || (!scene.animated && !hasObjectAnims)) return;
    const ms = hasObjectAnims ? 40 : 100;
    const t = setInterval(() => setFrame((f) => f + ms / 40), ms);
    return () => clearInterval(t);
  }, [scene.animated, visibility.animate, hasObjectAnims]);

  // One renderer per canvas; redraw on demand.
  useEffect(() => {
    renderer.current = new MapRenderer(glCanvas.current!);
    let raf = 0;
    let last = performance.now();
    const frame = () => {
      if (!glCanvas.current || !overlay.current) return;
      raf = requestAnimationFrame(frame);
      const dpr = window.devicePixelRatio || 1;
      // Arrow keys pan smoothly while held (Shift = faster), at a steady on-screen speed whatever the zoom.
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = arrows.current;
      const dx = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
      const dy = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
      if (dx || dy) {
        const speed = (k.has('Shift') ? 1800 : 700) * (latest.current.input?.arrowSpeed ?? 1) * dpr * dt / camera.current.zoom;
        camera.current.x += dx * speed;
        camera.current.y += dy * speed;
        dirty.current = true;
      }
      for (const c of [glCanvas.current!, overlay.current!]) {
        const w = Math.round(c.clientWidth * dpr);
        const h = Math.round(c.clientHeight * dpr);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
          dirty.current = true;
        }
      }
      if (!dirty.current) return;
      dirty.current = false;
      renderer.current!.light = latest.current.light ?? [1, 1, 1];
      const glowAt = latest.current.light && latest.current.playerLight ? cursorWorld.current : null;
      renderer.current!.glow = glowAt ? [glowAt[0], glowAt[1], latest.current.playerLight!] : [0, 0, 0];
      renderer.current!.lights = latest.current.light && latest.current.objectLightsLit !== false ? (latest.current.objectLights ?? []) : [];
      renderer.current!.draw(camera.current, BACKGROUND);
      drawOverlay(overlay.current!, camera.current, latest.current);
      minimapDraw.current?.();
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, []);

  const fit = () => {
    const c = glCanvas.current!;
    const { minX, minY, maxX, maxY } = latest.current.scene.bounds;
    const dpr = window.devicePixelRatio || 1;
    const free = Math.min((c.clientWidth * dpr) / (maxX - minX + 160), (c.clientHeight * dpr) / (maxY - minY + 240), 2 * dpr);
    const zoom = latest.current.input?.smoothZoom ? free : stepAtOrBelow(free);
    camera.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
    latest.current.onZoom(zoom / dpr);
    dirty.current = true;
  };

  // A picture of the view as it is on screen. WebGL keeps its picture only until the frame is shown, so it is drawn
  // again right before copying; the overlay and the minimap (2D canvases) are copied where they sit.
  const snapshotRef = props.snapshotRef;
  useEffect(() => {
    if (!snapshotRef) return;
    snapshotRef.current = () => {
      const gl = glCanvas.current;
      const ov = overlay.current;
      if (!gl || !ov || !renderer.current || !gl.width || !gl.height) return null;
      renderer.current.draw(camera.current, BACKGROUND);
      const out = document.createElement('canvas');
      out.width = gl.width;
      out.height = gl.height;
      const ctx = out.getContext('2d')!;
      ctx.drawImage(gl, 0, 0);
      ctx.drawImage(ov, 0, 0);
      const base = gl.getBoundingClientRect();
      const sx = gl.width / base.width;
      const sy = gl.height / base.height;
      for (const c of gl.parentElement?.querySelectorAll('canvas') ?? []) {
        if (c === gl || c === ov) continue;
        const r = c.getBoundingClientRect();
        if (r.width && r.height) ctx.drawImage(c, (r.left - base.left) * sx, (r.top - base.top) * sy, r.width * sx, r.height * sy);
      }
      return out;
    };
    return () => {
      snapshotRef.current = null;
    };
  }, [snapshotRef]);

  // New map: fresh atlas, fit to view. (Re-resolving tiles or switching palettes keeps the same DS1 and camera.)
  useEffect(() => {
    atlas.current = new TileAtlas();
    fit();
  }, [map.ds1]);

  // The atlas holds palette indices, so a palette change only swaps the palette texture.
  useEffect(() => {
    renderer.current!.setPalette(map.palette);
    dirty.current = true;
  }, [map.palette]);

  useEffect(() => {
    if (fitSignal) fit();
  }, [fitSignal]);

  useEffect(() => {
    const c = props.centerOn;
    if (!c?.signal) return;
    const dpr = window.devicePixelRatio || 1;
    const near = Math.max(camera.current.zoom, 0.6 * dpr);
    const zoom = latest.current.input?.smoothZoom || near === camera.current.zoom ? near : stepZoom(near, 1);
    camera.current = { x: c.x, y: c.y, zoom };
    latest.current.onZoom(zoom / dpr);
    dirty.current = true;
  }, [props.centerOn?.signal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const z = props.zoomCommand;
    if (!z?.signal) return;
    const cam = camera.current;
    const dpr = window.devicePixelRatio || 1;
    const smooth = latest.current.input?.smoothZoom;
    cam.zoom = z.to === '10' ? 1 / AUTOMAP_SCALE : z.to === '100' ? (smooth ? dpr : 1) : smooth ? Math.min(Math.max(cam.zoom * (z.to > 0 ? 1.25 : 0.8), 0.05), 8 * dpr) : stepZoom(cam.zoom, z.to);
    latest.current.onZoom(cam.zoom / dpr);
    dirty.current = true;
  }, [props.zoomCommand?.signal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const g = props.gameView;
    if (!g?.signal) return;
    const c = glCanvas.current!;
    const dpr = window.devicePixelRatio || 1;
    // Exactly 100% (one game pixel per screen pixel, as in game) when the screen fits; smaller only when it doesn't
    // (a step down that keeps pixels sharp, unless zooming smoothly).
    const free = Math.min(latest.current.input?.smoothZoom ? dpr : 1, (c.clientWidth * dpr) / (g.width + 40), (c.clientHeight * dpr) / (g.height + 40));
    const zoom = latest.current.input?.smoothZoom ? free : stepAtOrBelow(free);
    const cam = camera.current;
    camera.current = { x: g.center?.[0] ?? cam.x, y: g.center?.[1] ?? cam.y, zoom };
    latest.current.onZoom(zoom / dpr);
    dirty.current = true;
  }, [props.gameView?.signal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    dirty.current = true;
  }, [props.gameView?.on, props.gameView?.width, props.gameView?.height]);

  /**
   * The map's instances as last built, with each scene tile's instance index: hovering and selecting only change
   * flags (see the emphasis effect), and the brush preview is spliced in without rebuilding (see uploadWithGhosts).
   */
  const built = useRef<{
    instances: Instance[];
    slotIdx: number[];
    slotItems: DrawItem[];
    slotBase: number[];
    /** Animated objects: a fixed run of instances each (the most parts any frame has; unused ones drawn empty). */
    animObjs: { start: number; count: number; i: number; anim: NonNullable<Props['animations']> extends Map<string, infer A> ? A : never; wx: number; wy: number; flags: number }[];
    /** Animated floor tiles (water, lava): one instance each. */
    animFloors: { index: number; it: DrawItem; slot: number }[];
  } | null>(null);
  /** The animation frame, read by the rebuild (which must not rerun on every frame). */
  const frameRef = useRef(frame);
  frameRef.current = frame;
  /** Emphasis (selected / hovered) for a scene tile with the current selection, focus, hover and tool. */
  const emphasisOf = (it: DrawItem): number => {
    if (tool === 'object' || props.walkBrush || ghost.length) return 0;
    const e = tileEmphasis(it, tool === 'select' ? selection : null, tool === 'select' ? focus?.item ?? null : null, previewCell, tool === 'select' ? props.areaLayer ?? null : null);
    return e === 'selected' ? InstanceFlag.Highlight : e === 'hover' ? InstanceFlag.Preview : 0;
  };
  /** Uploads the built instances plus the brush / paste preview ("ghost") tiles. */
  const uploadWithGhosts = () => {
    const b = built.current;
    if (!b || !renderer.current) return;
    const a = atlas.current;
    const ghostInstance = (g: GhostTile): Instance | null => {
      const e = a.get(g.tile);
      return e ? { x: g.x + e.image.offsetX, y: g.y + e.image.offsetY, w: e.image.width, h: e.image.height, u: e.u, v: e.v, layer: e.layer, flags: InstanceFlag.Ghost } : null;
    };
    if (!ghost.length) {
      renderer.current.syncAtlas(a);
      renderer.current.setInstances(b.instances);
      dirty.current = true;
      return;
    }
    // A wall placed on a lower layer goes behind the higher layers' tiles at its cell: insert it before the first of them.
    const inserts: { at: number; inst: Instance }[] = [];
    const tail: Instance[] = [];
    for (const g of ghost) {
      const inst = ghostInstance(g);
      if (!inst) continue;
      let at = -1;
      if (g.depth) {
        const d = g.depth;
        for (let k = 0; k < b.slotItems.length; k++) {
          const it = b.slotItems[k];
          if (it.kind !== 'floor' && it.kind !== 'shadow' && it.cellX === d.cellX && it.cellY === d.cellY && it.layer > d.wallLayer) {
            at = b.slotIdx[k];
            break;
          }
        }
      }
      if (at >= 0) inserts.push({ at, inst });
      else tail.push(inst);
    }
    inserts.sort((p, q) => p.at - q.at);
    const out: Instance[] = [];
    let from = 0;
    for (const ins of inserts) {
      for (; from < ins.at; from++) out.push(b.instances[from]);
      out.push(ins.inst);
    }
    for (; from < b.instances.length; from++) out.push(b.instances[from]);
    out.push(...tail);
    renderer.current.syncAtlas(a);
    renderer.current.setInstances(out);
    dirty.current = true;
  };

  /** The instances of an animated object at animation frame `f`: its parts, then empty ones up to its run length. */
  const objectFrame = (slot: NonNullable<typeof built.current>['animObjs'][number], f: number): Instance[] => {
    const a = atlas.current;
    const parts = slot.anim.parts[Math.floor((f / 25) * slot.anim.fps + slot.i * 7) % slot.anim.parts.length];
    const out: Instance[] = [];
    for (const part of parts) {
      const e = a.getImage(part.image, part.image);
      if (!e) continue;
      const img = part.image;
      out.push({ x: slot.wx + img.offsetX, y: slot.wy + 4 + img.offsetY, w: img.width, h: img.height, u: e.u, v: e.v, layer: e.layer, flags: slot.flags | blendFlag(part.blend) });
    }
    while (out.length < slot.count) out.push({ x: slot.wx, y: slot.wy, w: 0, h: 0, u: 0, v: 0, layer: 0, flags: 0 });
    return out;
  };

  // Rebuild instances when the scene, layer visibility, tool or objects change (animation frames only patch, below).
  useEffect(() => {
    const instances: Instance[] = [];
    const slotIdx: number[] = [];
    const slotItems: DrawItem[] = [];
    const slotBase: number[] = [];
    const animObjs: NonNullable<typeof built.current>['animObjs'] = [];
    const animFloors: NonNullable<typeof built.current>['animFloors'] = [];
    const frameNow = frameRef.current;
    const floorFrameNow = Math.floor(frameNow / 2.5);
    const a = atlas.current;
    const push = (tile: Dt1Tile, x: number, y: number, flags: number) => {
      const e = a.get(tile);
      if (!e) return;
      instances.push({ x: x + e.image.offsetX, y: y + e.image.offsetY, w: e.image.width, h: e.image.height, u: e.u, v: e.v, layer: e.layer, flags });
    };
    // Object sprites are interleaved with the walls in depth order: an object draws after the walls of its own
    // cell diagonal and before those further forward (WinDS1 draws objects right after each row's walls).
    const objs = visibility.sprites
      ? map.ds1.objects
          .map((o, i) => ({ o, i, sprite: sprites.get(`${o.type}:${o.id}`), depth: Math.floor(o.x / 5) + Math.floor(o.y / 5) }))
          .filter((x): x is typeof x & { sprite: Sprite } => !!x.sprite)
          .sort((a, b) => a.depth - b.depth || a.o.x + a.o.y - (b.o.x + b.o.y))
      : [];
    let next = 0;
    const flushObjects = (maxDepth: number) => {
      for (; next < objs.length && objs[next].depth <= maxDepth; next++) {
        const { o, i, sprite } = objs[next];
        // Drawn like the game: solid layers plus translucent / glowing ones with their own blend. Animated objects
        // show their current frame (each starts at its own phase so they don't move in step); otherwise frame 0.
        const anim = animations?.get(`${o.type}:${o.id}`);
        const [wx, wy] = subTileToWorld(o.x, o.y);
        const flags = i === selectedObject || props.selectedObjects?.has(i) ? InstanceFlag.Highlight : 0;
        if (anim && anim.parts.length > 1 && visibility.animate) {
          // A fixed run of instances, patched frame by frame; every frame's images go into the atlas now.
          const count = Math.max(...anim.parts.map((p) => p.length));
          for (const f of anim.parts) for (const part of f) a.getImage(part.image, part.image);
          const start = instances.length;
          const slot = { start, count, i, anim, wx, wy, flags };
          instances.push(...objectFrame(slot, frameNow));
          animObjs.push(slot);
          continue;
        }
        const parts = anim?.parts.length ? anim.parts[0] : [{ image: sprite, blend: -1 }];
        for (const part of parts) {
          const e = a.getImage(part.image, part.image);
          if (!e) continue;
          const img = part.image;
          instances.push({ x: wx + img.offsetX, y: wy + 4 + img.offsetY, w: img.width, h: img.height, u: e.u, v: e.v, layer: e.layer, flags: flags | blendFlag(part.blend) });
        }
      }
    };
    for (const it of scene.items) {
      if (it.kind === 'wall') flushObjects(it.cellX + it.cellY - 1);
      else if (it.kind === 'roof' || it.kind === 'special') flushObjects(Infinity);
      if (!isVisible(it, visibility)) continue;
      if (popsInside && (it.kind === 'wall' || it.kind === 'roof' || it.kind === 'lowerWall') && popsInside.has(`${it.layer}:${it.cellX}:${it.cellY}`)) continue;
      const flags = it.kind === 'shadow' ? InstanceFlag.Shadow : it.kind === 'floor' ? InstanceFlag.Floor : 0;
      const animated = !!it.frames && visibility.animate;
      if (animated) for (const f of it.frames!) a.get(f);
      const tile = animated ? it.frames![floorFrameNow % it.frames!.length] : it.tile;
      const before = instances.length;
      push(tile, it.x, it.y, flags | emphasisOf(it));
      if (instances.length > before) {
        if (animated) animFloors.push({ index: before, it, slot: slotIdx.length });
        slotIdx.push(before);
        slotItems.push(it);
        slotBase.push(flags);
      }
    }
    flushObjects(Infinity);
    built.current = { instances, slotIdx, slotItems, slotBase, animObjs, animFloors };
    uploadWithGhosts();
  }, [scene, visibility, tool, sprites, animations, selectedObject, props.selectedObjects, popsInside, !!props.walkBrush, props.objectsRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new animation frame: only the animated objects' and floors' instances change.
  useEffect(() => {
    const b = built.current;
    if (!b || !renderer.current || (!b.animObjs.length && !b.animFloors.length)) return;
    const a = atlas.current;
    const updates: { index: number; inst: Instance }[] = [];
    for (const slot of b.animObjs) {
      const insts = objectFrame(slot, frame);
      insts.forEach((inst, k) => {
        const index = slot.start + k;
        const cur = b.instances[index];
        if (cur.u === inst.u && cur.v === inst.v && cur.layer === inst.layer && cur.x === inst.x && cur.w === inst.w) return;
        b.instances[index] = inst;
        updates.push({ index, inst });
      });
    }
    const ff = Math.floor(frame / 2.5);
    for (const f of b.animFloors) {
      const tile = f.it.frames![ff % f.it.frames!.length];
      const e = a.get(tile);
      if (!e) continue;
      const cur = b.instances[f.index];
      if (cur.u === e.u && cur.v === e.v && cur.layer === e.layer) continue;
      const inst = { ...cur, x: f.it.x + e.image.offsetX, y: f.it.y + e.image.offsetY, w: e.image.width, h: e.image.height, u: e.u, v: e.v, layer: e.layer };
      b.instances[f.index] = inst;
      updates.push({ index: f.index, inst });
    }
    if (!updates.length) return;
    // With a preview spliced in, the indices are shifted: upload the lot.
    if (ghost.length) uploadWithGhosts();
    else renderer.current.patchInstances(updates);
    dirty.current = true;
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps

  // The brush / paste preview moved: splice it in (no rebuild).
  const hadGhost = useRef(false);
  useEffect(() => {
    if (!ghost.length && !hadGhost.current) return; // still no preview: nothing to do
    // Emphasis is off while a preview shows; put it back (or take it away) in the flags first.
    if (hadGhost.current !== ghost.length > 0) {
      hadGhost.current = ghost.length > 0;
      const b = built.current;
      if (b) for (let k = 0; k < b.slotIdx.length; k++) b.instances[b.slotIdx[k]].flags = b.slotBase[k] | emphasisOf(b.slotItems[k]);
    }
    uploadWithGhosts();
  }, [ghost]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hover and selection: only the tiles whose emphasis changed get new flags.
  useEffect(() => {
    const b = built.current;
    if (!b || !renderer.current) return;
    const changes = new Map<number, number>();
    for (let k = 0; k < b.slotIdx.length; k++) {
      const inst = b.instances[b.slotIdx[k]];
      const f = b.slotBase[k] | emphasisOf(b.slotItems[k]);
      if (inst.flags !== f) {
        inst.flags = f;
        changes.set(b.slotIdx[k], f);
      }
    }
    if (!changes.size) return;
    // With a preview spliced in, the indices are shifted: upload the lot.
    if (ghost.length) uploadWithGhosts();
    else renderer.current.setFlags(changes);
    dirty.current = true;
  }, [previewCell, selection, focus, props.areaLayer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    dirty.current = true;
  }, [selection, pasteRect, selectedObject, props.selectedObjects, objectLabel, walk, overviewPaths, props.resizeMode, props.marks, focus, automapImage, props.sprites, props.animations, hover, props.specialLabel, props.pops, props.walkMarks, props.walkBrush, props.light, props.playerLight, props.objectLights, props.objectLightsLit, props.lightRings, props.objectGhost, props.doomed, props.input?.objectLabels, props.objectsRevision]);

  // Input.
  useEffect(() => {
    const el = overlay.current!;
    const modalBlocked = () => {
      const dialogs = document.querySelectorAll('.modal-backdrop');
      return dialogs.length > 0 && !dialogs[dialogs.length - 1].contains(el);
    };
    let pan: { x: number; y: number } | null = null;
    /** Where a right/middle button went down, to tell a click from a pan. */
    let panStart: { x: number; y: number } | null = null;
    let stroke: [number, number] | null = null;
    /** The sub-tile under the cursor at the last object-drag move. */
    let strokeSub: [number, number] | null = null;
    let pointer: number | null = null;
    let space = false;
    let shiftHeld = false;
    const wheelSteps = new WheelSteps();
    const dpr = () => window.devicePixelRatio || 1;
    const toWorld = (ev: MouseEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      const cam = camera.current;
      return canvasToWorld(ev.clientX, ev.clientY, r, el, cam);
    };
    const toCell = (ev: MouseEvent): [number, number] => {
      const [fx, fy] = worldToCell(...toWorld(ev));
      return [Math.floor(fx), Math.floor(fy)];
    };
    const setCursor = () => {
      const t = latest.current.tool;
      el.style.cursor = pan ? 'grabbing' : space ? 'grab' : t === 'pick' ? 'copy' : t === 'select' ? 'default' : 'crosshair';
    };
    const down = (ev: PointerEvent) => {
      if (pointer !== null || modalBlocked()) return;
      pointer = ev.pointerId;
      el.setPointerCapture(ev.pointerId);
      // Resize handles take precedence over tools.
      if (ev.button === 0 && latest.current.resizeMode) {
        const { width: w, height: h } = latest.current.map.ds1;
        const [wx, wy] = toWorld(ev);
        const reach = 14 / camera.current.zoom * dpr();
        const side = SIDES.find((sd) => {
          const [ax, ay] = cellToWorld(...sideAnchor(sd, w, h));
          return Math.hypot(ax - wx, ay - wy) < reach;
        });
        if (side) {
          resizeDrag.current = { side, delta: { left: 0, top: 0, right: 0, bottom: 0 } };
          dirty.current = true;
          return;
        }
      }
      const toolDrag = ev.button === 0 && !space;
      if (toolDrag) {
        stroke = toCell(ev);
        strokeSub = null;
        latest.current.onStroke('start', [stroke], toWorld(ev), { alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey });
      } else if (ev.button <= 2) {
        pan = { x: ev.clientX, y: ev.clientY };
        panStart = { x: ev.clientX, y: ev.clientY };
      }
      setCursor();
    };
    const move = (ev: PointerEvent) => {
      if (pointer !== null && pointer !== ev.pointerId) return;
      if (resizeDrag.current) {
        const { width: w, height: h } = latest.current.map.ds1;
        const [fx, fy] = worldToCell(...toWorld(ev));
        resizeDrag.current = { side: resizeDrag.current.side, delta: dragDelta(resizeDrag.current.side, fx, fy, w, h) };
        dirty.current = true;
        return;
      }
      if (pan) {
        const cam = camera.current;
        cam.x -= ((ev.clientX - pan.x) * dpr()) / cam.zoom;
        cam.y -= ((ev.clientY - pan.y) * dpr()) / cam.zoom;
        pan = { x: ev.clientX, y: ev.clientY };
        dirty.current = true;
      }
      const [cx, cy] = toCell(ev);
      cursorWorld.current = toWorld(ev);
      if ((latest.current.light && latest.current.playerLight) || latest.current.objectGhost) dirty.current = true;
      if (latest.current.walkBrush) {
        // Walkability: follow the cursor sub-tile by sub-tile (the brush footprint, and strokes within a cell).
        const [fx, fy] = worldToSubTile(...toWorld(ev));
        const sub: [number, number] = [Math.round(fx), Math.round(fy)];
        const was = walkCursor.current;
        if (!was || was[0] !== sub[0] || was[1] !== sub[1]) {
          walkCursor.current = sub;
          dirty.current = true;
          if (stroke) latest.current.onStroke('move', [[cx, cy]], toWorld(ev));
        }
        if (stroke) stroke = [cx, cy];
      } else if (stroke && latest.current.tool === 'object') {
        // Objects stand on sub-tiles (5 per tile side): a drag follows the cursor sub-tile by sub-tile.
        const [fx, fy] = worldToSubTile(...toWorld(ev));
        const sub: [number, number] = [Math.round(fx), Math.round(fy)];
        if (!strokeSub || strokeSub[0] !== sub[0] || strokeSub[1] !== sub[1]) {
          strokeSub = sub;
          latest.current.onStroke('move', [[cx, cy]], toWorld(ev));
        }
        stroke = [cx, cy];
      } else if (stroke && (cx !== stroke[0] || cy !== stroke[1])) {
        latest.current.onStroke('move', cellLine(stroke, [cx, cy]).slice(1), toWorld(ev));
        stroke = [cx, cy];
      }
      const { map: m, hover: h, onHover: hov } = latest.current;
      const hoverCell = latest.current.tool === 'select' ? combinedCellAt(latest.current.scene, cursorWorld.current, [cx, cy], latest.current.hittable) : [cx, cy];
      const oldCell = h?.world && latest.current.tool === 'select' ? combinedCellAt(latest.current.scene, h.world, [h.cellX, h.cellY], latest.current.hittable) : h ? [h.cellX, h.cellY] : null;
      const inside = cx >= 0 && cy >= 0 && cx < m.ds1.width && cy < m.ds1.height;
      if (!inside) {
        if (h) hov(null);
      } else if (latest.current.walkBrush || !h || h.cellX !== cx || h.cellY !== cy || !oldCell || oldCell[0] !== hoverCell[0] || oldCell[1] !== hoverCell[1]) {
        hov({ cellX: cx, cellY: cy, world: cursorWorld.current });
      }
    };
    const up = (ev: PointerEvent) => {
      if (pointer !== ev.pointerId) return;
      pointer = null;
      if (resizeDrag.current) {
        const { delta } = resizeDrag.current;
        resizeDrag.current = null;
        dirty.current = true;
        if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
        if (delta.left || delta.top || delta.right || delta.bottom) latest.current.onResize(delta);
        return;
      }
      if (stroke) latest.current.onStroke('end', [], toWorld(ev));
      stroke = null;
      if (pan && ev.button === 2) {
        // The context menu for this right-click fires after pointerup, wherever the cursor ended up: swallow it.
        const swallow = (e: Event) => e.preventDefault();
        window.addEventListener('contextmenu', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('contextmenu', swallow, { capture: true }), 400);
        // Barely moved: a click, which opens the map's menu instead of panning.
        if (panStart && Math.hypot(ev.clientX - panStart.x, ev.clientY - panStart.y) < 5) latest.current.onContextMenu?.([ev.clientX, ev.clientY], toCell(ev), toWorld(ev), { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey });
      }
      panStart = null;
      pan = null;
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      setCursor();
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      if (pointer !== null || modalBlocked()) return;
      const cam = camera.current;
      const [wx, wy] = toWorld(ev);
      const s = latest.current;
      const shiftZooms = s.input?.shiftWheel === 'zoom';
      // Preferences can swap it: Shift+wheel zooms and Alt+wheel steps through the stack.
      if (shiftZooms ? ev.altKey && !(ev.ctrlKey || ev.metaKey) : cycleWithWheel(ev.shiftKey, shiftHeld, ev.ctrlKey || ev.metaKey, ev.deltaX, ev.deltaY)) {
        // Shift+wheel picks one tile out of a stack instead of zooming (Windows turns it into a horizontal scroll).
        const d = ev.deltaY || ev.deltaX;
        if (d) s.onCycle(d > 0 ? 1 : -1, [wx, wy]);
        return;
      }
      // Windows turns Shift+wheel into a horizontal scroll.
      const dy = ev.deltaY || (ev.shiftKey ? ev.deltaX : 0);
      let zoom: number;
      if (s.input?.smoothZoom) {
        const factor = Math.exp(-dy * (ev.ctrlKey ? 0.01 : 0.0015) * (s.input?.zoomSpeed ?? 1));
        zoom = Math.min(Math.max(cam.zoom * factor, 0.05), 8 * dpr());
      } else {
        // In steps that keep pixels sharp (a touchpad pinch, Ctrl+wheel, adds up faster).
        const n = wheelSteps.take(ev.deltaMode === 1 ? dy * 33 : dy, (s.input?.zoomSpeed ?? 1) * (ev.ctrlKey ? 4 : 1), ev.timeStamp);
        if (!n) return;
        zoom = stepZoom(cam.zoom, n);
      }
      // Keep the world point under the cursor fixed.
      cam.x = wx - (wx - cam.x) * (cam.zoom / zoom);
      cam.y = wy - (wy - cam.y) * (cam.zoom / zoom);
      cam.zoom = zoom;
      latest.current.onZoom(zoom / dpr());
      dirty.current = true;
    };
    const leave = () => {
      if (walkCursor.current) {
        walkCursor.current = null;
        dirty.current = true;
      }
      if (latest.current.hover) latest.current.onHover(null);
    };
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
    const keydown = (ev: KeyboardEvent) => {
      if (ev.key === 'Shift') shiftHeld = true;
      if (ev.key.startsWith('Arrow') && !typing(ev.target) && !document.querySelector('.modal-backdrop') && !ev.ctrlKey && !ev.altKey) {
        arrows.current.add(ev.key);
        if (ev.shiftKey) arrows.current.add('Shift');
        ev.preventDefault();
      }
      if (ev.key === 'Shift' && arrows.current.size) arrows.current.add('Shift');
      if (ev.code === 'Space' && !typing(ev.target) && !(ev.target instanceof HTMLElement && ev.target.closest('button,[role="dialog"]')) && !document.querySelector('.modal-backdrop')) {
        space = true;
        setCursor();
        ev.preventDefault();
      }
    };
    const keyup = (ev: KeyboardEvent) => {
      if (ev.key === 'Shift') shiftHeld = false;
      arrows.current.delete(ev.key);
      if (ev.key === 'Shift') arrows.current.delete('Shift');
      if (![...arrows.current].some((a) => a.startsWith('Arrow'))) arrows.current.clear();
      if (ev.code === 'Space') {
        space = false;
        setCursor();
      }
    };
    setCursor();
    const dbl = (ev: MouseEvent) => {
      if (ev.button === 0) latest.current.onDoubleClick?.(toWorld(ev));
    };
    el.addEventListener('dblclick', dbl);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    const cancel = () => {
      if (stroke) latest.current.onStroke('end', [], cursorWorld.current ?? [0, 0]);
      stroke = null; pan = null; panStart = null; resizeDrag.current = null; space = false;
      const id = pointer; pointer = null;
      if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id);
      arrows.current.clear(); setCursor(); dirty.current = true;
    };
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    const blur = () => { shiftHeld = false; cancel(); };
    window.addEventListener('blur', blur);
    return () => {
      el.removeEventListener('dblclick', dbl);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Keep the cursor in sync with the tool.
  useEffect(() => {
    const el = overlay.current!;
    el.style.cursor = tool === 'pick' ? 'copy' : tool === 'select' ? 'default' : 'crosshair';
  }, [tool]);

  return (
    <div className="viewport">
      <canvas ref={glCanvas} className="viewport-canvas" />
      <canvas ref={overlay} className="viewport-canvas viewport-overlay" onContextMenu={(e) => e.preventDefault()} />
      {visibility.minimap && (
        <Minimap
          scene={scene}
          palette={map.palette}
          width={map.ds1.width}
          height={map.ds1.height}
          drawRef={minimapDraw}
          view={{
            camera: () => camera.current,
            viewport: () => [glCanvas.current?.width ?? 0, glCanvas.current?.height ?? 0],
            moveTo: (x, y) => {
              camera.current = { ...camera.current, x, y };
              dirty.current = true;
            },
          }}
        />
      )}
    </div>
  );
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, w = 1, h = 1) {
  const [x0, y0] = cellToWorld(cx, cy);
  const [x1, y1] = cellToWorld(cx + w, cy);
  const [x2, y2] = cellToWorld(cx + w, cy + h);
  const [x3, y3] = cellToWorld(cx, cy + h);
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.closePath();
}

/** Colours for hide areas, one per group (areas of a group hide together). */
const POP_COLORS = ['110, 220, 255', '255, 170, 90', '150, 255, 140', '255, 120, 200', '200, 170, 255', '255, 230, 110'];

/**
 * Roof/wall hide areas: the trigger area (where the player must stand, PopPad included) filled, the area whose tiles
 * can hide outlined, the tiles that hide marked, and a label.
 */
function drawPops(ctx: CanvasRenderingContext2D, pops: NonNullable<Props['pops']>, ds1: Ds1, px: number) {
  for (const a of pops.areas) {
    const c = POP_COLORS[(a.group - 1 + POP_COLORS.length) % POP_COLORS.length];
    const t = triggerRect(a, pops.popPad);
    ctx.fillStyle = `rgba(${c}, 0.14)`;
    ctx.strokeStyle = `rgba(${c}, 0.95)`;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    diamond(ctx, t.x, t.y, t.w, t.h);
    ctx.fill();
    ctx.stroke();
    const h = hideRect(a);
    ctx.setLineDash([6 * px, 5 * px]);
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    diamond(ctx, h.x0, h.y0, h.x1 - h.x0 + 1, h.y1 - h.y0 + 1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(${c}, 0.8)`;
    ctx.beginPath();
    for (const tile of popTargets(ds1, a)) diamond(ctx, tile.x + 0.3, tile.y + 0.3, 0.4, 0.4);
    ctx.stroke();
    const [x, y] = cellToWorld(a.x0 + t.w / 2, a.y0 + t.h / 2);
    const size = Math.max(12 * px, 15);
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const text = `Hide area ${a.main}: tiles #${a.target} fade${a.markers.length !== 2 ? ` (${a.markers.length} markers!)` : ''}`;
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(0, 10, 20, 0.85)';
    ctx.strokeText(text, x, y - size);
    ctx.fillStyle = `rgba(${c}, 1)`;
    ctx.fillText(text, x, y - size);
    ctx.textAlign = 'start';
  }
}

/** The walkability overlay: red = blocks jumping/teleport too (may block walking); amber = blocks walking. */
function walkPaths(walk: Uint8Array, width: number, height: number): SubTilePaths {
  const classOf = (sx: number, sy: number) => {
    const f = walk[(Math.floor(sy / 5) * width + Math.floor(sx / 5)) * 25 + (sy % 5) * 5 + (sx % 5)];
    return f & SubTileFlag.BlockJump ? 1 : f & (SubTileFlag.BlockWalk | SubTileFlag.BlockPlayerWalk) ? 2 : 0;
  };
  return subTilePaths(classOf, ['rgba(255, 60, 70, 0.38)', 'rgba(255, 176, 40, 0.34)'], width, height);
}

/** Draws sub-tile paths over the part of the map in view. */
function drawPaths(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, cam: Camera, p: SubTilePaths) {
  const view = {
    x0: cam.x - canvas.width / 2 / cam.zoom,
    y0: cam.y - canvas.height / 2 / cam.zoom,
    x1: cam.x + canvas.width / 2 / cam.zoom,
    y1: cam.y + canvas.height / 2 / cam.zoom,
  };
  drawSubTilePaths(ctx, p, view, cam.zoom);
}

interface AutomapImage {
  canvas: HTMLCanvasElement;
  /** World position of the canvas's top-left corner. */
  x: number;
  y: number;
  /** Cells whose wall has no automap entry. */
  missing: [number, number][];
  /** Cells showing a suggested (unsaved) piece. */
  suggested: [number, number][];
  style: AutomapStyle;
}

/** The automap at its own resolution (one cel pixel = 10 world pixels), drawn scaled up by the overlay. */
function renderAutomap(width: number, height: number, a: NonNullable<Props['automap']>): AutomapImage {
  const missing: [number, number][] = [];
  const suggested: [number, number][] = [];
  const draw: DrawPiece[] = [];
  for (const p of a.pieces) {
    if (p.suggested) suggested.push([p.cellX, p.cellY]);
    if (p.cel === null) {
      // Only walls leave a hole: trees and props (also on wall layers) are often left off on purpose.
      if (!p.rule && a.kindOf(p.orientation, p.main, p.sub) === 'walls') missing.push([p.cellX, p.cellY]);
      continue;
    }
    draw.push({ cellX: p.cellX, cellY: p.cellY, kind: a.kindOf(p.orientation, p.main, p.sub), code: AUTOMAP_CODES[p.orientation], cel: p.cel });
  }
  const { canvas, ox, oy } = automapCanvas(width, height, draw, a.cels, a.palette, a.style);
  return { canvas, x: -ox * AUTOMAP_SCALE, y: -oy * AUTOMAP_SCALE, missing, suggested, style: a.style };
}

type OverlayState = Props & {
  automapImage: AutomapImage | null;
  walk: SubTilePaths | null;
  overviewPaths: SubTilePaths | null;
  resizeDrag: { current: { side: Side; delta: ResizeDelta } | null };
  walkCursor: { current: [number, number] | null };
  cursorWorld: { current: [number, number] | null };
};

/** A sprite in one colour (its shading kept), for objects on the cursor: green for a copy, red for a cut. */
const tintCache = new WeakMap<SpriteFrame, Map<string, HTMLCanvasElement>>();
function tintedSprite(f: SpriteFrame, palette: Uint8Array, cut: boolean): HTMLCanvasElement {
  const key = `${cut ? 'cut' : 'copy'}:${palette.length}`;
  const cached = tintCache.get(f)?.get(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = Math.max(1, f.width);
  c.height = Math.max(1, f.height);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  const [tr, tg, tb] = cut ? [255, 70, 70] : [80, 255, 120];
  const stride = palette.length >= 1024 ? 4 : 3;
  for (let i = 0; i < f.width * f.height; i++) {
    const p = f.pixels[i];
    if (!p) continue;
    const lum = (0.3 * palette[p * stride] + 0.59 * palette[p * stride + 1] + 0.11 * palette[p * stride + 2]) / 255;
    const k = 0.35 + 0.65 * lum;
    img.data[i * 4] = tr * k;
    img.data[i * 4 + 1] = tg * k;
    img.data[i * 4 + 2] = tb * k;
    img.data[i * 4 + 3] = 210;
  }
  ctx.putImageData(img, 0, 0);
  (tintCache.get(f) ?? tintCache.set(f, new Map()).get(f)!).set(key, c);
  return c;
}

function drawOverlay(canvas: HTMLCanvasElement, cam: Camera, s: OverlayState) {
  const ctx = canvas.getContext('2d')!;
  const { map, scene, visibility: v, hover, tool, selection, pasteRect, walk, objectLabel, selectedObject } = s;
  const { ds1 } = map;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.zoom, 0, 0, cam.zoom, Math.floor(canvas.width / 2) - Math.round(cam.x * cam.zoom), Math.floor(canvas.height / 2) - Math.round(cam.y * cam.zoom));
  const px = 1 / cam.zoom; // one device pixel in world units

  if (s.automapImage) {
    // The automap as the game draws it, over a dimmed map; walls without an automap entry outlined.
    const am = s.automapImage;
    ctx.fillStyle = `rgba(0, 0, 0, ${am.style.dim})`;
    ctx.beginPath();
    diamond(ctx, 0, 0, ds1.width, ds1.height);
    ctx.fill();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(am.canvas, am.x, am.y, am.canvas.width * AUTOMAP_SCALE, am.canvas.height * AUTOMAP_SCALE);
    if (am.missing.length && am.style.missing) {
      ctx.strokeStyle = am.style.missingColour;
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      for (const [cx, cy] of am.missing) diamond(ctx, cx, cy);
      ctx.stroke();
    }
    if (am.suggested.length) {
      ctx.strokeStyle = 'rgba(110, 230, 255, 0.85)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      for (const [cx, cy] of am.suggested) diamond(ctx, cx, cy);
      ctx.stroke();
    }
  }

  // Red = blocks jumping/teleport too; amber = blocks walking.
  if (walk) drawPaths(ctx, canvas, cam, walk);
  if (s.overviewPaths) drawPaths(ctx, canvas, cam, s.overviewPaths);
  // Sub-tiles a walkability stroke is painting: filled in the colour they are getting.
  if (s.walkMarks?.keys.size) {
    ctx.beginPath();
    for (const k of s.walkMarks.keys) {
      const [x, y] = subTileToWorld(k % 65536, Math.floor(k / 65536));
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x + 16, y);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 16, y);
      ctx.closePath();
    }
    ctx.fillStyle = s.walkMarks.mode === 'block' ? 'rgba(255, 150, 30, 0.55)' : 'rgba(90, 220, 120, 0.5)';
    ctx.fill();
    ctx.lineWidth = 1 * px;
    ctx.strokeStyle = s.walkMarks.mode === 'block' ? 'rgba(255, 190, 90, 0.9)' : 'rgba(150, 255, 170, 0.9)';
    ctx.stroke();
  }

  if (v.grid) {
    ctx.beginPath();
    for (let y = 0; y <= ds1.height; y++) {
      const [ax, ay] = cellToWorld(0, y);
      const [bx, by] = cellToWorld(ds1.width, y);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    for (let x = 0; x <= ds1.width; x++) {
      const [ax, ay] = cellToWorld(x, 0);
      const [bx, by] = cellToWorld(x, ds1.height);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = px;
    ctx.stroke();
  }

  // The game builds the level out of 8x8-tile rooms (streamed in and out as players move), cut from the map's origin.
  if (v.rooms) {
    const R = 8;
    const cols = Math.ceil(ds1.width / R);
    const rows = Math.ceil(ds1.height / R);
    for (let ry = 0; ry < rows; ry++)
      for (let rx = 0; rx < cols; rx++) {
        const x0 = rx * R;
        const y0 = ry * R;
        const w = Math.min(R, ds1.width - x0);
        const h = Math.min(R, ds1.height - y0);
        const partial = w < R || h < R;
        ctx.beginPath();
        diamond(ctx, x0, y0, w, h);
        ctx.fillStyle = (rx + ry) % 2 ? 'rgba(90, 200, 255, 0.07)' : 'rgba(90, 200, 255, 0.02)';
        ctx.fill();
        ctx.setLineDash(partial ? [8 * px, 5 * px] : []);
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = partial ? 'rgba(255, 190, 90, 0.85)' : 'rgba(90, 200, 255, 0.85)';
        ctx.stroke();
        ctx.setLineDash([]);
        if (cam.zoom > 0.12) {
          const [cx, cy] = cellToWorld(x0 + w / 2, y0 + h / 2);
          ctx.font = `600 ${12 * px}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          const label = `Room ${ry * cols + rx}  (${rx},${ry})${partial ? ` · ${w}×${h}` : ''}`;
          ctx.lineWidth = 3 * px;
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.strokeText(label, cx, cy);
          ctx.fillStyle = partial ? 'rgba(255, 215, 150, 1)' : 'rgba(190, 235, 255, 1)';
          ctx.fillText(label, cx, cy);
          ctx.textAlign = 'start';
        }
      }
  }

  if (v.groups && ds1.groups.length) {
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.8)';
    for (const g of ds1.groups) {
      ctx.beginPath();
      diamond(ctx, g.x, g.y, g.width, g.height);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (s.pops?.show) drawPops(ctx, s.pops, ds1, px);

  // Special tiles (warps, entry points…): invisible in game, so marked and labelled here (at any zoom).
  if (v.specials && scene.specials.length) {
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = 'rgba(200, 140, 255, 0.9)';
    for (const sp of scene.specials) {
      ctx.fillStyle = sp.drawn ? 'rgba(180, 110, 255, 0.1)' : 'rgba(180, 110, 255, 0.25)';
      ctx.beginPath();
      diamond(ctx, sp.cellX + 0.1, sp.cellY + 0.1, 0.8, 0.8);
      ctx.fill();
      ctx.stroke();
      const [x, y] = cellToWorld(sp.cellX + 0.5, sp.cellY + 0.5);
      const text = s.specialLabel?.(sp.main, sp.sub) ?? specialTileInfo(sp.main, sp.sub).label;
      const size = Math.max(11 * px, 14);
      ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = 'rgba(20, 0, 40, 0.85)';
      ctx.strokeText(text, x, y + size * 0.35);
      ctx.fillStyle = 'rgba(235, 215, 255, 1)';
      ctx.fillText(text, x, y + size * 0.35);
      ctx.textAlign = 'start';
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = 'rgba(200, 140, 255, 0.9)';
    }
  }

  if (v.missing && scene.missing.length) {
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = 'rgba(255, 70, 90, 0.85)';
    ctx.fillStyle = 'rgba(255, 70, 90, 0.12)';
    for (const m of scene.missing) {
      ctx.beginPath();
      diamond(ctx, m.cellX + 0.08, m.cellY + 0.08, 0.84, 0.84);
      ctx.fill();
      ctx.stroke();
    }
  }

  for (const [rect, fill, stroke] of [
    [selection, 'rgba(212, 168, 79, 0.10)', 'rgba(255, 205, 110, 0.95)'],
    [pasteRect, 'rgba(110, 190, 255, 0.08)', 'rgba(130, 200, 255, 0.95)'],
  ] as const) {
    if (!rect) continue;
    const cells = 'cells' in rect ? rect.cells : undefined;
    ctx.beginPath();
    if (cells) for (const k of cells) diamond(ctx, k % 65536, Math.floor(k / 65536));
    else diamond(ctx, rect.x0, rect.y0, rect.x1 - rect.x0 + 1, rect.y1 - rect.y0 + 1);
    ctx.fillStyle = fill;
    ctx.fill();
    // An irregular selection is outlined along its outer edges only.
    if (cells) {
      ctx.beginPath();
      const edge = (a: [number, number], b: [number, number]) => {
        const [ax, ay] = cellToWorld(...a);
        const [bx, by] = cellToWorld(...b);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      };
      for (const k of cells) {
        const x = k % 65536;
        const y = Math.floor(k / 65536);
        if (!cells.has(cellKey(x, y - 1))) edge([x, y], [x + 1, y]);
        if (!cells.has(cellKey(x + 1, y))) edge([x + 1, y], [x + 1, y + 1]);
        if (!cells.has(cellKey(x, y + 1))) edge([x, y + 1], [x + 1, y + 1]);
        if (!cells.has(cellKey(x - 1, y))) edge([x, y], [x, y + 1]);
      }
    }
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (s.focus) {
    // Outline the chosen tile and say which of the stack it is.
    const { item, index, count, label } = s.focus;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of item.tile.blocks) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + 32);
      maxY = Math.max(maxY, b.y + (b.format === 1 ? 15 : 32));
    }
    if (minX < maxX) {
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = 'rgba(120, 230, 255, 0.95)';
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.strokeRect(item.x + minX, item.y + minY, maxX - minX, maxY - minY);
      ctx.setLineDash([]);
      const text = `${label} · ${index + 1} of ${count}`;
      ctx.font = `${12 * px}px system-ui, sans-serif`;
      const w = ctx.measureText(text).width + 8 * px;
      ctx.fillStyle = 'rgba(10, 20, 30, 0.85)';
      ctx.fillRect(item.x + minX, item.y + minY - 18 * px, w, 16 * px);
      ctx.fillStyle = 'rgb(160, 235, 255)';
      ctx.fillText(text, item.x + minX + 4 * px, item.y + minY - 6 * px);
    }
  }

  if (s.gameView?.on) {
    // What the character sees: the game's screen centred on the view; shade the rest.
    const { width: GAME_W, height: GAME_H } = s.gameView;
    const x0 = cam.x - GAME_W / 2;
    const y0 = cam.y - GAME_H / 2;
    const big = 1e6;
    ctx.fillStyle = 'rgba(5, 6, 9, 0.62)';
    ctx.beginPath();
    ctx.rect(-big, -big, 2 * big, 2 * big);
    ctx.rect(x0 + GAME_W, y0, -GAME_W, GAME_H); // counter-clockwise hole
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255, 215, 130, 0.9)';
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(x0, y0, GAME_W, GAME_H);
    ctx.font = `${12 * px}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255, 215, 130, 0.95)';
    ctx.fillText(`In-game screen (${GAME_W}×${GAME_H}) · the character stands at the centre`, x0 + 6 * px, y0 - 6 * px);
    ctx.beginPath();
    ctx.moveTo(cam.x - 8 * px, cam.y);
    ctx.lineTo(cam.x + 8 * px, cam.y);
    ctx.moveTo(cam.x, cam.y - 8 * px);
    ctx.lineTo(cam.x, cam.y + 8 * px);
    ctx.stroke();
  }

  if (s.doomed?.length) {
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = 'rgba(255, 70, 90, 0.95)';
    ctx.fillStyle = 'rgba(255, 70, 90, 0.28)';
    ctx.beginPath();
    for (const m of s.doomed) diamond(ctx, m.x + 0.06, m.y + 0.06, 0.88, 0.88);
    ctx.fill();
    ctx.stroke();
  }

  if (s.marks?.length) {
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(255, 120, 60, 0.95)';
    ctx.fillStyle = 'rgba(255, 120, 60, 0.18)';
    for (const m of s.marks) {
      ctx.beginPath();
      diamond(ctx, m.x, m.y);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (s.resizeMode) {
    const { width: w, height: h } = ds1;
    const drag = s.resizeDrag.current;
    if (drag) {
      const d = drag.delta;
      ctx.beginPath();
      diamond(ctx, -d.left, -d.top, w + d.left + d.right, h + d.top + d.bottom);
      ctx.setLineDash([8 * px, 5 * px]);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = 'rgba(130, 200, 255, 0.95)';
      ctx.stroke();
      ctx.setLineDash([]);
      const [lx, ly] = cellToWorld(...sideAnchor(drag.side, w, h));
      ctx.font = `600 ${13 * px}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(200, 230, 255, 1)';
      ctx.fillText(`${w + d.left + d.right} × ${h + d.top + d.bottom}`, lx + 14 * px, ly - 10 * px);
    }
    for (const side of SIDES) {
      const [ax, ay] = cellToWorld(...sideAnchor(side, w, h));
      const r = 7 * px;
      ctx.fillStyle = drag?.side === side ? 'rgba(130, 200, 255, 1)' : 'rgba(212, 168, 79, 1)';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.rect(ax - r, ay - r, 2 * r, 2 * r);
      ctx.fill();
      ctx.stroke();
    }
  }

  const wc = s.walkCursor.current;
  if (s.walkBrush && wc) {
    // The brush's footprint on the sub-tile grid: one diamond per sub-tile it paints, outlined as one shape.
    const { width: W, height: Hh } = ds1;
    const cells: [number, number][] = [];
    if (s.walkBrush.size === 'cell') {
      const [bx, by] = [Math.floor(wc[0] / 5) * 5, Math.floor(wc[1] / 5) * 5];
      for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) cells.push([bx + dx, by + dy]);
    } else {
      const r = (s.walkBrush.size - 1) / 2;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) cells.push([wc[0] + dx, wc[1] + dy]);
    }
    const inMap = cells.filter(([x, y]) => x >= 0 && y >= 0 && x < W * 5 && y < Hh * 5);
    if (inMap.length) {
      const set = new Set(inMap.map(([x, y]) => y * 65536 + x));
      const color = s.walkBrush.mode === 'block' ? [255, 176, 40] : [110, 230, 140];
      ctx.beginPath();
      for (const [x, y] of inMap) {
        const [cx, cy] = subTileToWorld(x, y);
        ctx.moveTo(cx, cy - 8);
        ctx.lineTo(cx + 16, cy);
        ctx.lineTo(cx, cy + 8);
        ctx.lineTo(cx - 16, cy);
        ctx.closePath();
      }
      ctx.fillStyle = `rgba(${color.join(',')}, 0.28)`;
      ctx.fill();
      // Outline: the edges of the footprint only (a sub-tile's corners are at ±16/±8 from its centre).
      ctx.beginPath();
      for (const [x, y] of inMap) {
        const [cx, cy] = subTileToWorld(x, y);
        const [n, e, so, w] = [[cx, cy - 8], [cx + 16, cy], [cx, cy + 8], [cx - 16, cy]] as const;
        const edge = (a: readonly number[], b: readonly number[]) => {
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
        };
        if (!set.has((y - 1) * 65536 + x)) edge(n, e);
        if (!set.has(y * 65536 + x + 1)) edge(e, so);
        if (!set.has((y + 1) * 65536 + x)) edge(so, w);
        if (!set.has(y * 65536 + x - 1)) edge(w, n);
      }
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = `rgba(${color.join(',')}, 0.95)`;
      ctx.stroke();
    }
  } else if (hover && tool !== 'object') {
    ctx.beginPath();
    const cell = tool === 'select' && hover.world ? combinedCellAt(scene, hover.world, [hover.cellX, hover.cellY], s.hittable) : [hover.cellX, hover.cellY];
    diamond(ctx, cell[0], cell[1]);
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = tool === 'erase' ? 'rgba(255, 90, 110, 0.95)' : 'rgba(100, 210, 255, 0.95)';
    ctx.stroke();
  }

  const showObjects = v.objects || tool === 'object';
  if (v.paths || tool === 'object') {
    ds1.objects.forEach((o, i) => {
      if (!o.path.length) return;
      const selected = i === selectedObject || !!s.selectedObjects?.has(i);
      if (!v.paths && !selected) return;
      // The NPC walks to point 0, then along the points, looping back to point 0.
      ctx.beginPath();
      ctx.moveTo(...subTileToWorld(o.x, o.y));
      for (const p of o.path) ctx.lineTo(...subTileToWorld(p.x, p.y));
      ctx.lineTo(...subTileToWorld(o.path[0].x, o.path[0].y));
      ctx.lineWidth = (selected ? 2 : 1.5) * px;
      ctx.strokeStyle = selected ? 'rgba(255, 190, 90, 1)' : 'rgba(255, 150, 60, 0.85)';
      ctx.stroke();
      o.path.forEach((p, n) => {
        const [x, y] = subTileToWorld(p.x, p.y);
        const r = (selected ? 4 : 2) * px;
        ctx.fillStyle = selected ? 'rgba(255, 205, 110, 1)' : 'rgba(255, 150, 60, 0.9)';
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
        if (selected && cam.zoom > 0.4) {
          ctx.font = `${10 * px}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.fillText(`${n}${p.action !== 1 ? ` a${p.action}` : ''}`, x + 6 * px, y - 4 * px);
        }
      });
    });
  }

  // Each object light's reach (where its light fades out), in its colour: for placing light sources in any mode.
  if (s.lightRings && s.objectLights?.length) {
    ctx.save();
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.lineWidth = 1.5 * px;
    for (const l of s.objectLights) {
      const [r, g, b] = l.rgb;
      // The falloff is round in sub-tiles, so an ellipse twice as wide as high on screen.
      const reach = l.radius * 16 * Math.SQRT2;
      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.scale(1, 0.5);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.28)`);
      glow.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, 0.16)`);
      glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.beginPath();
      ctx.arc(0, 0, reach, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.ellipse(l.x, l.y, reach, reach / 2, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
      ctx.stroke();
    }
    ctx.restore();
  }

  if (showObjects) {
    const full = Math.max(4 * px, 5);
    ds1.objects.forEach((o, i) => {
      const [x, y] = subTileToWorld(o.x, o.y);
      const selected = i === selectedObject || !!s.selectedObjects?.has(i);
      // Objects drawn with their real sprite don't need a marker on top (the map should look like the game): only
      // when hovered or selected, or as a small dot in object mode. Invisible objects keep their full marker.
      const key = `${o.type}:${o.id}`;
      const drawn = v.sprites && (s.sprites.has(key) || !!s.animations?.get(key)?.parts.length);
      const hovered = !!hover && Math.floor(o.x / 5) === hover.cellX && Math.floor(o.y / 5) === hover.cellY;
      if (drawn && tool !== 'object' && !selected && !hovered) return;
      const r = drawn && !selected ? full * 0.6 : full;
      const showLabel = selected || hovered || (s.input?.objectLabels !== false && cam.zoom > 0.45 && (!drawn || tool === 'object'));
      ctx.beginPath();
      ctx.arc(x, y, selected ? r * 1.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = o.type === 1 ? 'rgba(240, 80, 80, 0.9)' : 'rgba(80, 160, 255, 0.9)';
      ctx.fill();
      ctx.lineWidth = (selected ? 2.5 : 1) * px;
      ctx.strokeStyle = selected ? 'rgba(255, 225, 150, 1)' : 'rgba(0,0,0,0.8)';
      ctx.stroke();
      if (showLabel) {
        ctx.font = `${selected ? 600 : 400} ${11 * px}px ui-sans-serif, system-ui, sans-serif`;
        const label = objectLabel(o);
        const tx = x + r + 3 * px;
        const ty = y + 4 * px;
        ctx.lineWidth = 3 * px;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillText(label, tx, ty);
      }
    });
  }

  // Objects on the cursor (copied: green, cut: red), snapped to the sub-tile they'd be placed on.
  const g = s.objectGhost;
  const cursor = s.cursorWorld.current;
  if (g && cursor && tool === 'object') {
    const [fx, fy] = worldToSubTile(cursor[0], cursor[1]);
    const [ax, ay] = [Math.round(fx), Math.round(fy)];
    const colour = g.cut ? 'rgba(255, 70, 70, 0.95)' : 'rgba(80, 255, 120, 0.95)';
    for (const o of g.objects) {
      const [x, y] = subTileToWorld(ax + o.x, ay + o.y);
      const key = `${o.type}:${o.id}`;
      const frame = s.animations?.get(key)?.parts[0]?.[0]?.image ?? s.sprites.get(key);
      if (frame && v.sprites) ctx.drawImage(tintedSprite(frame, map.palette as Uint8Array, g.cut), x + frame.offsetX, y + 4 + frame.offsetY);
      if (o.path.length) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (const p of o.path) ctx.lineTo(...subTileToWorld(ax + p.x, ay + p.y));
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = colour;
        ctx.setLineDash([4 * px, 3 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const r = Math.max(4 * px, 5) * 1.3;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.stroke();
      ctx.font = `600 ${11 * px}px ui-sans-serif, system-ui, sans-serif`;
      const label = `${g.cut ? 'Move' : 'Copy'}: ${objectLabel(o)}`;
      ctx.lineWidth = 3 * px;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(label, x + r + 3 * px, y + 4 * px);
      ctx.fillStyle = colour;
      ctx.fillText(label, x + r + 3 * px, y + 4 * px);
    }
  }
}
