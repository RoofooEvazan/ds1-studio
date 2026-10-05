import { describe, expect, it } from 'vitest';
import { withTile, writeDs1, parseDs1, type WallCell } from '../src/formats/ds1';
import { newDs1 } from '../src/formats/ds1ops';
import { MapDocument } from '../src/game/MapDocument';

const map = (wallLayers: number) => new MapDocument('m.ds1', newDs1({ width: 4, height: 4, act: 0, floorLayers: 1, wallLayers, tagType: 0, files: [] }));
const wall = (main: number): WallCell => ({ ...withTile({ prop1: 0, prop2: 0, prop3: 0, prop4: 0, mainIndex: 0, subIndex: 0, hidden: false }, main, 0, 1), orientation: 1, orientationHigh: 0 });
const W = (index: number) => ({ kind: 'wall' as const, index });

describe('wall layers 1-4 always available', () => {
  it('offers four wall layers whatever the file has, without changing it', () => {
    const doc = map(3);
    expect(doc.editableLayers().filter((l) => l.kind === 'wall').map((l) => l.index)).toEqual([0, 1, 2, 3]);
    expect(doc.hasLayer(W(3))).toBe(false);
    expect(doc.cell(W(3), 1, 1).prop1).toBe(0);
    expect(doc.ds1.walls.length).toBe(3);
    expect(doc.dirty).toBe(false);
  });

  it('adds the layer when a tile goes on it (its own undo step), and erasing there changes nothing', () => {
    const doc = map(3);
    expect(doc.apply([{ layer: W(3), x: 1, y: 1, cell: { ...wall(0), prop1: 0 } }])).toBe(false);
    expect(doc.ds1.walls.length).toBe(3);
    expect(doc.apply([{ layer: W(3), x: 1, y: 1, cell: wall(5) }])).toBe(true);
    expect(doc.ds1.walls.length).toBe(4);
    expect(doc.cell(W(3), 1, 1).mainIndex).toBe(5);
    expect(doc.history().done.map((h) => h.label)).toEqual(['Add wall layer 4', 'Edit tiles (1 cell)']);
    doc.undo();
    expect(doc.cell(W(3), 1, 1).prop1).toBe(0);
    doc.undo();
    expect(doc.ds1.walls.length).toBe(3);
  });

  it('keeps a paint stroke one undo step when it adds a layer on the way', () => {
    const doc = map(2);
    doc.beginStroke('Paint');
    doc.apply([{ layer: W(3), x: 0, y: 0, cell: wall(2) }]);
    doc.apply([{ layer: W(3), x: 1, y: 0, cell: wall(2) }]);
    doc.endStroke();
    expect(doc.ds1.walls.length).toBe(4);
    expect(doc.history().done.map((h) => h.label)).toEqual(['Add wall layers 3–4', 'Paint (2 cells)']);
    // Saved, the map has the layers it uses.
    expect(parseDs1(writeDs1(doc.ds1)).walls.length).toBe(4);
  });
});
