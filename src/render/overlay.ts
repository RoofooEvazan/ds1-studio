import type { CellRect } from '../game/clipboard';
import type { MapOverlay } from '../game/mapOverlays';
import { cellToWorld, subTileToWorld } from './scene';

/**
 * Sub-tile colour overlays (walkability, the walkable and monster-spawn overviews) as canvas paths: one Path2D per
 * class in 16×16-cell chunks, one parallelogram per run of same-class sub-tiles along each sub-tile row (a diamond's
 * top-right edge runs the same way as the row, so a run of diamonds is one parallelogram).
 */

export interface SubTileChunk {
  /** World-space bounds. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** One path per class (index = class - 1). */
  paths: Path2D[];
}

export interface SubTilePaths {
  chunks: SubTileChunk[];
  /** Fill colour of each class (index = class - 1), drawn in this order. */
  colours: string[];
  /** World bounds of the whole map. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Low-resolution raster for zoomed-out views, built on first use; one canvas pixel = `scale` world pixels. */
  raster: { canvas: HTMLCanvasElement; scale: number } | null;
}

const CHUNK = 16; // cells per chunk side

/** `classOf(sx, sy)`: 0 = nothing drawn, else 1 + an index into `colours`. */
export function subTilePaths(classOf: (sx: number, sy: number) => number, colours: string[], width: number, height: number): SubTilePaths {
  const chunks: SubTileChunk[] = [];
  for (let cy0 = 0; cy0 < height; cy0 += CHUNK)
    for (let cx0 = 0; cx0 < width; cx0 += CHUNK) {
      const cx1 = Math.min(width, cx0 + CHUNK);
      const cy1 = Math.min(height, cy0 + CHUNK);
      const paths = colours.map(() => new Path2D());
      let any = false;
      for (let sy = cy0 * 5; sy < cy1 * 5; sy++) {
        for (let sx = cx0 * 5; sx < cx1 * 5; ) {
          const c = classOf(sx, sy);
          let end = sx + 1;
          while (end < cx1 * 5 && classOf(end, sy) === c) end++;
          if (c) {
            any = true;
            const target = paths[c - 1];
            const [x0, y0] = subTileToWorld(sx, sy);
            const [xn, yn] = subTileToWorld(end - 1, sy);
            target.moveTo(x0, y0 - 8);
            target.lineTo(xn + 16, yn);
            target.lineTo(xn, yn + 8);
            target.lineTo(x0 - 16, y0);
            target.closePath();
          }
          sx = end;
        }
      }
      if (!any) continue;
      // Chunk corners in world space: north (cx0,cy0), east (cx1,cy0), south (cx1,cy1), west (cx0,cy1).
      const [, ny] = cellToWorld(cx0, cy0);
      const [ex] = cellToWorld(cx1, cy0);
      const [, sy2] = cellToWorld(cx1, cy1);
      const [wx] = cellToWorld(cx0, cy1);
      chunks.push({ x0: wx - 16, y0: ny - 8, x1: ex + 16, y1: sy2 + 8, paths });
    }
  const [, top] = cellToWorld(0, 0);
  const [right] = cellToWorld(width, 0);
  const [, bottom] = cellToWorld(width, height);
  const [left] = cellToWorld(0, height);
  return { chunks, colours, bounds: { x0: left - 16, y0: top - 8, x1: right + 16, y1: bottom + 8 }, raster: null };
}

const rgba = ([r, g, b, a]: [number, number, number, number]) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** A map overlay's paths (only the cells in `area`, when given). */
export function overlayPaths(ov: MapOverlay, width: number, area?: CellRect | null): SubTilePaths {
  const height = ov.sub.length / 25 / width;
  const classOf = (sx: number, sy: number) => {
    const [cx, cy] = [Math.floor(sx / 5), Math.floor(sy / 5)];
    if (area && (cx < area.x0 || cx > area.x1 || cy < area.y0 || cy > area.y1)) return 0;
    return ov.sub[(cy * width + cx) * 25 + (sy % 5) * 5 + (sx % 5)];
  };
  return subTilePaths(classOf, ov.classes.map((c) => rgba(c.rgba)), width, height);
}

function fillChunk(ctx: CanvasRenderingContext2D, p: SubTilePaths, c: SubTileChunk) {
  p.colours.forEach((colour, i) => {
    ctx.fillStyle = colour;
    ctx.fill(c.paths[i]);
  });
}

