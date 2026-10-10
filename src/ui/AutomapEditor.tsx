import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SpriteFrame } from '../formats/dc6';
import type { Palette } from '../formats/palette';
import {
  AUTOMAP_CODE_NAMES,
  AUTOMAP_CODES,
  AUTOMAP_SCALE,
  automapCellOrigin,
  automapPieces,
  describeRule,
  editKey,
  findRule,
  suggestAutomap,
  usualCels,
  type AutomapColors,
  type AutomapEdit,
  type AutomapTable,
} from '../game/automap';
import { AUTOMAP_KIND_LIST, AUTOMAP_PARTS, AUTOMAP_RECOLOUR, automapCanvas, automapFrame, lookOf, type AutomapKind, type AutomapStyle, type DrawPiece } from '../game/automapStyle';
import type { OpenMap } from '../game/openMap';
import { renderMapCanvas } from '../render/exportImage';
import type { Scene } from '../render/scene';
import { AutomapLook, KindIcon } from './AutomapLook';
import { CelThumb } from './AutomapPanel';
import { Thumb } from './TilePalette';

interface Props {
  map: OpenMap;
  /** The map as drawn, for showing it under the automap. */
  scene: Scene;
  table: AutomapTable;
  cels: SpriteFrame[];
  palette: Palette;
  level: string;
  onLevel: (level: string) => void;
  levelLabel: (level: string) => string;
  canSave: boolean;
  onSave: (edits: AutomapEdit[]) => Promise<void>;
  /** Colours and look-alike references for suggestions (may take a moment the first time). */
  makeColors: () => Promise<AutomapColors | undefined>;
  /** How the automap is drawn (shared with the map's Automap view). */
  style: AutomapStyle;
  onStyle: (s: AutomapStyle) => void;
  /** The category of a tile (floors: walkable or water, by the tile). */
  kindOf: (orientation: number, main: number, sub: number) => AutomapKind;
  onClose: () => void;
}

/** One kind of tile on the map (same orientation / style / sequence), its category, and where it is. */
interface Group {
  key: string;
  orientation: number;
  style: number;
  sub: number;
  layer: 'floor' | 'wall';
  kind: AutomapKind;
  cells: [number, number][];
}

type Status = 'shown' | 'hidden' | 'missing';
const statusOf = (cels: number[] | null): Status => (cels === null ? 'missing' : cels.length ? 'shown' : 'hidden');
const partsOf = (k: AutomapKind) => AUTOMAP_PARTS.filter((p) => p.kind === k);

/** Categories where a tile without an entry is a hole in the automap (walls); for the rest (floors, trees…) it is normal. */
const HOLE_KINDS: AutomapKind[] = ['walls'];

/**
 * The automap editor, by category: walls, walkable floors, water, roofs, objects & trees, shadows. Choosing a category
 * highlights all its tiles on a preview of the automap over the map itself (a slider fades between the two), and the
 * right-hand side sets its colour, opacity and piece (its "texture") for all of it at once. A category's tile kinds
 * can be opened to change them one by one. Nothing is written until "Save".
 */
