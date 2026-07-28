# CLAUDE.md

Necesse dedicated-server manager: a Node/TypeScript **daemon** that runs on the
game-server box, and a **Tauri 2 + React client** that drives it over the LAN.

## Layout and commands

| | |
|---|---|
| `daemon/` | Owns the game-server process and every side effect. Runs on SERVER. |
| `client/` | Thin view over the daemon's HTTP + WebSocket API. Runs on the workstation. |
| `scripts/` | `01-install-node` and `03-register-task` run **on SERVER**; `02-deploy` and `04-restart-daemon` run on the workstation. |

Verify from inside `daemon/` or `client/`: `npx vitest run` and `npx tsc --noEmit`.
Run the two packages separately; there is no workspace root.

## Deploying — read before you touch SERVER

**The game server is a child process of the daemon.** Restarting the daemon can
kill a live game session. Before `02-deploy.ps1` or `04-restart-daemon.ps1`,
confirm nobody is playing — `GET /api/status` reporting `stopped` is the check.

`02-deploy.ps1` seeds `config.json` and `mods.json` only when absent. That is
deliberate: `mods.json` is the only record of which jar belongs to which
workshop id, and clobbering it strands every installed mod as untracked.

**The daemon's own directory holds state, not just code.** Alongside those two,
`mod-library/`, `mod-library.json` and `mod-sets.json` live there (see
`docs/mod-sets-design.md`); the library is the only copy of every uploaded and
hand-placed jar, and the sets are what each world loads. Deploy copies `dist/`
and the two manifests in and never removes anything, which is what makes that
safe — a deploy step that mirrored or cleaned the directory would destroy jars
that exist nowhere else. Not `C:\necesseserver`, ever: steamcmd's
`app_update ... validate` prunes unknown files out of that tree.

SSH: `ssh -i "$env:USERPROFILE\.ssh\necesse_server" jeffp@192.168.1.106`.
**The remote default shell is cmd.exe.** Do not fight nested quoting — `scp` a
`.ps1` over and run it with `powershell -NoProfile -ExecutionPolicy Bypass -File`.
Inline `powershell -Command "..."` through ssh gets pipe-split by the remote
cmd.exe before powershell ever sees it.

`config.json` lives only on SERVER and holds the Steam API key. Hand-edit it
with the daemon stopped. **Write it without a BOM** — PowerShell 5.1's
`Set-Content -Encoding UTF8` adds one; use
`[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`.
`loadConfig` tolerates a BOM now, but nothing else does.

## Constraints that bite

- **Daemon sources must stay ES2020-library-compatible.** `client/test/api.integration.test.ts`
  imports the real daemon, so every daemon file is typechecked a second time
  under the client's ES2020 lib. `daemon/tsconfig.json` pins `"lib": ["ES2020"]`
  so an ES2022 call (`Object.hasOwn`, `Array.at`, `findLast`) fails where you
  are editing rather than in the other package. Do not raise it to silence an
  error.
- **`daemon/src/types.ts` and `client/src/types.ts` must stay byte-identical.**
  Two separately deployed apps, duplicated on purpose rather than sharing a
  workspace package. Hash both after editing either.
- **Errors are never swallowed or reworded.** A missing file (`ENOENT`) is
  distinguished from a real failure; everything else rethrows with the path and
  the underlying message. Several modules were fixed to comply — a `catch` that
  returns a default is a defect here, not a convenience.
- **Mod mutations and server updates are refused while the server runs or a
  task is in flight**, and nothing stops the server as a side effect. The game
  reads its mod set only at startup.
- **`stop` never escalates to a kill on timeout.** The server saves the world
  during shutdown; killing it risks the save. `kill` is a separate endpoint so
  it can never happen implicitly.

## Testing

Cover the seam, not just each side of it. 113 daemon tests and 6 client tests
once passed while **five of the app's actions were completely broken**: the
daemon's tests use Fastify's `inject()` (which never sets a content-type) and
the client's mocked `fetch` (which never reaches Fastify), so a bodyless POST
carrying a JSON content-type failed in production and nowhere else.
`client/test/api.integration.test.ts` exists to close that gap — it stands up a
real daemon on an ephemeral port and drives it with the real client transport.
Keep it that way; a test that mocks either side proves nothing about the seam.

Real captured server output lives in `daemon/test/fixtures/log-fixtures.ts`.
The game's stdout carries **ANSI colour escapes before the timestamp** — that
broke shutdown detection and was invisible to every unit test. Do not
"normalise" those fixtures; they are evidence.

## World save zips

`daemon/src/world-settings*.ts` rewrites a file inside a world zip, which is
the only copy of that world. The write is build-elsewhere → re-open and
hash-verify every entry → fsync → back up → rename, in that order, and the
verification is load-bearing: a rebuild that silently drops an entry is still a
*valid* zip and only the per-entry hash catches it. Unknown keys in
`worldSettings.cfg` come from mods and must round-trip untouched; the editor
never adds a key the file did not already have.