/**
 * Draws the paths in world space (the context's transform maps world to screen). `view` = the world rectangle shown,
 * with `zoom` screen pixels per world pixel: zoomed far out, a pre-rendered raster is drawn instead.
 */
export function drawSubTilePaths(ctx: CanvasRenderingContext2D, p: SubTilePaths, view: { x0: number; y0: number; x1: number; y1: number }, zoom: number) {
  const visible = p.chunks.filter((c) => c.x1 >= view.x0 && c.x0 <= view.x1 && c.y1 >= view.y0 && c.y0 <= view.y1);
  // Zoomed out, many chunks are visible and each diamond is a pixel or two: draw the pre-rendered raster instead.
  const worldW = p.bounds.x1 - p.bounds.x0;
  const worldH = p.bounds.y1 - p.bounds.y0;
  const scale = Math.max(2, Math.ceil(Math.max(worldW / 4096, worldH / 4096)));
  if (visible.length > 12 && zoom * scale <= 2) {
    if (!p.raster || p.raster.scale !== scale) {
      const r = document.createElement('canvas');
      r.width = Math.ceil(worldW / scale);
      r.height = Math.ceil(worldH / scale);
      const rc = r.getContext('2d')!;
      rc.setTransform(1 / scale, 0, 0, 1 / scale, -p.bounds.x0 / scale, -p.bounds.y0 / scale);
      for (const c of p.chunks) fillChunk(rc, p, c);
      p.raster = { canvas: r, scale };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(p.raster.canvas, p.bounds.x0, p.bounds.y0, p.raster.canvas.width * scale, p.raster.canvas.height * scale);
    return;
  }
  for (const c of visible) fillChunk(ctx, p, c);
}

/**
 * The overlay's legend in a box at (x, y) in canvas pixels (no transform), `size` = text height: the classes it
 * coloured (with how many tiles², 25 sub-tiles each) and its notes.
 */
export function drawOverlayLegend(ctx: CanvasRenderingContext2D, ov: MapOverlay, x: number, y: number, size: number) {
  const rows = ov.classes.map((c, i) => ({ c, n: ov.counts[i] })).filter((r) => r.n > 0);
  const pad = size * 0.7;
  const line = size * 1.45;
  const font = (bold: boolean) => `${bold ? '600 ' : ''}${size}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  const tiles = (n: number) => `${(n / 25).toLocaleString(undefined, { maximumFractionDigits: 0 })} tiles²`;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = font(true);
  let w = ctx.measureText(ov.title).width;
  ctx.font = font(false);
  for (const r of rows) w = Math.max(w, size * 2.4 + ctx.measureText(`${r.c.label} · ${tiles(r.n)}`).width);
  const small = size * 0.8;
  ctx.font = `${small}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  for (const n of ov.notes) w = Math.max(w, ctx.measureText(n).width);
  const h = pad * 2 + line * (1 + rows.length) + ov.notes.length * small * 1.4;
  ctx.fillStyle = 'rgba(12, 13, 16, 0.85)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = Math.max(1, size / 14);
  ctx.fillRect(x, y, w + pad * 2, h);
  ctx.strokeRect(x, y, w + pad * 2, h);
  ctx.textBaseline = 'middle';
  let cy = y + pad + line / 2;
  ctx.fillStyle = '#fff';
  ctx.font = font(true);
  ctx.fillText(ov.title, x + pad, cy);
  ctx.font = font(false);
  for (const r of rows) {
    cy += line;
    const sx = x + pad;
    // A diamond swatch, over black so its translucent colour reads as on the map.
    const dw = size * 1.8;
    const dh = size * 0.9;
    ctx.beginPath();
    ctx.moveTo(sx + dw / 2, cy - dh / 2);
    ctx.lineTo(sx + dw, cy);
    ctx.lineTo(sx + dw / 2, cy + dh / 2);
    ctx.lineTo(sx, cy);
    ctx.closePath();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.fillStyle = rgba([r.c.rgba[0], r.c.rgba[1], r.c.rgba[2], Math.min(1, r.c.rgba[3] * 2)]);
    ctx.fill();
    ctx.fillStyle = '#e8e8ea';
    ctx.fillText(`${r.c.label} · ${tiles(r.n)}`, sx + size * 2.4, cy);
  }
  ctx.font = `${small}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  ctx.fillStyle = '#b8bac0';
  cy += line / 2 + small * 0.7;
  for (const n of ov.notes) {
    ctx.fillText(n, x + pad, cy);
    cy += small * 1.4;
  }
  ctx.restore();
}
