# Necesse Server Manager

A desktop app for managing a Necesse dedicated server on your own LAN. Start
and stop the server, pick a mod set per world from the Steam Workshop, watch
the live console, and edit a world's settings, all from a client on your PC
talking to a small daemon on the server box.

It is two pieces:

- **The daemon** runs on the machine hosting the Necesse dedicated server.
  It owns the game process and every file it touches.
- **The client** is a Windows desktop app you run on your own PC. It is a
  thin view over the daemon's HTTP and WebSocket API; it does not touch the
  game's files directly.

They can be the same machine or two different ones. The client never talks
to the game server or its files directly, only to the daemon.

## Requirements

- **The server box:** Windows, with a Necesse dedicated server already
  installed (`Server.jar` and a Java runtime somewhere on disk), and
  [Node.js](https://nodejs.org/) 22 or newer. The daemon does not install
  the game server for you; the setup wizard asks where an existing install
  lives.
- **steamcmd** on the server box is optional. Starting, stopping and
  managing worlds never touch it. It is needed only to install mods from
  the Workshop and to update the server itself.
- **Your PC:** Windows, to run the client installer.

## Install the daemon

1. Download `necesse-daemon-vX.Y.Z.zip` from the project's Releases page
   and unzip it anywhere on the server box (it does not need to be beside
   the game).
2. Run `setup.cmd`. It looks for an existing Necesse install and Java
   runtime, asks you to confirm or correct what it found, and asks for
   `steamcmd.exe`'s path (leave blank if you don't have one). It writes
   `config.json` and, at the end, prints an **access token**. Copy it
   down; you will need it in the client.
3. Run `start-daemon.cmd` to run the daemon in that window, or see the
   next step to have it start automatically.

## Run it at boot (optional)

Run `register-task.ps1` as Administrator (as Administrator matters: it
registers a Scheduled Task).

It registers the daemon as a Task Scheduler task that starts AtStartup,
running as SYSTEM, with a 30-second delay after boot. AtStartup rather than
at a user's logon means an unattended reboot still brings the daemon back;
SYSTEM means no password has to be stored anywhere. The 30-second delay
exists because the daemon binds its port almost immediately, and at the
exact instant of boot the network stack usually isn't ready yet.

Running as SYSTEM is only safe here because the daemon is told the game's
data directory explicitly (`dataDir` in `config.json`, passed to the server
as `-datadir`). Without that, the game would derive its save and mod
folders from whoever is running it: as SYSTEM that is a folder under
`systemprofile` that holds no worlds and no mods, and the server would
start successfully with nothing in it.

## Install the client

Download the installer from the Releases page and run it.

**The installer is unsigned**, so Windows SmartScreen will show a blue
"Windows protected your PC" warning the first time you run it. This is
expected for an app that isn't signed with a paid code-signing
certificate. Click "More info", then "Run anyway".

## Connect

On first launch (or whenever you want to point the client at a different
daemon), the client shows a connection screen. Enter:

- **Host**: the server box's hostname or LAN IP.
- **Port**: `8710` unless you changed it during setup.
- **Access token**: the token `setup.cmd` printed. Leave it blank only if
  you left the daemon's token disabled (see Security, below).

Use "Test connection" to check the values before committing to them. Once
connected, the app remembers this connection for next time.

The "Copy" button copies a small block of text describing the connection
(host, port and token) to your clipboard, so you can paste it into the
"Paste connection details" box on a second machine instead of retyping
everything.

## Upgrading

The daemon's state (`config.json`, the mod library, and every per-world
mod set) lives in `%PROGRAMDATA%\NecesseServerManager`, not inside the
folder you unzipped the release into. That is what makes upgrading simple:
delete the old install directory and unzip the new release in its place
(or anywhere else). Nothing you would lose lives there.

