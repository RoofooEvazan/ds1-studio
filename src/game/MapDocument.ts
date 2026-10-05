import { DEFAULT_PROP1, EMPTY_CELL, isEmptyCell, withTile, type Ds1, type Ds1Object, type TileCell, type WallCell } from '../formats/ds1';

/** Wall layers a map can have; the editor always offers all of them. */
const WALL_LAYERS = 4;

export type LayerKind = 'floor' | 'wall' | 'shadow';

export interface LayerRef {
  kind: LayerKind;
  index: number;
}

export function layerKey(l: LayerRef): string {
  return `${l.kind}:${l.index}`;
}

export function layerLabel(l: LayerRef): string {
  return l.kind === 'shadow' ? 'Shadow' : `${l.kind === 'floor' ? 'Floor' : 'Wall'} ${l.index + 1}`;
}

/** A DT1 tile identity to paint with. */
export interface Brush {
  orientation: number;
  main: number;
  sub: number;
}

type AnyCell = TileCell | WallCell;

interface CellChange {
  layer: LayerRef;
  index: number;
  before: AnyCell;
  after: AnyCell;
}

/** One undoable step: cell changes and/or a before/after snapshot of the object list. */
export interface FileHistoryChange { path: string; before: Uint8Array; after: Uint8Array }
export type HistoryFileWriter = (path: string, bytes: Uint8Array, expected: Uint8Array) => Promise<void>;

interface HistoryStep {
  /** What the step did, for the History panel. */
  label: string;
  /** When it was made (ms since epoch). */
  time: number;
  cells: CellChange[];
  objects?: { before: Ds1Object[]; after: Ds1Object[] };
  /** Whole-map snapshots, for structural edits (resize, tags, groups). */
  map?: { before: Ds1; after: Ds1 };
  file?: FileHistoryChange;
}

const cloneObjects = (objs: Ds1Object[]): Ds1Object[] => objs.map((o) => ({ ...o, path: o.path.map((p) => ({ ...p })) }));

export interface CellEdit {
  layer: LayerRef;
  x: number;
  y: number;
  cell: AnyCell;
}

/**
 * An open, editable DS1. All mutations go through `apply`, which records undo history.
 * Changes made between beginStroke/endStroke undo as a single step.
 */
export class MapDocument {
  private undoStack: HistoryStep[] = [];
  private redoStack: HistoryStep[] = [];
  private stroke: Map<string, CellChange> | null = null;
  private strokeLabel = 'Paint';
  private objectsBefore: Ds1Object[] | null = null;
  /** The undo step the map was last saved at (null = as opened); `undefined` = never saved in this form (new/restored). */
  private savedAt: HistoryStep | null | undefined = null;
  revision = 0;

  constructor(
    public path: string,
    readonly ds1: Ds1,
  ) {}

