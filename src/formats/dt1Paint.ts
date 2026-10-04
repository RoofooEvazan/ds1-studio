import { decodeTile, parseDt1, type Dt1Block, type Dt1Tile, type TileImage } from './dt1';

/**
 * Pixel painting engine for DT1 tiles: writes an edited TileImage (as returned by decodeTile)
 * back into the tile's blocks and returns a new DT1 file.
 *
 * File layout (see parseDt1 / dt1Edit.ts):
 *   file header: i32 7, i32 6, 260 bytes, i32 tileCount @268, i32 tileHeaderPtr @272
 *   tile header (96 bytes): +72 i32 blockHeaderPtr (absolute), +76 i32 blockDataLength
 *     (= 20 * blockCount + sum of block data lengths in vanilla files), +80 i32 blockCount
 *   block header (20 bytes each, at blockHeaderPtr): +0 i16 x, +2 i16 y, +6 u8 gridX, +7 u8 gridY,
 *     +8 i16 format, +10 i32 length, +16 i32 offset (relative to blockHeaderPtr)
 *
 * Block encodings, as found in every vanilla DT1 of d2data.mpq:
 *   - format 1 (isometric): exactly 256 bytes, a 15-row 32px diamond with no transparency.
 *     Every diamond pixel is stored as given, so a painted 0 inside an isometric block is written
 *     as palette index 0 (decodeTile shows it as 0/transparent, the game draws index 0).
 *   - any other format: RLE. Each row is a sequence of (skip, count, count pixel bytes) runs, where
 *     `skip` covers a maximal run of transparent (0) pixels and `count` a maximal run of opaque
 *     pixels; the row ends with (0, 0). Transparent pixels at the end of a row are not encoded
 *     (the (0, 0) comes right after the last opaque run). Every row of the block is terminated,
 *     including trailing empty rows: format 0x1001 (wall) blocks always encode 32 rows, format
 *     0x2005 (floor/roof RLE) blocks always encode 15 rows. The encoder keeps the original block's
 *     row count (growing it only if a pixel is painted below it), which reproduces vanilla blocks
 *     byte for byte.
 *
 * Blocks whose pixels do not change are copied verbatim; changed blocks are re-encoded and the
 * file is re-laid-out (lengths, offsets, block-header pointers of later tiles, tile data length,
 * tile header pointer). Every byte not belonging to changed block data is preserved.
 */

const TILE_HEADER_SIZE = 96;
const BLOCK_HEADER_SIZE = 20;
const ISO_X_JUMP = [14, 12, 10, 8, 6, 4, 2, 0, 2, 4, 6, 8, 10, 12, 14];
const ISO_PIXELS = [4, 8, 12, 16, 20, 24, 28, 32, 28, 24, 20, 16, 12, 8, 4];
/** RLE format used by the 15-row RLE blocks of floor/roof tiles. */
const RLE_FLOOR_FORMAT = 0x2005;

function i32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
}
function setI32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

// ---------------------------------------------------------------------------------------------
// Per-block pixel models

/** A block's pixels in its own 32 x 32 space (value 0 = transparent for RLE). */
interface BlockModel {
  block: Dt1Block;
  iso: boolean;
  /** Paintable height in rows (15 for iso / floor RLE, 32 for wall RLE). */
  height: number;
  /** Original encoded row count (RLE only). */
  rows: number;
  /** 32 x 32 pixel values, row-major. */
  px: Uint8Array;
  /** 32 x 32 coverage: 1 = this block defines the pixel. */
  cover: Uint8Array;
}

/** Decodes one RLE block into a 32 x 32 array exactly like decodeTile. Returns the encoded row count. */
export function decodeRleBlock(d: Uint8Array): { pixels: Uint8Array; rows: number } {
  const pixels = new Uint8Array(32 * 32);
  let p = 0;
  let x = 0;
  let y = 0;
  while (p + 1 < d.length && y < 32) {
    const skip = d[p++];
    const n = d[p++];
    if (skip === 0 && n === 0) {
      x = 0;
      y++;
      continue;
    }
    x += skip;
    for (let k = 0; k < n && p + k < d.length; k++) {
      if (x + k < 32) pixels[y * 32 + x + k] = d[p + k];
    }
    p += n;
    x += n;
  }
  return { pixels, rows: y };
}

