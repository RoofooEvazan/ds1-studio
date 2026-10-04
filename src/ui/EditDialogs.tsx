import { useEffect, useMemo, useState } from 'react';
import { parseDt1, type Dt1 } from '../formats/dt1';
import { sharedTiles, tileKeys } from '../game/duplicateDt1s';
import { missingTablesWarning, tableCoverage } from '../game/mapPackage';
import type { Palette } from '../formats/palette';
import type { CellRect } from '../game/clipboard';
import { OVERLAY_NAMES, type OverlayKind } from '../game/mapOverlays';
import { findTile, keyText, replaceEdits, type TileKey } from '../game/editTools';
import type { TileLibrary } from '../game/GameData';
import { layerLabel, type CellEdit, type LayerRef, type MapDocument } from '../game/MapDocument';
import { exportSize, MAX_PIXELS, MAX_SIDE } from '../render/exportImage';
import { Modal } from './Dialogs';
import { HelpTip } from './HelpTip';
import { Thumb } from './TilePalette';
import { importedDt1Path, matchDt1s, type NeededDt1 } from '../game/importMatch';
import { allLevels, allWarps, levelLinks, levelRef, linkWrite, type WarpTables } from '../game/warps';
import type { TableWrite } from '../game/levelTables';

// ---------------------------------------------------------------------------------------------------------------
// Find & replace