If you are upgrading from a release that predates this split, where
`config.json` and the mod library sat next to `dist\` inside the install
folder, run `migrate.cmd` once from the old install directory before you
delete it. It copies that state into `%PROGRAMDATA%\NecesseServerManager`
and verifies every file and jar it copied by reading it back before it
prints success. It never deletes or moves the originals, so a failed
migration costs you nothing but a re-run.

## Security

Be plain about this: the daemon spawns processes and writes files on the
machine it runs on. The access token stops another device on your network
from doing that without your say-so, but it is a shared secret sent over
plain HTTP, not TLS. Anyone who can read traffic on that network segment
can read the token. Because of that:

- Never port-forward the daemon, and never expose it to the internet. It
  is built for a LAN you trust, nothing more.
- Setting `authToken` to `""` in `config.json` disables the check
  entirely: any device that can reach the port can control the server.
  That is only a reasonable choice on a network you fully control (a
  single-user home LAN, for instance).

## Configuration reference

`config.json` lives in `%PROGRAMDATA%\NecesseServerManager\config.json`
(or wherever the `NECESSE_MANAGER_DATA` environment variable points, if
you have set one). `setup.cmd` writes it for you; hand-edit it with the
daemon stopped if you need to change something afterward.

| Key | Meaning |
|---|---|
| `port` | TCP port the daemon listens on. Default `8710`. |
| `dataDir` | The game's own data directory (contains `saves\worlds` and `mods`), passed to the server as `-datadir`. |
| `serverRoot` | Where the dedicated server is installed. |
| `serverJar` | Full path to `Server.jar`. |
| `javaExe` | Full path to the `java.exe` that should run it. |
| `steamcmdExe` | Full path to `steamcmd.exe`. Leave `""` if you don't use mod installs or server updates through this app. |
| `authToken` | The shared access token. `""` disables authentication (see Security). |
| `steamApiKey` | A Steam Web API key, needed only for Workshop search. Everything else, including installing a mod by its Workshop id, updating mods and updating the server, works without one. Get one at https://steamcommunity.com/dev/apikey. |
| `owners` | List of world owner names. The client can edit this remotely. |
| `lastWorld` | The most recently started world. The client can edit this remotely. |
| `stopTimeoutMs` | How long a graceful stop is given before the daemon reports it as timed out (it does not kill the process on timeout). Default `90000`. |
| `jvmArgs` | JVM flags passed to `Server.jar`. Sensible defaults are shipped; only change these if you know why. |

Two keys are deliberately left out of that list because they should never
be set by hand: `modsDir` and `worldsDir` are derived from `dataDir`
(`<dataDir>\mods` and `<dataDir>\saves\worlds`), and the daemon computes
them itself every time it starts. If a config file still carries either
key and it disagrees with what `dataDir` implies, the daemon refuses to
boot rather than guess. The daemon reads and writes one mods folder while
the game is launched against whatever `-datadir` points to, and a silent
mismatch would mean the game loads a different mod set than the one the
daemon prepared, with nothing reporting that as a failure. A handful of
other keys (`modLibraryDir`, `modLibraryFile`, `modSetsFile`,
`modUploadMaxBytes`, `serverAppId`, `workshopAppId`) exist with working
defaults and normally don't need to be touched at all.

## Building from source

Daemon (from `daemon/`):

```
npm ci
npm run build
```

Client (from `client/`; needs a Rust toolchain, the MSVC build tools, and
WebView2, the standard requirements for building a Tauri 2 app on
Windows):

```
npm ci
npm run tauri build
```

Tests for either package (`daemon/` or `client/`):

```
npx vitest run
```

## A note on the CSP

The client's Content Security Policy lets `connect-src` reach any host
over `http:`, `https:`, `ws:` and `wss:`, rather than pinning it to one
origin. That is deliberate, not an oversight: the daemon's address is
typed in at runtime on the connection screen (see Connect, above), so the
client cannot know in advance which host and port it will need to reach.

## License

MIT. See [LICENSE](LICENSE).
