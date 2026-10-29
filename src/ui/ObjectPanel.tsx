import { useState } from 'react';
import type { Ds1Object } from '../formats/ds1';

interface Props {
  objects: Ds1Object[];
  selected: number | null;
  nameOf: (type: number, id: number) => string;
  hasNames: boolean;
  placing: { type: number; id: number } | null;
  onSelect: (i: number | null) => void;
  /** Replaces the object list (one undo step). */
  onChange: (next: Ds1Object[]) => void;
  onStartPlacing: (template: { type: number; id: number } | null) => void;
}

function Num({ value, onCommit, width = 52, min = -99999, max = 99999 }: { value: number; onCommit: (v: number) => void; width?: number; min?: number; max?: number }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = Number(text);
    setText(null);
    if (Number.isInteger(v) && v >= min && v <= max && v !== value) onCommit(v);
  };
  return (
    <input
      className="num-field mono"
      style={{ width }}
      value={text ?? String(value)}
      onFocus={(e) => {
        setText(String(value));
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(null);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

export function ObjectPanel({ objects, selected, nameOf, hasNames, placing, onSelect, onChange, onStartPlacing }: Props) {
  const [newType, setNewType] = useState(2);
  const [newId, setNewId] = useState(0);
  const obj = selected !== null ? objects[selected] : null;

  const update = (patch: Partial<Ds1Object>) => {
    if (selected === null) return;
    onChange(objects.map((o, i) => (i === selected ? { ...o, ...patch } : o)));
  };
  const updatePoint = (n: number, patch: Partial<Ds1Object['path'][number]>) => update({ path: obj!.path.map((p, i) => (i === n ? { ...p, ...patch } : p)) });

  return (
    <section className="panel">
      <div className="panel-header static">
        <span>Objects</span>
        <span className="muted small">{objects.length}</span>
      </div>
      <div className="panel-body">
        <div className="object-list">
          {objects.map((o, i) => (
            <button key={i} className={`object-row${i === selected ? ' active' : ''}`} onClick={() => onSelect(i === selected ? null : i)}>
              <span className="swatch" style={{ background: o.type === 1 ? 'rgb(240,80,80)' : 'rgb(80,160,255)' }} />
              <span className="object-name">{nameOf(o.type, o.id)}</span>
              <span className="muted small mono">
                {o.type},{o.id}
              </span>
            </button>
          ))}
          {objects.length === 0 && <div className="muted small">No objects.</div>}
        </div>

        {obj && (
          <div className="object-edit">
            <div className="field-label">
              <span>{nameOf(obj.type, obj.id)}</span>
              <button className="icon-btn" title="Delete object (Delete)" onClick={() => onChange(objects.filter((_, i) => i !== selected))}>
                Delete
              </button>
            </div>
            <div className="cell-edit">
              <select className="orient-select narrow" value={obj.type} onChange={(e) => update({ type: Number(e.target.value) })}>
                <option value={1}>1 · NPC/monster</option>
                <option value={2}>2 · Object</option>
              </select>
              <span className="muted small">id</span>
              <Num value={obj.id} min={-9999} max={9999} onCommit={(id) => update({ id })} />
            </div>
            <div className="cell-edit">
              <span className="muted small">x</span>
              <Num value={obj.x} min={0} onCommit={(x) => update({ x })} />
              <span className="muted small">y</span>
              <Num value={obj.y} min={0} onCommit={(y) => update({ y })} />
              <span className="muted small">flags</span>
              <Num value={obj.flags} onCommit={(flags) => update({ flags })} width={44} />
            </div>
            <div className="field-label">
              <span>
                Path <span className="muted small">{obj.path.length} points</span>
              </span>
              {obj.path.length > 0 && (
                <button className="icon-btn" onClick={() => update({ path: [] })}>
                  Clear
                </button>
              )}
            </div>
            {obj.path.map((p, n) => (
              <div key={n} className="cell-edit path-row">
                <span className="muted small mono">{n}</span>
                <Num value={p.x} min={0} onCommit={(x) => updatePoint(n, { x })} width={46} />
                <Num value={p.y} min={0} onCommit={(y) => updatePoint(n, { y })} width={46} />
                <span className="muted small">act</span>
                <Num value={p.action} onCommit={(action) => updatePoint(n, { action })} width={38} />
                <button className="icon-btn" title="Remove point" onClick={() => update({ path: obj.path.filter((_, i) => i !== n) })}>
                  ×
                </button>
              </div>
            ))}
            <p className="muted small">Shift+click the map to append a path point. Drag markers and points to move them.</p>
          </div>
        )}

        <div className="field-label">Add object</div>
        <div className="cell-edit">
          <select className="orient-select narrow" value={newType} onChange={(e) => setNewType(Number(e.target.value))}>
            <option value={1}>NPC/monster</option>
            <option value={2}>Object</option>
          </select>
          <span className="muted small">id</span>
          <Num value={newId} min={-9999} max={9999} onCommit={setNewId} />
        </div>
        <div className="cell-edit">
          <span className="small">{nameOf(newType, newId)}</span>
          <span className="spacer" />
          {placing ? (
            <button className="btn" onClick={() => onStartPlacing(null)}>
              Cancel
            </button>
          ) : (
            <button className="btn" onClick={() => onStartPlacing({ type: newType, id: newId })}>
              Place…
            </button>
          )}
        </div>
        {placing && <p className="muted small">Click the map to place it (Esc to cancel).</p>}
        {!hasNames && (
          <p className="muted small">
            Object names couldn&apos;t be read: the object table comes from the game&apos;s D2Common.dll (1.13 and older) or
            Game.exe (1.14) in the Diablo II or mod folder. NPC names come from MonPreset.txt.
          </p>
        )}
      </div>
    </section>
  );
}
