import type { PlayerEntry } from "./types";

interface Props {
  players: PlayerEntry[];
  /** Whether a server is up at all, which is what makes an empty roster meaningful. */
  running: boolean;
  onRefresh: () => void;
}

/**
 * How long this player has been on, or "-" when that is not knowable.
 *
 * A player the daemon discovered by asking the server, rather than by watching
 * them connect, has no join time. Dating one from daemon start would show a
 * number the operator would read as playtime, and it would be wrong.
 */
function session(joinedAt: string | null): string {
  if (joinedAt === null) return "-";
  const ms = Date.now() - Date.parse(joinedAt);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function PlayersPanel({ players, running, onRefresh }: Props) {
  return (
    <section className="players">
      <div className="mods-head">
        <h2>Players ({players.length})</h2>
        <div className="mods-head-actions">
          {/* Refresh asks the server itself. There is nothing to ask when it is
              not running, and the daemon would refuse anyway. */}
          <button onClick={onRefresh} disabled={!running}>
            Refresh
          </button>
        </div>
      </div>

      {players.length === 0 ? (
        <p className="players-empty">
          {running
            ? "No players online."
            : "The server is stopped, so nobody can be connected."}
        </p>
      ) : (
        <table className="players-table">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Slot</th>
              <th scope="col">Session</th>
              <th scope="col">Latency</th>
              <th scope="col">Level</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              // The auth is the roster's own key and is stable for a player
              // across a rejoin, unlike the slot, which the server reuses.
              <tr key={p.auth}>
                {/* The name is empty until the server names them - a first-time
                    player is announced by authentication only. */}
                <td>{p.name.length > 0 ? p.name : p.auth}</td>
                <td>{p.slot ?? "-"}</td>
                <td>{session(p.joinedAt)}</td>
                <td>{p.latency === null ? "-" : `${p.latency} ms`}</td>
                <td>{p.level ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