  /** Unsaved changes: the map differs from the last save (undoing back to it counts as clean again). */
  get dirty(): boolean {
    return !!this.stroke?.size || this.objectsBefore !== null || (this.undoStack[this.undoStack.length - 1] ?? null) !== this.savedAt;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  markSaved(): void {
    this.endStroke();
    this.endObjectEdit();
    this.savedAt = this.undoStack[this.undoStack.length - 1] ?? null;
  }

  /** A map that exists only here so far (new, or restored from an autosave): unsaved until saved. */
  markUnsaved(): void {
    this.savedAt = undefined;
  }

  layers(): LayerRef[] {
    return [
      ...this.ds1.floors.map((_, index) => ({ kind: 'floor' as const, index })),
      ...this.ds1.walls.map((_, index) => ({ kind: 'wall' as const, index })),
      ...this.ds1.shadows.map((_, index) => ({ kind: 'shadow' as const, index })),
    ];
  }

  /**
   * The layers the editor offers: the map's own, plus every wall layer up to 4. A wall layer the file doesn't have yet
   * reads as empty and is added to the map when a tile is put on it (ensureLayer), so it can be shown, hidden and
   * painted like the others without changing the file until it is used.
   */
  editableLayers(): LayerRef[] {
    return [
      ...this.ds1.floors.map((_, index) => ({ kind: 'floor' as const, index })),
      ...Array.from({ length: Math.max(WALL_LAYERS, this.ds1.walls.length) }, (_, index) => ({ kind: 'wall' as const, index })),
      ...this.ds1.shadows.map((_, index) => ({ kind: 'shadow' as const, index })),
    ];
  }

  /** Whether the map (the file) has this layer. */
  hasLayer(layer: LayerRef): boolean {
    return !!this.layerList(layer)[layer.index];
  }

  /**
   * Adds empty wall layers so that `layer` exists, as its own undo step (a stroke in progress goes on after it).
   * Returns whether anything was added. Only wall layers are added this way, up to 4.
   */
  ensureLayer(layer: LayerRef): boolean {
    if (layer.kind !== 'wall' || this.hasLayer(layer) || layer.index >= WALL_LAYERS) return false;
    const stroke = this.stroke ? this.strokeLabel : null;
    const from = this.ds1.walls.length;
    this.mutate((d) => {
      while (d.walls.length <= layer.index) d.walls.push(Array.from({ length: d.width * d.height }, () => ({ ...EMPTY_CELL, orientation: 0, orientationHigh: 0 })));
    }, layer.index === from ? `Add wall layer ${layer.index + 1}` : `Add wall layers ${from + 1}–${layer.index + 1}`);
    if (stroke !== null) this.beginStroke(stroke);
    return true;
  }

  private layerList(layer: LayerRef): AnyCell[][] {
    return layer.kind === 'floor' ? this.ds1.floors : layer.kind === 'wall' ? this.ds1.walls : this.ds1.shadows;
  }

  private cells(layer: LayerRef): AnyCell[] {
    const cells = this.layerList(layer)[layer.index];
    if (!cells) throw new Error(`no ${layerKey(layer)} layer`);
    return cells;
  }

  /** A cell of a layer; empty for a wall layer the map doesn't have yet. */
  cell(layer: LayerRef, x: number, y: number): AnyCell {
    const cells = this.layerList(layer)[layer.index];
    if (!cells) return layer.kind === 'wall' ? { ...EMPTY_CELL, orientation: 0, orientationHigh: 0 } : EMPTY_CELL;
    return cells[y * this.ds1.width + x];
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.ds1.width && y < this.ds1.height;
  }

  /** What `current` becomes when painted with `brush` on `layer` (null brush = erase). */
  static painted(layer: LayerRef, current: AnyCell, brush: Brush | null): AnyCell {
    if (!brush) {
      return layer.kind === 'wall' ? { ...EMPTY_CELL, orientation: 0, orientationHigh: (current as WallCell).orientationHigh } : EMPTY_CELL;
    }
    const next = withTile(current, brush.main, brush.sub, DEFAULT_PROP1[layer.kind]);
    return layer.kind === 'wall' ? { ...next, orientation: brush.orientation } : next;
  }

  beginStroke(label = 'Paint'): void {
    this.endStroke();
    this.stroke = new Map();
    this.strokeLabel = label;
  }

  endStroke(): void {
    if (this.stroke?.size) this.pushHistory({ label: `${this.strokeLabel} (${this.stroke.size} cell${this.stroke.size === 1 ? '' : 's'})`, time: Date.now(), cells: [...this.stroke.values()] });
    this.stroke = null;
  }

  /**
   * Sets cells; returns true if anything changed. Outside a stroke, one undo step named `label`. With `file` (a file
   * written with the change, such as a renumbered DT1), the step restores that file too when undone.
   */
  apply(edits: CellEdit[], label = 'Edit tiles', file?: FileHistoryChange): boolean {
    if (file) { this.endStroke(); this.endObjectEdit(); }
    // A tile put on a wall layer the map doesn't have yet adds that layer first (its own undo step).
    for (const e of edits) if (!isEmptyCell(e.cell) && this.inBounds(e.x, e.y)) this.ensureLayer(e.layer);
    const applied: CellChange[] = [];
    for (const { layer, x, y, cell } of edits) {
      // Erasing on a layer the map doesn't have: nothing there to erase.
      if (!this.inBounds(x, y) || !this.hasLayer(layer)) continue;
      const cells = this.cells(layer);
      const index = y * this.ds1.width + x;
      const before = cells[index];
      if (sameCell(before, cell)) continue;
      cells[index] = cell;
      applied.push({ layer, index, before, after: cell });
    }
    if (!applied.length) return false;
    if (this.stroke) {
      for (const c of applied) {
        const k = `${layerKey(c.layer)}@${c.index}`;
        const prev = this.stroke.get(k);
        this.stroke.set(k, prev ? { ...c, before: prev.before } : c);
      }
    } else {
      this.pushHistory({ label: `${label} (${applied.length} cell${applied.length === 1 ? '' : 's'})`, time: Date.now(), cells: applied, ...(file ? { file: { ...file, before: file.before.slice(), after: file.after.slice() } } : {}) });
    }
    this.revision++;
    return true;
  }

  /**
   * A structural edit (resize, tag layer, substitution groups) as one undoable step. `fn` either mutates the map in
   * place or returns a replacement map.
   */
  mutate(fn: (ds1: Ds1) => Ds1 | void, label = 'Change map', file?: FileHistoryChange): void {
    this.endStroke();
    this.endObjectEdit();
    const before = structuredClone(this.ds1);
    const result = fn(this.ds1);
    if (result) this.restore(result);
    this.pushHistory({ label, time: Date.now(), cells: [], map: { before, after: structuredClone(this.ds1) }, file });
    this.revision++;
  }

  private restore(snapshot: Ds1): void {
    Object.assign(this.ds1, structuredClone(snapshot));
  }

  /** Replaces the object list as one undoable step. */
  setObjects(next: Ds1Object[], label = 'Edit objects'): void {
    this.endObjectEdit();
    this.pushHistory({ label, time: Date.now(), cells: [], objects: { before: cloneObjects(this.ds1.objects), after: cloneObjects(next) } });
    this.ds1.objects = cloneObjects(next);
    this.revision++;
  }

  /** Starts a live object edit (e.g. a drag): changes via `liveObjects` become one undo step at `endObjectEdit`. */
  beginObjectEdit(): void {
    this.endObjectEdit();
    this.objectsBefore = cloneObjects(this.ds1.objects);
  }

  liveObjects(next: Ds1Object[]): void {
    this.ds1.objects = next;
    this.revision++;
  }

  endObjectEdit(): void {
    const before = this.objectsBefore;
    this.objectsBefore = null;
    if (before && JSON.stringify(before) !== JSON.stringify(this.ds1.objects)) {
      this.pushHistory({ label: 'Move objects', time: Date.now(), cells: [], objects: { before, after: cloneObjects(this.ds1.objects) } });
    }
  }

  private pushHistory(step: HistoryStep): void {
    this.undoStack.push(step);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Record a table edit only after the file has been written successfully. */
  recordFileChange(file: FileHistoryChange, label: string): void {
    this.endStroke(); this.endObjectEdit();
    this.pushHistory({ label, time: Date.now(), cells: [], file: { ...file, before: file.before.slice(), after: file.after.slice() } });
    this.revision++;
  }

  /** Persist external changes before moving history. A failed write leaves history untouched. */
  async undoWithFiles(write: HistoryFileWriter): Promise<boolean> {
    this.endStroke(); this.endObjectEdit();
    const step = this.undoStack[this.undoStack.length - 1];
    if (step?.file) await write(step.file.path, step.file.before, step.file.after);
    return this.undo(true);
  }

  async redoWithFiles(write: HistoryFileWriter): Promise<boolean> {
    const step = this.redoStack[this.redoStack.length - 1];
    if (step?.file) await write(step.file.path, step.file.after, step.file.before);
    return this.redo(true);
  }

  /** Undo steps (oldest first) and redo steps (next first), for the History panel. */
  history(): { done: { label: string; time: number }[]; undone: { label: string; time: number }[] } {
    const info = (s: HistoryStep) => ({ label: s.label, time: s.time });
    return { done: this.undoStack.map(info), undone: [...this.redoStack].reverse().map(info) };
  }

  /** Undoes or redoes until `count` steps are done (0 = the map as opened, or as far back as history goes). */
  goTo(count: number): void {
    while (this.undoStack.length > count && this.undo());
    while (this.undoStack.length < count && this.redo());
  }

  undo(fileWritten = false): boolean {
    this.endStroke();
    this.endObjectEdit();
    if (this.undoStack[this.undoStack.length - 1]?.file && !fileWritten) return false;
    const step = this.undoStack.pop();
    if (!step) return false;
    for (const c of [...step.cells].reverse()) this.cells(c.layer)[c.index] = c.before;
    if (step.objects) this.ds1.objects = cloneObjects(step.objects.before);
    if (step.map) this.restore(step.map.before);
    this.redoStack.push(step);
    this.revision++;
    return true;
  }

  redo(fileWritten = false): boolean {
    if (this.redoStack[this.redoStack.length - 1]?.file && !fileWritten) return false;
    const step = this.redoStack.pop();
    if (!step) return false;
    for (const c of step.cells) this.cells(c.layer)[c.index] = c.after;
    if (step.objects) this.ds1.objects = cloneObjects(step.objects.after);
    if (step.map) this.restore(step.map.after);
    this.undoStack.push(step);
    this.revision++;
    return true;
  }
}

function sameCell(a: AnyCell, b: AnyCell): boolean {
  return (
    a.prop1 === b.prop1 &&
    a.prop2 === b.prop2 &&
    a.prop3 === b.prop3 &&
    a.prop4 === b.prop4 &&
    (a as WallCell).orientation === (b as WallCell).orientation
  );
}