/**
 * Encodes a 32 x 32 pixel array (0 = transparent) as an RLE block using the vanilla conventions:
 * per row (skip, count, pixels...) runs followed by (0, 0); `minRows` rows are always terminated
 * (more if a lower row has opaque pixels). Rows beyond 32 are never written.
 */
export function encodeRleBlock(pixels: Uint8Array, minRows: number): Uint8Array {
  let last = -1;
  for (let i = 0; i < 32 * 32; i++) if (pixels[i] !== 0) last = i >> 5;
  const rows = Math.min(32, Math.max(minRows, last + 1));
  const out: number[] = [];
  for (let y = 0; y < rows; y++) {
    const row = y * 32;
    let x = 0;
    while (x < 32) {
      let skip = 0;
      while (x < 32 && pixels[row + x] === 0) {
        x++;
        skip++;
      }
      if (x >= 32) break;
      const start = x;
      while (x < 32 && pixels[row + x] !== 0) x++;
      out.push(skip, x - start);
      for (let k = start; k < x; k++) out.push(pixels[row + k]);
    }
    out.push(0, 0);
  }
  return Uint8Array.from(out);
}

function blockModel(block: Dt1Block): BlockModel {
  const px = new Uint8Array(32 * 32);
  const cover = new Uint8Array(32 * 32);
  if (block.format === 1) {
    const d = block.data;
    let p = 0;
    for (let row = 0; row < 15; row++) {
      const n = ISO_PIXELS[row];
      const x0 = ISO_X_JUMP[row];
      for (let k = 0; k < n; k++) {
        cover[row * 32 + x0 + k] = 1;
        if (p + k < d.length) px[row * 32 + x0 + k] = d[p + k];
      }
      p += n;
    }
    return { block, iso: true, height: 15, rows: 15, px, cover };
  }
  const { pixels, rows } = decodeRleBlock(block.data);
  const height = block.format === RLE_FLOOR_FORMAT ? Math.max(15, Math.min(32, rows)) : 32;
  px.set(pixels);
  cover.fill(1, 0, height * 32);
  return { block, iso: false, height, rows, px, cover };
}

function encodeBlock(m: BlockModel): Uint8Array {
  if (!m.iso) return encodeRleBlock(m.px, m.rows);
  const out = new Uint8Array(Math.max(256, m.block.data.length));
  out.set(m.block.data);
  let p = 0;
  for (let row = 0; row < 15; row++) {
    const n = ISO_PIXELS[row];
    out.set(m.px.subarray(row * 32 + ISO_X_JUMP[row], row * 32 + ISO_X_JUMP[row] + n), p);
    p += n;
  }
  return out;
}

/** The TileImage geometry decodeTile produces for a tile (null when it has no blocks). */
function tileGeometry(tile: Dt1Tile): { width: number; height: number; offsetX: number; offsetY: number } | null {
  if (tile.blocks.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of tile.blocks) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + 32);
    maxY = Math.max(maxY, b.y + (b.format === 1 ? 15 : 32));
  }
  return { width: maxX - minX, height: maxY - minY, offsetX: minX, offsetY: minY };
}

/**
 * 1 for every pixel of the tile's decodeTile image that some block covers (and can therefore be
 * painted), 0 elsewhere. Isometric blocks cover their 15-row diamond, wall RLE blocks their full
 * 32 x 32 square, floor RLE blocks (format 0x2005) a 32 x 15 rectangle. Empty array for a tile
 * without blocks.
 */
export function paintableMask(tile: Dt1Tile): Uint8Array {
  const g = tileGeometry(tile);
  if (!g) return new Uint8Array(0);
  const mask = new Uint8Array(g.width * g.height);
  for (const b of tile.blocks) {
    const m = blockModel(b);
    const ox = b.x - g.offsetX;
    const oy = b.y - g.offsetY;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (m.cover[y * 32 + x]) mask[(oy + y) * g.width + ox + x] = 1;
      }
    }
  }
  return mask;
}