function TileField({ label, value, onChange, lib, palette, wall, onUseBrush }: { label: string; value: TileKey; onChange: (k: TileKey) => void; lib: TileLibrary; palette: Palette; wall: boolean; onUseBrush?: () => void }) {
  const tile = lib.pick(value.orientation, value.main, value.sub, 0);
  const num = (field: keyof TileKey, max: number) => (
    <input
      className="num-field mono"
      type="number"
      min={0}
      max={max}
      value={value[field]}
      onChange={(e) => onChange({ ...value, [field]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
  return (
    <div className="rp-tile">
      <div className="field-label">{label}</div>
      <div className="rp-tile-row">
        <div className="rp-thumb">{tile ? <Thumb tile={tile} palette={palette} /> : <span className="muted small">not in this map&apos;s DT1s</span>}</div>
        <div className="rp-nums">
          <label>
            main {num('main', 63)}
          </label>
          <label>
            sub {num('sub', 255)}
          </label>
          {wall && (
            <label title="Wall orientation (1-9 walls, 10/11 special, 12 pillar, 14 tree, 15 roof, 16-19 lower walls)">
              orient. {num('orientation', 19)}
            </label>
          )}
          {onUseBrush && (
            <button className="btn small" onClick={onUseBrush}>
              Use brush
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ReplaceProps {
  doc: MapDocument;
  lib: TileLibrary;
  palette: Palette;
  activeLayer: LayerRef;
  selection: CellRect | null;
  from: TileKey | null;
  brush: TileKey | null;
  onApply: (edits: CellEdit[], label: string) => void;
  onShow: (cells: { x: number; y: number }[]) => void;
  onClose: () => void;
}

export function ReplaceDialog({ doc, lib, palette, activeLayer, selection, from: initialFrom, brush, onApply, onShow, onClose }: ReplaceProps) {
  const orient = activeLayer.kind === 'floor' ? 0 : activeLayer.kind === 'shadow' ? 13 : 1;
  const [from, setFrom] = useState<TileKey>(initialFrom ?? { orientation: orient, main: 0, sub: 0 });
  const [to, setTo] = useState<TileKey>(brush ?? { orientation: orient, main: 0, sub: 1 });
  const [layers, setLayers] = useState<'active' | 'kind'>('kind');
  const [area, setArea] = useState<'map' | 'selection'>(selection ? 'selection' : 'map');
  const targets = layers === 'active' ? [activeLayer] : doc.layers().filter((l) => l.kind === activeLayer.kind);
  const within = area === 'selection' ? selection : null;
  const found = useMemo(() => findTile(doc, targets, from, within), [doc, doc.revision, from, layers, area, activeLayer]); // eslint-disable-line react-hooks/exhaustive-deps
  const wall = activeLayer.kind === 'wall';
  const kindName = activeLayer.kind === 'floor' ? 'floor' : activeLayer.kind === 'wall' ? 'wall' : 'shadow';
  return (
    <Modal title="Find & replace tiles" onClose={onClose}>
      <p className="muted small">
        Swaps every use of one tile for another. It works on {kindName} layers (switch the active layer for another kind) and is one step to undo.
      </p>
      <div className="rp-pair">
        <TileField label="Find" value={from} onChange={setFrom} lib={lib} palette={palette} wall={wall} onUseBrush={brush ? () => setFrom(brush) : undefined} />
        <div className="rp-arrow">→</div>
        <TileField label="Replace with" value={to} onChange={setTo} lib={lib} palette={palette} wall={wall} onUseBrush={brush ? () => setTo(brush) : undefined} />
      </div>
      <div className="rp-options">
        <label>
          <input type="radio" checked={layers === 'kind'} onChange={() => setLayers('kind')} /> every {kindName} layer
        </label>
        <label>
          <input type="radio" checked={layers === 'active'} onChange={() => setLayers('active')} /> only {layerLabel(activeLayer)}
        </label>
        <span className="rp-sep" />
        <label>
          <input type="radio" checked={area === 'map'} onChange={() => setArea('map')} /> whole map
        </label>
        <label className={selection ? '' : 'muted'}>
          <input type="radio" disabled={!selection} checked={area === 'selection'} onChange={() => setArea('selection')} /> selection only
        </label>
      </div>
      <p className="small">
        <b>{found.length}</b> cell{found.length === 1 ? '' : 's'} use {keyText(from)}.{' '}
        {found.length > 0 && (
          <button className="link" onClick={() => onShow(found.map(({ x, y }) => ({ x, y })))}>
            Show them on the map
          </button>
        )}
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button
          className="btn primary"
          disabled={!found.length || keyText(from) + from.orientation === keyText(to) + to.orientation}
          onClick={() => onApply(replaceEdits(doc, targets, from, to, within), `Replace ${keyText(from)} → ${keyText(to)}`)}
        >
          Replace {found.length || ''}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Export image

interface ExportImageProps {
  width: number;
  height: number;
  selection: CellRect | null;
  busy: boolean;
  /** The overview shown on the map now: the image gets it too unless another is picked. */
  overview: OverlayKind | null;
  onExport: (o: { area: CellRect | null; scale: number; objects: boolean; overview: OverlayKind | null }) => void;
  onClose: () => void;
}

const SCALES = [1, 0.5, 0.25, 0.125];

export function ExportImageDialog({ width, height, selection, busy, overview: shown, onExport, onClose }: ExportImageProps) {
  const [area, setArea] = useState<'map' | 'selection'>(selection ? 'selection' : 'map');
  const rect = area === 'selection' && selection ? selection : { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const fits = (s: number) => {
    const [w, h] = exportSize(rect, s);
    return w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_PIXELS;
  };
  const [scale, setScale] = useState(() => SCALES.find(fits) ?? 0.125);
  const [objects, setObjects] = useState(true);
  const [overview, setOverview] = useState<OverlayKind | null>(shown);
  const chosen = fits(scale) ? scale : (SCALES.find(fits) ?? 0.125);
  const [w, h] = exportSize(rect, chosen);
  return (
    <Modal title="Export image" onClose={onClose}>
      <p className="muted small">
        Saves the map as a PNG, drawn with the layers currently shown. <HelpTip text="Tiles and object sprites are drawn solid and shadows as translucent black; glows and fog are left out. Special-tile markers and overlays (grid, walkability…) aren't included; a colour overview below is, with its legend." />
      </p>
      <div className="rp-options">
        <label>
          <input type="radio" checked={area === 'map'} onChange={() => setArea('map')} /> whole map
        </label>
        <label className={selection ? '' : 'muted'}>
          <input type="radio" disabled={!selection} checked={area === 'selection'} onChange={() => setArea('selection')} /> selection only
        </label>
      </div>
      <div className="rp-options">
        <span className="muted small">Size</span>
        {SCALES.map((s) => (
          <label key={s} className={fits(s) ? '' : 'muted'} title={fits(s) ? '' : 'Too large for one image: pick a smaller size or the selection'}>
            <input type="radio" disabled={!fits(s)} checked={chosen === s} onChange={() => setScale(s)} /> {s * 100}%
          </label>
        ))}
      </div>
      <label className="small">
        <input type="checkbox" checked={objects} onChange={(e) => setObjects(e.target.checked)} /> include objects and NPCs
      </label>
      <div className="rp-options">
        <span className="muted small">Colour</span>
        {([null, 'walkable', 'spawn'] as const).map((k) => (
          <label key={k ?? 'none'} title={k === 'walkable' ? 'Where players can walk, sub-tile by sub-tile' : k === 'spawn' ? 'Where random monsters can spawn, and why not elsewhere' : 'Just the map'}>
            <input type="radio" checked={overview === k} onChange={() => setOverview(k)} /> {k ? OVERLAY_NAMES[k].toLowerCase() : 'nothing'}
          </label>
        ))}
      </div>
      <p className="small">
        {w.toLocaleString()} × {h.toLocaleString()} pixels
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={() => onExport({ area: area === 'selection' ? selection : null, scale: chosen, objects, overview })}>
          {busy ? 'Drawing…' : 'Export PNG…'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Warp links

interface WarpProps {
  tables: WarpTables;
  levelId: number;
  vis: number;
  busy: boolean;
  /** Level to preselect for a new link (an exit usually leads to the act's town); the way back is then off. */
  initialTarget?: number;
  onApply: (write: TableWrite) => void;
  onClose: () => void;
}

/** Sets where link `vis` of a level leads (Levels.txt VisN / WarpN), optionally with the way back. */
export function WarpLinkDialog({ tables, levelId, vis, busy, initialTarget, onApply, onClose }: WarpProps) {
  const current = useMemo(() => levelLinks(tables, levelId), [tables, levelId]);
  const link = current?.links[vis] ?? null;
  const levels = useMemo(() => allLevels(tables), [tables]);
  const warps = useMemo(() => allWarps(tables), [tables]);
  const [target, setTarget] = useState(link?.target.id ?? initialTarget ?? 0);
  const [warp, setWarp] = useState(link?.warp?.id ?? warps[0]?.id ?? 0);
  const [query, setQuery] = useState('');
  const [back, setBack] = useState(!link && !initialTarget);
  const [backWarp, setBackWarp] = useState(link?.warp?.id ?? warps[0]?.id ?? 0);
  const q = query.trim().toLowerCase();
  const shown = levels.filter((l) => !q || l.name.toLowerCase().includes(q) || String(l.id) === q);
  const plan = target ? linkWrite(tables, { levelId, vis, targetId: target, warpId: warp, back: back ? { warpId: backWarp } : null }) : null;
  const name = current?.level.name ?? `level ${levelId}`;
  return (
    <Modal title={`Warp link ${vis} of ${name}`} onClose={onClose}>
      <p className="muted small">
        Warp tiles with main index {vis} in this level&apos;s maps use this link. Choose the level it leads to and the kind of warp (LvlWarp.txt decides the
        look and where the player appears). Saved into Levels.txt in your mod.
      </p>
      <label className="form-row">
        <span>Leads to</span>
        <div className="wl-pick">
          <input className="search small-input" placeholder="Search levels…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <select size={8} value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {shown.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id} · {l.name}
              </option>
            ))}
          </select>
        </div>
      </label>
      {target > 0 && <p className="small">Its maps: {levelRef(tables, target).maps.map((p) => p.split('/').pop()).join(', ') || 'none (built at random)'}</p>}
      <label className="form-row">
        <span>Kind of warp</span>
        <select value={warp} onChange={(e) => setWarp(Number(e.target.value))}>
          {warps.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id} · {w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        <input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} /> also add the way back (the target level gets a link to {name})
      </label>
      {back && (
        <label className="form-row">
          <span>Way back</span>
          <select value={backWarp} onChange={(e) => setBackWarp(Number(e.target.value))}>
            {warps.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} · {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="change-list">
        {typeof plan === 'string' ? <p className="error-text small">{plan}</p> : plan ? plan.write.summary.map((s) => <div key={s} className="small">• {s}</div>) : <p className="muted small">Pick a level.</p>}
      </div>
      <p className="muted small">If your mod ships compiled .bin tables, rebuild them after applying (start the game once with -direct -txt).</p>
      <div className="modal-actions">
        {link && (
          <button className="btn" disabled={busy} onClick={() => {
            const r = linkWrite(tables, { levelId, vis, targetId: 0, warpId: -1 });
            if (typeof r !== 'string') onApply(r.write);
          }}>
            Remove link
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !plan || typeof plan === 'string'} onClick={() => plan && typeof plan !== 'string' && onApply(plan.write)}>
          {busy ? 'Saving…' : 'Apply'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Import DT1 / DS1

/** Letters, digits, - and _ only: plain names are safe in the game's tables and file lookups on every system. */
export const safeName = (s: string) => /^[A-Za-z0-9_-]{1,48}$/.test(s.trim());
const baseName = (file: string) => file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'imported';

export interface ImportDt1File {
  name: string;
  /** Subfolder path inside the picked folder ('' for a picked file). */
  folder: string;
  bytes: Uint8Array;
  /** Parsed summary, or why the file can't be used. */
  info: { tiles: number; kinds: string } | string;
}

export interface ImportDt1Choice {
  files: { path: string; bytes: Uint8Array }[];
  addToMap: boolean;
}

/** A path segment made safe for the game's tables (letters, digits, - and _). */
const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'x';

/**
 * Import DT1s (picked files, or whole folders with their subfolders) into data/global/tiles/PD2assets/<folder>/…,
 * optionally adding them to the open map's level type.
 */
export function ImportDt1Dialog({ files, exists, usedBy, mapOpen, freeSlots, busy, onImport, onClose }: {
  files: ImportDt1File[];
  exists: (path: string) => boolean;
  /** Level types (by name) that load a path now: replacing it changes their levels too. */
  usedBy?: (path: string) => string[];
  mapOpen: string | null;
  /** Free File slots in the open map's level type (LvlTypes.txt), when known. */
  freeSlots: number | null;
  busy: boolean;
  onImport: (c: ImportDt1Choice) => void;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState(() => {
    try {
      return localStorage.getItem('ds1studio.importFolder') || 'custom';
    } catch {
      return 'custom';
    }
  });
  const hasFolders = files.some((f) => f.folder);
  const [keepFolders, setKeepFolders] = useState(true);
  const valid = files.map((_, i) => i).filter((i) => typeof files[i].info !== 'string');
  const [chosen, setChosen] = useState(() => new Set(valid));
  const [addToMap, setAddToMap] = useState(!!mapOpen);
  const okFolder = safeName(folder);
  // Target path of every file; clashes (same name after cleaning up) get a number.
  const targets = useMemo(() => {
    const used = new Set<string>();
    return files.map((f) => {
      const sub = keepFolders && f.folder ? `${f.folder.split('/').map(safeSegment).join('/')}/` : '';
      const base = safeSegment(f.name.replace(/\.dt1$/i, ''));
      let path = `data/global/tiles/PD2assets/${folder.trim()}/${sub}${base}.dt1`;
      for (let n = 2; used.has(path.toLowerCase()); n++) path = `data/global/tiles/PD2assets/${folder.trim()}/${sub}${base}_${n}.dt1`;
      used.add(path.toLowerCase());
      return path;
    });
  }, [files, folder, keepFolders]);
  const picked = files.map((_, i) => i).filter((i) => chosen.has(i));
  // Picked files that would replace a library other levels load: named, so it isn't done by accident.
  const replacing = picked.filter((i) => exists(targets[i]) && (usedBy?.(targets[i]).length ?? 0) > 0);
  const tooMany = addToMap && !!mapOpen && freeSlots !== null && picked.length > freeSlots;
  const toggle = (i: number) =>
    setChosen((c) => {
      const n = new Set(c);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <Modal title={files.length === 1 ? 'Import DT1' : `Import ${files.length} DT1s`} onClose={onClose} wide>
      <label className="form-row">
        <span>
          Into PD2assets / <HelpTip text="A subfolder of data/global/tiles/PD2assets/ in your mod, to keep your imported tile libraries together (created if needed)." />
        </span>
        <input className="text-input" value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      {!okFolder && <p className="error-text small">Use letters, digits, - and _ only (no spaces): plain names are safe in the game&apos;s tables.</p>}
      {hasFolders && (
        <label className="small">
          <input type="checkbox" checked={keepFolders} onChange={(e) => setKeepFolders(e.target.checked)} /> keep the folder structure (each picked folder and its subfolders)
        </label>
      )}
      <div className="imp-list">
        <div className="imp-head small muted">
          <label>
            <input type="checkbox" checked={valid.length > 0 && valid.every((i) => chosen.has(i))} onChange={(e) => setChosen(new Set(e.target.checked ? valid : []))} /> {picked.length} of {files.length} selected
          </label>
        </div>
        {files.map((f, i) => {
          const bad = typeof f.info === 'string';
          return (
            <label key={i} className={`imp-row${bad ? ' bad' : ''}`} title={bad ? String(f.info) : targets[i]}>
              <input type="checkbox" disabled={bad} checked={chosen.has(i)} onChange={() => toggle(i)} />
              <span className="imp-name">
                {f.folder && <span className="muted">{f.folder}/</span>}
                {f.name}
              </span>
              <span className="small muted">{bad ? <span className="error-text">unreadable</span> : `${(f.info as { tiles: number }).tiles} tiles`}</span>
              <span className="imp-target mono small">
                {targets[i].replace(/^data\/global\/tiles\//, '')}
                {!bad && exists(targets[i]) && (
                  <span className="warn-text">
                    {' '}
                    (replaces{usedBy?.(targets[i]).length ? `, used by ${usedBy(targets[i]).join(', ')}` : ''})
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {!files.length && <p className="muted small pad">No .dt1 files were found there.</p>}
      </div>
      {mapOpen ? (
        <label className="small">
          <input type="checkbox" checked={addToMap} onChange={(e) => setAddToMap(e.target.checked)} /> add them to {mapOpen.split('/').pop()}&apos;s tile libraries{' '}
          <HelpTip text="Puts each DT1 in a free File slot of the map's level type (LvlTypes.txt, 32 slots; when other levels use that type too, the map's level gets a level type of its own instead) and includes it in the map's Dt1Mask (LvlPrest.txt), so both DS1 Studio and the game load them. Without that, the game never loads the files (so it can't crash on them), but maps can't use their tiles either." />
          {freeSlots !== null && <span className="muted"> · {freeSlots} free slot{freeSlots === 1 ? '' : 's'}</span>}
        </label>
      ) : (
        <p className="muted small">Open a map first to add them to that map&apos;s tile libraries right away; otherwise add them later with Map → Tile libraries.</p>
      )}
      {replacing.length > 0 && (
        <p className="error-text small">
          {replacing.length === 1 ? 'This file replaces a tile library' : `${replacing.length} files replace tile libraries`} that other levels load (
          {[...new Set(replacing.flatMap((i) => usedBy?.(targets[i]) ?? []))].join(', ')}): their maps would show the new tiles, and tiles they use that
          the new file doesn&apos;t have would disappear. Pick another folder name above to keep both.
        </p>
      )}
      {tooMany && (
        <p className="error-text small">
          The map&apos;s level type has only {freeSlots} free slots for {picked.length} DT1s: select fewer (the ones this map needs), or untick “add them” and add them later.
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!okFolder || !picked.length || busy || tooMany}
          onClick={() => onImport({ files: picked.map((i) => ({ path: targets[i], bytes: files[i].bytes })), addToMap: !!mapOpen && addToMap })}
        >
          {busy ? 'Importing…' : `Import ${picked.length || ''}`}
        </button>
      </div>
    </Modal>
  );
}

export interface ImportDs1Choice {
  path: string;
  register: boolean;
  /** Tile libraries imported with the map; `replaces` = the library the map names that this one provides. */
  dt1s: { path: string; bytes: Uint8Array; replaces?: string }[];
  /** Libraries the map names to take out of its list (the extra copy of a library it names twice). */
  drop: string[];
}

/**
 * Import a DS1 as data/global/tiles/expansion/Map/<name>.ds1 together with the tile libraries it needs: every DT1 the
 * map names is listed as already there, provided by a picked file, or missing, and missing ones can be found by
 * picking DT1 files or folders. Then (optionally) add it to the game.
 */
export function ImportDs1Dialog({ file, info, needs, exists, readDt1, busy, pickDt1s, onImport, onClose }: {
  file: { name: string };
  info: { width: number; height: number; act: number } | string;
  /** The tile libraries the map names (its embedded file list). */
  needs: NeededDt1[];
  exists: (path: string) => boolean;
  /** Reads a DT1 from the game or mod (to compare libraries). */
  readDt1: (path: string) => Promise<Dt1 | null>;
  busy: boolean;
  /** Picks DT1 files or folders and reads them. */
  pickDt1s: (mode: 'files' | 'folders') => Promise<ImportDt1File[]>;
  onImport: (c: ImportDs1Choice) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => baseName(file.name));
  const [register, setRegister] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const [picked, setPicked] = useState<ImportDt1File[]>([]);
  const [manual, setManual] = useState<Record<number, number | null>>({});
  const [extras, setExtras] = useState<Set<number>>(new Set());
  const [acceptMissing, setAcceptMissing] = useState(false);
  const [picking, setPicking] = useState(false);
  const dt1Folder = (folder ?? name).trim();
  const path = `data/global/tiles/expansion/Map/${name.trim()}.ds1`;
  const auto = useMemo(() => matchDt1s(needs.map((n) => (n.found ? { ...n, rel: '\u0000' } : n)), picked.map((f) => ({ ...f, ok: typeof f.info !== 'string' }))), [needs, picked]);
  // A library the game or mod has can still be replaced by a picked file of the same name (chosen by hand).
  const source = needs.map((n, i) => (i in manual ? manual[i] : n.found ? null : auto[i]));
  const missing = needs.filter((n, i) => !n.found && source[i] === null);
  const usedFiles = new Set(source.filter((x): x is number => x !== null));
  const unmatched = picked.map((_, i) => i).filter((i) => !usedFiles.has(i) && typeof picked[i].info !== 'string');
  const ok = typeof info !== 'string' && safeName(name) && safeName(dt1Folder) && (!missing.length || acceptMissing);
  const add = async (mode: 'files' | 'folders') => {
    setPicking(true);
    try {
      const more = await pickDt1s(mode);
      if (more.length) setPicked((p) => [...p, ...more]);
    } finally {
      setPicking(false);
    }
  };
  const targetOf = (needIndex: number) => importedDt1Path(dt1Folder, needs[needIndex].rel);
  const extraTarget = (fi: number) => importedDt1Path(dt1Folder, `${picked[fi].folder ? `${picked[fi].folder}/` : ''}${picked[fi].name}`);
  const valid = picked.map((f, i) => ({ f, i })).filter(({ f }) => typeof f.info !== 'string');
  const fileName = (p: string) => p.split('/').pop()!.toLowerCase();

  // Libraries the map names twice (a DT1 and a copy of it in another folder): the game picks tile variants among
  // both, so the map shows a random mix of them. Compared by the tiles they provide.
  const [keys, setKeys] = useState<(Set<number> | null)[]>([]);
  const sourceKey = source.join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(
      needs.map(async (n, i) => {
        const src = source[i];
        try {
          if (src !== null) return tileKeys(parseDt1(picked[src].bytes));
          if (n.found) {
            const d = await readDt1(n.path);
            return d ? tileKeys(d) : null;
          }
        } catch {
          // unreadable: not compared
        }
        return null;
      }),
    ).then((k) => live && setKeys(k));
    return () => {
      live = false;
    };
  }, [needs, picked, sourceKey, readDt1]); // eslint-disable-line react-hooks/exhaustive-deps
  const twice = useMemo(() => {
    const out: { earlier: number; later: number }[] = [];
    for (let i = 0; i < needs.length; i++)
      for (let j = i + 1; j < needs.length; j++) if (keys[i] && keys[j] && sharedTiles(keys[i]!, keys[j]!)) out.push({ earlier: i, later: j });
    return out;
  }, [keys, needs]);
  const [dropTwice, setDropTwice] = useState(true);
  const drop = dropTwice ? [...new Set(twice.map((t) => t.earlier))] : [];
  // Picked DT1s left over that share a name with a library the map already has: importing them too gives it two copies.
  const sameNameAs = (fi: number) => needs.findIndex((n, i) => source[i] === null && n.found && fileName(n.path) === picked[fi].name.toLowerCase());
  return (
    <Modal title="Import DS1" onClose={onClose} wide>
      <p className="small">
        <b>{file.name}</b>: {typeof info === 'string' ? <span className="error-text">{info}</span> : `${info.width}×${info.height} map, act ${info.act + 1}`}
      </p>
      <label className="form-row">
        <span>Map name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </label>
      {!safeName(name) && <p className="error-text small">Use letters, digits, - and _ only (no spaces): plain names are safe in the game&apos;s tables.</p>}
      <p className="small mono">{path}</p>
      {exists(path) && <p className="warn-text small">A map with that name exists: it will be replaced (the old one is kept as .bak).</p>}
      <div className="imp-callout">
        <span className="small warn-text">
          {missingTablesWarning(tableCoverage([]))} A map package (.zip, from Export map) brings its Levels, LvlPrest, LvlTypes, CubeMain and AutoMap
          rows along: Import DS1… reads those too.
        </span>
      </div>

      <div className="field-label">
        Tile libraries this map uses{' '}
        <HelpTip text="A DS1 names the DT1 files its tiles come from. The ones your game or mod doesn't have can be imported with the map: pick DT1 files or whole folders and they're matched by name (and folder). They go into PD2assets/<folder>/ and the map is pointed at them, so DS1 Studio and — after Add to game — the game load them." />
      </div>
      {typeof info !== 'string' && needs.some((n) => !n.found) && (
        <div className={`imp-callout${missing.length ? '' : ' done'}`}>
          <span className="small">
            {missing.length
              ? `${missing.length} of the ${needs.filter((n) => !n.found).length} libraries your game and mod don't have ${missing.length === 1 ? 'is' : 'are'} still missing. Add their DT1s:`
              : 'Every library the map needs is there or provided.'}
          </span>
          <button className="btn small" disabled={picking} onClick={() => void add('files')}>
            Add DT1 files…
          </button>
          <button className="btn small" disabled={picking} onClick={() => void add('folders')}>
            Add folders…
          </button>
        </div>
      )}
      {typeof info !== 'string' && needs.length > 0 && needs.every((n) => n.found) && (
        <div className="imp-callout done">
          <span className="small">Your game and mod have every library the map names. You can still import your own versions of them with the map:</span>
          <button className="btn small" disabled={picking} onClick={() => void add('files')}>
            Add DT1 files…
          </button>
          <button className="btn small" disabled={picking} onClick={() => void add('folders')}>
            Add folders…
          </button>
        </div>
      )}
      <div className="imp-list">
        {needs.map((n, i) => {
          const src = source[i];
          return (
            <div key={n.path} className={`imp-need${n.found ? ' found' : src === null ? ' missing' : ' provided'}`}>
              <span className="imp-mark">{n.found ? '✓' : src === null ? '✗' : '＋'}</span>
              <span className="imp-name mono small" title={n.path}>
                {n.rel}
              </span>
              {n.found && !valid.some(({ f }) => f.name.toLowerCase() === fileName(n.path)) ? (
                <span className="small muted">in your game / mod{drop.includes(i) ? ' · left out (copy)' : ''}</span>
              ) : n.found ? (
                <span className="imp-pick">
                  <select
                    value={src ?? ''}
                    onChange={(e) => setManual((m) => ({ ...m, [i]: e.target.value === '' ? null : Number(e.target.value) }))}
                    title="Use the one your game or mod has, or replace it with a picked DT1 of the same name"
                  >
                    <option value="">in your game / mod{drop.includes(i) ? ' · left out (copy)' : ''}</option>
                    {valid
                      .filter(({ f }) => f.name.toLowerCase() === fileName(n.path))
                      .map(({ f, i: fi }) => (
                        <option key={fi} value={fi}>
                          use {f.folder ? `${f.folder}/` : ''}
                          {f.name} instead
                        </option>
                      ))}
                  </select>
                </span>
              ) : (
                <span className="imp-pick">
                  <select
                    value={src ?? ''}
                    onChange={(e) => setManual((m) => ({ ...m, [i]: e.target.value === '' ? null : Number(e.target.value) }))}
                    title={src !== null ? `→ ${targetOf(i).replace(/^data\/global\/tiles\//, '')}` : 'Pick which DT1 provides it'}
                  >
                    <option value="">{valid.length ? 'missing — choose a DT1…' : 'missing'}</option>
                    {valid.map(({ f, i: fi }) => (
                      <option key={fi} value={fi}>
                        {f.folder ? `${f.folder}/` : ''}
                        {f.name}
                      </option>
                    ))}
                  </select>
                </span>
              )}
            </div>
          );
        })}
        {!needs.length && <p className="muted small pad">The map doesn&apos;t name any tile libraries (it will use its level type&apos;s).</p>}
      </div>
      {twice.length > 0 && (
        <div className="imp-callout small">
          <span>
            <b>
              The map names {twice.length} tile librar{twice.length === 1 ? 'y' : 'ies'} twice
            </b>{' '}
            — {twice.length <= 3 ? `${twice.map((t) => `${needs[t.earlier].rel} and ${needs[t.later].rel}`).join('; ')} provide` : 'pairs of them in different folders provide'} the same tiles. Where a tile has random variants
            the game picks among both copies, so the map would show a random mix of them (odd colours on some cells, for example).
          </span>
          <label>
            <input type="checkbox" checked={dropTwice} onChange={(e) => setDropTwice(e.target.checked)} /> keep one copy of each: leave out the first-listed ones
            (marked “left out (copy)” above)
          </label>
        </div>
      )}
      {picked.some((f) => typeof f.info === 'string') && (
        <p className="warn-text small">
          Left out (can&apos;t be read): {picked.filter((f) => typeof f.info === 'string').map((f) => f.name).join(', ')}
        </p>
      )}
      {unmatched.length > 0 && (
        <details className="small">
          <summary>
            {unmatched.length} other picked DT1{unmatched.length === 1 ? '' : 's'} the map doesn&apos;t name ({extras.size} to import too)
          </summary>
          {unmatched.map((fi) => (
            <label key={fi} className="imp-extra">
              <input
                type="checkbox"
                checked={extras.has(fi)}
                onChange={() =>
                  setExtras((x) => {
                    const n = new Set(x);
                    if (n.has(fi)) n.delete(fi);
                    else n.add(fi);
                    return n;
                  })
                }
              />{' '}
              {picked[fi].folder ? `${picked[fi].folder}/` : ''}
              {picked[fi].name} <span className="muted">→ {extraTarget(fi).replace(/^data\/global\/tiles\//, '')}</span>
              {sameNameAs(fi) >= 0 && (
                <span className="warn-text">
                  {' '}
                  · same name as {needs[sameNameAs(fi)].rel}, which the map already uses: importing both gives it two copies (a random mix). Choose it on that
                  library&apos;s line to use it instead.
                </span>
              )}
            </label>
          ))}
        </details>
      )}
      {(usedFiles.size > 0 || extras.size > 0) && (
        <label className="form-row">
          <span>
            DT1s into PD2assets / <HelpTip text="The subfolder of data/global/tiles/PD2assets/ the imported DT1s go into (keeping the folders the map names inside it)." />
          </span>
          <input className="text-input" value={dt1Folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
      )}
      {missing.length > 0 && (
        <label className="small warn-text">
          <input type="checkbox" checked={acceptMissing} onChange={(e) => setAcceptMissing(e.target.checked)} /> import anyway: tiles from the {missing.length} missing
          librar{missing.length === 1 ? 'y' : 'ies'} will show as missing (and the game can&apos;t draw them)
        </label>
      )}
      <label className="small">
        <input type="checkbox" checked={register} onChange={(e) => setRegister(e.target.checked)} /> add it to the game next{' '}
        <HelpTip text="Opens “Add to game” for it: a LvlPrest row pointing at the map, a level for it (existing or new) and its tile libraries in LvlTypes/Dt1Mask. Until then the game doesn't know the map (it can't load it, so it can't crash on it either)." />
      </label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!ok || busy}
          onClick={() =>
            onImport({
              path,
              register,
              dt1s: [
                ...needs.flatMap((n, i) => (source[i] === null || drop.includes(i) ? [] : [{ path: targetOf(i), bytes: picked[source[i]!].bytes, replaces: n.path }])),
                ...[...extras].map((fi) => ({ path: extraTarget(fi), bytes: picked[fi].bytes })),
              ],
              drop: drop.map((i) => needs[i].path),
            })
          }
        >
          {busy ? 'Importing…' : `Import${usedFiles.size + extras.size ? ` map + ${usedFiles.size + extras.size} DT1${usedFiles.size + extras.size === 1 ? '' : 's'}` : ''}`}
        </button>
      </div>
    </Modal>
  );
}
