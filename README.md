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
  installed (`Server.jar` and a Java runtime somewhere on disk). The
  daemon does not install the game server for you; the setup wizard asks
  where an existing install lives. [Node.js](https://nodejs.org/) 22 or
  newer is required only if you install the daemon from the zip; the
  installer brings its own.
- **steamcmd** on the server box is optional. Starting, stopping and
  managing worlds never touch it. It is needed only to install mods from
  the Workshop and to update the server itself.
- **Your PC:** Windows, to run the client installer.
- **64-bit Windows on the server box.** The daemon installer is x64-only
  and refuses to run on a 32-bit or ARM-without-x64-emulation Windows.

## Install the daemon

There are two ways to install the daemon. The installer is recommended
unless you already have Node 22+ on the server box and would rather manage
the daemon yourself as a plain folder.

### Installer (recommended)

1. Download `necesse-daemon-vX.Y.Z-setup.exe` from the project's Releases
   page and run it **as Administrator** (the scheduled task and the
   firewall rule both need elevation).
2. **SmartScreen will warn** because the installer is unsigned: click
   "More info", then "Run anyway".
3. On a fresh install, the wizard page offers two checkboxes: "Run the
   setup wizard now" and "Start the daemon automatically at boot, and
   open its firewall port". Leave both ticked unless you have a reason
   not to.
   - The setup wizard runs in its own console window; answer its prompts
     the same way you would for `setup.cmd` (see the zip instructions
     below), and copy down the **access token** it prints at the end.
   - If you leave the boot-task box ticked, the installer registers the
     Scheduled Task and opens the firewall port for you; you do not need
     to do anything from "Open the port" or "Run it at boot" below.
   - Both boxes are skipped automatically on an upgrade: the wizard never
     runs a second time once `config.json` already exists, and the boot
     task's checkbox instead reflects whatever the machine already has
     (ticked if a task is already registered, unticked if it isn't).
4. If you install silently (`necesse-daemon-vX.Y.Z-setup.exe /VERYSILENT`),
   **the setup wizard can never run, no `/TASKS` flag included.** It needs
   a console to prompt on, and a silent run has none, so on a genuinely
   fresh machine you are left with a daemon and no `config.json`. The boot
   task can't be registered either in that same run, because registering
   it requires `config.json` to already exist, and nothing in a fresh
   silent install ever creates one. Run `setup.cmd` and then
   `register-task.cmd` from the install directory yourself afterwards,
   the same two steps the zip route asks for. `/TASKS=boottask` only does
   something on a *re-run* of the installer over a machine that already
   has a `config.json` (from an earlier manual `setup.cmd`, or an earlier
   install): in that case it will register the boot task during the
   silent run.
5. A silent **upgrade** of a machine that already has the boot task
   re-registers it and starts it again, with no `/TASKS` flag needed, so
   the daemon comes back up on the new files. A machine that never had a
   boot task still does not get one: without `/TASKS=boottask`, nothing
   is created that was not already there.

Before it touches anything, the installer checks the daemon's own
`/api/status` to see whether a game session might be running. If it looks
live (or the check cannot tell), a silent install or upgrade **aborts
outright** rather than risk killing an unsaved session; an interactive one
asks you to confirm nobody is playing before it continues. If your install
or upgrade appears to fail for no obvious reason, this is the first thing
to check: stop the server yourself and run the installer again.

Uninstalling (from "Add or Remove Programs") removes the daemon files, and
the scheduled task and firewall rule **if this installer was what created
them** (if they were already on the machine before you first ran it, they
are left alone and the uninstaller says so). It **deliberately leaves your
configuration and mod library alone**, in
`%PROGRAMDATA%\NecesseServerManager`. Delete that folder yourself if you
want it gone; it holds the only copy of any mod jar you uploaded by hand.
There is no "also remove my data" option.

Upgrading (running a newer installer over an existing install) keeps your
existing `config.json` and access token and does not re-run the wizard.

**If you previously used the zip and your `config.json` sits beside
`dist\`** (an install that predates the `%PROGRAMDATA%` split), run
`migrate.cmd` in that old folder first. The installer creates a fresh
install directory of its own and has no way to find your old one, so
skipping this step leaves you with an apparently empty daemon.

### Zip

This route needs [Node.js](https://nodejs.org/) 22 or newer already
installed on the server box; the installer above bundles its own Node and
does not need this.

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

The zip also contains `config.example.json`. It is reference only, to show
what the file looks like: it is not read by anything, and renaming it to
`config.json` would give you a daemon with an empty `authToken`, meaning
anyone who can reach the port controls the server. `setup.cmd` is what
writes the real config.

## Open the port

If you used the installer and left the boot-task checkbox ticked, the
firewall rule was already created for you and you can skip this section.

If the client runs on a different PC from the daemon, Windows Firewall on
the server box has to allow inbound TCP on the daemon's port (`8710` by
default). `register-task.cmd` below creates that rule for you; if you run
the daemon with `start-daemon.cmd` instead, add it yourself, or the client
will simply never connect and nothing on either side will say why.

## Run it at boot (optional)

If you used the installer and left the boot-task checkbox ticked, this
was already done for you and you can skip this section.

Run `register-task.cmd`. It asks Windows for Administrator rights and then
runs `register-task.ps1` for you; accept the prompt. Elevation is not
optional here, and it used to fail confusingly when it was missing:
registering a Scheduled Task that runs as SYSTEM throws access-denied
without it, and the firewall rule fails *silently*.

It registers the daemon as a Task Scheduler task that starts AtStartup,
running as SYSTEM, with a 30-second delay after boot. AtStartup rather than
at a user's logon means an unattended reboot still brings the daemon back;
SYSTEM means no password has to be stored anywhere. The 30-second delay
exists because the daemon binds its port almost immediately, and at the
exact instant of boot the network stack usually isn't ready yet.

A Scheduled Task's console output goes nowhere, so if the daemon refuses
to start there is nothing to read. It therefore writes the reason to
`%PROGRAMDATA%\NecesseServerManager\boot-refusal.txt` as well, and deletes
that file again as soon as a start succeeds. If the task will not stay
running, read that file first.

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

This section covers the zip route. If you installed with the installer,
upgrading means running the newer version's installer over the existing
install; see "Install the daemon" above for what that keeps and what it
does not touch.

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

If you set `NECESSE_MANAGER_DATA`, **set it as a machine (System)
environment variable, not a per-user one.** The daemon runs as SYSTEM (see
"Run it at boot" above), and SYSTEM has no access to your user account's
environment variables at all, so a per-user setting is silently ignored by
the daemon and you end up with state in the default `%PROGRAMDATA%`
location instead. (SYSTEM is the main reason, not elevation as such:
accepting a UAC prompt for your own account keeps you on that account with
a higher-privilege token and your own environment. But if you elevate by
typing a *different* administrator account's credentials, you are running
as that account, and its per-user variables are the ones that apply. A
machine variable is correct in every case.)

**Point it at a local path.** A mapped network drive is per-logon-session,
so the drive letter usually does not exist for SYSTEM or for an elevated
process at all, and both the daemon and the installer's safety check would
be looking at a path that is not there.

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
| `lastWorld` | The most recently started world. The client can edit this remotely. |
| `stopTimeoutMs` | How long a graceful stop is given before the daemon reports it as timed out (it does not kill the process on timeout). Default `90000`. The client can edit this remotely. |
| `jvmArgs` | JVM flags passed to `Server.jar`. Sensible defaults are shipped; only change these if you know why. |

Five keys are deliberately left out of that list because they are derived,
not configured, and the daemon recomputes all five every time it starts:

- `modsDir` and `worldsDir` come from `dataDir` (`<dataDir>\mods` and
  `<dataDir>\saves\worlds`). If a config file still carries either key and
  it disagrees with what `dataDir` implies, the daemon refuses to boot
  rather than guess. The daemon reads and writes one mods folder while the
  game is launched against whatever `-datadir` points to, and a silent
  mismatch would mean the game loads a different mod set than the one the
  daemon prepared, with nothing reporting that as a failure.
- `modLibraryDir`, `modLibraryFile` and `modSetsFile` live in the state
  directory alongside `config.json`. An older config file may still carry
  them pointing into an install directory; those values are ignored and
  dropped the next time the daemon writes the file.

A few other keys (`modUploadMaxBytes`, `serverAppId`, `workshopAppId`)
exist with working defaults and normally don't need to be touched at all.

## Players

The **Players** tab, beside Mods, lists who is on the server right now: name,
slot, how long they have been connected, latency and which level they are on.
The count on the tab itself updates whether or not you are looking at it.

The list is derived from the server's own console output, so a join or a quit
shows up the moment the server prints it. Two consequences are worth knowing:

- **It empties when the server stops.** The roster describes a running process,
  so nothing is stored and nothing survives a restart. An empty list while the
  server is up says nobody is connected; an empty list while it is stopped says
  so in as many words, because those are different facts.
- **A session length is only shown when the daemon saw the join.** If the
  daemon was restarted while people were already playing, it learns who is on
  by asking the server, which does not report when they arrived. Those rows
  show a dash rather than a number that would read as playtime and be wrong.

**Refresh** asks the server directly rather than trusting what the daemon
inferred. That matters because only a clean quit prints a departure line: a
timeout, a latency kick, a `/kick` or a shutdown do not, so a player who
dropped out abruptly can linger in the list. The daemon already asks on its own
whenever the server starts and whenever it sees a departure it cannot match to
somebody, and Refresh is the manual version of the same question. It is
disabled while the server is stopped, since there is nothing to ask.

## Mods and Update All

**Update All only downloads mods whose Workshop entry has changed since the
jar you have installed came from it.** Anything unchanged is left alone and
reported as "unchanged" rather than as updated, so a run with nothing to do
finishes in seconds instead of redownloading every mod.

What that decision rests on is worth knowing:

- **A moved timestamp indicates a new jar, it does not prove one.** Steam
  moves an entry's `time_updated` for any edit to it, including a changed
  description or title. So Update All can download a mod whose actual jar is
  identical to the one you had. It will never do the reverse and skip a mod
  whose jar genuinely changed.
- **The first Update All after upgrading to this version reinstalls
  everything, once.** Nothing installed by an older daemon has a recorded
  Workshop timestamp, and an unknown timestamp always means "download it".
  That run records the real values, and every run after it skips.
- **A mod Steam will not tell us about is downloaded again rather than
  skipped.** That covers a Steam outage (the whole run says so in the console
  and updates everything), an entry that has been removed or banned, and an
  entry Steam serves with no timestamp at all.
- **A mod is also reinstalled if the mod library no longer holds its jar**,
  whatever the timestamps say, so deleting a jar out of the library is enough
  to get it back.

The update badges in the mod list are painted from exactly the same
comparison, so the list never offers an update that Update All then skips.
The two are not quite symmetrical: a mod with no usable Workshop entry is not
badged but is still retried by Update All. That asymmetry only ever runs one
way, with Update All doing more than the badges imply.

## Launch options

Server launch options (owner, password, player slots, world border and so
on) live outside `config.json`, in the client's launch options dialog. There
are daemon-wide defaults, and each world can override any of them; a world
that sets nothing just uses the defaults.

A few things about how they work are easy to miss:

- **Changes take effect at the world's next start, not immediately.** The
  game reads its command line only at launch, so editing options while a
  world is running does not affect that running world; the daemon accepts
  the write anyway; you just have to stop and start the world for it to
  apply.
- **`owner` holds one name, not a list**, because the game itself only
  supports one: it builds its launch options into a plain map, so repeated
  `-owner` flags overwrite each other and only the last one survives. If you
  need more than one privileged account, that has to be handled some other
  way (in-game permissions), not through this option.
- **Text options cannot contain `-`, `+`, `"` or `'` at all.** This one is
  worth reading in full, because it rules out things you would expect to
  work. The game does not read its command line argument by argument. It
  joins the whole thing into one string, and after it reads each value it
  looks for the next `-` or `+` *anywhere* in what is left, including in the
  middle of a word. So every hyphen starts a new option. Measured against the
  real `Server.jar`:

  | You type | The game receives |
  |---|---|
  | owner `Jean-Luc` | owner `Jean-Luc`, plus an option `Luc` |
  | motd `co-op night` | motd `co-op night`, plus an option `op` set to `night` |
  | owner `x-settings C:/evil.cfg` | owner `x-settings C:/evil.cfg`, plus the game's real `-settings` option pointed at that file |

  Note that the option you set still arrives correctly, so nothing looks
  wrong; the damage is the *second* option you did not ask for. Three of
  those, `-dev`, `-settings` and `-logs`, are options this daemon
  deliberately does not offer. The daemon refuses such a value rather than
  sending a command line that means more than what you typed.

  What this costs you, plainly:
  - An owner name cannot contain a hyphen. `Jean-Luc` has to be `Jean_Luc`
    or `JeanLuc`.
  - A message of the day cannot contain a hyphen or an apostrophe. Write
    `Welcome, have fun` rather than `Welcome - have fun`, and `dont` rather
    than `don't`.
  - **The languages `pt-BR`, `zh-CN` and `zh-TW` cannot be set through the
    language option at all** - three of the game's 29 locales. The other 26
    have no hyphen and work normally. The game has its own server command for
    setting the language, which you can run from the console panel.

  This is a limitation of the game's command-line parser, not of this tool,
  and there is no way around it from here.
- **Number options cannot be negative.** Same cause: the game reads the
  leading `-` as the start of another option, so `-1` arrives as an empty
  value plus an option called `1`. The game uses `-1` internally to mean
  "no world border" and "unlimited settlements", and **those values cannot be
  sent on a command line**, so this tool does not offer them. Leave the option
  unset to get the game's own default.
- **Clearing an option and setting it to blank are different.** Setting an
  option to `null` in the client removes it, so the world falls back to the
  daemon-wide default (or the game's own default if there is no default
  either). Setting it to an empty string keeps it set, and the game receives
  that flag with an empty value.
- **The game's port is not the daemon's port.** The daemon listens on
  `8710` (or whatever `port` is set to) for the client to talk to it; the
  `port` launch option is what players connect to. Changing the game port
  needs its own inbound firewall rule, the same way the daemon's own port
  does (see "Open the port" above). Changing one port does not touch the
  other.
- A handful of options are not offered at all: `-nogui`, `-datadir` and
  `-world` are the daemon's own arguments and cannot be set from here, at
  any level.

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