/** Number of non-transparent pixels of `image` lying outside the tile's paintable mask (they would be dropped). */
export function droppedPixelCount(tile: Dt1Tile, image: TileImage): number {
  const mask = paintableMask(tile);
  let n = 0;
  const len = Math.min(mask.length, image.pixels.length);
  for (let i = 0; i < len; i++) if (!mask[i] && image.pixels[i] !== 0) n++;
  return n;
}

/**
 * Applies `image` to the tile's block models. Returns the indices of blocks whose pixels changed.
 * For each covered pixel whose decoded value differs from the target: a non-zero target is written
 * into the last covering block (blocks decode in order, later ones on top); a zero target is
 * written into every covering block.
 */
function applyImage(tile: Dt1Tile, models: BlockModel[], image: TileImage): Set<number> {
  const g = tileGeometry(tile)!;
  const changed = new Set<number>();
  const { width, height } = g;
  // Covering blocks per image pixel, in decode order.
  const covering: number[][] = new Array(width * height);
  models.forEach((m, bi) => {
    const ox = m.block.x - g.offsetX;
    const oy = m.block.y - g.offsetY;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (!m.cover[y * 32 + x]) continue;
        const i = (oy + y) * width + ox + x;
        (covering[i] ??= []).push(bi);
      }
    }
  });
  const local = (bi: number, i: number) => {
    const m = models[bi];
    const x = (i % width) - (m.block.x - g.offsetX);
    const y = Math.floor(i / width) - (m.block.y - g.offsetY);
    return y * 32 + x;
  };
  for (let i = 0; i < width * height; i++) {
    const list = covering[i];
    if (!list) continue;
    const v = image.pixels[i];
    let current = 0;
    for (let k = list.length - 1; k >= 0; k--) {
      const m = models[list[k]];
      const val = m.px[local(list[k], i)];
      if (m.iso || val !== 0) {
        current = val;
        break;
      }
    }
    if (current === v) continue;
    const targets = v !== 0 ? [list[list.length - 1]] : list;
    for (const bi of targets) {
      const li = local(bi, i);
      if (models[bi].px[li] !== v) {
        models[bi].px[li] = v;
        changed.add(bi);
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// File rebuild

export interface TilePixelEdit {
  tileIndex: number;
  image: TileImage;
}

export interface PaintOptions {
  /**
   * Re-encode every block of the edited tiles, even blocks whose pixels did not change (by default
   * unchanged blocks are copied verbatim). Mainly for verifying the encoder.
   */
  reencodeAll?: boolean;
}

interface Splice {
  tile: number;
  block: number;
  start: number;
  end: number;
  data: Uint8Array;
}

/**
 * Returns a new DT1 with the given tiles' pixels replaced by the edit images. Each image must have
 * exactly the geometry decodeTile returns for that tile (width/height/offsetX/offsetY). Pixels
 * outside paintableMask(tile) are ignored (see droppedPixelCount). Block lists, positions and
 * formats are kept; RLE blocks may change length, and all offsets/pointers are recomputed.
 * Later edits of the same tile win.
 */
export function setManyTilePixels(
  bytes: Uint8Array,
  edits: TilePixelEdit[],
  options: PaintOptions = {},
): Uint8Array {
  const dt1 = parseDt1(bytes);
  const count = i32(bytes, 268);
  const headerPtr = i32(bytes, 272);

  const byTile = new Map<number, TileImage>();
  for (const e of edits) {
    if (!Number.isInteger(e.tileIndex) || e.tileIndex < 0 || e.tileIndex >= dt1.tiles.length) {
      throw new RangeError(`tile index ${e.tileIndex} out of range 0..${dt1.tiles.length - 1}`);
    }
    const tile = dt1.tiles[e.tileIndex];
    const g = tileGeometry(tile);
    if (!g) throw new Error(`tile ${e.tileIndex} has no blocks to paint`);
    const im = e.image;
    if (im.width !== g.width || im.height !== g.height || im.offsetX !== g.offsetX || im.offsetY !== g.offsetY) {
      throw new Error(
        `tile ${e.tileIndex}: image geometry ${im.width}x${im.height}@${im.offsetX},${im.offsetY} ` +
          `differs from tile geometry ${g.width}x${g.height}@${g.offsetX},${g.offsetY}`,
      );
    }
    if (im.pixels.length !== g.width * g.height) {
      throw new Error(`tile ${e.tileIndex}: expected ${g.width * g.height} pixels, got ${im.pixels.length}`);
    }
    byTile.set(e.tileIndex, im);
  }

  // Re-encode changed blocks.
  const splices: Splice[] = [];
  for (const [t, image] of byTile) {
    const tile = dt1.tiles[t];
    const models = tile.blocks.map(blockModel);
    const changed = applyImage(tile, models, image);
    if (options.reencodeAll) models.forEach((_, bi) => changed.add(bi));
    if (changed.size === 0) continue;
    const blockPtr = i32(bytes, headerPtr + t * TILE_HEADER_SIZE + 72);
    for (const bi of [...changed].sort((a, b) => a - b)) {
      const bh = blockPtr + bi * BLOCK_HEADER_SIZE;
      const start = blockPtr + i32(bytes, bh + 16);
      const end = start + tile.blocks[bi].data.length;
      splices.push({ tile: t, block: bi, start, end, data: encodeBlock(models[bi]) });
    }
  }
  if (splices.length === 0) return bytes.slice();

  // Changed block data must not be shared with / overlap any other block's data.
  const ranges: { start: number; end: number; tile: number; block: number }[] = [];
  dt1.tiles.forEach((tile, t) =>
    tile.blocks.forEach((b, bi) => ranges.push({ start: b.data.byteOffset - bytes.byteOffset, end: b.data.byteOffset - bytes.byteOffset + b.data.length, tile: t, block: bi })),
  );
  for (const s of splices) {
    for (const r of ranges) {
      if (r.tile === s.tile && r.block === s.block) continue;
      if (r.start < s.end && s.start < r.end) {
        throw new Error(`tile ${s.tile} block ${s.block} shares its data with tile ${r.tile} block ${r.block}; cannot re-encode`);
      }
    }
  }

  // Splice new block data in, in file order.
  splices.sort((a, b) => a.start - b.start || a.tile - b.tile || a.block - b.block);
  let total = bytes.length;
  for (const s of splices) total += s.data.length - (s.end - s.start);
  const out = new Uint8Array(total);
  const newStart = new Map<string, number>();
  let cursor = 0;
  let w = 0;
  for (const s of splices) {
    out.set(bytes.subarray(cursor, s.start), w);
    w += s.start - cursor;
    newStart.set(`${s.tile}:${s.block}`, w);
    out.set(s.data, w);
    w += s.data.length;
    cursor = s.end;
  }
  out.set(bytes.subarray(cursor), w);

  /** New position of an unchanged byte position. */
  const newPos = (pos: number) => {
    let p = pos;
    for (const s of splices) if (s.end <= pos) p += s.data.length - (s.end - s.start);
    return p;
  };

  // Fix pointers, offsets and lengths.
  const newHeaderPtr = newPos(headerPtr);
  setI32(out, newPos(272), newHeaderPtr);
  const deltaByTile = new Map<number, number>();
  for (const s of splices) deltaByTile.set(s.tile, (deltaByTile.get(s.tile) ?? 0) + s.data.length - (s.end - s.start));
  const spliceOf = new Map(splices.map((s) => [`${s.tile}:${s.block}`, s]));
  for (let t = 0; t < count; t++) {
    const th = headerPtr + t * TILE_HEADER_SIZE;
    const nth = newPos(th);
    const blockPtr = i32(bytes, th + 72);
    const blockCount = i32(bytes, th + 80);
    if (blockPtr <= 0) continue;
    const nbp = newPos(blockPtr);
    setI32(out, nth + 72, nbp);
    const dl = deltaByTile.get(t);
    if (dl) setI32(out, nth + 76, i32(bytes, th + 76) + dl);
    for (let b = 0; b < blockCount; b++) {
      const bh = blockPtr + b * BLOCK_HEADER_SIZE;
      const nbh = newPos(bh);
      const s = spliceOf.get(`${t}:${b}`);
      if (s) {
        setI32(out, nbh + 10, s.data.length);
        setI32(out, nbh + 16, newStart.get(`${t}:${b}`)! - nbp);
      } else {
        setI32(out, nbh + 16, newPos(blockPtr + i32(bytes, bh + 16)) - nbp);
      }
    }
  }
  return out;
}

/** Single-tile form of setManyTilePixels. */
export function setTilePixels(
  bytes: Uint8Array,
  tileIndex: number,
  image: TileImage,
  options?: PaintOptions,
): Uint8Array {
  return setManyTilePixels(bytes, [{ tileIndex, image }], options);
}

/** `image` with the pixels outside the tile's paintable mask made transparent: what saving it will keep. */
export function cropToTile(tile: Dt1Tile, image: TileImage): TileImage {
  const mask = paintableMask(tile);
  return { ...image, pixels: image.pixels.map((v, i) => (mask[i] ? v : 0)) };
}

/**
 * Checks an edited DT1 before it is written over the one it came from: it must read back, with the same number of tiles
 * and the same tile numbers (orientation, main, sub, unless `renumbered`), every tile that had a picture still having
 * one, and the tiles not in `touched` keeping exactly their pictures. Returns what is wrong, or null.
 */
export function editedDt1Problem(before: Uint8Array, after: Uint8Array, touched: ReadonlySet<number>, renumbered = false): string | null {
  let a, b;
  try {
    a = parseDt1(before);
    b = parseDt1(after);
  } catch (e) {
    return `the new file doesn't read back (${(e as Error).message})`;
  }
  if (a.tiles.length !== b.tiles.length) return `it has ${b.tiles.length} tiles instead of ${a.tiles.length}`;
  for (let i = 0; i < a.tiles.length; i++) {
    const x = a.tiles[i], y = b.tiles[i];
    if (!renumbered && (x.orientation !== y.orientation || x.mainIndex !== y.mainIndex || x.subIndex !== y.subIndex)) return `tile ${i} changed its number`;
    let px, py;
    try {
      px = decodeTile(x);
      py = decodeTile(y);
    } catch (e) {
      return `tile ${i} can't be drawn (${(e as Error).message})`;
    }
    if (!!px !== !!py) return `tile ${i} lost its picture`;
    if (!touched.has(i) && px && py && (px.pixels.length !== py.pixels.length || px.pixels.some((v, k) => v !== py.pixels[k]))) return `tile ${i} changed although it wasn't edited`;
  }
  return null;
}

/** Row widths of an isometric (format 1) 32×15 block, centred in its 32 columns. */
const ISO_ROWS = [4, 8, 12, 16, 20, 24, 28, 32, 28, 24, 20, 16, 12, 8, 4];

/**
 * The standard floor/roof diamond (the 25 isometric blocks of a 160×79 floor tile, at tile x 0-159, y 0-78) as a mask
 * over an image of the given geometry: where a floor or roof tile can have pixels, whatever its blocks are stored as.
 */
export function diamondMask(g: { width: number; height: number; offsetX: number; offsetY: number }): Uint8Array {
  const mask = new Uint8Array(g.width * g.height);
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 5; j++) {
      const bx = 64 + 16 * (i - j), by = 64 - 8 * (i + j);
      ISO_ROWS.forEach((w, r) => {
        const y = by + r - g.offsetY;
        if (y < 0 || y >= g.height) return;
        for (let x = bx + (32 - w) / 2 - g.offsetX, end = x + w; x < end; x++) if (x >= 0 && x < g.width) mask[y * g.width + x] = 1;
      });
    }
  return mask;
}

/** `image` cut to the standard floor/roof diamond, and how many of its pixels lay outside it. */
export function cropToDiamond(image: TileImage): { image: TileImage; dropped: number } {
  const mask = diamondMask(image);
  let dropped = 0;
  const pixels = image.pixels.map((v, i) => {
    if (mask[i] || !v) return v;
    dropped++;
    return 0;
  });
  return { image: { ...image, pixels }, dropped };
}
