import { drawnPalettes, guessDrawnAct, viewPalette } from '../game/openMap';
import { keysOf, ownTilesPath } from '../game/ownTiles';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tileKey } from '../game/dt1Review';
import type { Dt1, Dt1Tile } from '../formats/dt1';
import type { GameData } from '../game/GameData';
import type { OpenMap } from '../game/openMap';
import { normalizePath } from '../vfs/vfs';
import { Thumb, TilePreview, tilePicture, usePreview } from './TilePalette';
import { act0Display, act0Remap, dt1Act, loadAct0Palette } from '../game/act0Palette';
import { ACT0_PALETTE, type Palette } from '../formats/palette';
import { ORIENTATION_NAMES } from './state';
import { isBuiltinPath } from '../game/specialTiles';
import { Dt1Tree } from './Dt1Tree';
import { HelpTip } from './HelpTip';
import { buildCustomDt1, customNameProblem, maxCustomNameLength, planCustomDt1, RECOMMENDED_NAME_LENGTH, type CustomDt1Plan, type TilePick } from '../game/customDt1';
import { decodeTile } from '../formats/dt1';

interface Props {
  map: OpenMap;
  gd: GameData;
  /** Placed tiles per DT1 path (normalized), to warn before removing a library in use. */
  usage: Map<string, number>;
  /** `toAct0`: libraries to convert to the Act 0 colours as they are added. */
  onApply: (paths: string[], opts?: { toAct0: string[] }) => void;
  onClose: () => void;
}

const short = (p: string) => p.replace(/^data\/global\/tiles\//i, '');

/** A tile drawn large with crisp pixels: fitted to the panel, or at a chosen zoom. */
function BigTile({ tile, palette }: { tile: Dt1Tile; palette: Palette }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 300, h: 300 });
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pic = tilePicture(tile, palette);
  const fit = pic ? Math.min(6, (box.w - 16) / pic.width, (box.h - 16) / pic.height) : 1;
  // Whole-number zoom keeps every pixel the same size; below 2× that would waste too much of the panel.
  const scale = zoom === 'fit' ? (fit >= 2 ? Math.floor(fit) : fit) : zoom;
  return (
    <>
      <div className="chips dt1v-zoom">
        {(['fit', 1, 2, 3, 4] as const).map((z) => (
          <button key={z} className={`chip${zoom === z ? ' active' : ''}`} onClick={() => setZoom(z)}>
            {z === 'fit' ? 'Fit' : `${z}×`}
          </button>
        ))}
      </div>
      <div ref={ref} className="dt1v-big">
        {pic ? (
          <img src={pic.url} alt="" width={pic.width * scale} height={pic.height * scale} className={`tile-preview-img${tile.orientation === 13 ? ' shadow-preview' : ''}`} />
        ) : (
          <span className="muted small">No picture (invisible in game)</span>
        )}
      </div>
    </>
  );
}

const KINDS: { id: string; label: string; test: (o: number) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'floor', label: 'Floors', test: (o) => o === 0 },
  { id: 'wall', label: 'Walls', test: (o) => (o >= 1 && o <= 9) || o === 12 },
  { id: 'tree', label: 'Trees/objects', test: (o) => o === 14 },
  { id: 'roof', label: 'Roofs', test: (o) => o === 15 },
  { id: 'lower', label: 'Lower walls', test: (o) => o >= 16 },
  { id: 'shadow', label: 'Shadows', test: (o) => o === 13 },
  { id: 'special', label: 'Specials', test: (o) => o === 10 || o === 11 },
];

/**
 * Every tile of one DT1, filterable by kind: resting the pointer on a tile shows it enlarged (as in the Tiles panel),
 * clicking it shows its details.
 */
