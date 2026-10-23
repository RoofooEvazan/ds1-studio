// DT1 Viewer: lists every DT1 in the folders the visitor picks (game, then optionally a mod) and draws their tiles.
// Everything is read locally with the File System Access API; nothing is uploaded or shipped with the page.
import { decodeTile, parseDt1, type Dt1Tile } from '../src/formats/dt1';
import { palettePath, parsePalette, type Palette } from '../src/formats/palette';
import { dt1Act, loadAct0Palette } from '../src/game/act0Palette';
import { guessDrawnAct } from '../src/game/openMap';
import { loadFromDevServer, sourcesFromDirectory } from '../src/vfs/loaders';
import { BlobAccess } from '../src/util/RandomAccess';
import { CLASSIC_MPQS, LayeredFs, LooseSource, MpqSource, RELEVANT_EXT, type FileSource } from '../src/vfs/vfs';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => ($('status').textContent = s);
const ORIENT: Record<number, string> = {
  0: 'Floor', 1: 'Left wall', 2: 'Right wall', 3: 'North corner (right part)', 4: 'North corner (left part)', 5: 'Left end wall', 6: 'Right end wall',
  7: 'South corner', 8: 'Left wall with door', 9: 'Right wall with door', 10: 'Special tile', 11: 'Special tile', 12: 'Pillar / object', 13: 'Shadow',
  14: 'Tree', 15: 'Roof', 16: 'Lower wall (left)', 17: 'Lower wall (right)', 18: 'Lower wall (north corner)', 19: 'Lower wall (south corner)',
};
const kindOf = (o: number) => (o === 0 ? 'floor' : o === 13 ? 'shadow' : o === 15 ? 'roof' : o >= 16 ? 'lower' : o === 10 || o === 11 ? 'special' : o === 12 || o === 14 ? 'tree' : 'wall');

let game: FileSource[] = [], mod: FileSource[] = [];
// Files chosen with the browser's ordinary pickers (they work in C:\Program Files, where Chrome's folder picker
// refuses "system files"): MPQs by name, and loose files under their data/ path.
const mpqFiles = new Map<string, File>();
const looseFiles = new Map<string, File>();
let fs: LayeredFs | null = null;
let palettes: (Palette | null)[] = [];
let act0: Palette | null = null;
let act0Usable: boolean[] | null = null;
let current: { path: string; tiles: Dt1Tile[]; act: number | null; why: string } | null = null;
let selected = -1;

async function pick(includeModMpqs: boolean): Promise<FileSource[] | null> {
  if (!('showDirectoryPicker' in window)) { status('This browser cannot open folders this way: use “Choose MPQ files” instead.'); return null; }
  try {
    const dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: includeModMpqs ? 'dt1mod' : 'dt1game', mode: 'read' });
    status(`Reading ${dir.name}…`);
    return await sourcesFromDirectory(dir, includeModMpqs);
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    status(/system files|not allowed|security/i.test((e as Error).message) || (e as Error).name === 'SecurityError'
      ? 'The browser won’t open that folder (it’s under C:\\Program Files). Use “Choose MPQ files” and select the .mpq files instead.'
      : `Couldn't read that folder: ${(e as Error).message}`);
    return null;
  }
}

/** Sources from the files picked with the ordinary pickers: loose data first, mod MPQs next, then the game's own. */
async function sourcesFromPicked(): Promise<FileSource[]> {
  const sources: FileSource[] = [];
  if (looseFiles.size) sources.push(new LooseSource('chosen folder', new Map([...looseFiles].map(([p, f]) => [p, async () => new Uint8Array(await f.arrayBuffer())]))));
  const names = [...mpqFiles.keys()];
  const order = [...names.filter((n) => !CLASSIC_MPQS.includes(n)).sort(), ...CLASSIC_MPQS.filter((n) => mpqFiles.has(n))];
  for (const n of order) {
    try { sources.push(await MpqSource.open(n, new BlobAccess(mpqFiles.get(n)!))); } catch (e) { status(`${n}: ${(e as Error).message}`); }
  }
  return sources;
}

