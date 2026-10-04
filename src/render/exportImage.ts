import type { Ds1Object } from '../formats/ds1';
import { decodeTile, type Dt1Tile, type TileImage } from '../formats/dt1';
import type { Palette } from '../formats/palette';
import type { CellRect } from '../game/clipboard';
import type { MapOverlay } from '../game/mapOverlays';
import type { Sprite } from '../game/sprites';
import { drawOverlayLegend, drawSubTilePaths, overlayPaths } from './overlay';
import { cellToWorld, subTileToWorld, type DrawItem, type Scene } from './scene';

/**
 * Renders a map (or part of it) to a PNG on the CPU with the 2D canvas: the same tiles, draw order and object
 * interleaving as the map view, with tiles drawn solid and shadows as translucent black (glow and fog blending are
 * left out). Used by "Export image".
 */

export interface ExportOptions {
  /** Cells to include; null = the whole map. */
  area: CellRect | null;
  /** 1 = the game's pixels, 0.5 = half size… */
  scale: number;
  objects: boolean;
  /** Which scene items to draw (the map view's layer visibility). */
  visible: (it: DrawItem) => boolean;
  /** Draw the special tiles (orientation 10/11: warps, entries…) that have graphics, after everything else. */
  specials?: boolean;
  /** A colour-coded overview (walkable sub-tiles, monster spawns) drawn over the map, with its legend. */
  overlay?: MapOverlay | null;
  /** PNG (default) or JPEG (much smaller, for previews). */
  format?: 'png' | 'jpeg';
}

/** The largest canvas side browsers reliably allow, and a total pixel budget. */
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 120_000_000;

/** World-space bounds of a cell rectangle, with room for tall walls above and objects. */
export function areaBounds(r: CellRect): { x: number; y: number; w: number; h: number } {
  const left = cellToWorld(r.x0, r.y1 + 1)[0];
  const right = cellToWorld(r.x1 + 1, r.y0)[0];
  const top = cellToWorld(r.x0, r.y0)[1] - 400;
  const bottom = cellToWorld(r.x1 + 1, r.y1 + 1)[1] + 80;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function exportSize(r: CellRect, scale: number): [number, number] {
  const b = areaBounds(r);
  return [Math.ceil(b.w * scale), Math.ceil(b.h * scale)];
}

const imageCache = new WeakMap<Palette, WeakMap<object, HTMLCanvasElement | null>>();

/** A tile or sprite image as a canvas (palette colours; `shadow` = translucent black), cached per palette. */
function toCanvas(key: object, image: TileImage | Sprite | null, palette: Palette, shadow: boolean): HTMLCanvasElement | null {
  let byKey = imageCache.get(palette);
  if (!byKey) imageCache.set(palette, (byKey = new WeakMap()));
  if (byKey.has(key)) return byKey.get(key)!;
  let out: HTMLCanvasElement | null = null;
  if (image && image.width > 0 && image.height > 0) {
    out = document.createElement('canvas');
    out.width = image.width;
    out.height = image.height;
    const ctx = out.getContext('2d')!;
    const data = ctx.createImageData(image.width, image.height);
    for (let i = 0; i < image.pixels.length; i++) {
      const p = image.pixels[i];
      if (!p) continue;
      if (shadow) data.data.set([0, 0, 0, 128], i * 4);
      else data.data.set([palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], i * 4);
    }
    ctx.putImageData(data, 0, 0);
  }
  byKey.set(key, out);
  return out;
}

const decoded = new WeakMap<Dt1Tile, TileImage | null>();
const tileImage = (t: Dt1Tile) => {
  if (!decoded.has(t)) decoded.set(t, decodeTile(t));
  return decoded.get(t)!;
};

export async function renderMapImage(scene: Scene, objects: Ds1Object[], sprites: Map<string, Sprite>, palette: Palette, width: number, height: number, opt: ExportOptions): Promise<Blob> {
  const area = opt.area ?? { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const b = areaBounds(area);
  const [w, h] = exportSize(area, opt.scale);
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw new Error(`${w}×${h} is too large: choose a smaller size or area`);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = opt.scale < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(opt.scale, 0, 0, opt.scale, -b.x * opt.scale, -b.y * opt.scale);
  const inArea = (cx: number, cy: number) => cx >= area.x0 && cx <= area.x1 && cy >= area.y0 && cy <= area.y1;

  const objs = opt.objects
    ? objects
        .map((o) => ({ o, sprite: sprites.get(`${o.type}:${o.id}`), depth: Math.floor(o.x / 5) + Math.floor(o.y / 5) }))
        .filter((x): x is typeof x & { sprite: Sprite } => !!x.sprite && inArea(Math.floor(x.o.x / 5), Math.floor(x.o.y / 5)))
        .sort((a, c) => a.depth - c.depth || a.o.x + a.o.y - (c.o.x + c.o.y))
    : [];
  let next = 0;
  const flush = (maxDepth: number) => {
    for (; next < objs.length && objs[next].depth <= maxDepth; next++) {
      const { o, sprite } = objs[next];
      const img = toCanvas(sprite, sprite, palette, false);
      const [wx, wy] = subTileToWorld(o.x, o.y);
      if (img) ctx.drawImage(img, wx + sprite.offsetX, wy + 4 + sprite.offsetY);
    }
  };
  for (const it of scene.items) {
    if (it.kind === 'wall') flush(it.cellX + it.cellY - 1);
    else if (it.kind === 'roof' || it.kind === 'special') flush(Infinity);
    if (!opt.visible(it) || (it.kind === 'special' && !opt.specials) || !inArea(it.cellX, it.cellY)) continue;
    const image = tileImage(it.tile);
    const img = toCanvas(it.tile, image, palette, it.kind === 'shadow');
    if (img && image) ctx.drawImage(img, it.x + image.offsetX, it.y + image.offsetY);
  }
  flush(Infinity);
  if (opt.overlay) {
    drawSubTilePaths(ctx, overlayPaths(opt.overlay, width, area), { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }, Infinity);
    drawOverlayLegend(ctx, opt.overlay, Math.round(w / 100) + 4, Math.round(h / 100) + 4, Math.max(13, Math.min(64, Math.round(Math.max(w, h) / 75))));
  }
  const type = opt.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image'))), type, 0.85));
}

/**
 * The whole map's tiles (no objects, no special markers) drawn at `scale` of the game's pixels, for showing under the
 * automap in the automap editor; `bounds` is where the canvas sits in world space.
 */
export function renderMapCanvas(scene: Scene, palette: Palette, width: number, height: number, scale: number): { canvas: HTMLCanvasElement; bounds: { x: number; y: number; w: number; h: number } } {
  const b = areaBounds({ x0: 0, y0: 0, x1: width - 1, y1: height - 1 });
  // Kept to a size every browser draws quickly.
  const s = Math.min(scale, 4096 / b.w, 4096 / b.h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(b.w * s));
  canvas.height = Math.max(1, Math.ceil(b.h * s));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(s, 0, 0, s, -b.x * s, -b.y * s);
  for (const it of scene.items) {
    if (it.kind === 'special') continue;
    const image = tileImage(it.tile);
    const img = toCanvas(it.tile, image, palette, it.kind === 'shadow');
    if (img && image) ctx.drawImage(img, it.x + image.offsetX, it.y + image.offsetY);
  }
  return { canvas, bounds: b };
}
