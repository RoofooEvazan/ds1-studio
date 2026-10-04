import { MpqArchive } from '../formats/mpq/MpqArchive';
import type { RandomAccess } from '../util/RandomAccess';

/** Canonical form for game paths: lower-case, forward slashes, no leading slash. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

export interface FileSource {
  readonly label: string;
  read(path: string): Promise<Uint8Array | null>;
  has(path: string): boolean;
  /** Known file paths in their original case, '/'-separated. May be incomplete for archives without a listfile. */
  list(): string[];
}

export class MpqSource implements FileSource {
  private constructor(
    readonly label: string,
    private readonly mpq: MpqArchive,
    private readonly files: string[],
  ) {}

  static async open(label: string, src: RandomAccess): Promise<MpqSource> {
    const mpq = await MpqArchive.open(label, src);
    let files: string[] = [];
    try {
      const lf = await mpq.read('(listfile)');
      if (lf) files = new TextDecoder('latin1').decode(lf).split(/[\r\n;]+/).filter(Boolean).map(normalizePath);
    } catch {
      // Protected archives may have a mangled listfile; lookups by name still work.
    }
    return new MpqSource(label, mpq, files);
  }

  read(path: string) {
    return this.mpq.read(normalizePath(path));
  }

  has(path: string) {
    return this.mpq.has(normalizePath(path));
  }

  list() {
    return this.files;
  }
}

/** A folder of loose files (an extracted "data" tree). `files` maps original-case path -> opener. */
export class LooseSource implements FileSource {
  private readonly index = new Map<string, () => Promise<Uint8Array>>();
  constructor(
    readonly label: string,
    private readonly files: Map<string, () => Promise<Uint8Array>>,
  ) {
    for (const [path, open] of files) this.index.set(normalizePath(path), open);
  }

  async read(path: string) {
    const open = this.index.get(normalizePath(path));
    return open ? open() : null;
  }

  has(path: string) {
    return this.index.has(normalizePath(path));
  }

  list() {
    return [...this.files.keys()];
  }

  private labels = new Map<string, string>();

  /** Replaces the whole file list (a folder listed again), keeping per-file labels of files still there. */
  replaceFiles(files: Map<string, () => Promise<Uint8Array>>): void {
    this.files.clear();
    this.index.clear();
    for (const [path, open] of files) {
      this.files.set(path, open);
      this.index.set(normalizePath(path), open);
    }
    for (const k of [...this.labels.keys()]) if (!this.index.has(k)) this.labels.delete(k);
  }

  /** Adds or replaces a file. `label` optionally overrides the source label for this file. */
  set(path: string, open: () => Promise<Uint8Array>, label?: string): void {
    const key = normalizePath(path);
    for (const k of this.files.keys()) if (normalizePath(k) === key) this.files.delete(k);
    this.files.set(path, open);
    this.index.set(key, open);
    if (label) this.labels.set(key, label);
  }

  labelOf(path: string): string {
    return this.labels.get(normalizePath(path)) ?? this.label;
  }
}

/** Sources in priority order: the first source that has a file wins (mods override patch_d2 > d2exp > d2data). */
export class LayeredFs {
  readonly sources: FileSource[];
  /** Files saved this session; they shadow every other source so re-opening shows the edit. */
  private readonly saved = new LooseSource('Saved this session', new Map());

  constructor(sources: FileSource[]) {
    this.sources = [this.saved, ...sources];
  }

  /** The real (non-overlay) sources, for display. */
  get baseSources(): FileSource[] {
    return this.sources.slice(1);
  }

  /** Records a file written by a save target. */
  remember(path: string, bytes: Uint8Array, label: string): void {
    const copy = bytes.slice();
    this.gone.delete(normalizePath(path));
    this.saved.set(path, async () => copy.slice(), label);
  }

  /**
   * After the real sources were listed again (files added, changed or removed outside the app): forgets the files
   * saved and moved away this session, since the folders now show them as they are.
   */
  resetSession(): void {
    this.saved.replaceFiles(new Map());
    this.gone.clear();
  }

  /** Files moved away this session (a renamed DT1's old name): no longer there for the editor either. */
  private readonly gone = new Set<string>();
  forget(path: string): void {
    this.gone.add(normalizePath(path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (this.gone.has(normalizePath(path))) return null;
    for (const s of this.sources) {
      const data = await s.read(path);
      if (data) return data;
    }
    return null;
  }

  async readOrThrow(path: string): Promise<Uint8Array> {
    const data = await this.read(path);
    if (!data) throw new Error(`file not found: ${path}`);
    return data;
  }

  /** Which source provides a path (for the UI). */
  locate(path: string): string | null {
    if (this.gone.has(normalizePath(path))) return null;
    if (this.saved.has(path)) return this.saved.labelOf(path);
    return this.sources.find((s) => s.has(path))?.label ?? null;
  }

  /**
   * A file's own spelling (capitals kept) as a source lists it, for writing into the game's tables; null when no
   * source lists it with capitals (or at all).
   */
  exactPath(path: string): string | null {
    const key = normalizePath(path);
    for (const s of this.sources)
      for (const p of s.list()) if (p !== p.toLowerCase() && normalizePath(p) === key) return p.replace(/\\/g, '/');
    return null;
  }

  /** Union of all sources' files, de-duplicated case-insensitively. `filter` receives the normalized path. */
  list(filter?: (normalized: string) => boolean): string[] {
    const all = new Map<string, string>();
    for (const s of this.sources)
      for (const p of s.list()) {
        const key = normalizePath(p);
        // Quarantined assets stay on disk for recovery but are outside the active editor library.
        if (/(^|\/)pd2 ?assets\/unused\//.test(key)) continue;
        if (this.gone.has(key)) continue;
        const prev = all.get(key);
        // Some listfiles are all lower-case; keep the first spelling that preserves the game's original casing.
        if (prev === undefined ? !filter || filter(key) : prev === prev.toLowerCase() && p !== p.toLowerCase()) all.set(key, p);
      }
    return [...all].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, p]) => p);
  }
}

/** Base-game archives, highest priority first. */
export const CLASSIC_MPQS = ['patch_d2.mpq', 'd2exp.mpq', 'd2data.mpq', 'd2char.mpq'];

/**
 * Game program files mounted as `bin/<lower-case name>` (most specific first): the object id table lives in
 * D2Common.dll up to 1.13 and in Game.exe from 1.14. Only read, never written.
 */
export const GAME_BINARY_FILES = ['D2Common.dll', 'Game.exe'];

/** Only these extensions matter to the editor; skipping the rest keeps folder indexing fast. */
export const RELEVANT_EXT = /\.(ds1|dt1|dat|txt|json|bin|cof|dcc|dc6|tbl)$/i;