function addPicked(files: FileList | null) {
  for (const f of [...(files ?? [])]) {
    const name = f.name.toLowerCase();
    if (name.endsWith('.mpq')) { mpqFiles.set(name, f); continue; }
    // In a chosen folder the file's path tells where it belongs: everything from its "data/" on.
    const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, '/');
    const at = rel.toLowerCase().indexOf('data/');
    if (at >= 0 && RELEVANT_EXT.test(name)) looseFiles.set(rel.slice(at), f);
    else if (name.endsWith('.dt1')) looseFiles.set(`data/global/tiles/chosen/${f.name}`, f);
  }
}

async function load() {
  const picked = await sourcesFromPicked();
  fs = new LayeredFs([...mod, ...picked, ...game]);
  palettes = await Promise.all([0, 1, 2, 3, 4].map(async (a) => { const b = await fs!.read(palettePath(a)); return b ? parsePalette(b) : null; }));
  try { const a0 = await loadAct0Palette(fs); act0 = a0.palette; act0Usable = a0.usable; } catch { act0 = null; act0Usable = null; }
  const sel = $('pal') as HTMLSelectElement;
  sel.innerHTML = '<option value="auto">Palette: its own act</option>' + [0, 1, 2, 3, 4].map((a) => `<option value="${a}"${palettes[a] ? '' : ' disabled'}>Act ${a + 1} palette</option>`).join('') + (act0 ? '<option value="act0">Act 0 (act-safe; magenta = changes by act)</option>' : '');
  renderList();
  ($('filter') as HTMLInputElement).disabled = false;
  ($('pickMod') as HTMLButtonElement).disabled = false;
  const n = fs.list((p) => p.endsWith('.dt1')).length;
  const noPal = !palettes.some(Boolean);
  status(!n ? 'No DT1s yet: choose d2data.mpq, d2exp.mpq and patch_d2.mpq (and a mod’s .mpq files) or a data folder.'
    : noPal ? `${n} DT1s, in the shared Act 0 colours (act-specific colours grey): for each act's exact colours, also choose d2data.mpq from your Diablo II folder.`
    : `${n} DT1s from ${fs.sources.length} sources. Nothing leaves your computer.`);
  // Redraw what's open: the files just added may bring its palette or replace its tiles.
  if (current) await open(current.path);
}

