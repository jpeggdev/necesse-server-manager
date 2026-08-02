# Necesse Server Manager

A desktop app for managing a Necesse dedicated server on your LAN: start and
stop the server, install and update mods from the Steam Workshop, watch the
live console, run server commands, and edit world settings and launch
options — all from a client on your PC talking to a small daemon on the
server box.

It's two pieces:

- **The daemon** runs on the machine hosting the Necesse dedicated server. It
  owns the game process and its files.
- **The client** is a Windows desktop app you run on your PC. It talks to the
  daemon over HTTP/WebSocket and never touches the game's files directly.

They can be the same machine or two different ones on the same network.

## Requirements

- **Server box:** 64-bit Windows, with a Necesse dedicated server already
  installed (`Server.jar` and a Java runtime). The daemon doesn't install the
  game server for you — setup asks where your existing install lives.
  [Node.js](https://nodejs.org/) 22+ is only needed if you install the
  daemon from the zip; the installer bundles its own.
- **steamcmd** is optional. It's only needed for installing/updating mods
  and updating the server itself — starting, stopping, and managing worlds
  don't touch it.
- **Client PC:** Windows.

## Install the daemon

### Installer (recommended)

1. Download `necesse-daemon-vX.Y.Z-setup.exe` from Releases and run it **as
   Administrator** (needed to register the boot task and firewall rule).
2. SmartScreen will warn because the installer is unsigned — click "More
   info" → "Run anyway".
3. Leave both setup checkboxes ticked: run the setup wizard, and start the
   daemon automatically at boot. The wizard asks a few questions about your
   install and prints an **access token** at the end — copy it down, you'll
   need it in the client.

Uninstalling removes the daemon files but leaves your config and mod
library alone, in `%PROGRAMDATA%\NecesseServerManager`. Delete that folder
yourself if you want it gone. Upgrading (running a newer installer over an
existing one) keeps your existing config and token.

If you're moving from an old install where `config.json` sat next to
`dist\`, run `migrate.cmd` in that old folder first — otherwise the new
install starts out empty.

### Zip (manual)

Needs Node.js 22+ already on the server box.

1. Download `necesse-daemon-vX.Y.Z.zip` and unzip it anywhere.
2. Run `setup.cmd`. It finds your Necesse install and Java runtime, asks
   you to confirm, and asks for `steamcmd.exe`'s path (blank is fine). It
   prints an access token at the end — copy it down.
3. Run `start-daemon.cmd` to run it, or `register-task.cmd` to install it
   as a boot-time Scheduled Task (recommended — see below).

`config.example.json` in the zip is reference only; it isn't read by
anything and shouldn't be renamed to `config.json`. `setup.cmd` writes the
real one.

### Open the port

Skip this if you used the installer with the boot-task box checked. If the
client runs on a different PC than the daemon, Windows Firewall on the
server box needs to allow inbound TCP on the daemon's port (`8710` by
default). `register-task.cmd` creates that rule for you.

### Run it at boot

Skip this too if you used the installer with the boot-task box checked.
Run `register-task.cmd` (accept the UAC prompt) to register the daemon as a
Scheduled Task that starts at boot, running as SYSTEM. If it won't stay
running, check `%PROGRAMDATA%\NecesseServerManager\boot-refusal.txt` — a
Scheduled Task's console output goes nowhere, so the daemon writes its
refusal reason there instead.

## Install the client

Download the installer from Releases and run it. It's unsigned, so
SmartScreen will warn — "More info" → "Run anyway".

## Connect

On first launch, enter:

- **Host** — the server box's hostname or LAN IP.
- **Port** — `8710` unless you changed it.
- **Access token** — printed by `setup.cmd` / the installer wizard. Leave
  blank only if you disabled the token (see Security).

Use "Test connection" first. The "Copy" button copies the connection
details to your clipboard so you can paste them into a second client
instead of retyping everything.

## Features

**Players** — a tab beside Mods listing who's online, their slot, session
length, latency, and level. It's live, derived from the server's console
output, and empties when the server stops. Session length shows a dash if
the daemon didn't see the player actually join (e.g. it restarted while
they were already connected). **Refresh** asks the server directly, useful
since not every disconnect (timeouts, kicks) prints a departure line.

**Server commands** — "Run command" opens a form for any of the game's
server commands, generated from your server's own jar so it always matches
what your version actually supports. A few things are deliberate: `stop`,
`exit`, and `quit` aren't offered (the daemon owns server lifecycle
already); irreversible commands like `allowcheats` and `regen` require
typing the command name to confirm; and the dialog reports that a command
was *sent*, not that it *succeeded* — check the console for the server's
reply.

**Mods** — install and search from the Steam Workshop, or upload a jar by
hand. **Update All** only re-downloads a mod if its Workshop entry has
actually changed since you installed it, so a run with nothing to do
finishes in seconds. The first Update All after upgrading this app
reinstalls everything once (nothing has a recorded baseline yet); every run
after that is fast.

**Launch options** — per-world overrides of the server's command-line
options (owner, password, slots, world border, etc.), with daemon-wide
defaults underneath. A few limits worth knowing:

- Changes apply on the world's *next* start, not immediately.
- Text values (owner, message of the day, password) can't contain
  `- + " '`, a tab, or a line break — the game's own command-line parser
  treats these as the start of a different option, so this app refuses
  them rather than silently sending something you didn't type. For a line
  break in the message of the day, type `\n` and the game expands it.
- Numbers can't be negative (same cause) or larger than `2147483647`.
- `owner` holds one name — the game itself only supports one, however many
  you set.

## Security

The access token is a shared secret sent over plain HTTP, not TLS —
**never port-forward the daemon or expose it to the internet.** It's built
for a trusted LAN. Setting `authToken` to `""` disables the check entirely
(anyone who can reach the port controls the server); only do that on a
network you fully control.

## Configuration reference

`config.json` lives in `%PROGRAMDATA%\NecesseServerManager\config.json`
(or wherever `NECESSE_MANAGER_DATA` points, if you set it as a **machine**
environment variable — the daemon runs as SYSTEM, which can't see
per-user variables). `setup.cmd` writes it; hand-edit it with the daemon
stopped if needed.

| Key | Meaning |
|---|---|
| `port` | TCP port the daemon listens on. Default `8710`. |
| `dataDir` | The game's data directory (`saves\worlds`, `mods`). |
| `serverRoot` | Where the dedicated server is installed. |
| `serverJar` | Full path to `Server.jar`. |
| `javaExe` | Full path to the `java.exe` to run it with. |
| `steamcmdExe` | Full path to `steamcmd.exe`. Blank if unused. |
| `authToken` | The shared access token. `""` disables auth. |
| `steamApiKey` | Steam Web API key, needed only for Workshop *search*. |
| `lastWorld` | Most recently started world. |
| `stopTimeoutMs` | How long a graceful stop is given before it's reported as timed out. Default `90000`. |
| `jvmArgs` | JVM flags for `Server.jar`. Defaults are sensible; only change if you know why. |

`modsDir`, `worldsDir`, and the mod-library/mod-sets paths are derived
automatically and shouldn't be set by hand.

## Building from source

Daemon (from `daemon/`):

```
npm ci
npm run build
```

Client (from `client/`; needs a Rust toolchain, MSVC build tools, and
WebView2):

```
npm ci
npm run tauri build
```

Tests for either package:

```
npx vitest run
```

## License

MIT. See [LICENSE](LICENSE).