export function Dt1Viewer({
  path,
  dt1,
  palette,
  paletteNote,
  inMap,
  onAdd,
  addLabel = 'Add to map',
  picks,
  onPick,
  usage,
  headActions,
  tileActions,
}: {
  path: string;
  dt1: Dt1 | null;
  palette: Palette;
  paletteNote: string | null;
  inMap: boolean;
  onAdd: () => void;
  addLabel?: string;
  /** Tiles ticked for a custom DT1 (with onPick: clicking a tile ticks or unticks it, Shift+click a range). */
  picks?: Set<number>;
  onPick?: (indices: number[], on: boolean) => void;
  /** How many of the map's cells place each tile key (tileKey): used tiles are marked, and can be shown alone. */
  usage?: Map<string, number>;
  /** More buttons for the library, in the header. */
  headActions?: ReactNode;
  /** Actions for the clicked tile, under its details. */
  tileActions?: (index: number, tile: Dt1Tile, uses: number) => ReactNode;
}) {
  const [kind, setKind] = useState('all');
  const usesOf = (t: Dt1Tile) => usage?.get(tileKey(t.orientation, t.mainIndex, t.subIndex)) ?? 0;
  const lastClick = useRef<number | null>(null);
  const [hovered, hover, hideHover] = usePreview();
  const [picked, setPicked] = useState<number | null>(null);
  const [size, setSize] = useState(64);
  useEffect(() => {
    setPicked(null);
    lastClick.current = null;
    hideHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const tiles = (dt1?.tiles ?? []).map((t, i) => ({ t, i })).filter(({ t }) => (kind === 'used' ? usesOf(t) > 0 : KINDS.find((k) => k.id === kind)!.test(t.orientation)));
  const usedCount = usage && dt1 ? dt1.tiles.filter((t) => usesOf(t) > 0).length : 0;
  // A filter that hides the clicked tile moves the large view to the first tile shown.
  useEffect(() => {
    if (picked !== null && tiles.length && !tiles.some((x) => x.i === picked)) setPicked(tiles[0].i);
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (dt1?.tiles.length) setPicked((p) => p ?? 0);
  }, [dt1]);
  const sel = picked !== null ? dt1?.tiles[picked] : undefined;
  return (
    <div className="dt1v">
      <div className="dt1v-head">
        <span className="mono">{short(path)}</span>
        <span className="muted small">
          {dt1 ? `${dt1.tiles.length} tiles` : 'loading…'}
          {paletteNote ? ` · shown in the ${paletteNote}` : ''}
        </span>
        <div className="chips">
          {KINDS.map((k) => {
            const n = dt1 ? dt1.tiles.filter((t) => k.test(t.orientation)).length : 0;
            return (
              <button key={k.id} className={`chip${kind === k.id ? ' active' : ''}`} disabled={k.id !== 'all' && !n} onClick={() => setKind(k.id)}>
                {k.label} {k.id !== 'all' && <span className="muted">{n}</span>}
              </button>
            );
          })}
          {usage && (
            <button className={`chip used-chip${kind === 'used' ? ' active' : ''}`} onClick={() => setKind('used')} title="Only the tiles this map places">
              Used in this map <span className="muted">{usedCount}</span>
            </button>
          )}
        </div>
        {headActions}
        <label className="dt1v-size small" title="Thumbnail size (or Ctrl + scroll over the tiles)">
          Size <input type="range" min={36} max={200} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        </label>
        {onPick && dt1 && (
          <>
            <button className="btn small" onClick={() => onPick(tiles.map((x) => x.i), true)} title="Tick every tile shown (the filter applies)">
              Tick all shown
            </button>
            {!!picks?.size && (
              <button className="btn small" onClick={() => onPick([...picks], false)}>
                Untick all here
              </button>
            )}
          </>
        )}
        {!inMap && !onPick && (
          <button className="btn small" onClick={onAdd}>
            {addLabel}
          </button>
        )}
      </div>
      <div className="dt1v-body">
        <div
          className="thumb-grid dt1v-grid"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 14}px, 1fr))`, ['--thumb-h' as string]: `${size}px` }}
          onWheel={(e) => {
            if (!e.ctrlKey) return;
            setSize((v) => Math.round(Math.min(200, Math.max(36, v * Math.exp(-e.deltaY * 0.0015)))));
          }}
          title="Ctrl + scroll to zoom"
        >
          {tiles.map(({ t, i }) => (
            <div
              key={i}
              className={`thumb${picked === i ? ' active' : ''}${picks?.has(i) ? ' ticked' : ''}${usage && usesOf(t) ? ' used' : ''}`}
              {...hover(() => {
                const pic = tilePicture(t, palette);
                return {
                  tile: t,
                  title: `#${i} · ${ORIENTATION_NAMES[t.orientation] ?? `o${t.orientation}`} · main ${t.mainIndex} · sub ${t.subIndex}`,
                  lines: [
                    [pic ? `${pic.width}×${pic.height} px` : '', `rarity ${t.rarity}`, t.animated ? 'animated' : ''].filter(Boolean).join(' · '),
                    ...(usage ? [usesOf(t) ? `Used in this map: ${usesOf(t)} cell${usesOf(t) === 1 ? '' : 's'}` : 'Not used in this map'] : []),
                    onPick ? (picks?.has(i) ? 'Click: untick · Shift+click: a range' : 'Click: tick for the custom DT1 · Shift+click: a range') : 'Click: details',
                  ],
                };
              })}
              onClick={(e) => {
                setPicked(i);
                if (!onPick) return;
                const on = !picks?.has(i);
                const from = e.shiftKey && lastClick.current !== null ? tiles.findIndex((x) => x.i === lastClick.current) : -1;
                const to = tiles.findIndex((x) => x.i === i);
                onPick(from >= 0 ? tiles.slice(Math.min(from, to), Math.max(from, to) + 1).map((x) => x.i) : [i], e.shiftKey && from >= 0 ? true : on);
                lastClick.current = i;
              }}
            >
              {onPick && <span className={`thumb-tick${picks?.has(i) ? ' on' : ''}`}>{picks?.has(i) ? '✓' : ''}</span>}
              {usage && usesOf(t) > 0 && <span className="thumb-uses" title="Cells of this map using it">×{usesOf(t)}</span>}
              <Thumb tile={t} palette={palette} />
              <span className="thumb-label">
                {t.mainIndex}/{t.subIndex}
              </span>
            </div>
          ))}
        </div>
        {hovered && <TilePreview p={hovered} palette={palette} />}
        <div className="dt1v-detail">
          {sel ? (
            <>
              <BigTile tile={sel} palette={palette} />
              <div className="dt1v-facts small">
                <div>
                  <b>#{picked}</b> · {ORIENTATION_NAMES[sel.orientation] ?? '?'} (orientation {sel.orientation}) · main/sub <code>{sel.mainIndex}/{sel.subIndex}</code>
                </div>
                <div className="muted">
                  {sel.width}×{Math.abs(sel.height)} · rarity/frame {sel.rarity}
                  {sel.animated ? ' · animated' : ''}
                </div>
              </div>
              {tileActions && picked !== null && tileActions(picked, sel, usesOf(sel))}
            </>
          ) : (
            <p className="muted small">Click a tile for a closer look.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The act a tile library belongs to, from its folder (act1…act5, expansion = Act 5); null when it doesn't say. */
const libraryAct = dt1Act;

/** A palette whose entry i shows the colour of remap[i]: draws tiles as a remap would leave them. */
function remapPalette(palette: Palette, remap: Uint8Array): Palette {
  const out = new Uint8Array(palette.length);
  for (let i = 0; i < 256; i++) out.set(palette.subarray(remap[i] * 4, remap[i] * 4 + 4), i * 4);
  return out;
}

/** The picked tiles' key, per library. */
const pickKey = (p: TilePick) => `${normalizePath(p.dt1)}#${p.index}`;
/** How many tiles a DT1 file holds. */
const dt1Count = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(268, true);
const DEFAULT_CUSTOM_FOLDER = 'PD2assets/custom';
const FOLDER_OK = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;

interface LibraryProps extends Omit<Props, 'usage'> {
  /** Placed tiles per DT1 path (normalized), to warn before removing a library in use. */
  usage?: Map<string, number>;
  /**
   * Writes a custom DT1 built from picked tiles and adds it to the map (null: no writable mod folder). `existing`
   * given: the tiles are added after those of that DT1 (at `path`) instead.
   */
  onCreateCustom: ((req: { path: string; plan: CustomDt1Plan; bytes: Uint8Array; actSafe: boolean; existing?: Uint8Array | null }) => Promise<void>) | null;
  /** Brings DT1 files, or folders of them, from the computer into the mod (null: no writable mod folder). */
  onImportFiles: ((mode: 'files' | 'folders') => void) | null;
  /** DT1s just imported: the first is shown, those the map does not load yet come chosen. */
  reveal: string[] | null;
  /** Moves one of the map's libraries up (-1) or down (+1) in load order (null: no writable mod folder). */
  onMove?: ((path: string, dir: -1 | 1) => Promise<void>) | null;
}

/**
 * Import DT1 → From game library: every tile library the game and mods have, by folder, with each one's tiles to look
 * through (hover to enlarge). Either whole libraries are chosen and added to the open map (like the Tile libraries
 * dialog), or single tiles from any of them are ticked and built into a new custom DT1 (see game/customDt1.ts).
 */
export function Dt1LibraryDialog({ map, gd, usage, onApply, onCreateCustom, onImportFiles, reveal, onMove, onClose }: LibraryProps) {
  const current = useMemo(() => map.lib.loaded.filter((l) => !isBuiltinPath(l.path)).map((l) => l.path), [map]);
  const inMap = useMemo(() => new Set(current.map(normalizePath)), [current]);
  const all = useMemo(() => gd.fs.list((p) => p.endsWith('.dt1') && p.startsWith('data/global/tiles/')), [gd]);
  const [mode, setMode] = useState<'libraries' | 'custom'>('libraries');
  const [selected, setSelected] = useState('');
  const [dt1, setDt1] = useState<Dt1 | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [picks, setPicks] = useState<TilePick[]>([]);
  const [toAct0, setToAct0] = useState(true);
  /** "Edit a custom DT1": the DT1 the picked tiles are added to (null: they make a new one). */
  const [addTo, setAddTo] = useState<string | null>(null);
  /** A library of the map waiting for "Remove from the map?" (Delete). */
  const [removing, setRemoving] = useState<string | null>(null);
  /** Moving a library in load order: busy, and what went wrong. */
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Colours: the library's own act (from its folder), the map's act, or Act 0 (magenta = colours that change by act).
  // A map shown in the Act 0 colours (a new map) opens the library in them too.
  const [palMode, setPalMode] = useState<'own' | 'map' | 'act0'>(map.paletteAct === ACT0_PALETTE ? 'act0' : 'own');
  const [pal, setPal] = useState<{ palette: Palette; note: string } | null>(null);
  const ownAct = libraryAct(selected);
  useEffect(() => {
    let live = true;
    const act = palMode === 'own' ? (ownAct ?? map.ds1.act) : map.ds1.act;
    const load =
      palMode === 'act0'
        ? Promise.all([loadAct0Palette(gd.fs), gd.palette(ownAct ?? map.ds1.act)]).then(([a, home]) =>
            viewPalette().magenta
              ? { palette: a.palette, note: 'Act 0 palette (magenta = changes between acts)' }
              : { palette: act0Display(a, home, false), note: 'Act 0 palette (colours that change between acts in this library’s own act)' },
          )
        : gd.palette(act).then((palette) => ({ palette, note: `Act ${act + 1} palette` }));
    void load.then((p) => live && setPal(p)).catch(() => live && setPal(null));
    return () => {
      live = false;
    };
  }, [gd, palMode, ownAct, map]);
  useEffect(() => {
    let live = true;
    setDt1(null);
    if (selected) void gd.dt1(selected).then(d => live && setDt1(d)).catch(() => live && setDt1(null));
    return () => { live = false; };
  }, [selected, gd]);
  // DT1s just imported: show the first and choose those the map doesn't load yet (no click per file).
  useEffect(() => {
    if (!reveal?.length) return;
    setSelected(reveal[0]);
    const fresh = reveal.filter((p) => !inMap.has(normalizePath(p)));
    if (fresh.length) setChosen((c) => [...c.filter((x) => !fresh.some((f) => normalizePath(f) === normalizePath(x))), ...fresh]);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The import window opened from here closes itself first.
      if (e.key === 'Escape' && document.querySelectorAll('[role=dialog]').length <= 1) {
        if (removingRef.current) setRemoving(null);
        else onClose();
      }
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if (e.key === 'Delete' && !typing && removableRef.current) {
        e.preventDefault();
        setRemoving(removableRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const removingRef = useRef(removing);
  removingRef.current = removing;
  /** The selected library, when it is one of the map's (Delete offers to remove it). */
  const removableRef = useRef<string | null>(null);
  removableRef.current = selected && inMap.has(normalizePath(selected)) && mode === 'libraries' ? selected : null;
  const removeLibrary = (p: string) => {
    setRemoving(null);
    onApply(current.filter((c) => normalizePath(c) !== normalizePath(p)));
  };
  /** A DT1 of the mod (not the game's archives): "Edit a custom DT1" can add tiles to it. */
  const editable = (p: string) => !!p && !/\.mpq$/i.test(gd.fs.locate(p) ?? '.mpq');
  const isChosen = (p: string) => chosen.some((c) => normalizePath(c) === normalizePath(p));
  const toggle = (p: string) => setChosen((c) => (isChosen(p) ? c.filter((x) => normalizePath(x) !== normalizePath(p)) : [...c, p]));
  const selInMap = selected && inMap.has(normalizePath(selected));
  /** The selected library's place in the map's load order (-1: not loaded). */
  const loadIndex = selInMap ? current.findIndex((c) => normalizePath(c) === normalizePath(selected)) : -1;
  const move = (dir: -1 | 1) => {
    if (!onMove || moving) return;
    setMoving(true);
    setMoveError(null);
    onMove(selected, dir)
      .catch((e) => setMoveError((e as Error).message))
      .finally(() => setMoving(false));
  };
  const pickedHere = useMemo(() => new Set(picks.filter((p) => normalizePath(p.dt1) === normalizePath(selected)).map((p) => p.index)), [picks, selected]);
  const pickLibraries = useMemo(() => [...new Set(picks.map((p) => p.dt1))], [picks]);
  const onPick = (indices: number[], on: boolean) =>
    setPicks((prev) => {
      const drop = new Set(indices.map((index) => pickKey({ dt1: selected, index })));
      const rest = prev.filter((p) => !drop.has(pickKey(p)));
      return on ? [...rest, ...indices.map((index) => ({ dt1: selected, index }))] : rest;
    });
  const custom = mode === 'custom';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dt1-manager dt1-library" role="dialog" aria-label="Tile libraries from the game">
        <div className="modal-title dt1l-title">
          Import DT1 from the game library · {map.path.split('/').pop()}
          <div className="chips">
            <button className={`chip${!custom ? ' active' : ''}`} onClick={() => setMode('libraries')} title="Add whole tile libraries to the map">
              Add whole libraries
            </button>
            <button
              className={`chip${custom && !addTo ? ' active' : ''}`}
              onClick={() => {
                setMode('custom');
                setAddTo(null);
              }}
              title="Tick single tiles from any libraries and build a new DT1 from them"
            >
              Build a custom DT1{picks.length && !addTo ? ` · ${picks.length}` : ''}
            </button>
            <button
              className={`chip${custom && addTo ? ' active' : ''}`}
              disabled={!addTo && !editable(selected)}
              onClick={() => {
                setMode('custom');
                if (!addTo) setAddTo(selected);
              }}
              title={
                addTo
                  ? `Adding the picked tiles to ${short(addTo)}`
                  : editable(selected)
                    ? `Add more tiles to ${short(selected)}: tick them in any libraries, then add them (its own tiles stay as they are)`
                    : 'Select a DT1 of your mod on the left (a custom DT1 you built, for example), then click here to add more tiles to it'
              }
            >
              Edit a custom DT1{addTo ? ` · ${short(addTo).split('/').pop()}${picks.length ? ` +${picks.length}` : ''}` : ''}
            </button>
          </div>
        </div>
        <div className="dt1l-cols">
          <div className="dt1l-side">
            <div className="dt1l-add">
              <button className="btn small" disabled={!onImportFiles} onClick={() => onImportFiles?.('files')} title="Copy DT1 files from your computer into your mod (PD2assets/<folder>), so they are part of the library">
                + Add DT1 files…
              </button>
              <button className="btn small" disabled={!onImportFiles} onClick={() => onImportFiles?.('folders')} title="Copy every DT1 in a folder (and its subfolders) into your mod">
                + Add a folder…
              </button>
            </div>
            <Dt1Tree
              all={all}
              inMap={current}
              chosen={custom ? pickLibraries : chosen}
              chosenLabel={custom ? 'picked' : 'chosen'}
              selected={selected}
              onSelect={setSelected}
              onChooseMany={custom ? undefined : (paths, on) => setChosen((c) => {
                const these = new Set(paths.map(normalizePath));
                const rest = c.filter((x) => !these.has(normalizePath(x)));
                return on ? [...rest, ...paths] : rest;
              })}
            />
            {loadIndex >= 0 && !custom && (
              <div className="dt1l-order">
                <span className="small muted" title="The game loads the map's libraries in this order; when two have a tile with the same number, the first one loaded is drawn">
                  Load order {loadIndex + 1} of {current.length}
                </span>
                <div className="dt1l-order-btns">
                  <button className="btn small" disabled={!onMove || moving || loadIndex === 0} onClick={() => move(-1)} title="Load it one place earlier (it wins over the libraries after it for tiles with the same number)">
                    ↑ Move up
                  </button>
                  <button className="btn small" disabled={!onMove || moving || loadIndex === current.length - 1} onClick={() => move(1)} title="Load it one place later">
                    ↓ Move down
                  </button>
                  <button className="btn small danger" disabled={moving || !!removing} onClick={() => setRemoving(selected)} title="Take this library out of the map (Delete). Asks first.">
                    Remove…
                  </button>
                </div>
                {moveError && <p className="small error-text">{moveError}</p>}
              </div>
            )}
          </div>
          <div className="dt1l-view">
            {selected ? (
              <Dt1Viewer
                path={selected}
                dt1={dt1}
                palette={pal?.palette ?? map.palette}
                paletteNote={pal?.note ?? null}
                inMap={!!selInMap}
                addLabel={isChosen(selected) ? '✓ Chosen (click to undo)' : 'Choose this library'}
                onAdd={() => toggle(selected)}
                picks={custom ? pickedHere : undefined}
                onPick={custom ? onPick : undefined}
              />
            ) : (
              <p className="muted small">
                Pick a tile library on the left to see its tiles. Rest the pointer on a tile to see it enlarged; click it for its details.{' '}
                {custom
                  ? 'Click tiles to tick them (Shift+click for a range), from as many libraries as you like, then name the new DT1 below.'
                  : 'Choose the libraries you want, then add them to the map.'}
              </p>
            )}
            <label className="small dt1l-colours">
              Colours
              <select value={palMode} onChange={(e) => setPalMode(e.target.value as typeof palMode)}>
                <option value="own">its act{ownAct !== null ? ` (Act ${ownAct + 1})` : ''}</option>
                <option value="map">this map&apos;s act (Act {map.ds1.act + 1})</option>
                <option value="act0">Act 0: show colours that change between acts</option>
              </select>
            </label>
            {selInMap && !custom && !removing && (
              <p className="muted small">This map already loads this library: move it in load order or remove it under the library list.</p>
            )}
            {removing && (
              <div className="dt1l-remove" role="alert">
                <b>Remove {short(removing)} from the map?</b>{' '}
                {(() => {
                  const n = usage?.get(normalizePath(removing)) ?? 0;
                  return n ? (
                    <span className="warn">
                      {n} placed tile{n === 1 ? ' comes' : 's come'} from it: {n === 1 ? 'it' : 'they'} will show as missing (or as another library&apos;s tile with the same number).
                    </span>
                  ) : (
                    <span className="muted">No placed tile comes from it.</span>
                  );
                })()}{' '}
                The DT1 file itself stays; its level type and Dt1Mask are updated as when adding.
                <div className="modal-actions">
                  <button className="btn" onClick={() => setRemoving(null)}>
                    Keep it
                  </button>
                  <button className="btn danger" autoFocus onClick={() => removeLibrary(removing)}>
                    Remove from the map
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        {custom ? (
          <CustomDt1Panel map={map} gd={gd} picks={picks} setPicks={setPicks} palette={pal?.palette ?? map.palette} onShow={setSelected} onCreate={onCreateCustom} onClose={onClose} addTo={addTo} onStopAdding={() => setAddTo(null)} />
        ) : (
          <>
            <div className="dt1l-chosen">
              <span className="field-label">Chosen</span>
              {chosen.length ? (
                chosen.map((p) => (
                  <span key={p} className="chip active" title={p}>
                    <button className="link" onClick={() => setSelected(p)}>
                      {short(p)}
                    </button>
                    <button className="icon-btn" title="Remove" onClick={() => toggle(p)}>
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <span className="muted small">none yet</span>
              )}
            </div>
            <label className="small act0-standard" title="Colours that change between acts are snapped to the nearest colour that is the same in every act, so the tiles look right in any act. A DT1 from the game's archives gets a converted copy in your mod, which every map using it then shares.">
              <input type="checkbox" checked={toAct0} onChange={(e) => setToAct0(e.target.checked)} /> Convert them to <b>Act 0 colours</b> (the same in every act; recommended)
            </label>
            <p className="muted small">
              They are added to the map, and its level type and Dt1Mask are updated so the game loads them (originals kept as .bak).
              {toAct0 ? ' Libraries using colours that change between acts are converted first (in your mod).' : ' Nothing is copied: the libraries are already in the game or your mod.'}
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!chosen.length} onClick={() => onApply([...current, ...chosen], { toAct0: toAct0 ? chosen : [] })}>
                Add {chosen.length || ''} to the map
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The picked tiles, the new DT1's name and folder, and what building it will do: tiles that come along (corner
 * halves, animation frames), tiles that get a new number, tiles from other acts.
 */
function CustomDt1Panel({
  map,
  gd,
  picks,
  setPicks,
  palette,
  onShow,
  onCreate,
  onClose,
  addTo = null,
  onStopAdding,
}: {
  /** "Edit a custom DT1": the picked tiles are added to this DT1 (null: they make a new one). */
  addTo?: string | null;
  onStopAdding?: () => void;
  map: OpenMap;
  gd: GameData;
  picks: TilePick[];
  setPicks: (f: (p: TilePick[]) => TilePick[]) => void;
  palette: Palette;
  onShow: (dt1: string) => void;
  onCreate: LibraryProps['onCreateCustom'];
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  // The level type's home folder (next to its other libraries; see game/ownTiles.ts), else the old default.
  const [folder, setFolder] = useState(() => ownTilesPath(gd, map.path, map.resolution.lvlType).replace(/^data\/global\/tiles\//i, '').replace(/\/[^/]*$/, '') || DEFAULT_CUSTOM_FOLDER);
  const [libs, setLibs] = useState<Map<string, Dt1>>(new Map());
  const [plan, setPlan] = useState<CustomDt1Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, hover] = usePreview();
  // Act 0 colours are the standard: a custom DT1 is act-safe unless you untick it.
  const [actSafe, setActSafe] = useState(true);
  /** Act 0 conversion: per act a library can be drawn for, the remap to act-safe colours. */
  const [safe, setSafe] = useState<{ usable: boolean[]; remaps: Uint8Array[]; palettes: Palette[] } | null>(null);
  const bytes = useRef(new Map<string, Uint8Array>());
  // What the map's level already loads: a new tile with one of these numbers would mix with it in game.
  // Adding to a DT1: its own tiles' numbers are taken too (it may not be in the map yet).
  const [addToBytes, setAddToBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let live = true;
    setAddToBytes(null);
    if (addTo) void gd.fs.read(addTo).then((b) => live && setAddToBytes(b));
    return () => {
      live = false;
    };
  }, [addTo, gd]);
  const taken = useMemo(() => {
    const keys = new Set<string>();
    for (const l of map.lib.loaded) for (const t of map.lib.tilesOf(l.path)) keys.add(`${t.orientation}|${t.mainIndex}|${t.subIndex}`);
    for (const k of keysOf(addToBytes)) keys.add(k);
    return keys;
  }, [map, addToBytes]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const paths = [...new Set(picks.map((p) => p.dt1))];
      for (const p of paths) {
        if (!bytes.current.has(p)) {
          const b = await gd.fs.read(p);
          if (b) bytes.current.set(p, b);
        }
      }
      const loaded = new Map<string, Dt1>();
      for (const p of paths) {
        const d = await gd.dt1(p);
        if (d) loaded.set(p, d);
      }
      if (!live) return;
      setLibs(loaded);
      setPlan(picks.length ? planCustomDt1(picks, bytes.current, taken) : null);
    })();
    return () => {
      live = false;
    };
  }, [picks, gd, taken]);

  useEffect(() => {
    if (!actSafe || safe) return;
    let live = true;
    void Promise.all([loadAct0Palette(gd.fs), drawnPalettes(gd)])
      .then(([a0, acts]) => live && setSafe({ usable: a0.usable, remaps: acts.map((p) => act0Remap(p, a0.usable)), palettes: acts }))
      .catch((e) => live && setError(`Couldn't load the Act 0 palette: ${(e as Error).message}`));
    return () => {
      live = false;
    };
  }, [actSafe, safe, gd]);
  // The act a library was drawn for: its folder's, else the one its art fits (classic Act 5 included), else this map's.
  const drawnFor = useMemo(() => {
    const out = new Map<string, number | null>();
    if (safe) for (const [path, d] of libs) out.set(path, libraryAct(path) ?? guessDrawnAct(d.tiles, safe.palettes));
    return out;
  }, [libs, safe]);
  const actOf = (dt1: string) => drawnFor.get(dt1) ?? libraryAct(dt1) ?? map.ds1.act;
  const remapFor = actSafe && safe ? (dt1: string) => safe.remaps[actOf(dt1)] : undefined;
  // After conversion the colours are the same in every act: show them in this map's palette.
  const safePalettes = useMemo(() => safe?.remaps.map((r) => remapPalette(map.palette, r)) ?? null, [safe, map.palette]);
  const trayPalette = (dt1: string) => (actSafe && safePalettes ? safePalettes[actOf(dt1)] : palette);
  /** Picked tiles using colours that change between acts (they look different in other acts). */
  const actSpecific = useMemo(() => {
    if (!safe) return null;
    let n = 0;
    for (const p of picks) {
      const img = libs.get(p.dt1)?.tiles[p.index] && decodeTile(libs.get(p.dt1)!.tiles[p.index]);
      if (img && img.pixels.some((v) => v !== 0 && !safe.usable[v])) n++;
    }
    return n;
  }, [safe, picks, libs]);

  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, '');
  const folderProblem = FOLDER_OK.test(cleanFolder) ? null : 'The folder: letters, digits and _ only, with / between folders.';
  const nameProblem = customNameProblem(name, cleanFolder);
  const path = `data/global/tiles/${cleanFolder}/${name.trim()}.dt1`;
  const exists = !nameProblem && !folderProblem && !!gd.fs.locate(path);
  const partners = plan?.tiles.filter((t) => t.partner).length ?? 0;
  const otherActs = [...new Set(picks.map((p) => libraryAct(p.dt1)).filter((a): a is number => a !== null && a !== map.ds1.act))].sort();
  const problem = addTo
    ? addToBytes
      ? null
      : `Reading ${short(addTo)}…`
    : (folderProblem ?? nameProblem ?? (exists ? `${path.replace(/^data\/global\/tiles\//, '')} already exists: choose another name.` : null));
  const create = async () => {
    if (!onCreate || !plan) return;
    setBusy(true);
    setError(null);
    try {
      if (addTo) {
        if (!addToBytes) throw new Error(`${addTo} could not be read.`);
        await onCreate({ path: addTo, plan, bytes: buildCustomDt1(plan, remapFor), actSafe: !!remapFor, existing: addToBytes });
        setPicks(() => []);
        return;
      }
      await onCreate({ path, plan, bytes: buildCustomDt1(plan, remapFor), actSafe: !!remapFor });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dt1c">
      <div className="dt1c-picked">
        <div className="field-label">
          Picked tiles{' '}
          <span className="muted small">{picks.length ? `${picks.length} from ${new Set(picks.map((p) => p.dt1)).size} libraries` : 'none yet: click tiles above to tick them'}</span>
          {picks.length > 0 && (
            <button className="link small" onClick={() => setPicks(() => [])}>
              clear all
            </button>
          )}
        </div>
        {hovered && <TilePreview p={hovered} palette={palette} />}
        <div className="dt1c-tray">
          {picks.map((p) => {
            const t = libs.get(p.dt1)?.tiles[p.index];
            return (
              <div
                key={pickKey(p)}
                className="thumb dt1c-item"
                {...(t
                  ? hover(() => {
                      const pic = tilePicture(t, palette);
                      const planned = plan?.tiles.find((x) => !x.partner && pickKey(x.from) === pickKey(p));
                      return {
                        tile: t,
                        title: `${short(p.dt1)} #${p.index} · ${ORIENTATION_NAMES[t.orientation] ?? `o${t.orientation}`}`,
                        lines: [
                          [pic ? `${pic.width}×${pic.height} px` : '', `main/sub ${t.mainIndex}/${t.subIndex}`, planned && (planned.newMain !== t.mainIndex || planned.newSub !== t.subIndex) ? `becomes ${planned.newMain}/${planned.newSub}` : '']
                            .filter(Boolean)
                            .join(' · '),
                          'Click: show its library · ×: remove',
                        ],
                      };
                    })
                  : {})}
                onClick={() => onShow(p.dt1)}
              >
                {t && <Thumb tile={t} palette={trayPalette(p.dt1)} />}
                <button
                  className="icon-btn dt1c-remove"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPicks((prev) => prev.filter((x) => pickKey(x) !== pickKey(p)));
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="dt1c-form">
        {addTo ? (
          <p className="small">
            Adding the picked tiles to <code>{short(addTo)}</code>
            {addToBytes ? ` (${dt1Count(addToBytes)} tiles now; they stay as they are, the new ones go after them)` : ''}.{' '}
            <button className="link small" onClick={onStopAdding}>
              Make a new DT1 instead
            </button>
          </p>
        ) : (
          <>
        <label className="form-row">
          <span>Name</span>
          <input className="mono" value={name} maxLength={40} placeholder="e.g. GuildMix" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <p className="muted small">
          Keep it short ({RECOMMENDED_NAME_LENGTH} characters or fewer is best; at most {Math.max(0, maxCustomNameLength(cleanFolder))} here). Letters, digits and _
          only: spaces, dots, dashes and accents can break the game&apos;s tables and archives.
        </p>
        <label className="form-row">
          <span>Folder</span>
          <input className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
          </>
        )}
        <label className="small dt1c-safe">
          <input type="checkbox" checked={actSafe} onChange={(e) => setActSafe(e.target.checked)} /> Make it act-safe (Act 0 colours)
          <HelpTip text="A DT1 stores palette numbers, not colours, and most numbers mean a different colour in each act: a tile drawn for Act 3 can look wrong in an Act 1 map. This snaps every colour of the picked tiles to the nearest one that looks the same in every act (Gimli's Act 0 palette), judged by how it looks in the act its library was drawn for. The picked tiles then show as they will look in game." />
        </label>
        {actSafe && (
          <p className="muted small">
            {actSpecific === null
              ? 'Loading the Act 0 palette…'
              : actSpecific
                ? `${actSpecific} of the picked tiles use colours that change between acts: they'll be converted (the picked tiles show the result).`
                : 'None of the picked tiles use colours that change between acts: they already look the same in every act.'}
          </p>
        )}
        <div className="dt1c-summary small">
          {plan ? (
            <>
              <div>
                <b>{plan.records.length}</b> tiles into <code>{short(addTo ?? path)}</code>
                {partners ? ` (${partners} added so pieces stay whole: the other half of a corner wall, or animation frames)` : ''}. Pixels, walkability
                (sub-tile flags), sound and roof height are copied as they are.
              </div>
              {plan.renumbered.length > 0 && (
                <details>
                  <summary>{plan.renumbered.length} given a new number, so they don&apos;t mix with tiles this level already loads (or with each other)</summary>
                  <div className="mono">{plan.renumbered.join(' · ')}</div>
                </details>
              )}
              {plan.skipped.length > 0 && <div className="warn-text">Left out: {plan.skipped.join('; ')}</div>}
              {otherActs.length > 0 && !actSafe && (
                <div className="warn-text">
                  Tiles from Act {otherActs.map((a) => a + 1).join('/')} libraries are drawn in this map&apos;s Act {map.ds1.act + 1} colours in game. Check them
                  with Colours → this map&apos;s act, or tick Make it act-safe.
                </div>
              )}
              <div className="muted">
                Then the DT1 is added to this map&apos;s tile libraries, its level type (LvlTypes.txt) and Dt1Mask (LvlPrest.txt), and each tile&apos;s AutoMap.txt
                pieces are copied from the level it came from (originals kept as .bak).
              </div>
            </>
          ) : (
            <span className="muted">Tick tiles to see what the new DT1 will hold.</span>
          )}
          {problem && (name || addTo) && <div className="error-text">{problem}</div>}
          {error && <div className="error-text">{error}</div>}
          {!onCreate && <div className="error-text">No writable mod folder: the DT1 can&apos;t be saved.</div>}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !onCreate || !plan?.records.length || !!problem} onClick={() => void create()}>
            {busy ? (addTo ? 'Adding…' : 'Creating…') : addTo ? `Add ${plan?.records.length || ''} tiles to ${short(addTo).split('/').pop()}` : 'Create DT1 and add it to the map'}
          </button>
        </div>
      </div>
    </div>
  );
}