function renderList() {
  if (!fs) return;
  const q = ($('filter') as HTMLInputElement).value.trim().toLowerCase();
  const paths = fs.list((p) => p.endsWith('.dt1') && (!q || p.includes(q))).sort();
  const byDir = new Map<string, string[]>();
  for (const p of paths) { const rel = p.replace(/^data\/global\/tiles\//, ''); const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '(tiles)'; byDir.set(dir, [...(byDir.get(dir) ?? []), p]); }
  const list = $('list');
  list.innerHTML = '';
  for (const [dir, files] of byDir) {
    const h = document.createElement('div'); h.className = 'dir'; h.textContent = dir; list.append(h);
    for (const p of files) {
      const el = document.createElement('div');
      el.className = 'file' + (current?.path === p ? ' sel' : '');
      el.textContent = p.split('/').pop()!;
      el.title = `${p}\nfrom ${fs.locate(p) ?? '?'}`;
      el.onclick = () => open(p);
      list.append(el);
    }
  }
  if (!paths.length) list.innerHTML = '<p class="status" style="padding:12px">No DT1s match.</p>';
}

async function open(path: string) {
  if (!fs) return;
  try {
    const tiles = parseDt1((await fs.read(path))!).tiles;
    // The act it was drawn for: its folder says (act1-act4, expansion = Act 5), else its art does: the palette its
    // act-specific pixels blend in best under (DS1 Studio's own test). Wrong-act colours are what look "screwy".
    let act = dt1Act(path), why = 'from its folder';
    const pals = palettes.filter(Boolean) as Palette[];
    if (act === null && pals.length === 5) { act = guessDrawnAct(tiles, pals); why = act === null ? 'too few act colours to tell: Act 1 shown' : 'from its art'; }
    current = { path, tiles, act, why };
    selected = -1;
    $('empty').hidden = true; $('bar').hidden = false;
    $('title').textContent = path.replace(/^data\/global\/tiles\//, '');
    document.querySelectorAll('.file').forEach((el) => el.classList.toggle('sel', (el as HTMLElement).title.startsWith(path + '\n')));
    renderGrid();
    $('info').innerHTML = `<h2>${path.split('/').pop()}</h2><dl><dt>Tiles</dt><dd>${tiles.length}</dd><dt>Drawn for</dt><dd>${act === null ? 'Act 1' : `Act ${act + 1}`} <span class="status">(${why})</span></dd><dt>From</dt><dd>${fs.locate(path) ?? '?'}</dd><dt>Path</dt><dd style="word-break:break-all">${path}</dd></dl><p class="status">Click a tile for details.</p>`;
  } catch (e) { status(`${path}: ${(e as Error).message}`); }
}

function paletteFor(path: string): Palette | null {
  const v = ($('pal') as HTMLSelectElement).value;
  if (v === 'act0') return act0;
  if (v !== 'auto') return palettes[Number(v)];
  const act = current?.path === path ? current.act : dt1Act(path);
  return palettes[act ?? 0] ?? palettes.find(Boolean) ?? stand_in();
}
/**
 * Without the game's palettes (they're in d2data.mpq): the community Act 0 palette, which has the real colour of every
 * slot that's the same in all acts (225 of them), with the 30 act-specific slots in a neutral grey.
 */
let standIn: Palette | null = null;
function stand_in(): Palette {
  if (!act0 || !act0Usable) return GREY;
  if (!standIn) { standIn = act0.slice(); for (let i = 1; i < 256; i++) if (!act0Usable[i]) standIn.set([110, 106, 100, 255], i * 4); }
  return standIn;
}
/**
 * Without the game's palettes the 30 act-specific colours are unknown: give those pixels the average of the known pixels
 * around them, so they blend in instead of showing as grey specks (a few passes reach into larger patches).
 */
function fillUnknown(px: Uint8Array, w: number, h: number, out: Uint8ClampedArray, known: boolean[]) {
  let todo: number[] = [];
  for (let k = 0; k < px.length; k++) if (px[k] && !known[px[k]]) todo.push(k);
  const done = new Uint8Array(px.length);
  for (let k = 0; k < px.length; k++) if (px[k] && known[px[k]]) done[k] = 1;
  for (let pass = 0; pass < 6 && todo.length; pass++) {
    const next: number[] = [], set: [number, number, number, number][] = [];
    for (const k of todo) {
      const x = k % w, y = (k - x) / w;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx; if (!done[j]) continue;
        r += out[j * 4]; g += out[j * 4 + 1]; b += out[j * 4 + 2]; n++;
      }
      if (n) set.push([k, r / n, g / n, b / n]); else next.push(k);
    }
    for (const [k, r, g, b] of set) { out[k * 4] = r; out[k * 4 + 1] = g; out[k * 4 + 2] = b; done[k] = 1; }
    todo = next;
  }
}
/** Last resort (offline, no game palette): grey by index. */
const GREY: Palette = Uint8Array.from({ length: 1024 }, (_, i) => (i % 4 === 3 ? 255 : Math.round(((i >> 2) / 255) ** 0.8 * 255)));

function renderGrid() {
  if (!current) return;
  const pal = paletteFor(current.path);
  const kind = ($('kind') as HTMLSelectElement).value;
  const zoom = Number(($('zoom') as HTMLSelectElement).value);
  const grid = $('grid');
  grid.innerHTML = '';
  let shown = 0;
  current.tiles.forEach((t, i) => {
    if (kind && kindOf(t.orientation) !== kind) return;
    const img = decodeTile(t);
    const box = document.createElement('div');
    box.className = 'tile' + (i === selected ? ' sel' : '');
    box.title = `${ORIENT[t.orientation] ?? t.orientation} ${t.orientation}/${t.mainIndex}/${t.subIndex}`;
    if (img && img.width && img.height && pal) {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      // 100% = one tile pixel per screen pixel, as in game (Windows display scaling would otherwise stretch tiles by
      // 1.25 or 1.5 and make every pixel uneven). Hard pixel edges only where each pixel covers whole screen pixels.
      const scale = zoom / (window.devicePixelRatio || 1);
      c.style.width = `${img.width * scale}px`; c.style.height = `${img.height * scale}px`;
      c.style.imageRendering = Number.isInteger(zoom) ? 'pixelated' : 'auto';
      const ctx = c.getContext('2d')!;
      const data = ctx.createImageData(img.width, img.height);
      for (let k = 0; k < img.pixels.length; k++) { const p = img.pixels[k]; if (!p) continue; data.data[k * 4] = pal[p * 4]; data.data[k * 4 + 1] = pal[p * 4 + 1]; data.data[k * 4 + 2] = pal[p * 4 + 2]; data.data[k * 4 + 3] = 255; }
      if (pal === standIn && act0Usable) fillUnknown(img.pixels, img.width, img.height, data.data, act0Usable);
      ctx.putImageData(data, 0, 0);
      box.append(c);
    } else { const e = document.createElement('div'); e.style.cssText = 'width:40px;height:20px'; box.append(e); }
    const label = document.createElement('span'); label.textContent = `${t.orientation}/${t.mainIndex}/${t.subIndex}`; box.append(label);
    box.onclick = () => { selected = i; document.querySelectorAll('.tile.sel').forEach((el) => el.classList.remove('sel')); box.classList.add('sel'); info(t, i); };
    grid.append(box);
    shown++;
  });
  $('count').textContent = `${shown} of ${current.tiles.length} tiles`;
}

function info(t: Dt1Tile, i: number) {
  const img = decodeTile(t);
  // File order runs bottom-up: show the 5x5 grid as seen on screen (row 4 of the file first).
  const flags = Array.from({ length: 25 }, (_, k) => t.subTileFlags[(4 - Math.floor(k / 5)) * 5 + (k % 5)]);
  $('info').innerHTML = `<h2>${ORIENT[t.orientation] ?? 'Orientation ' + t.orientation}</h2><dl>
    <dt>Number</dt><dd>${t.orientation} / ${t.mainIndex} / ${t.subIndex}</dd>
    <dt>Index</dt><dd>${i} in the file</dd>
    <dt>Size</dt><dd>${img ? `${img.width} × ${img.height}` : 'empty'}</dd>
    <dt>${t.animated ? 'Frame' : 'Rarity'}</dt><dd>${t.rarity}${t.animated ? ' (animated)' : ''}</dd>
    <dt>Blocks</dt><dd>${t.blocks.length}</dd>
  </dl>
  <p class="status" style="margin:10px 0 0">Walkability (red = blocks walking):</p>
  <div class="flags">${flags.map((f) => `<div class="${f & 1 ? 'block' : ''}" title="flags 0x${f.toString(16).padStart(2, '0')}">${f ? f.toString(16) : ''}</div>`).join('')}</div>`;
}

$('pickGame').onclick = async () => { const s = await pick(false); if (s) { game = s; await load(); } };
$('pickMod').onclick = async () => { const s = await pick(true); if (s) { mod = s; await load(); } };
const mpqInput = $('mpqInput') as HTMLInputElement, dirInput = $('dirInput') as HTMLInputElement;
$('pickMpqs').onclick = () => mpqInput.click();
$('pickDir').onclick = () => dirInput.click();
for (const input of [mpqInput, dirInput]) input.onchange = async () => { status('Reading…'); addPicked(input.files); input.value = ''; await load(); };
$('filter').oninput = renderList;
for (const id of ['kind', 'pal', 'zoom']) $(id).onchange = renderGrid;

// Local development only: the dev server can serve a test installation (absent on the published page).
if (!location.search.includes("nodev")) void loadFromDevServer().then(async (dev) => { if (dev) { game = dev.sources; await load(); } });
