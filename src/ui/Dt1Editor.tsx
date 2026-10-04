import { viewPalette } from '../game/openMap';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isEmptyCell, type WallCell } from '../formats/ds1';
import { decodeTile, Orientation, parseDt1, type Dt1, type TileImage } from '../formats/dt1';
import { cropToTile, droppedPixelCount, editedDt1Problem, setManyTilePixels } from '../formats/dt1Paint';
import { cornerPartner, freeSub, mirrorRecord, rebuildRleRecord } from '../formats/dt1Blocks';
import { buildDt1, changedRecord, dt1Records, recordInfo, type Dt1Record } from '../formats/dt1Write';
import { readPng, toPaletteIndices, writeIndexedPng } from '../formats/png';
import { ImageThumb, PixelPainter } from './PixelPainter';
import { FloatingWindow } from './FloatingWindow';
import { TileZoom } from './TileZoom';
import { Dt1Tree } from './Dt1Tree';
import { dt1ToIni, parseDt1Ini, readTileSettings, writeTileSettings, type TileSettings } from '../formats/dt1Header';
import { TileSettingsPanel } from './TileSettings';
import { exportBytes, importBytes } from '../vfs/save';
import { act0Display, loadAct0Palette, type Act0Palette } from '../game/act0Palette';
import { HelpTip } from './HelpTip';
import { normalizePath } from '../vfs/vfs';
import type { Palette } from '../formats/palette';
import { hueRemap, recolorDt1, swapRemap } from '../formats/dt1Edit';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { presetToClipboard, type Preset } from '../game/presets';
import { inSelection, type CellSelection } from '../game/clipboard';
import { selectTileIndices } from '../game/tileSelection';
import { ORIENTATION_NAMES } from './state';
import { Thumb } from './TilePalette';
import { isBuiltinPath } from '../game/specialTiles';
import { sharedTakenKeys } from '../game/ownTiles';
import { cellMoves, composeMoves, libraryOwners, loadedWithOwners, movedNumbers, renumberDt1, settledMoves, tileNumbers, type NumberOwners, type TileNumber } from '../game/reassignTiles';
import { ReassignPanel } from './ReassignPanel';

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

export interface Dt1EditResult {
  /** Where the edited DT1 goes (a new name, or the original to overwrite it). */
  path: string;
  bytes: Uint8Array;
  /** Replace the original with the new DT1 in this map's tile libraries. */
  switchMap: boolean;
  original: string;
  /** Old tile number → new ("orientation|main|sub") for the cells the open map placed: moved along when it is saved. */
  moves?: Map<string, string>;
}

interface Props {
  /** The open map (null: editing a DT1 on its own, from the Home tab). */
  map: OpenMap | null;
  gd: GameData;
  /** Saved + suggested presets (their tiles can be selected in one go). */
  presets: Preset[];
  /** The map selection, to select the tiles used there. */
  selection: CellSelection | null;
  canSave: boolean;
  onSave: (r: Dt1EditResult) => Promise<void>;
  onClose: () => void;
}

interface Adjust {
  hue: number;
  saturation: number;
  brightness: number;
  tint: string;
  tintAmount: number;
  swapFrom: string;
  swapTo: string;
  swapTolerance: number;
  swapOn: boolean;
  /** Snap every colour to the Act 0 palette (makes tiles look the same in every act). */
  toAct0: boolean;
}

const NO_ADJUST: Adjust = { hue: 0, saturation: 1, brightness: 1, tint: '#ff8040', tintAmount: 0, swapFrom: '#808080', swapTo: '#4060c0', swapTolerance: 40, swapOn: false, toAct0: false };
const isNeutral = (a: Adjust) => a.hue === 0 && a.saturation === 1 && a.brightness === 1 && a.tintAmount === 0 && !a.swapOn && !a.toAct0;

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Palette whose entry i shows the colour index remap[i] has: drawing with it previews a remap without touching the DT1. */
function remappedPalette(palette: Palette, remap: Uint8Array): Palette {
  const out = new Uint8Array(palette.length);
  for (let i = 0; i < 256; i++) out.set(palette.subarray(remap[i] * 4, remap[i] * 4 + 4), i * 4);
  return out;
}

/**
 * Duplicate / rename / recolour a DT1. Pick tiles one by one, by preset, or from the map selection; adjust hue,
 * saturation, brightness, tint or swap a colour; the preview shows exactly what gets written (colours are snapped to
 * the act palette, since DT1s store palette indices).
 */
