import { validateAutomapSave } from '../game/automapSafety';
import { invoke } from '@tauri-apps/api/core';
import type { RandomAccess } from '../util/RandomAccess';
import type { SaveTarget } from './save';
import { CLASSIC_MPQS, GAME_BINARY_FILES, LayeredFs, LooseSource, MpqSource, type FileSource } from './vfs';

/** True when running inside the Tauri desktop shell. */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Folders the desktop app works with (persisted by the native side). */
export interface DesktopConfig {
  gameDir?: string | null;
  modDirs: string[];
  modMpqs: boolean;
  saveDir?: string | null;
}

export const getConfig = () => invoke<DesktopConfig>('get_config');
export const setConfig = (config: DesktopConfig) => invoke<void>('set_config', { config });

const join = (dir: string, rel: string) => `${dir.replace(/[\\/]+$/, '')}/${rel}`;

async function readFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>('read_file', { path }));
}

/** Random access to a local file through the native side (MPQs are read piecemeal). */
class NativeFileAccess implements RandomAccess {
  private constructor(
    private readonly path: string,
    readonly size: number,
  ) {}

  static async open(path: string): Promise<NativeFileAccess> {
    return new NativeFileAccess(path, await invoke<number>('file_size', { path }));
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    return new Uint8Array(await invoke<ArrayBuffer>('read_range', { path: this.path, offset, length }));
  }
}

/** The folder each loose data source was listed from, so it can be listed again (refreshLooseFolders). */
const looseRoots = new WeakMap<LooseSource, string>();

async function looseFiles(root: string): Promise<Map<string, () => Promise<Uint8Array>>> {
  const files = await invoke<string[]>('list_data_files', { root });
  return new Map(files.map((f) => [f, () => readFile(join(root, f))]));
}

async function looseData(label: string, root: string): Promise<LooseSource | null> {
  const files = await looseFiles(root);
  if (!files.size) return null;
  const src = new LooseSource(label, files);
  looseRoots.set(src, root);
  return src;
}

/**
 * Lists the loose data folders of `fs` again, so files added, changed or removed since it was loaded are seen (file
 * contents are read when asked for, so only the lists go stale). Returns the paths now listed there.
 */
export async function refreshLooseFolders(fs: LayeredFs): Promise<string[]> {
  const listed: string[] = [];
  for (const s of fs.baseSources) {
    const root = s instanceof LooseSource ? looseRoots.get(s) : undefined;
    if (!root) continue;
    const files = await looseFiles(root);
    (s as LooseSource).replaceFiles(files);
    listed.push(...files.keys());
  }
  fs.resetSession();
  return listed;
}

async function exists(path: string): Promise<boolean> {
  try {
    await invoke<number>('file_size', { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * The game's program files, mounted as `bin/…`: only read to find the object table inside them (see objectCatalog).
 * Linux installs may have them in lower case.
 */
async function binaries(dir: string): Promise<LooseSource | null> {
  const files = new Map<string, () => Promise<Uint8Array>>();
  for (const name of GAME_BINARY_FILES) {
    for (const variant of [name, name.toLowerCase()]) {
      const path = join(dir, variant);
      if (!files.has(`bin/${name.toLowerCase()}`) && (await exists(path))) files.set(`bin/${name.toLowerCase()}`, () => readFile(path));
    }
  }
  return files.size ? new LooseSource(`${dir} (program files)`, files) : null;
}

/**
 * Mounts the configured folders in priority order, like the dev server: mod data folders (and their MPQs if enabled),
 * the game's loose data folder, then patch_d2 > d2exp > d2data > d2char; the program files of the mod, then the game.
 */
export async function loadFromTauri(config: DesktopConfig): Promise<LayeredFs> {
  const sources: FileSource[] = [];
  if (config.saveDir && !config.modDirs.some(p => p.replace(/\\/g, '/').toLowerCase() === config.saveDir!.replace(/\\/g, '/').toLowerCase())) {
    const saved = await looseData(config.saveDir + '/data', config.saveDir);
    if (saved) sources.push(saved);
  }
  for (const mod of config.modDirs) {
    const loose = await looseData(`${mod}/data`, mod);
    if (loose) sources.push(loose);
    if (config.modMpqs) {
      const mpqs = (await invoke<string[]>('list_mpqs', { dir: mod })).filter((m) => !CLASSIC_MPQS.includes(m.toLowerCase())).sort();
      for (const m of mpqs) sources.push(await MpqSource.open(`${mod}/${m}`, await NativeFileAccess.open(join(mod, m))));
    }
  }
  if (config.gameDir) {
    const loose = await looseData(`${config.gameDir}/data`, config.gameDir);
    if (loose) sources.push(loose);
    const present = new Set((await invoke<string[]>('list_mpqs', { dir: config.gameDir })).map((m) => m.toLowerCase()));
    for (const m of CLASSIC_MPQS) {
      if (present.has(m)) sources.push(await MpqSource.open(m, await NativeFileAccess.open(join(config.gameDir, m))));
    }
  }
  for (const dir of [...config.modDirs, ...(config.gameDir ? [config.gameDir] : [])]) {
    const bin = await binaries(dir);
    if (bin) sources.push(bin);
  }
  return new LayeredFs(sources);
}

/** Saves into the mod folder (or `saveDir`) through the native side. */
export function tauriSaveTarget(config: DesktopConfig): SaveTarget | null {
  const root = config.saveDir ?? config.modDirs[0];
  if (!root) return null;
  return {
    label: root,
    async save(path, bytes) {
      validateAutomapSave(path, bytes);
      const r = await invoke<{ written: string; backup: string | null }>('save_file', bytes.slice(), { headers: { 'x-path': encodeURIComponent(path) } });
      return r.backup ? `Saved ${r.written} (original kept as ${r.backup})` : `Saved ${r.written}`;
    },
    retire: (path) => invoke<string>('retire_file', { path }),
  };
}

/** Native folder picker. */
export async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, title });
  return typeof picked === 'string' ? picked : null;
}
