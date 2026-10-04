import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Palette } from '../formats/palette';
import type { GameData } from '../game/GameData';

export interface ObjectGalleryProps {
  gd: GameData;
  /** DS1 act, 0-based. */
  act: number;
  palette: Palette;
  placing: { type: number; id: number } | null;
  onPlace: (o: { type: number; id: number }) => void;
}

type TypeFilter = 'all' | 1 | 2;

const FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 1, label: 'NPCs' },
  { id: 2, label: 'Objects' },
];

const SIZE_KEY = 'ds1studio.objThumbSize';
/** Object ids per act in the game's DS1 object table (see GameData.objRow). */
const OBJECTS_PER_ACT = 150;

/** Thumbnail data URLs (null = no sprite), per GameData, then "palette#:act:type:id". */
const thumbCache = new WeakMap<GameData, Map<string, Promise<string | null>>>();
const paletteIds = new WeakMap<Palette, number>();
let nextPaletteId = 1;

function paletteId(p: Palette): number {
  let id = paletteIds.get(p);
  if (!id) paletteIds.set(p, (id = nextPaletteId++));
  return id;
}

function objectThumb(gd: GameData, act: number, type: number, id: number, palette: Palette): Promise<string | null> {
  let byGd = thumbCache.get(gd);
  if (!byGd) thumbCache.set(gd, (byGd = new Map()));
  const key = `${paletteId(palette)}:${act}:${type}:${id}`;
  let p = byGd.get(key);
  if (!p) {
    p = gd.objectSprite(act, type, id).then(
      (s) => {
        if (!s || s.width <= 0 || s.height <= 0) return null;
        const canvas = document.createElement('canvas');
        canvas.width = s.width;
        canvas.height = s.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        const img = ctx.createImageData(s.width, s.height);
        for (let i = 0; i < s.pixels.length; i++) {
          const v = s.pixels[i];
          if (!v) continue;
          const o = i * 4;
          img.data[o] = palette[v * 4];
          img.data[o + 1] = palette[v * 4 + 1];
          img.data[o + 2] = palette[v * 4 + 2];
          img.data[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return canvas.toDataURL();
      },
      () => null,
    );
    byGd.set(key, p);
  }
  return p;
}

const ObjThumb = memo(function ObjThumb({ gd, act, type, id, name, palette }: { gd: GameData; act: number; type: number; id: number; name: string; palette: Palette }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  // Load lazily, only once the thumbnail scrolls into view.
  useEffect(() => {
    const el = ref.current!;
    let cancelled = false;
    setUrl(undefined);
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      objectThumb(gd, act, type, id, palette).then((u) => !cancelled && setUrl(u));
    });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [gd, act, type, id, palette]);
  return (
    <div ref={ref} className={`og-img${url === undefined ? ' loading' : ''}`} style={url ? { backgroundImage: `url(${url})` } : undefined}>
      {url === null && <span className={`og-initial og-t${type}`}>{(name.trim()[0] ?? '?').toUpperCase()}</span>}
    </div>
  );
});

/** Visual picker of every placeable object/NPC of an act; clicking one starts placing it. */
export function ObjectGallery({ gd, act, palette, placing, onPlace }: ObjectGalleryProps) {
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [query, setQuery] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => {
    try {
      return Number(localStorage.getItem(SIZE_KEY)) || 64;
    } catch {
      return 64;
    }
  });

  // Ctrl + wheel zooms the thumbnails (native listener so the page doesn't zoom).
  useEffect(() => {
    const el = grid.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setSize((t) => {
        const next = Math.round(Math.min(240, Math.max(36, t * Math.exp(-e.deltaY * 0.0015))));
        try {
          localStorage.setItem(SIZE_KEY, String(next));
        } catch {
          // per-viewer convenience only
        }
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Objects of another act. An id below 150 is read in the map's act table and runs back into earlier acts' (150
  // objects per act), so an Act 5 map places Act 1's object 0 as id -600, as WinDS1 maps do. An id of 150 or more
  // is an objects.txt row (id - 150), which is how a later act's object is placed.
  const [fromAct, setFromAct] = useState(act);
  useEffect(() => setFromAct(act), [act]);
  const shift = (fromAct - act) * OBJECTS_PER_ACT;
  const all = useMemo(
    () =>
      gd
        .objectList(fromAct)
        .filter((o) => fromAct === act || (o.type === 2 && (fromAct < act || o.row !== undefined)))
        .map((o) => ({ ...o, id: o.type !== 2 || fromAct === act ? o.id : fromAct < act ? o.id + shift : OBJECTS_PER_ACT + o.row!, own: o.id })),
    [gd, act, fromAct, shift],
  );
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (o) =>
        (filter === 'all' || o.type === filter) &&
        (!q || o.name.toLowerCase().includes(q) || String(o.id) === q || `${o.type}/${o.id}` === q || `${o.type},${o.id}` === q),
    );
  }, [all, filter, query]);

  return (
    <div className="og">
      <div className="og-controls">
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={String(f.id)} className={`chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="small og-act" title="Objects of another act, placed with the id that reaches them from this map's act (negative for earlier acts, e.g. -600 for Act 1's object 0 in an Act 5 map; 150 + the objects.txt row for later acts). NPCs only come from the map's own act.">
          Act{' '}
          <select value={fromAct} onChange={(e) => setFromAct(Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map((a) => (
              <option key={a} value={a}>
                {a + 1}
                {a === act ? ' (this map)' : ''}
              </option>
            ))}
          </select>
        </label>
        <input
          className="search small-input og-search"
          placeholder="Name or id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              if (query) setQuery('');
              else (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
      <div
        className="og-grid"
        ref={grid}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 18}px, 1fr))`, ['--og-h' as string]: `${size}px` }}
        title="Ctrl + scroll to zoom the thumbnails"
      >
        {items.map((o) => {
          const active = !!placing && placing.type === o.type && placing.id === o.id;
          return (
            <button
              key={`${o.type}:${o.id}`}
              className={`og-item${active ? ' active' : ''}`}
              title={`${o.name} · ${o.type === 1 ? 'NPC' : 'object'} ${o.type}/${o.id}${fromAct !== act ? ` (Act ${fromAct + 1} object ${o.own})` : ''}${active ? ' (placing — click the map)' : ''}`}
              onClick={() => onPlace({ type: o.type, id: o.id })}
            >
              <ObjThumb gd={gd} act={act} type={o.type} id={o.id} name={o.name} palette={palette} />
              <span className="og-name">{o.name}</span>
              <span className="og-id">
                {o.type}/{o.id}
              </span>
            </button>
          );
        })}
        {items.length === 0 && (
          <div className="muted small pad">
            {all.length === 0 ? 'No object list for this act (needs the game’s D2Common.dll / Game.exe, or MonPreset.txt).' : 'No matching objects.'}
          </div>
        )}
      </div>
    </div>
  );
}