export function Dt1Editor({ map, gd, presets, selection, canSave, onSave, onClose }: Props) {
  const libs = useMemo(() => (map ? map.lib.loaded.filter((l) => l.found && !isBuiltinPath(l.path)).map((l) => l.path) : []), [map]);
  const [path, setPath] = useState(libs[0] ?? '');
  /** Every DT1 in the game and mods, for the library tree. */
  const allDt1s = useMemo(() => gd.fs.list((p) => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')), [gd]);
  const inMapLib = libs.some((l) => normalizePath(l) === normalizePath(path));
  // DT1s are shown, recoloured and painted in one palette. Default: Act 0 — only the colours that look the same in
  // every act (Gimli's act0), so edited tiles work in any act. -1 = Act 0, 0..4 = the game's Act 1..5 palettes.
  const [palAct, setPalAct] = useState(() => {
    try {
      const raw = localStorage.getItem('ds1studio.dt1Palette2');
      const v = raw === null ? -1 : Number(raw);
      return v >= -1 && v <= 4 ? v : -1;
    } catch {
      return -1;
    }
  });
  const [pal, setPal] = useState<{ palette: Palette; act: number; usable: boolean[] | null; source?: string; act0?: Act0Palette }>({ palette: map?.palette ?? new Uint8Array(1024), act: -2, usable: null });
  /** Show colours that change between acts as magenta (else in the tile's own act colours). */
  const [highlightUnsafe, setHighlightUnsafe] = useState(() => viewPalette().magenta);
  // The act the DT1 was made for (from its folder): the real colours behind Act 0's magenta slots, for conversions.
  const homeAct = useMemo(() => {
    const m = /tiles\/(?:act(\d)|(expansion))\//i.exec(path);
    return m ? (m[1] ? Number(m[1]) - 1 : 4) : 0;
  }, [path]);
  const [homePalette, setHomePalette] = useState<Palette | null>(null);
  useEffect(() => {
    let live = true;
    void gd.palette(homeAct).then((p) => live && setHomePalette(p));
    return () => {
      live = false;
    };
  }, [homeAct, gd]);
  useEffect(() => {
    let live = true;
    if (palAct === -1) void loadAct0Palette(gd.fs).then((a) => live && setPal({ palette: a.palette, act: -1, usable: a.usable, source: a.source, act0: a }));
    else void gd.palette(palAct).then((palette) => live && setPal({ palette, act: palAct, usable: null }));
    try {
      localStorage.setItem('ds1studio.dt1Palette2', String(palAct));
    } catch {
      // per-viewer convenience only
    }
    return () => {
      live = false;
    };
  }, [palAct, gd]);
  const palette = useMemo(() => (pal.act0 ? act0Display(pal.act0, homePalette, highlightUnsafe) : pal.palette), [pal, homePalette, highlightUnsafe]);
  const [dt1, setDt1] = useState<Dt1 | null>(null);
  const selectionAnchor = useRef<number | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adjust, setAdjust] = useState<Adjust>(NO_ADJUST);
  const [name, setName] = useState('');
  const [switchMap, setSwitchMap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(64);
  /** Pixel edits per tile index, applied (before any recolour) when saving. */
  const [edits, setEdits] = useState<Map<number, TileImage>>(new Map());
  const [painting, setPainting] = useState<number | null>(null);
  /** The tile shown in the zoom window (the last one clicked). */
  const [zoomed, setZoomed] = useState<number | null>(null);
  /** The DT1 file as stored, and pending tile-settings (.ini field) changes per tile. */
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);
  const [settingsEdits, setSettingsEdits] = useState<Map<number, Partial<TileSettings>>>(new Map());
  const [sideTab, setSideTab] = useState<'colours' | 'settings'>('colours');
  const [iniMessage, setIniMessage] = useState<string | null>(null);
  /** The DT1 after clone / mirror / picture imports (not saved yet); null: the file as it is. */
  const [working, setWorking] = useState<Uint8Array | null>(null);
  const [cloneSame, setCloneSame] = useState(false);
  const [opNote, setOpNote] = useState<string | null>(null);
  /** Waiting for "Delete the selected tiles?" (the Delete key or the button). */
  const [deleting, setDeleting] = useState(false);
  /** The Reassign index menu: the DT1 it renumbers (with unsaved changes), its numbers and the tiles shown. */
  const [reassign, setReassign] = useState<{ bytes: Uint8Array; numbers: TileNumber[]; indices: number[] } | null>(null);
  /** Renumberings applied but not saved (old → new, relative to the map's cells). */
  const [pendingMoves, setPendingMoves] = useState<Map<string, string>>(new Map());
  const [remapMap, setRemapMap] = useState(true);
  const [loadedWith, setLoadedWith] = useState<NumberOwners | null>(null);
  const [library, setLibrary] = useState<NumberOwners | null>(null);
  const [libraryProgress, setLibraryProgress] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    selectionAnchor.current = null;
    setAdjust(NO_ADJUST);
    setError(null);
    setDt1(null);
    setPicked(new Set());
    setEdits(new Map());
    setPainting(null);
    setZoomed(null);
    setSettingsEdits(new Map());
    setRawBytes(null);
    setIniMessage(null);
    setWorking(null);
    setOpNote(null);
    setReassign(null);
    setPendingMoves(new Map());
    if (!path) return;
    void Promise.all([gd.dt1(path), gd.fs.read(path)]).then(([tiles, bytes]) => {
      if (live) { setDt1(tiles); setRawBytes(bytes); }
    }).catch(e => live && setError(String(e)));
    setName(path.split('/').pop()!.replace(/\.dt1$/i, '') + '_edit');
    return () => { live = false; };
  }, [path, gd]);

  const remap = useMemo(() => {
    // No adjustment = no change (an Act 0 tile's act-specific colours are only converted when asked).
    if (isNeutral(adjust)) return Uint8Array.from({ length: 256 }, (_, i) => i);
    const allowed = pal.usable ?? undefined;
    // With Act 0, colours are judged by their real look in the DT1's own act (Act 0 marks those slots magenta).
    const source = allowed && homePalette ? homePalette : palette;
    let r = hueRemap(source, {
      hue: adjust.hue,
      saturation: adjust.saturation,
      brightness: adjust.brightness,
      tint: rgb(adjust.tint),
      tintAmount: adjust.tintAmount,
      allowed,
      // Act 0: the nearest colour by plain RGB distance, as the community's act-0 conversions do.
      metric: allowed ? 'rgb' : 'perceptual',
    });
    if (adjust.swapOn) {
      const s = swapRemap(source, rgb(adjust.swapFrom), rgb(adjust.swapTo), adjust.swapTolerance, allowed);
      r = r.map((v) => s[v]);
    }
    return r;
  }, [palette, adjust, pal.usable, homePalette]);
  const previewPal = useMemo(() => remappedPalette(palette, remap), [palette, remap]);
  const changes = remap.some((v, i) => v !== i);

  // Tiles of this DT1 matching a set of (orientation, main, sub) keys.
  const tilesMatching = (keys: Set<string>) => {
    const out = new Set<number>();
    dt1?.tiles.forEach((t, i) => keys.has(`${t.orientation}|${t.mainIndex}|${t.subIndex}`) && out.add(i));
    return out;
  };
  const keysOfCells = (cells: { kind: string; cell: { mainIndex: number; subIndex: number; prop1: number } & Partial<WallCell> }[]) => {
    const keys = new Set<string>();
    for (const { kind, cell } of cells) {
      if (isEmptyCell(cell as never)) continue;
      const o = kind === 'floor' ? Orientation.Floor : kind === 'shadow' ? Orientation.Shadow : (cell.orientation ?? 0);
      keys.add(`${o}|${cell.mainIndex}|${cell.subIndex}`);
      if (o === Orientation.RightPartOfNorthCornerWall) keys.add(`${Orientation.LeftPartOfNorthCornerWall}|${cell.mainIndex}|${cell.subIndex}`);
    }
    return keys;
  };
  const presetTiles = useMemo(() => {
    if (!dt1) return [];
    return presets
      .map((p) => {
        const clip = presetToClipboard(p);
        const keys = keysOfCells(clip.layers.flatMap((l) => l.cells.map((cell) => ({ kind: l.layer.kind, cell }))));
        return { preset: p, tiles: tilesMatching(keys) };
      })
      .filter((x) => x.tiles.size > 0);
  }, [presets, dt1]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectionTiles = () => {
    if (!selection || !map) return new Set<number>();
    const cells = [];
    for (let y = selection.y0; y <= selection.y1; y++)
      for (let x = selection.x0; x <= selection.x1; x++) {
        if (!inSelection(selection, x, y) || x < 0 || y < 0 || x >= map.ds1.width || y >= map.ds1.height) continue;
        const i = y * map.ds1.width + x;
        for (const f of map.ds1.floors) cells.push({ kind: 'floor', cell: f[i] });
        for (const w of map.ds1.walls) cells.push({ kind: 'wall', cell: w[i] });
      }
    return tilesMatching(keysOfCells(cells));
  };

  const toggle = (i: number, shift: boolean, additive: boolean) => {
    if (busy) return;
    setPicked(prev => selectTileIndices(prev, i, selectionAnchor.current, dt1?.tiles.length ?? 0, { shift, toggle: additive }));
    if (!shift) selectionAnchor.current = i;
  };
  const discardAllowed = () => !busy && ((!edits.size && !settingsEdits.size && !working && isNeutral(adjust)) || window.confirm('Discard the unsaved pixel, colour and tile-setting changes?'));
  const close = () => { if (discardAllowed()) onClose(); };

  // Tile settings (.ini fields): the file's values with pending changes on top.
  const settingsOf = (i: number): TileSettings => ({ ...readTileSettings(rawBytes!, i), ...(settingsEdits.get(i) ?? {}) });
  const settingsTargets = [...(picked.size ? picked : zoomed !== null ? [zoomed] : [])].filter((i) => dt1?.tiles[i]).sort((a, b) => a - b);
  const changeSettings = (patch: Partial<TileSettings>, flagsFor?: (current: Uint8Array) => Uint8Array) =>
    setSettingsEdits((prev) => {
      const next = new Map(prev);
      for (const i of settingsTargets) {
        const cur = { ...readTileSettings(rawBytes!, i), ...(prev.get(i) ?? {}) };
        const merged: Partial<TileSettings> = { ...(prev.get(i) ?? {}), ...patch };
        if (flagsFor) merged.flags = flagsFor(cur.flags);
        // Drop fields that are back to the file's value.
        const file = readTileSettings(rawBytes!, i);
        for (const k of Object.keys(merged) as (keyof TileSettings)[]) if (JSON.stringify(merged[k]) === JSON.stringify(file[k])) delete merged[k];
        if (Object.keys(merged).length) next.set(i, merged);
        else next.delete(i);
      }
      return next;
    });
  const exportIni = async () => {
    if (!rawBytes || !dt1) return;
    const text = dt1ToIni(writeTileSettings(rawBytes, settingsEdits), dt1.tiles.map((t) => ({ width: t.width, height: t.height })));
    const where = await exportBytes(`${path.split('/').pop()!.replace(/\.dt1$/i, '')}.ini`, new TextEncoder().encode(text));
    if (where) setIniMessage(`Exported ${where}`);
  };
  const importIni = async () => {
    if (!rawBytes || !dt1) return;
    const bytes = await importBytes('ini');
    if (!bytes) return;
    const { blocks, count } = parseDt1Ini(new TextDecoder('latin1').decode(bytes));
    const next = new Map(settingsEdits);
    let applied = 0;
    for (const b of blocks) {
      if (b.block < 0 || b.block >= dt1.tiles.length) continue;
      const file = readTileSettings(rawBytes, b.block);
      const merged: Partial<TileSettings> = { ...(next.get(b.block) ?? {}), ...b.settings };
      for (const k of Object.keys(merged) as (keyof TileSettings)[]) if (JSON.stringify(merged[k]) === JSON.stringify(file[k])) delete merged[k];
      if (Object.keys(merged).length) {
        next.set(b.block, merged);
        applied++;
      } else next.delete(b.block);
    }
    setSettingsEdits(next);
    setSideTab('settings');
    setIniMessage(
      `Read ${blocks.length} blocks${count !== null && count !== dt1.tiles.length ? ` (the .ini has ${count}, this DT1 ${dt1.tiles.length}: matched by block number)` : ''}; ${applied} tile${applied === 1 ? '' : 's'} differ and are now pending. Pixels come from the DT1, not the .pcx.`,
    );
  };

  const dir = path.replace(/[^/]+$/, '');
  const newPath = `${dir}${name.replace(/\.dt1$/i, '')}.dt1`;
  const overwrite = normalizePath(newPath) === normalizePath(path);
  const exists = !overwrite && !!gd.fs.locate(newPath);
  const validName = /^[\w\- .]+$/.test(name);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = working ?? (await gd.fs.read(path));
      if (!bytes) throw new Error(`${path} not found`);
      const painted = edits.size ? setManyTilePixels(bytes, [...edits].map(([tileIndex, image]) => ({ tileIndex, image }))) : bytes;
      const recoloured = changes ? recolorDt1(painted, remap, [...picked]) : painted;
      const out = settingsEdits.size ? writeTileSettings(recoloured, settingsEdits) : recoloured;
      // Safeguard: the new DT1 must read back whole (same tiles, every picture drawable, untouched tiles unchanged)
      // before it is written, above all over the original.
      const touched = new Set([...edits.keys(), ...(changes ? picked : [])]);
      const renumbered = [...settingsEdits.values()].some((c) => c.orientation !== undefined || c.mainIndex !== undefined || c.subIndex !== undefined);
      const problem = editedDt1Problem(bytes, out, touched, renumbered);
      if (problem) throw new Error(`Not saved, nothing was written: ${problem}. Please report this.`);
      const usesSaved = inMapLib && (overwrite || switchMap);
      const moves = remapMap && usesSaved && pendingMoves.size ? settledMoves(pendingMoves, tileNumbers(out)) : undefined;
      await onSave({ path: newPath, bytes: out, switchMap: switchMap && !overwrite && inMapLib, original: path, moves });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- Clone, mirror, PNG (the tile list itself changes: pending pixel and setting edits are folded in first) ---
  const bake = async (): Promise<Uint8Array> => {
    const base = working ?? (await gd.fs.read(path));
    if (!base) throw new Error(`${path} not found`);
    const painted = edits.size ? setManyTilePixels(base, [...edits].map(([tileIndex, image]) => ({ tileIndex, image }))) : base;
    return settingsEdits.size ? writeTileSettings(painted, settingsEdits) : painted;
  };
  const useWorking = (next: Uint8Array, select: number[], note: string) => {
    setWorking(next);
    setRawBytes(next);
    setDt1(parseDt1(next));
    setEdits(new Map());
    setSettingsEdits(new Map());
    setPicked(new Set(select));
    setOpNote(note);
  };
  /** The picked tiles plus the other half of any north-corner wall among them (the halves go together). */
  const withPartners = (records: Dt1Record[]) => {
    const out = new Set(picked);
    for (const i of picked) {
      const info = recordInfo(records[i]);
      const other = cornerPartner(info.orientation);
      if (other === null) continue;
      records.forEach((r, j) => {
        const o = recordInfo(r);
        if (o.orientation === other && o.main === info.main && o.sub === info.sub) out.add(j);
      });
    }
    return [...out].sort((a, b) => a - b);
  };
  /** Tile numbers of the DT1s loaded with this one (the map's other libraries, its level types' DT1s). */
  const othersTaken = () => sharedTakenKeys(gd, path, map?.lib.loaded.map((l) => l.path) ?? []);
  const runOp = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((e) => setError((e as Error).message));
  };
  const cloneTiles = () =>
    runOp(async () => {
      const records = dt1Records(await bake());
      const targets = withPartners(records);
      const taken = cloneSame ? new Set<string>() : await othersTaken();
      const added: Dt1Record[] = [];
      const subFor = new Map<string, number>();
      for (const i of targets) {
        const info = recordInfo(records[i]);
        let sub = info.sub;
        if (!cloneSame) {
          // Corner halves share one new number.
          const k = `${Math.min(info.orientation, cornerPartner(info.orientation) ?? info.orientation)}|${info.main}|${info.sub}`;
          sub = subFor.get(k) ?? freeSub([...records, ...added], info.orientation, info.main, taken);
          if (sub < 0) throw new Error(`No free sub index left for main index ${info.main}.`);
          subFor.set(k, sub);
        }
        added.push(changedRecord(records[i], { sub }));
      }
      const next = buildDt1([...records, ...added]);
      useWorking(next, added.map((_, k) => records.length + k), `Cloned ${added.length} tile${added.length === 1 ? '' : 's'}${cloneSame ? ' under the same numbers (random variants of the originals)' : ' under new sub indices'}; the copies are selected. Save to keep them.`);
    });
  const mirrorTiles = () =>
    runOp(async () => {
      const records = dt1Records(await bake());
      const targets = withPartners(records);
      const next = records.map((r, i) => (targets.includes(i) ? mirrorRecord(r) : r));
      const turnedIdx = targets.filter((i) => recordInfo(next[i]).orientation !== recordInfo(records[i]).orientation);
      // A wall that now faces the other way has a new number: when a tile of this DT1 or of a DT1 loaded with it
      // already has that number, the game would draw that one instead, so it gets a free sub index.
      const taken = turnedIdx.length ? await othersTaken() : new Set<string>();
      const key = (r: Dt1Record) => {
        const i = recordInfo(r);
        return `${i.orientation}|${i.main}|${i.sub}`;
      };
      const subFor = new Map<string, number>();
      let renumbered = 0;
      for (const i of turnedIdx) {
        const info = recordInfo(next[i]);
        const k = `${Math.min(info.orientation, cornerPartner(info.orientation) ?? info.orientation)}|${info.main}|${info.sub}`;
        // The other half of a corner goes with it.
        const clash = subFor.has(k) || taken.has(key(next[i])) || next.some((r, j) => j !== i && key(r) === key(next[i]));
        if (!clash) continue;
        const sub = subFor.get(k) ?? freeSub(next.filter((_, j) => j !== i), info.orientation, info.main, taken);
        if (sub < 0) throw new Error(`No free sub index left for main index ${info.main}.`);
        subFor.set(k, sub);
        next[i] = changedRecord(next[i], { sub });
        renumbered++;
      }
      const turned = turnedIdx.length;
      useWorking(
        buildDt1(next),
        targets,
        `Mirrored ${targets.length} tile${targets.length === 1 ? '' : 's'}${turned ? `; ${turned} wall${turned === 1 ? '' : 's'} now face${turned === 1 ? 's' : ''} the other way (orientation changed: maps using the old number no longer find ${turned === 1 ? 'it' : 'them'})` : ''}${renumbered ? `; ${renumbered} of them got a new sub index because the mirrored number was already used here or in a DT1 loaded with this one` : ''}. Clone first to keep the originals. Save to keep it.`,
      );
    });
  const exportPng = async () => {
    const i = [...picked][0];
    const t = dt1?.tiles[i];
    const img = t ? (edits.get(i) ?? decodeTile(t)) : null;
    if (!t || !img) return setError('That tile has no picture.');
    const where = await exportBytes(`${path.split('/').pop()!.replace(/\.dt1$/i, '')}_${t.orientation}-${t.mainIndex}-${t.subIndex}.png`, writeIndexedPng(img.width, img.height, img.pixels, palette));
    if (where) setOpNote(`Exported ${where} (${img.width}×${img.height}, indexed with the palette shown; index 0 transparent). Edit it keeping the size and import it back.`);
  };
  const importPng = () =>
    runOp(async () => {
      const i = [...picked][0];
      const t = dt1?.tiles[i];
      const geo = t ? decodeTile(t) : null;
      if (!t || !geo) throw new Error('That tile has no picture to replace.');
      const bytes = await importBytes('png');
      if (!bytes) return;
      const png = readPng(bytes);
      if (png.width !== geo.width || png.height !== geo.height) throw new Error(`The picture is ${png.width}×${png.height}; this tile is ${geo.width}×${geo.height}. Keep the exported size (it places the tile).`);
      const { pixels, remapped } = toPaletteIndices(png, palette, pal.usable);
      const image = { ...geo, pixels };
      const colours = remapped ? `; ${remapped} pixel${remapped === 1 ? '' : 's'} took the nearest ${pal.usable ? 'Act 0 ' : ''}colour` : '';
      const rle = t.blocks.length > 0 && t.blocks.every((b) => b.format !== 1);
      if (rle) {
        // Walls: the blocks are rebuilt from the picture, so it may have any shape inside its area.
        const records = dt1Records(await bake());
        records[i] = rebuildRleRecord(records[i], image);
        useWorking(buildDt1(records), [i], `Imported the picture into tile ${t.orientation}/${t.mainIndex}/${t.subIndex}${colours}. Save to keep it.`);
      } else {
        // Floors and roofs keep their diamond: the picture is painted into it, and what lies outside is cut away now,
        // so the tile shows what saving keeps.
        const dropped = droppedPixelCount(t, image);
        setEdits((m) => new Map(m).set(i, cropToTile(t, image)));
        setOpNote(`Imported the picture into tile ${t.orientation}/${t.mainIndex}/${t.subIndex}${colours}${dropped ? `; ${dropped} pixels outside the tile's diamond were cut away (floor and roof tiles keep their diamond shape)` : ''}. Save to keep it.`);
      }
    });

  /** Cells of the open map drawn with tiles of these numbers from this DT1 (they lose their picture if deleted). */
  const usesInMap = (indices: number[]) => {
    if (!map || !dt1) return 0;
    const keys = new Set(indices.map((i) => dt1.tiles[i]).filter(Boolean).map((t) => `${t.orientation}|${t.mainIndex}|${t.subIndex}`));
    // A number this DT1 still has after the delete (another variant) keeps its cells drawn.
    dt1.tiles.forEach((t, i) => {
      if (!indices.includes(i)) keys.delete(`${t.orientation}|${t.mainIndex}|${t.subIndex}`);
    });
    if (!keys.size || !map.lib.loaded.some((l) => normalizePath(l.path) === normalizePath(path))) return 0;
    const { ds1 } = map;
    let n = 0;
    for (const layer of ds1.floors) for (const c of layer) if (!isEmptyCell(c) && keys.has(`0|${c.mainIndex}|${c.subIndex}`)) n++;
    for (const layer of ds1.walls) for (const c of layer) if (!isEmptyCell(c) && keys.has(`${(c as WallCell).orientation}|${c.mainIndex}|${c.subIndex}`)) n++;
    for (const layer of ds1.shadows) for (const c of layer) if (!isEmptyCell(c) && keys.has(`13|${c.mainIndex}|${c.subIndex}`)) n++;
    return n;
  };
  const deleteTiles = () =>
    runOp(async () => {
      setDeleting(false);
      const records = dt1Records(await bake());
      const gone = new Set(withPartners(records));
      if (gone.size >= records.length) throw new Error('A DT1 needs at least one tile: delete the file instead, or keep one.');
      useWorking(buildDt1(records.filter((_, i) => !gone.has(i))), [], `Deleted ${gone.size} tile${gone.size === 1 ? '' : 's'}${gone.size > picked.size ? ' (with the other half of their corner walls)' : ''}. Save to keep it; closing without saving brings ${gone.size === 1 ? 'it' : 'them'} back.`);
    });
  /** Orders the tiles by orientation, main and sub index (tiles sharing a number keep their order: it matters in game). */
  const sortTiles = () =>
    runOp(async () => {
      const records = dt1Records(await bake());
      const order = records.map((r, i) => ({ r, i, k: recordInfo(r) })).sort((a, b) => a.k.orientation - b.k.orientation || a.k.main - b.k.main || a.k.sub - b.k.sub || a.i - b.i);
      if (order.every((o, n) => o.i === n)) return setOpNote('The tiles are already in order (orientation, main, sub index).');
      const where = new Map(order.map((o, n) => [o.i, n]));
      useWorking(buildDt1(order.map((o) => o.r)), [...picked].map((i) => where.get(i)!).filter((i) => i !== undefined), 'Sorted the tiles by orientation, then main and sub index (tiles sharing a number keep their order). Maps find tiles by number, so nothing changes in them. Save to keep it.');
    });

  /** Opens the Reassign index menu for the selected tiles (and the other half of corners among them). */
  const openReassign = () =>
    runOp(async () => {
      const bytes = await bake();
      setReassign({ bytes, numbers: tileNumbers(bytes), indices: withPartners(dt1Records(bytes)) });
      setLoadedWith(null);
      void loadedWithOwners(gd, path, map?.lib.loaded.map((l) => l.path) ?? []).then(setLoadedWith);
      if (!library) {
        setLibraryProgress('Checking the game library…');
        void libraryOwners(gd, (done, total) => (done % 40 === 0 || done === total) && setLibraryProgress(done === total ? null : `Checking the game library… ${done}/${total}`)).then((l) => {
          setLibrary(l);
          setLibraryProgress(null);
        });
      }
    });
  const applyReassign = (changes: Map<number, TileNumber>) => {
    if (!reassign) return;
    const next = renumberDt1(reassign.bytes, changes);
    const { moves } = movedNumbers(reassign.numbers, tileNumbers(next));
    setPendingMoves((m) => composeMoves(m, moves));
    setReassign(null);
    const cells = inMapLib && map && remapMap ? cellMoves(map.ds1, settledMoves(composeMoves(pendingMoves, moves), tileNumbers(next))).length : 0;
    useWorking(
      next,
      reassign.indices,
      `Gave ${changes.size} tile${changes.size === 1 ? '' : 's'} new numbers${cells ? `; ${cells} placed cell${cells === 1 ? '' : 's'} of the map will follow when you save` : ''}. Save to keep it.`,
    );
  };

  // Delete: asks to delete the selected tiles (clicking a tile leaves the focus outside the dialog, so on the window).
  const canDelete = useRef(false);
  canDelete.current = picked.size > 0 && painting === null && !busy;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== 'Delete' || !canDelete.current || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
      e.preventDefault();
      setDeleting(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = <K extends keyof Adjust>(k: K, v: Adjust[K]) => setAdjust((a) => ({ ...a, [k]: v }));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="modal dt1-editor"
        role="dialog"
        aria-label="DT1 editor"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">DT1 editor{map ? '' : ' · no map open'}</div>
        {busy && <div className="modal-busy-shield" role="status">Saving tile changes…</div>}
        <div className="dte-top">
          <span className="mono small dte-current">{short(path)}</span>
          <label className="small" title="DT1s store palette indices: this palette is used to show, recolour and paint them">
            Palette{' '}
            <select value={palAct} onChange={(e) => setPalAct(Number(e.target.value))}>
              <option value={-1}>Act 0 — every act (default)</option>
              {[0, 1, 2, 3, 4].map((a) => (
                <option key={a} value={a}>
                  Act {a + 1} only
                </option>
              ))}
            </select>
            {pal.usable && (
              <label className="small" title="Pixels whose colour changes between acts turn magenta">
                <input type="checkbox" checked={highlightUnsafe} onChange={(e) => setHighlightUnsafe(e.target.checked)} /> highlight colours that change between acts
              </label>
            )}
            <HelpTip
              text={`Act 0 holds only the ${pal.usable ? pal.usable.filter(Boolean).length : 225} colours that look the same in every act (Gimli's act0 palette${pal.source === 'derived' ? ', worked out from your game palettes because it couldn’t be downloaded' : ''}), so tiles edited with it can be used in any act. Tick “highlight” to see which pixels use colours that change between acts (magenta); “Make act-safe” converts them. The pixel painter only offers Act 0 colours.`}
            />
          </label>
          <span className="muted small">{!path ? 'no DT1 picked' : dt1 ? `${dt1.tiles.length} tiles · ${picked.size ? `${picked.size} selected` : 'no tiles selected'}` : 'loading…'}</span>
          <button className="btn small" onClick={() => setPicked(new Set(dt1?.tiles.map((_, i) => i)))}>
            Select all
          </button>
          <button className="btn small" onClick={() => setPicked(new Set())}>
            Clear
          </button>
          <button className="btn small" disabled={picked.size !== 1} onClick={() => setPainting([...picked][0])} title="Paint the selected tile pixel by pixel (or double-click a tile)">
            Paint pixels…
          </button>
          <button className="btn small" disabled={!picked.size || busy} onClick={cloneTiles} title="Copy the selected tiles into this DT1 under a new, unused sub index (or the same number, as random variants: see the tick box). The originals stay.">
            Clone
          </button>
          <label className="small" title="Give the copies the same number as the originals: the game then picks between them at random (by rarity), for variation.">
            <input type="checkbox" checked={cloneSame} onChange={(e) => setCloneSame(e.target.checked)} /> same number
          </label>
          <button className="btn small" disabled={!picked.size || busy} onClick={mirrorTiles} title="Flip the selected tiles left to right: pixels, walkability flags, and walls turn to face the other way (left ↔ right). Clone first to keep the originals.">
            Mirror
          </button>
          <button className="btn small" disabled={picked.size !== 1} onClick={() => void exportPng()} title="Save the selected tile as an indexed PNG (the palette shown here) to edit in GIMP or similar">
            Export PNG…
          </button>
          <button className="btn small" disabled={picked.size !== 1 || busy} onClick={importPng} title="Replace the selected tile's picture with a PNG of the same size (an exported one, edited). Colours are matched to the palette.">
            Import PNG…
          </button>
          <button className="btn small danger" disabled={!picked.size || busy} onClick={() => setDeleting(true)} title="Remove the selected tiles from this DT1 (Delete). Asks first.">
            Delete…
          </button>
          <button className="btn small" disabled={!picked.size || busy || reassign !== null} onClick={openReassign} title="Give the selected tiles new numbers (main index, sub index, kind), checked against the DT1s loaded with this one; the map's placed tiles can follow">
            Reassign index…
          </button>
          <button className="btn small" disabled={!dt1 || busy} onClick={sortTiles} title="Put the tiles in order: by orientation, then main index, then sub index">
            Sort by number
          </button>
          {edits.size > 0 && (
            <span className="small accent-text">
              {edits.size} tile{edits.size === 1 ? '' : 's'} painted{' '}
              <button className="link" onClick={() => setEdits(new Map())}>
                discard
              </button>
            </span>
          )}
          {map && (
            <button className="btn small" disabled={!selection} onClick={() => setPicked(selectionTiles())} title="Select the tiles of this DT1 used in the map selection">
              From map selection
            </button>
          )}
          <select
            className="small"
            value=""
            onChange={(e) => {
              const p = presetTiles.find((x) => x.preset.id === e.target.value);
              if (p) setPicked(new Set(p.tiles));
            }}
            title="Select the tiles a preset is built from"
          >
            <option value="">From preset… ({presetTiles.length})</option>
            {presetTiles.map((x) => (
              <option key={x.preset.id} value={x.preset.id}>
                {x.preset.name} ({x.tiles.size} tiles)
              </option>
            ))}
          </select>
        </div>
        {deleting && picked.size > 0 && painting === null && (
          <div className="dte-confirm" role="alert">
            <b>
              Delete {picked.size} tile{picked.size === 1 ? '' : 's'} from {short(path).split('/').pop()}?
            </b>{' '}
            {(() => {
              const n = usesInMap([...picked]);
              return n ? <span className="warn-text">{n} cell{n === 1 ? '' : 's'} of the open map use{n === 1 ? 's' : ''} {picked.size === 1 ? 'it' : 'them'}: they will show as missing.</span> : null;
            })()}{' '}
            <span className="muted">Nothing is written until you save.</span>
            <button className="btn small" onClick={() => setDeleting(false)}>
              Keep
            </button>
            <button className="btn small danger" autoFocus onClick={deleteTiles}>
              Delete
            </button>
          </div>
        )}
        {(opNote || error) && painting === null && (
          <p className={`small dte-note${error ? ' error-text' : ''}`}>
            {error ?? opNote}
          </p>
        )}
        {painting !== null && dt1 && (
          <PixelPainter
            key={painting}
            tile={dt1.tiles[painting]}
            tileIndex={painting}
            image={edits.get(painting) ?? decodeTile(dt1.tiles[painting])!}
            palette={palette}
            usable={pal.usable}
            onDone={(img) => {
              if (img) setEdits((m) => new Map(m).set(painting, img));
              setPainting(null);
            }}
          />
        )}
        {reassign && dt1 && painting === null && (
          <ReassignPanel
            path={path}
            tiles={dt1.tiles}
            numbers={reassign.numbers}
            indices={reassign.indices}
            rarityOf={(i) => {
              const s = readTileSettings(reassign.bytes, i);
              return { rarity: s.frame, animated: s.animated };
            }}
            palette={palette}
            loadedWith={loadedWith}
            library={library}
            libraryProgress={libraryProgress}
            mapCells={inMapLib && map ? (moves) => cellMoves(map.ds1, moves).length : null}
            pendingMoves={pendingMoves}
            remapMap={remapMap}
            setRemapMap={setRemapMap}
            onApply={applyReassign}
            onCancel={() => setReassign(null)}
          />
        )}
        <div className="dte-body" hidden={painting !== null || reassign !== null}>
          <Dt1Tree all={allDt1s} inMap={libs} selected={path} onSelect={p => { if (p !== path && discardAllowed()) setPath(p); }} />
          <div
            className="thumb-grid dte-grid"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 14}px, 1fr))`, ['--thumb-h' as string]: `${size}px` }}
            onWheel={(e) => e.ctrlKey && setSize((v) => Math.round(Math.min(200, Math.max(36, v * Math.exp(-e.deltaY * 0.0015)))))}
            title="Click: one tile · Ctrl+click: toggle · Shift+click: range · Ctrl + scroll to zoom"
          >
            {!path && <p className="muted small">Pick a DT1 on the left (every tile library in the game and your mod).</p>}
            {dt1?.tiles.map((t, i) => {
              const affected = changes && (picked.has(i));
              const edited = edits.get(i);
              return (
                <div
                  key={i}
                  className={`thumb${picked.has(i) ? ' active' : ''}${edited ? ' edited' : ''}`}
                  title={`#${i} · ${ORIENTATION_NAMES[t.orientation] ?? `o${t.orientation}`} · ${t.mainIndex}/${t.subIndex}${edited ? ' · painted' : ''} · double-click to paint`}
                  onClick={(e) => {
                    toggle(i, e.shiftKey, e.ctrlKey || e.metaKey);
                    setZoomed(i);
                  }}
                  onDoubleClick={() => !busy && t.blocks.length && setPainting(i)}
                >
                  {edited ? <ImageThumb image={edited} palette={affected ? previewPal : palette} /> : <Thumb tile={t} palette={affected ? previewPal : palette} />}
                  <span className="thumb-label">
                    {t.mainIndex}/{t.subIndex}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="dte-side">
            <div className="chips dte-tabs">
              <button className={`chip${sideTab === 'colours' ? ' active' : ''}`} onClick={() => setSideTab('colours')}>
                Colours
              </button>
              <button className={`chip${sideTab === 'settings' ? ' active' : ''}`} onClick={() => setSideTab('settings')} title="Everything a DT1 Tools .ini holds for each tile, including the walkability sub-tiles">
                Tile settings (ini){settingsEdits.size ? ` · ${settingsEdits.size}` : ''}
              </button>
            </div>
            {sideTab === 'settings' && (
              <>
                <div className="dte-ini-bar">
                  <button className="btn small" onClick={() => void exportIni()} disabled={!rawBytes} title="Save this DT1's settings as a DT1 Tools .ini">
                    Export .ini
                  </button>
                  <button className="btn small" onClick={() => void importIni()} disabled={!rawBytes} title="Take the settings of a DT1 Tools .ini (block numbers match tiles here)">
                    Import .ini…
                  </button>
                </div>
                {iniMessage && <p className="small muted">{iniMessage}</p>}
                {rawBytes && dt1 && (
                  <TileSettingsPanel
                    tiles={settingsTargets.map((i) => ({ index: i, tile: dt1.tiles[i], image: edits.get(i) ?? decodeTile(dt1.tiles[i]) }))}
                    palette={palette}
                    settingsOf={settingsOf}
                    changed={(i) => settingsEdits.has(i)}
                    onChange={changeSettings}
                    onRevert={() =>
                      setSettingsEdits((prev) => {
                        const next = new Map(prev);
                        for (const i of settingsTargets) next.delete(i);
                        return next;
                      })
                    }
                  />
                )}
              </>
            )}
            <div className="dte-colours" hidden={sideTab !== 'colours'}>
            <div className="field-label">Colour</div>
            <label className="dte-slider">
              Hue <input type="range" min={-180} max={180} value={adjust.hue} onChange={(e) => set('hue', Number(e.target.value))} /> <span>{adjust.hue}°</span>
            </label>
            <label className="dte-slider">
              Saturation <input type="range" min={0} max={200} value={Math.round(adjust.saturation * 100)} onChange={(e) => set('saturation', Number(e.target.value) / 100)} />{' '}
              <span>{Math.round(adjust.saturation * 100)}%</span>
            </label>
            <label className="dte-slider">
              Brightness <input type="range" min={20} max={200} value={Math.round(adjust.brightness * 100)} onChange={(e) => set('brightness', Number(e.target.value) / 100)} />{' '}
              <span>{Math.round(adjust.brightness * 100)}%</span>
            </label>
            <label className="dte-slider">
              Tint <input type="color" value={adjust.tint} onChange={(e) => set('tint', e.target.value)} />
              <input type="range" min={0} max={100} value={Math.round(adjust.tintAmount * 100)} onChange={(e) => set('tintAmount', Number(e.target.value) / 100)} />{' '}
              <span>{Math.round(adjust.tintAmount * 100)}%</span>
            </label>
            <label className="small">
              <input type="checkbox" checked={adjust.swapOn} onChange={(e) => set('swapOn', e.target.checked)} /> Replace a colour
            </label>
            {adjust.swapOn && (
              <label className="dte-slider">
                <input type="color" value={adjust.swapFrom} onChange={(e) => set('swapFrom', e.target.value)} /> →{' '}
                <input type="color" value={adjust.swapTo} onChange={(e) => set('swapTo', e.target.value)} /> range
                <input type="range" min={5} max={160} value={adjust.swapTolerance} onChange={(e) => set('swapTolerance', Number(e.target.value))} />
              </label>
            )}
            {pal.usable && (
              <button
                className={`btn small${adjust.toAct0 ? ' active' : ''}`}
                onClick={() => setAdjust((a) => ({ ...a, toAct0: !a.toAct0 }))}
                title="Convert colours that change between acts (shown magenta) to the nearest Act 0 colour, for the selected tiles (or the whole DT1)"
              >
                {adjust.toAct0 ? '✓ Make act-safe' : 'Make act-safe'}
              </button>
            )}
            <button className="btn small" onClick={() => setAdjust(NO_ADJUST)} disabled={isNeutral(adjust)}>
              Reset colours
            </button>
            <p className="muted small">
              DT1s store colours as palette indices, so every colour is snapped to the nearest one in the act palette; the preview shows exactly what will be
              written. Tile shapes, walkability flags and indices stay the same.
            </p>
            </div>
            <div className="field-label">Save as</div>
            <div className="dte-name">
              <span className="muted small mono">{short(dir)}</span>
              <input className="small-input" value={name} onChange={(e) => setName(e.target.value)} />
              <span className="muted small">.dt1</span>
            </div>
            {overwrite && <p className="small warn-text">Overwrites the original (kept as .bak).</p>}
            {exists && <p className="small warn-text">A DT1 with that name already exists and will be replaced.</p>}
            {pendingMoves.size > 0 && remapMap && inMapLib && !overwrite && !switchMap && (
              <p className="small warn-text">The map&apos;s placed tiles only move to the new numbers when it uses the saved DT1: overwrite it, or tick “Use it in this map”.</p>
            )}
            {!overwrite && inMapLib && map && (
              <label className="small">
                <input type="checkbox" checked={switchMap} onChange={(e) => setSwitchMap(e.target.checked)} /> Use it in this map instead of {short(path).split('/').pop()}
              </label>
            )}
            <p className="muted small">
              A copy keeps the same tile indices, so the map&apos;s tiles use it as soon as it replaces the original. Loading both at once makes the game pick
              between them at random.
            </p>
            {error && <p className="small error-text">{error}</p>}
          </div>
        </div>
        {zoomed !== null && painting === null && sideTab === 'colours' && dt1?.tiles[zoomed] && (
          <FloatingWindow
            title={
              <>
                Tile #{zoomed} · {dt1.tiles[zoomed].mainIndex}/{dt1.tiles[zoomed].subIndex}
                {edits.has(zoomed) ? ' · painted' : ''}
                {changes && (picked.has(zoomed)) ? ' · recolour preview' : ''}
              </>
            }
            storageKey="dt1-zoom"
            initial={{ x: Math.max(16, window.innerWidth - 520), y: 90, w: 480, h: 520 }}
            onClose={() => setZoomed(null)}
          >
            <TileZoom
              shadow={dt1.tiles[zoomed].orientation === Orientation.Shadow}
              image={edits.get(zoomed) ?? decodeTile(dt1.tiles[zoomed]) ?? { width: 1, height: 1, offsetX: 0, offsetY: 0, pixels: new Uint8Array(1) }}
              palette={changes && (picked.has(zoomed)) ? previewPal : palette}
            />
          </FloatingWindow>
        )}
        <div className="modal-actions" hidden={painting !== null || reassign !== null}>
          {error && (
            <span className="small error-text dte-save-error" role="alert">
              {error}
            </span>
          )}
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={!canSave || !dt1 || busy || !validName || (changes && !picked.size)} onClick={() => void save()} title={canSave ? '' : 'No writable mod folder'}>
            {busy ? 'Saving…' : overwrite ? 'Save (overwrite)' : changes || edits.size || settingsEdits.size ? 'Save edited copy' : 'Save copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
