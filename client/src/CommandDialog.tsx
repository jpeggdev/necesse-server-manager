import { useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./api";
import { useModalFocus } from "./useModalFocus";
import type { CommandDef, CommandParam, PlayerEntry } from "./types";

export interface CommandDialogProps {
  api: Api;
  /** The live roster, which is what a `player` parameter picks from. */
  players: PlayerEntry[];
  onClose: () => void;
}

/**
 * Runs one of the game's own server commands.
 *
 * The command table comes from the daemon, which generated it from the
 * server's own jar, so this renders whatever the running game actually
 * supports rather than a hand-maintained list.
 *
 * Nothing here reports success. The daemon can only say a command was sent:
 * the server prints its own reply to the console, and a command accepted while
 * a world is still initialising is echoed and then silently ignored. So the
 * dialog says what it sent and points at the console for the answer.
 */
export function CommandDialog({ api, players, onClose }: CommandDialogProps) {
  const [commands, setCommands] = useState<CommandDef[] | null>(null);
  const [versions, setVersions] = useState<{ schema: string; game: string | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmText, setConfirmText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, backdropRef, onClose, sending);

  useEffect(() => {
    let live = true;
    void api
      .commands()
      .then((r) => {
        if (!live) return;
        // playerOnly commands act on the caller, and the console is not a
        // player, so offering them would only ever produce a failure.
        setCommands(r.commands.filter((c) => c.playerOnly !== true));
        setVersions({ schema: r.schemaGameVersion, game: r.gameVersion });
      })
      .catch((e: Error) => {
        if (live) setLoadError(e.message);
      });
    return () => {
      live = false;
    };
  }, [api]);

  const def = useMemo(
    () => commands?.find((c) => c.name === chosen) ?? null,
    [commands, chosen],
  );

  const missingRequired =
    def === null ||
    def.params.some((p) => !p.optional && (values[p.name] ?? "").trim().length === 0);
  const confirmed = def?.destructive !== true || confirmText.trim() === def.name;
  const canSend = def !== null && !missingRequired && confirmed && !sending;

  const send = (): void => {
    if (def === null) return;
    // Blank optionals are omitted rather than sent empty: the game resolves the
    // remaining values by type, which is how `give iron_bar` works with no
    // player named.
    const args: Record<string, string> = {};
    for (const p of def.params) {
      const v = (values[p.name] ?? "").trim();
      if (v.length > 0) args[p.name] = v;
    }
    setSending(true);
    setError(null);
    setSent(null);
    void api
      .runCommand(def.name, args)
      .then((r) => setSent(r.sent))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSending(false));
  };

  const control = (p: CommandParam) => {
    const id = `cmd-arg-${p.name}`;
    const set = (v: string) => setValues((prev) => ({ ...prev, [p.name]: v }));
    const value = values[p.name] ?? "";
    if (p.type === "player") {
      return (
        <select id={id} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{p.optional ? "(not specified)" : "Choose a player"}</option>
          {players.map((pl) => (
            <option key={pl.auth} value={pl.name.length > 0 ? pl.name : pl.auth}>
              {pl.name.length > 0 ? pl.name : pl.auth}
            </option>
          ))}
        </select>
      );
    }
    if (p.type === "enum" && p.values !== undefined) {
      return (
        <select id={id} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{p.optional ? "(not specified)" : "Choose one"}</option>
          {p.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    }
    if (p.type === "bool") {
      return (
        <select id={id} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{p.optional ? "(not specified)" : "Choose one"}</option>
          <option value="1">1 (on)</option>
          <option value="0">0 (off)</option>
        </select>
      );
    }
    return (
      <input
        id={id}
        type={p.type === "int" || p.type === "float" ? "number" : "text"}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    );
  };

  const stale =
    versions !== null && versions.game !== null && versions.game !== versions.schema;

  return (
    <div className="modal-backdrop" ref={backdropRef}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="command-title" ref={dialogRef} tabIndex={-1}>
        <div className="modal-head">
          <h2 id="command-title">Run a server command</h2>
          <button onClick={onClose} disabled={sending} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-body">
          {loadError !== null && <p className="cmd-error">Could not read the command list: {loadError}</p>}

          {stale && versions !== null && (
            <p className="cmd-warn">
              This command list was taken from game version {versions.schema}, but the server is
              running {versions.game}. It may be out of date.
            </p>
          )}

          <div className="cmd-row">
            <label htmlFor="cmd-name">Command</label>
            <select
              id="cmd-name"
              value={chosen}
              onChange={(e) => {
                setChosen(e.target.value);
                setValues({});
                setConfirmText("");
                setSent(null);
                setError(null);
              }}
            >
              <option value="">Choose a command</option>
              {(commands ?? []).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} - {c.description}
                </option>
              ))}
            </select>
          </div>

          {def !== null && (
            <>
              <p className="cmd-desc">
                {def.description}
                {def.isCheat && <span className="cmd-badge"> cheat</span>}
                <span className="cmd-perm"> {def.permission.toLowerCase()}</span>
              </p>

              {def.params.map((p) => (
                <div className="cmd-row" key={p.name}>
                  <label htmlFor={`cmd-arg-${p.name}`}>
                    {p.name}
                    {p.optional && <span className="cmd-optional"> (optional)</span>}
                  </label>
                  {control(p)}
                </div>
              ))}

              {def.destructive === true && (
                <div className="cmd-row">
                  <label htmlFor="cmd-confirm">Type {def.name} to confirm</label>
                  <input
                    id="cmd-confirm"
                    type="text"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                </div>
              )}
            </>
          )}

          {sent !== null && (
            <p className="cmd-sent">
              Sent <code>{sent}</code>. The server's reply appears in the console.
            </p>
          )}
          {error !== null && <p className="cmd-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <button onClick={onClose} disabled={sending}>
            Close
          </button>
          <button onClick={send} disabled={!canSend}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
