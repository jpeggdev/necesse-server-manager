import { useState } from "react";
import type { ModListResponse } from "./types";

export interface ModsPanelProps {
  mods: ModListResponse;
  /** True while a mod/server task is streaming - the game only reads mods at startup, so a second mutation must wait. */
  busy: boolean;
  running: boolean;
  onAdd: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onUpdateAll: () => void;
}

export function ModsPanel({ mods, busy, running, onAdd, onRemove, onUpdateAll }: ModsPanelProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const locked = busy || running;
  const canAdd = !locked && /^\d+$/.test(id.trim()) && name.trim().length > 0;

  return (
    <section className="mods">
      <div className="mods-head">
        <h2>Mods</h2>
        <button onClick={onUpdateAll} disabled={locked || mods.managed.length === 0}>
          Update All
        </button>
      </div>

      {running && <p className="hint hint-warn">Stop the server to change mods.</p>}
      {!running && busy && <p className="hint hint-warn">A task is already running &mdash; wait for it to finish.</p>}

      <ul className="mod-list">
        {mods.managed.map((m) => (
          <li key={m.id}>
            <span className="mod-name">{m.name}</span>
            <div className="mod-meta">
              <span className="mod-id">{m.id}</span>
              <span className="mod-jar">{m.jar}</span>
            </div>
            <button
              className="x"
              aria-label={`Remove ${m.name}`}
              disabled={locked}
              onClick={() => onRemove(m.id)}
            >
              &times;
            </button>
          </li>
        ))}
        {mods.untracked.map((u) => (
          <li key={u.jar} className="untracked">
            <span className="mod-name">{u.jar}</span>
            <div className="mod-meta">
              <span className="mod-id">untracked &mdash; no workshop id, cannot be updated</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="mod-add">
        <label htmlFor="mod-id">Mod id</label>
        <input id="mod-id" value={id} disabled={locked} onChange={(e) => setId(e.target.value)} />
        <label htmlFor="mod-name">Mod name</label>
        <input id="mod-name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
        <button
          disabled={!canAdd}
          onClick={() => {
            onAdd(id.trim(), name.trim());
            setId("");
            setName("");
          }}
        >
          Add
        </button>
      </div>
    </section>
  );
}