export function AutomapEditor({ map, scene, table, cels, palette, level, onLevel, levelLabel, canSave, onSave, makeColors, style, onStyle, kindOf, onClose }: Props) {
  const [edits, setEdits] = useState<Map<string, AutomapEdit>>(new Map());
  const [category, setCategory] = useState<AutomapKind>('walls');
  /** Tile kinds picked one by one (the category's details); empty = the whole category. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** A part of the category (Left walls, Corners…), or null for all of it. */
  const [sub, setSub] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lastClicked = useRef<string | null>(null);
  /** Home in the editor: the preview to exactly 10% (pixel-perfect automap). */
  const [zoom10, setZoom10] = useState(0);

  // A new level starts over.
  useEffect(() => {
    setEdits(new Map());
    setSelected(new Set());
  }, [level]);

  const pieces = useMemo(() => automapPieces(map.ds1, table, level), [map, table, level]);
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const p of pieces) {
      const k = editKey(p.orientation, p.main, p.sub);
      const g = m.get(k) ?? m.set(k, { key: k, orientation: p.orientation, style: p.main, sub: p.sub, layer: p.layer, kind: kindOf(p.orientation, p.main, p.sub), cells: [] }).get(k)!;
      g.cells.push([p.cellX, p.cellY]);
    }
    return [...m.values()].sort((a, b) => a.orientation - b.orientation || a.style - b.style || a.sub - b.sub);
  }, [pieces, kindOf]);

  const fileCels = useCallback(
    (g: Group): number[] | null => {
      const r = findRule(table, level, g.orientation, g.style, g.sub);
      return r ? r.cels.map((c) => c.cel) : null;
    },
    [table, level],
  );
  const celsOf = useCallback((g: Group): number[] | null => edits.get(g.key)?.cels ?? fileCels(g), [edits, fileCels]);

  /** Per category: its kinds, tiles, and how many tiles are shown / left off / without an entry. */
  const summary = useMemo(() => {
    const out = new Map<AutomapKind, { groups: Group[]; tiles: number; shown: number; hidden: number; none: number }>();
    for (const k of AUTOMAP_KIND_LIST) out.set(k.id, { groups: [], tiles: 0, shown: 0, hidden: 0, none: 0 });
    for (const g of groups) {
      const s = out.get(g.kind)!;
      s.groups.push(g);
      s.tiles += g.cells.length;
      const st = statusOf(celsOf(g));
      if (st === 'shown') s.shown += g.cells.length;
      else if (st === 'hidden') s.hidden += g.cells.length;
      else s.none += g.cells.length;
    }
    return out;
  }, [groups, celsOf]);
  const present = AUTOMAP_KIND_LIST.filter((k) => summary.get(k.id)!.groups.length);
  const holes = HOLE_KINDS.reduce((n, k) => n + summary.get(k)!.none, 0);
  const allCatGroups = summary.get(category)!.groups;
  const subsOf = (k: AutomapKind) => partsOf(k).filter((sg) => summary.get(k)!.groups.some((g) => sg.codes.includes(AUTOMAP_CODES[g.orientation] ?? '')));
  const subInfo = sub ? partsOf(category).find((sg) => sg.id === sub) ?? null : null;
  const catGroups = subInfo ? allCatGroups.filter((g) => subInfo.codes.includes(AUTOMAP_CODES[g.orientation] ?? '')) : allCatGroups;

  const setCels = (targets: Group[], value: number[] | ((current: number[] | null) => number[])) =>
    setEdits((prev) => {
      const next = new Map(prev);
      for (const g of targets) {
        const v = typeof value === 'function' ? value(celsOf(g)) : value;
        const file = fileCels(g);
        if (file && file.join(',') === v.join(',')) next.delete(g.key);
        else next.set(g.key, { orientation: g.orientation, style: g.style, sub: g.sub, cels: v });
      }
      return next;
    });
  const revert = (targets: Group[]) =>
    setEdits((prev) => {
      const next = new Map(prev);
      for (const g of targets) next.delete(g.key);
      return next;
    });
  const suggestFor = async (targets: Group[]) => {
    setMessage('Analysing tiles: comparing them with tiles this level (and the rest of the game) already puts on the automap…');
    const colors = await makeColors();
    const missing = pieces.filter((p) => targets.some((g) => g.orientation === p.orientation && g.style === p.main && g.sub === p.sub));
    const out: { leaveOff?: Set<string> } = {};
    const s = suggestAutomap(table, level, missing.map((p) => ({ ...p, rule: null })), { floors: true, colors }, out);
    const bySeq = new Map<string, number>();
    for (const x of s) for (const q of x.seqs) bySeq.set(`${x.orientation}|${x.style}|${q}`, x.cel);
    const pieceFor = targets.filter((g) => bySeq.has(g.key));
    const off = targets.filter((g) => !bySeq.has(g.key) && out.leaveOff?.has(g.key));
    for (const g of pieceFor) setCels([g], [bySeq.get(g.key)!]);
    if (off.length) setCels(off, []);
    const none = targets.length - pieceFor.length - off.length;
    setMessage(
      `Suggested: ${pieceFor.length} tile kind${pieceFor.length === 1 ? '' : 's'} get a piece` +
        (off.length ? `, ${off.length} look like tiles the level leaves off the automap (left off)` : '') +
        (none ? `, ${none} without a confident match (left as they are)` : '') +
        '. Check the preview, then save.',
    );
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave([...edits.values()]);
      setEdits(new Map());
      setMessage('Saved to AutoMap.txt');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickCategory = (k: AutomapKind) => {
    setCategory(k);
    setSub(null);
    setSelected(new Set());
  };
  const clickKind = (g: Group, e: React.MouseEvent) => {
    setSelected((prev) => {
      if (e.shiftKey && lastClicked.current) {
        const a = catGroups.findIndex((x) => x.key === lastClicked.current);
        const b = catGroups.findIndex((x) => x.key === g.key);
        if (a >= 0 && b >= 0) {
          const next = new Set(prev);
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(catGroups[i].key);
          return next;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(g.key)) next.delete(g.key);
        else next.add(g.key);
        return next;
      }
      return new Set([g.key]);
    });
    lastClicked.current = g.key;
  };
  const sel = groups.filter((g) => selected.has(g.key));
  const highlight = useMemo(() => new Set((sel.length ? sel : catGroups).map((g) => g.key)), [sel, catGroups]);
  const tint = (k: AutomapKind) => (style.colours === 'kind' ? style.kinds[k].colour : undefined);
  const catLabel = AUTOMAP_KIND_LIST.find((k) => k.id === category)!.label;

  return (
    <div className="modal-backdrop">
      <div
        className="modal am-editor"
        role="dialog"
        aria-label="Automap editor"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Home' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) {
            e.preventDefault();
            setZoom10((n) => n + 1);
          }
        }}
      >
        <div className="ame-head">
          <div className="modal-title">Automap editor</div>
          <label className="small">
            AutoMap.txt level{' '}
            <select value={level} onChange={(e) => (!edits.size || window.confirm('Discard the unsaved automap changes?')) && onLevel(e.target.value)}>
              {(table.levels.includes(level) ? table.levels : [level, ...table.levels]).map((l) => (
                <option key={l} value={l}>
                  {levelLabel(l)}
                  {table.levels.includes(l) ? '' : ' (new: no entries yet)'}
                </option>
              ))}
            </select>
          </label>
          {holes > 0 ? (
            <span className="ame-stat missing" title="Walls with no AutoMap.txt entry: holes in the automap">
              {holes} wall tiles missing
            </span>
          ) : (
            <span className="ame-stat shown">No walls missing</span>
          )}
          <span className="muted small ame-help">Pick a category on the left: its tiles light up on the preview, and the right side sets how it looks and which piece it draws.</span>
        </div>
        <div className="ame-body">
          {/* Categories: compact tabs, then the chosen one's parts and its tile kinds (most of the room) */}
          <div className="ame-list">
            <div className="amc-tabs" role="tablist" aria-label="Automap categories">
              {present.map((k) => {
                const s = summary.get(k.id)!;
                const hole = HOLE_KINDS.includes(k.id) && s.none > 0;
                return (
                  <button
                    key={k.id}
                    role="tab"
                    aria-selected={category === k.id}
                    className={`amc-tab${category === k.id ? ' active' : ''}${style.kinds[k.id].show ? '' : ' hidden-kind'}`}
                    onClick={() => pickCategory(k.id)}
                    title={`${k.label}: ${s.tiles} tiles · ${s.shown} shown${s.none ? ` · ${s.none} ${HOLE_KINDS.includes(k.id) ? 'missing' : 'not drawn'}` : ''}${s.hidden ? ` · ${s.hidden} left off` : ''}\n${k.hint}`}
                  >
                    <KindIcon kind={k.id} colour={style.kinds[k.id].colour} size={20} />
                    {hole && <span className="amc-tab-dot" aria-label="tiles missing" />}
                  </button>
                );
              })}
            </div>
            {(() => {
              const k = AUTOMAP_KIND_LIST.find((x) => x.id === category)!;
              const s = summary.get(category)!;
              const hole = HOLE_KINDS.includes(category);
              const subs = subsOf(category);
              return (
                <div className="amc-info">
                  <div className="amc-info-head">
                    <span className="amc-name">{k.label}</span>
                    <label className="amc-eye small" title="Show on the automap (the look only; nothing is written)">
                      <input type="checkbox" checked={style.kinds[category].show} onChange={(e) => onStyle({ ...style, kinds: { ...style.kinds, [category]: { ...style.kinds[category], show: e.target.checked } } })} /> Show
                    </label>
                  </div>
                  <div className="small">
                    <span className="muted">
                      {s.tiles} tiles · {s.groups.length} kind{s.groups.length === 1 ? '' : 's'} ·{' '}
                    </span>
                    <span className="ok-text">{s.shown} shown</span>
                    {s.none > 0 && <span className={hole ? 'amc-hole' : 'muted'}> · {s.none} {hole ? 'missing' : 'not drawn'}</span>}
                    {s.hidden > 0 && <span className="muted"> · {s.hidden} left off</span>}
                  </div>
                  {subs.length > 1 && (
                    <div className="amc-subs">
                      {subs.map((sg) => {
                        const list = s.groups.filter((g) => sg.codes.includes(AUTOMAP_CODES[g.orientation] ?? ''));
                        const n = list.reduce((a, g) => a + g.cells.length, 0);
                        const none = list.filter((g) => celsOf(g) === null).reduce((a, g) => a + g.cells.length, 0);
                        // The piece most of the part's tiles draw now.
                        const use = new Map<number, number>();
                        for (const g of list) for (const c of celsOf(g)?.slice(0, 1) ?? []) use.set(c, (use.get(c) ?? 0) + g.cells.length);
                        const top = [...use].sort((a, b) => b[1] - a[1])[0]?.[0];
                        return (
                          <button
                            key={sg.id}
                            className={`amc-sub${sub === sg.id ? ' active' : ''}`}
                            onClick={() => {
                              setSub(sub === sg.id ? null : sg.id);
                              setSelected(new Set());
                            }}
                            title={`${sg.codes.map((c) => AUTOMAP_CODE_NAMES[c] ?? c).join(', ')}: click to see and replace their pieces (again: the whole category)`}
                          >
                            <span className="amc-sub-name">{sg.label}</span>
                            <span className="muted small">
                              {n} tiles{none ? <span className={hole ? 'amc-hole' : ''}> · {none} {hole ? 'missing' : 'not drawn'}</span> : null}
                            </span>
                            <span className="amc-sub-piece">{top !== undefined ? <CelThumb frame={cels[top]} palette={palette} fit={22} tint={style.colours === 'kind' ? lookOf(style, category, sg.id).colour : undefined} /> : <span className="ame-badge hidden">off</span>}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="field-label amc-kinds-title">
              {subInfo ? subInfo.label : catLabel}: tile kinds one by one ({catGroups.length})
            </div>
            <div className="ame-rows">
              {catGroups.map((g) => {
                const c = celsOf(g);
                const st = statusOf(c);
                const tile = map.lib.pick(g.orientation, g.style, g.sub, 0);
                const code = AUTOMAP_CODES[g.orientation];
                return (
                  <div key={g.key} className={`ame-row${selected.has(g.key) ? ' selected' : ''}${edits.has(g.key) ? ' changed' : ''}`} onClick={(e) => clickKind(g, e)}>
                    <div className="ame-tile">{tile ? <Thumb tile={tile} palette={palette} /> : null}</div>
                    <div className="ame-what">
                      <div>
                        <code>{code}</code> <span className="small">{AUTOMAP_CODE_NAMES[code] ?? ''}</span>
                        {edits.has(g.key) && <span className="small warn-text"> · changed</span>}
                      </div>
                      <div className="muted small">
                        style {g.style} · seq {g.sub} · {g.cells.length} on map
                      </div>
                    </div>
                    <div className={`ame-piece ${st}`}>
                      {st === 'shown' ? (
                        c!.map((cel, i) => <CelThumb key={i} frame={cels[cel]} palette={palette} fit={40} tint={tint(g.kind)} title={`piece ${cel}`} />)
                      ) : (
                        <span className={`ame-badge ${st === 'missing' && !HOLE_KINDS.includes(g.kind) ? 'hidden' : st}`}>{st === 'missing' ? (HOLE_KINDS.includes(g.kind) ? 'missing' : 'not drawn') : 'off'}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Preview: the automap over the map */}
          <AutomapPreview map={map} scene={scene} groups={groups} celsOf={celsOf} cels={cels} palette={palette} highlight={highlight} style={style} onStyle={onStyle} zoom10={zoom10} />

          {/* The category (or the kinds picked in it) */}
          {sel.length ? (
            <PiecePanel
              tint={tint(sel[0].kind)}
              table={table}
              level={level}
              cels={cels}
              palette={palette}
              selection={sel}
              celsOf={celsOf}
              fileCels={fileCels}
              edited={(g) => edits.has(g.key)}
              onSet={(value) => setCels(sel, value)}
              onRevert={() => revert(sel)}
              onSuggest={() => void suggestFor(sel)}
              onBack={() => setSelected(new Set())}
            />
          ) : (
            <CategoryPanel
              key={`${category}|${sub ?? ''}`}
              category={category}
              part={subInfo ? { id: subInfo.id, label: subInfo.label } : null}
              groups={catGroups}
              table={table}
              level={level}
              levelLabel={levelLabel}
              cels={cels}
              palette={palette}
              style={style}
              onStyle={onStyle}
              celsOf={celsOf}
              lib={map.lib}
              onApply={(targets, value) => setCels(targets, value)}
              onRevert={() => revert(catGroups)}
              changed={catGroups.some((g) => edits.has(g.key))}
              onSuggest={(targets) => void suggestFor(targets)}
              onMessage={setMessage}
            />
          )}
        </div>
        <div className="modal-actions">
          <span className="muted small ame-foot">
            {message ??
              (edits.size
                ? `${edits.size} unsaved change${edits.size === 1 ? '' : 's'}. Saving writes AutoMap.txt in your mod folder (original kept as .bak); rebuild automap.bin for the game to see it.`
                : `${AUTOMAP_RECOLOUR ? 'Colour, opacity' : 'Opacity'} and show/hide only change how DS1 Studio draws the automap; pieces are what the game draws, written on Save.`)}
          </span>
          <button className="btn" disabled={!edits.size} onClick={() => window.confirm('Discard all unsaved automap changes?') && setEdits(new Map())}>
            Discard
          </button>
          <button className="btn" onClick={() => (!edits.size || window.confirm('Close without saving your automap changes?')) && onClose()}>
            Close
          </button>
          <button className="btn primary" disabled={!canSave || !edits.size || busy} onClick={() => void save()} title={canSave ? '' : 'No writable mod folder'}>
            {busy ? 'Saving…' : `Save to AutoMap.txt${edits.size ? ` (${edits.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One category, all at once: how DS1 Studio draws it (colour, opacity, shown) and the piece the game draws for it —
 * walls and objects one piece per shape (a left wall, a corner, a door each face their own way) from one level's set;
 * floors, water, roofs and shadows one piece for all (or left off the automap).
 */
function CategoryPanel({
  category,
  part,
  groups,
  table,
  level,
  levelLabel,
  cels,
  palette,
  style,
  onStyle,
  celsOf,
  lib,
  onApply,
  onRevert,
  changed,
  onSuggest,
  onMessage,
}: {
  category: AutomapKind;
  /** The part of the category shown (Left walls, Corners…), or null for all of it. */
  part: { id: string; label: string } | null;
  groups: Group[];
  table: AutomapTable;
  level: string;
  levelLabel: (level: string) => string;
  cels: SpriteFrame[];
  palette: Palette;
  style: AutomapStyle;
  onStyle: (s: AutomapStyle) => void;
  celsOf: (g: Group) => number[] | null;
  lib: OpenMap['lib'];
  onApply: (targets: Group[], cels: number[]) => void;
  onRevert: () => void;
  changed: boolean;
  onSuggest: (targets: Group[]) => void;
  onMessage: (m: string) => void;
}) {
  const info = AUTOMAP_KIND_LIST.find((k) => k.id === category)!;
  const perShape = category === 'walls' || category === 'objects';
  const [keep, setKeep] = useState(false);
  const [from, setFrom] = useState(level);
  const usual = useMemo(() => usualCels(table, from, { acrossActs: true }), [table, from]);
  const codeOf = (g: Group) => AUTOMAP_CODES[g.orientation] ?? '';
  const shapes = useMemo(() => {
    const m = new Map<string, Group[]>();
    for (const g of groups) (m.get(codeOf(g)) ?? m.set(codeOf(g), []).get(codeOf(g))!).push(g);
    return m;
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The piece most of these tiles draw now. */
  const current = (list: Group[]): number[] => {
    const n = new Map<number, number>();
    for (const g of list) for (const c of celsOf(g)?.slice(0, 1) ?? []) n.set(c, (n.get(c) ?? 0) + g.cells.length);
    const best = [...n].sort((a, b) => b[1] - a[1])[0];
    return best ? [best[0]] : [];
  };
  const [pick, setPick] = useState<Map<string, number[]>>(new Map());
  const code0 = perShape ? null : category === 'roofs' ? 'rf' : category === 'shadows' ? 'sh' : 'fl';
  // What a code gets: the piece picked here, else (taking another level's set) that level's, else what it draws now, else the level's usual.
  const chosen = (code: string, list: Group[]): number[] =>
    pick.get(code) ?? (from !== level && usual.has(code) ? [usual.get(code)!] : current(list).length ? current(list) : usual.has(code) ? [usual.get(code)!] : []);
  // A part (Left walls, Corners…) shows its pieces straight away.
  const [active, setActive] = useState<string | null>(() => (part || shapes.size === 1 ? ([...shapes.keys()][0] ?? null) : null));
  const [off, setOff] = useState<Set<string>>(new Set());
  const tint = style.colours === 'kind' ? lookOf(style, category, part?.id).colour : undefined;
  const tiles = (list: Group[]) => list.reduce((n, g) => n + g.cells.length, 0);
  const targets = (list: Group[]) => list.filter((g) => !off.has(g.key) && (!keep || celsOf(g) === null));
  const missing = groups.filter((g) => celsOf(g) === null);
  /**
   * What Apply changes: a shape whose piece was chosen here (or a whole set taken from another level) — all its tiles;
   * any other shape only where it has no entry yet, so the level's own variety (fences, stone walls…) stays. Floors,
   * water, roofs and shadows change once a piece (or "leave off") is chosen.
   */
  const changes = (): [Group[], number[]][] =>
    perShape
      ? [...shapes].map(([code, list]) => [pick.has(code) || from !== level ? targets(list) : targets(list).filter((g) => celsOf(g) === null), chosen(code, list)])
      : pick.has(code0!)
        ? [[targets(groups), chosen(code0!, groups)]]
        : [];
  const changing = changes().reduce((n, [list]) => n + tiles(list), 0);

  const gallery = (code: string, value: number[], set: (v: number[]) => void) => (
    <>
      <div className="amb-gallery-head small">
        Piece for <code>{code}</code> {AUTOMAP_CODE_NAMES[code] ?? ''} —{' '}
        <button className="link" onClick={() => set([])}>
          leave off the automap
        </button>
      </div>
      <PieceGallery table={table} level={level} cels={cels} palette={palette} codes={[code]} tint={tint} active={value} onPick={(c) => set([c])} start={part ? 'all' : 'kind'} />
    </>
  );
  const piece = (value: number[]) =>
    value.length ? <CelThumb frame={cels[value[0]]} palette={palette} fit={34} tint={tint} title={`piece ${value[0]}`} /> : <span className="ame-badge hidden">off</span>;

  const apply = () => {
    for (const [list, value] of changes()) if (list.length) onApply(list, value);
    onMessage(`${part?.label ?? info.label}: ${changing} tiles set${perShape && from !== level ? ` as in ${levelLabel(from)}` : ''}. Check the preview, then save.`);
  };

  return (
    <div className="ame-panel amb">
      <div className="field-label amb-head">
        <span className="amc-title">
          <KindIcon kind={category} colour={style.kinds[category].colour} size={18} /> {info.label}
          {part && <span className="amc-part"> › {part.label}</span>}
        </span>
        <span className="muted small">
          {tiles(groups)} tiles · {groups.length} kinds
        </span>
      </div>
      <div className="amb-section">
        <div className="amb-section-title">Look{part ? `: ${part.label.toLowerCase()} only` : ''}</div>
        <AutomapLook style={style} onChange={onStyle} kinds={[category]} compact single part={part} />
      </div>

      <div className="amb-section amb-texture">
        <div className="amb-section-title">Texture: the piece the game draws</div>
        {category === 'water' && (
          <>
            <p className="muted small">Water is floor nobody can walk on, dark or bluish (so not lava). Untick any of these that aren&apos;t water: they keep their own piece.</p>
            <div className="amb-water">
              {groups.map((g) => {
                const tile = lib.pick(0, g.style, g.sub, 0);
                const on = !off.has(g.key);
                return (
                  <label key={g.key} className={`amb-water-tile${on ? '' : ' off'}`} title={`Floor ${g.style}/${g.sub} · ${g.cells.length} on map`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setOff((o) => {
                          const n = new Set(o);
                          if (n.has(g.key)) n.delete(g.key);
                          else n.add(g.key);
                          return n;
                        })
                      }
                    />
                    {tile ? <Thumb tile={tile} palette={palette} /> : null}
                    <span className="mono tiny">
                      {g.style}/{g.sub}
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}
        {perShape ? (
          <>
            {!part && <p className="muted small">
              {category === 'walls'
                ? 'Each wall shape has its own piece, so it faces the right way. Click a shape to choose another piece, or take a whole set from a level:'
                : 'One piece per kind of object (trees, props). Click one to choose another piece:'}
            </p>}
            <label className="small amb-from">
              Pieces as in{' '}
              <select
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPick(new Map());
                }}
              >
                {(table.levels.includes(level) ? table.levels : [level, ...table.levels]).map((l) => (
                  <option key={l} value={l}>
                    {levelLabel(l)}
                    {l === level ? ' (this level)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {!(part && shapes.size === 1) && <div className="amb-rows">
              {[...shapes].map(([code, list]) => (
                <button key={code} className={`amb-row${active === code ? ' active' : ''}`} onClick={() => setActive(active === code ? null : code)}>
                  <span className="amb-name">
                    <code>{code}</code> {AUTOMAP_CODE_NAMES[code] ?? ''}
                    <span className="muted small"> · {tiles(list)} tiles</span>
                  </span>
                  <span className="amb-piece">{piece(chosen(code, list))}</span>
                </button>
              ))}
            </div>}
            {active && shapes.has(active) && gallery(active, chosen(active, shapes.get(active)!), (v) => setPick((m) => new Map(m).set(active, v)))}
          </>
        ) : (
          <>
            <div className="amb-current small">
              Now: {piece(chosen(code0!, groups))}
              {category === 'floors' && <span className="muted"> The game leaves most floors off the automap.</span>}
            </div>
            {gallery(code0!, chosen(code0!, groups), (v) => setPick((m) => new Map(m).set(code0!, v)))}
          </>
        )}
        <label className="small">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Only tiles without an entry (keep the others as they are)
        </label>
        <div className="ame-actions">
          <button
            className="btn primary"
            disabled={!changing}
            onClick={apply}
            title={perShape ? 'Shapes you chose a piece for change everywhere; the others only where they have no entry' : 'Every tile of the category gets the chosen piece'}
          >
            {changing ? `Apply (${changing} tiles)` : perShape ? 'Nothing to change: choose a piece or a set' : 'Choose a piece (or leave off) first'}
          </button>
          {category === 'walls' && missing.length > 0 && (
            <button className="btn small" onClick={() => onSuggest(missing)} title="The piece this level (or its act) uses for look-alike tiles, for every wall without an entry">
              Suggest for the {missing.length} missing wall kind{missing.length === 1 ? '' : 's'}
            </button>
          )}
          <button className="btn small" disabled={!changed} onClick={onRevert} title="Back to what AutoMap.txt says for this category">
            Revert
          </button>
        </div>
      </div>
    </div>
  );
}

function PiecePanel({
  tint,
  table,
  level,
  cels,
  palette,
  selection,
  celsOf,
  fileCels,
  edited,
  onSet,
  onRevert,
  onSuggest,
  onBack,
}: {
  table: AutomapTable;
  level: string;
  cels: SpriteFrame[];
  palette: Palette;
  selection: Group[];
  celsOf: (g: Group) => number[] | null;
  fileCels: (g: Group) => number[] | null;
  edited: (g: Group) => boolean;
  onSet: (value: number[] | ((current: number[] | null) => number[])) => void;
  onRevert: () => void;
  onSuggest: () => void;
  onBack: () => void;
  /** The selection's category colour, when colouring by category. */
  tint?: string;
}) {
  const [mode, setMode] = useState<'replace' | 'variant'>('replace');
  const codes = [...new Set(selection.map((g) => AUTOMAP_CODES[g.orientation]))];
  const shared = (() => {
    const first = celsOf(selection[0]);
    return selection.every((g) => (celsOf(g) ?? []).join(',') === (first ?? []).join(',')) ? first : undefined;
  })();
  const one = selection.length === 1 ? selection[0] : null;
  const rule = one ? findRule(table, level, one.orientation, one.style, one.sub) : null;

  return (
    <div className="ame-panel">
      <button className="link small" onClick={onBack}>
        ← the whole category
      </button>
      <div className="field-label">
        {one ? (
          <>
            <code>{AUTOMAP_CODES[one.orientation]}</code> style {one.style} · seq {one.sub}
          </>
        ) : (
          `${selection.length} tile kinds selected`
        )}
      </div>
      <div className="muted small">
        {one
          ? rule
            ? `In AutoMap.txt: ${describeRule(rule)} (row ${rule.row + 2})${edited(one) ? ' — changed, not saved yet' : ''}`
            : `No AutoMap.txt entry${edited(one) ? ' — changed, not saved yet' : ''}`
          : `${selection.filter(edited).length} changed · ${selection.filter((g) => fileCels(g) === null).length} without an entry in the file`}
      </div>
      <div className="ame-slots">
        {shared === undefined ? (
          <span className="muted small">Selected kinds use different pieces; picking one sets them all.</span>
        ) : shared === null ? (
          <span className="ame-badge missing">no entry</span>
        ) : shared.length === 0 ? (
          <span className="ame-badge hidden">off</span>
        ) : (
          shared.map((cel, i) => (
            <div key={i} className="ame-slot">
              <CelThumb frame={cels[cel]} palette={palette} fit={72} tint={tint} title={`piece ${cel}`} />
              <span className="mono small">{cel}</span>
              <button className="icon-btn" title="Remove this piece" onClick={() => onSet((cur) => (cur ?? []).filter((_, n) => n !== i))}>
                ×
              </button>
            </div>
          ))
        )}
      </div>
      <div className="ame-actions">
        <button className="btn small" onClick={() => onSet([])} title="Leave this tile off the automap: no AutoMap.txt row for it, as the game does for tiles it does not draw">
          Leave off the automap
        </button>
        <button className="btn small" onClick={onSuggest} title="The piece this level/act normally uses for this kind of tile">
          Suggest
        </button>
        <button className="btn small" disabled={!selection.some(edited)} onClick={onRevert} title="Back to what AutoMap.txt says">
          Revert
        </button>
      </div>
      <div className="ame-gallery-tools small">
        <label>
          <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> click sets the piece
        </label>
        <label>
          <input type="radio" checked={mode === 'variant'} onChange={() => setMode('variant')} /> click adds a random variant (max 4)
        </label>
      </div>
      <PieceGallery
        table={table}
        level={level}
        cels={cels}
        palette={palette}
        codes={codes}
        tint={tint}
        active={shared ?? undefined}
        onPick={(c) => onSet(mode === 'replace' ? [c] : (cur) => [...(cur ?? []).filter((x) => x !== c), c].slice(-4))}
      />
    </div>
  );
}

/**
 * The box every piece is shown in, in automap pixels around its cell: the cell's diamond is x 0-16, y 24-32; walls rise
 * up to 24 pixels above it. Pieces are drawn where the game puts them in it (empty space kept, so the side of the cell
 * a piece sits on shows), the few bigger ones cropped.
 */
const PIECE_BOX = { w: 16, h: 32, top: 24 };

/** One piece in the gallery's box, at a whole-number scale (the same for every piece). */
function PieceTile({ frame, palette, scale, tint }: { frame: SpriteFrame | undefined; palette: Palette; scale: number; tint?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const { w, h, top } = PIECE_BOX;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    if (frame) {
      const t = tint ? [1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16)) : null;
      // As automapCanvas places it: x from the cell's left corner, y from 8 below the cell's top.
      const x0 = frame.offsetX;
      const y0 = top + 8 + frame.offsetY;
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++) {
          const p = frame.pixels[y * frame.width + x];
          const px = x0 + x;
          const py = y0 + y;
          if (!p || px < 0 || py < 0 || px >= w || py >= h) continue;
          img.data.set(t ? [t[0], t[1], t[2], 255] : [palette[p * 4], palette[p * 4 + 1], palette[p * 4 + 2], 255], (py * w + px) * 4);
        }
    }
    ctx.putImageData(img, 0, 0);
  }, [frame, palette, tint]);
  return <canvas ref={ref} className="piece-tile" style={{ width: PIECE_BOX.w * scale, height: PIECE_BOX.h * scale }} />;
}

/** The gallery's settings, remembered in this browser: scale (1x-6x), and whether numbers and names show. */
interface GalleryLook {
  scale: number;
  numbers: boolean;
  names: boolean;
}
const GALLERY_LOOK_KEY = 'ds1studio.automapGallery';
function loadGalleryLook(): GalleryLook {
  const fallback = { scale: 3, numbers: true, names: true };
  try {
    const v = JSON.parse(localStorage.getItem(GALLERY_LOOK_KEY) ?? 'null');
    return v && typeof v === 'object' ? { scale: Math.max(1, Math.min(6, Math.round(Number(v.scale) || 3))), numbers: v.numbers !== false, names: v.names !== false } : fallback;
  } catch {
    return fallback;
  }
}
function saveGalleryLook(look: GalleryLook) {
  try {
    localStorage.setItem(GALLERY_LOOK_KEY, JSON.stringify(look));
  } catch {
    // per-viewer convenience only
  }
}

/**
 * The MaxiMap pieces to choose from: those this level (or its act) uses for these tile codes, all of the level's or
 * act's, or every piece; with a filter by number or name. Every piece is shown at the same scale (Ctrl+wheel over them
 * changes it), and the numbers and names can be hidden (the tooltip has them) to fit more in.
 */
function PieceGallery({
  table,
  level,
  cels,
  palette,
  codes,
  tint,
  active,
  onPick,
  start = 'kind',
}: {
  table: AutomapTable;
  level: string;
  cels: SpriteFrame[];
  palette: Palette;
  codes: string[];
  tint?: string;
  active?: number[];
  onPick: (cel: number) => void;
  /** Which pieces show first: those for this kind of tile, or every piece (those for this kind first). */
  start?: 'kind' | 'all';
}) {
  const [which, setWhich] = useState<'kind' | 'level' | 'act' | 'all'>(start);
  const [filter, setFilter] = useState('');
  const [look, setLookRaw] = useState(loadGalleryLook);
  const setLook = (patch: Partial<GalleryLook>) =>
    setLookRaw((cur) => {
      const next = { ...cur, ...patch };
      saveGalleryLook(next);
      return next;
    });
  const grid = useRef<HTMLDivElement>(null);
  // Ctrl+wheel over the pieces: a whole step bigger or smaller (a React wheel handler can't stop the page zooming).
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!e.deltaY) return;
      setLookRaw((cur) => {
        const next = { ...cur, scale: Math.max(1, Math.min(6, cur.scale + (e.deltaY < 0 ? 1 : -1))) };
        saveGalleryLook(next);
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const act = /^(\d)\s/.exec(level)?.[1];
  const { lists, labels } = useMemo(() => {
    const kind = new Set<number>();
    const lvl = new Set<number>();
    const actSet = new Set<number>();
    const labels = new Map<number, string>();
    for (const rules of table.byKey.values())
      for (const r of rules) {
        for (const c of r.cels) if (c.label && !labels.has(c.cel)) labels.set(c.cel, c.label);
        const sameAct = act ? r.level.startsWith(`${act} `) : r.level === level;
        if (r.level === level) for (const c of r.cels) lvl.add(c.cel);
        if (sameAct) for (const c of r.cels) actSet.add(c.cel);
        if ((r.level === level || sameAct) && codes.includes(r.code)) for (const c of r.cels) kind.add(c.cel);
      }
    return { lists: { kind, level: lvl, act: actSet }, labels };
  }, [table, level, act, codes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const pool = which === 'all' ? cels.map((_, i) => i) : [...(which === 'kind' ? lists.kind : which === 'level' ? lists.level : lists.act)];
  const shown = pool
    .sort((a, b) => Number(lists.kind.has(b)) - Number(lists.kind.has(a)) || a - b)
    .filter((c) => !filter || String(c) === filter.trim() || (labels.get(c) ?? '').toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <div className="ame-gallery-tools">
        <select className="small" value={which} onChange={(e) => setWhich(e.target.value as typeof which)}>
          <option value="kind">Pieces for this kind of tile ({lists.kind.size})</option>
          <option value="level">All of {level}&apos;s pieces ({lists.level.size})</option>
          {act && <option value="act">All Act {act} pieces ({lists.act.size})</option>}
          <option value="all">Every piece ({cels.length})</option>
        </select>
        <input className="small-input" placeholder="name or #" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="ame-gallery-tools small piece-look">
        <span className="segmented" title="Size of every piece (or Ctrl+wheel over the pieces)">
          {[1, 2, 3, 4, 5, 6].map((k) => (
            <button key={k} className={look.scale === k ? 'active' : ''} onClick={() => setLook({ scale: k })}>
              {k}×
            </button>
          ))}
        </span>
        <label title="Show each piece's number">
          <input type="checkbox" checked={look.numbers} onChange={(e) => setLook({ numbers: e.target.checked })} /> Numbers
        </label>
        <label title="Show each piece's name (from AutoMap.txt)">
          <input type="checkbox" checked={look.names} onChange={(e) => setLook({ names: e.target.checked })} /> Names
        </label>
      </div>
      {which !== 'kind' && lists.kind.size > 0 && <div className="muted amb-hint">Framed (and first): the pieces used for this kind of tile.</div>}
      <div ref={grid} className="ame-gallery piece-grid" style={{ gridTemplateColumns: `repeat(auto-fill, ${PIECE_BOX.w * look.scale + 6}px)` }}>
        {shown.map((c) => (
          <button
            key={c}
            className={`piece-cell${active?.includes(c) ? ' active' : ''}${which !== 'kind' && lists.kind.has(c) ? ' fits' : ''}`}
            title={`Piece ${c}${labels.get(c) ? ` · ${labels.get(c)}` : ''}${lists.kind.has(c) ? ' · used for this kind of tile' : ''}`}
            onClick={() => onPick(c)}
          >
            <PieceTile frame={cels[c]} palette={palette} scale={look.scale} tint={tint} />
            {look.numbers && <span className="mono tiny">{c}</span>}
            {look.names && <span className="muted tiny">{labels.get(c) ?? ''}</span>}
          </button>
        ))}
        {!shown.length && <p className="muted small">No pieces here — try “Every piece”.</p>}
      </div>
    </>
  );
}

/**
 * The automap with pending changes over the map itself, zoomable: a slider fades from all map to all automap; the
 * highlighted tile kinds are outlined; walls without an entry outlined in the look's colour.
 */
function AutomapPreview({
  map,
  scene,
  groups,
  celsOf,
  cels,
  palette,
  highlight,
  style,
  onStyle,
  zoom10,
}: {
  map: OpenMap;
  scene: Scene;
  groups: Group[];
  celsOf: (g: Group) => number[] | null;
  cels: SpriteFrame[];
  palette: Palette;
  highlight: Set<string>;
  style: AutomapStyle;
  onStyle: (s: AutomapStyle) => void;
  /** When it changes: zoom to exactly 10% (Home). */
  zoom10: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: 400 });
  const [view, setView] = useState<{ zoom: number; x: number; y: number } | null>(null);
  /** 0 = only the map, 100 = only the automap; in between both, the far one fading. */
  const [mix, setMix] = useState(() => {
    try {
      const saved = localStorage.getItem('ds1studio.automapMix');
      return saved !== null && Number.isFinite(Number(saved)) ? Number(saved) : 60;
    } catch {
      return 60;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ds1studio.automapMix', String(mix));
    } catch {
      // per-viewer convenience only
    }
  }, [mix]);
  const [lookOpen, setLookOpen] = useState(false);
  const pan = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const { width, height } = map.ds1;
  const { ox, oy, W, H } = automapFrame(width, height);

  // The map itself, once (under half the game's size is plenty under the automap).
  const mapImage = useMemo(() => renderMapCanvas(scene, palette, width, height, 0.4), [scene, palette, width, height]);
  // The automap in the chosen look, rebuilt when pieces or the look change.
  const image = useMemo(() => {
    const draw: DrawPiece[] = [];
    for (const g of groups) {
      const list = celsOf(g);
      if (!list?.length) continue;
      for (const [cx, cy] of g.cells) draw.push({ cellX: cx, cellY: cy, kind: g.kind, code: AUTOMAP_CODES[g.orientation], cel: list[(cx * 7 + cy * 13) % list.length] });
    }
    return automapCanvas(width, height, draw, cels, palette, style).canvas;
  }, [groups, celsOf, cels, palette, width, height, style]);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = Math.min(size.w / W, size.h / H) * 0.96;
  const v = view ?? { zoom: fit, x: W / 2, y: H / 2 };
  const dpr = window.devicePixelRatio || 1;
  // The preview is in automap pixels (a tenth of the map's): one per screen (device) pixel is the map view's 10%.
  const percent = v.zoom * dpr * 10;
  const toTenPercent = () => setView({ zoom: 1 / dpr, x: v.x, y: v.y });
  const firstZoom10 = useRef(zoom10);
  useEffect(() => {
    if (zoom10 !== firstZoom10.current) toTenPercent();
  }, [zoom10]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = mix / 100;
  const mapAlpha = Math.min(1, 2 * (1 - t));
  const amAlpha = Math.min(1, 2 * t);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.save();
    // On whole device pixels, so a pixel-perfect zoom stays sharp.
    ctx.translate(Math.round((size.w / 2 - v.x * v.zoom) * dpr) / dpr, Math.round((size.h / 2 - v.y * v.zoom) * dpr) / dpr);
    ctx.scale(v.zoom, v.zoom);
    // The map (world → automap pixels: a tenth of the size, from the frame's origin), darker the more automap shows.
    if (mapAlpha > 0) {
      const b = mapImage.bounds;
      ctx.globalAlpha = mapAlpha;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(mapImage.canvas, b.x / AUTOMAP_SCALE + ox, b.y / AUTOMAP_SCALE + oy, b.w / AUTOMAP_SCALE, b.h / AUTOMAP_SCALE);
      ctx.globalAlpha = mapAlpha * t * 0.6;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    if (amAlpha > 0) {
      ctx.globalAlpha = amAlpha;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      ctx.globalAlpha = 1;
    }
    const corner = (cx: number, cy: number): [number, number] => {
      const [ax, ay] = automapCellOrigin(cx, cy);
      return [ox + ax, oy + ay];
    };
    const diamond = (cx: number, cy: number) => {
      const [x, y] = corner(cx, cy);
      ctx.moveTo(x, y);
      ctx.lineTo(x + 8, y + 4);
      ctx.lineTo(x, y + 8);
      ctx.lineTo(x - 8, y + 4);
      ctx.closePath();
    };
    ctx.lineWidth = 1.5 / v.zoom;
    if (style.missing) {
      ctx.strokeStyle = style.missingColour;
      ctx.beginPath();
      for (const g of groups) if (g.kind === 'walls' && celsOf(g) === null) for (const [cx, cy] of g.cells) diamond(cx, cy);
      ctx.stroke();
    }
    // The chosen category (or kinds), in white: the category colours are gold, blue, green…
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.beginPath();
    for (const g of groups) if (highlight.has(g.key)) for (const [cx, cy] of g.cells) diamond(cx, cy);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }, [size, v.zoom, v.x, v.y, image, mapImage, mapAlpha, amAlpha, t, groups, highlight, celsOf, width, height, ox, oy, W, H, style]);

  const latest = useRef({ v });
  latest.current = { v };
  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = latest.current.v;
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const z = Math.max(0.3, Math.min(24, cur.zoom * Math.exp(-e.deltaY * 0.0025)));
      const ix = cur.x + (sx - r.width / 2) / cur.zoom;
      const iy = cur.y + (sy - r.height / 2) / cur.zoom;
      setView({ zoom: z, x: ix - (sx - r.width / 2) / z, y: iy - (sy - r.height / 2) / z });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="ame-preview">
      <div className="ame-preview-bar small">
        <label className="ame-mix" title="Fade between the map and the automap">
          <span>Map</span>
          <input type="range" min={0} max={100} value={mix} onChange={(e) => setMix(Number(e.target.value))} />
          <span>Automap</span>
        </label>
        <span className="muted">wheel to zoom · drag to pan</span>
        <button className={`btn small${lookOpen ? ' active' : ''}`} onClick={() => setLookOpen(!lookOpen)} title="Colours, opacity, thickness and which categories show">
          Look
        </button>
        <button className="btn small" onClick={toTenPercent} title="Zoom to exactly 10% (Home): one automap pixel per screen pixel, as in game">
          {`${+percent.toFixed(percent < 10 ? 2 : 1)}%`}
        </button>
        <button className="btn small" onClick={() => setView(null)}>
          Fit
        </button>
      </div>
      {lookOpen && (
        <div className="ame-look">
          <AutomapLook style={style} onChange={onStyle} compact />
        </div>
      )}
      <div
        ref={wrap}
        className="ame-canvas"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          pan.current = { px: e.clientX, py: e.clientY, x: v.x, y: v.y, moved: false };
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (!p) return;
          if (Math.abs(e.clientX - p.px) + Math.abs(e.clientY - p.py) > 3) p.moved = true;
          if (p.moved) setView({ zoom: v.zoom, x: p.x - (e.clientX - p.px) / v.zoom, y: p.y - (e.clientY - p.py) / v.zoom });
        }}
        onPointerUp={() => {
          pan.current = null;
        }}
      >
        <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
      </div>
    </div>
  );
}
