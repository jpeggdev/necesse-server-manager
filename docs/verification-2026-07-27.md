# Live verification against SERVER — 2026-07-27

First time the daemon has driven a real Necesse server. Everything before this
task was unit-tested against fakes: 122 daemon tests, 53 client tests, no game
process anywhere in the loop.

- **SERVER** `192.168.1.106`, user `jeffp`, daemon on `:8710`, run by the
  `NecesseDaemon` scheduled task.
- **Branch** `feat/necesse-gui-v1`.
- **Method** HTTP calls from the workstation plus a WebSocket observer
  (`ws://192.168.1.106:8710/ws`) logging every frame with a local receive
  timestamp.
- **Result** two defects found and fixed (one of them real and load-bearing),
  every other exercised path behaved as designed. Read the
  [Not verified](#not-verified) section before treating this as coverage.

> The observer prints each line through `JSON.stringify`, so `\u001b` in the
> transcripts below is a real escape byte on the wire, not a rendering of one.
> Blocks captured **before** the fix are marked *(pre-fix)*; where such a block
> is quoted with the escapes stripped for readability, it says so on the block.
> Everything unmarked is exactly as logged.

### Chronology

The steps below are numbered by the verification plan, **not** by the order they
ran, and the fix landed in the middle of the run. Times are the server's local
clock (UTC-5); the observer's timestamps elsewhere in this document are UTC.

| Local time | What ran | Build |
|---|---|---|
| 03:27:24 | Step 2 — start `Tulsa` | **pre-fix** |
| 03:27:40 | ready line, port 14159 | **pre-fix** |
| 03:28 | Step 7 — mod-mutation guards while running | **pre-fix** |
| 03:29:27 | Step 4 — graceful stop, first exercise | **pre-fix** |
| ~03:30-03:33 | ANSI defect diagnosed, fixed, tested, redeployed, daemon restarted | — |
| 03:33:10 | Step 3 — create `Claude Test World` | post-fix |
| 03:33:41 | Step 4 — graceful stop, second exercise | post-fix |
| 03:34:00 | Step 5 — install `Admin Tools` | post-fix |
| 03:34:2x | Step 6, plus the start-during-task interlock | post-fix |
| 03:35-03:36 | Step 8 — cleanup and restoration | post-fix |

Steps 2, 4 (first exercise) and 7 therefore ran against the **pre-fix** daemon.
No conclusion depends on which build produced them — the defect changed how an
*externally*-initiated shutdown is classified, and every stop performed here was
API-initiated, which takes a different path — but the record should not imply a
chronology it does not have.

---

## Step 0 — Redeploy (hard prerequisite)

The build running on SERVER predated round 4 and had no `activeTasks` field at
all, so client busy-gating read permanently false and the server-side
start-during-task interlock did not exist. Verifying against it would have
measured nothing.

Status before redeploy — note the absent field:

```
$ Invoke-RestMethod http://192.168.1.106:8710/api/status
{"state":"stopped","world":null,"pid":null,"startedAt":null,"port":null,
 "slots":null,"gameVersion":null,"lastError":null}
```

`scripts/02-deploy.ps1` ran clean and left live state alone, which is the
property that matters most in that script:

```
config.json already exists on SERVER -- left untouched.
mods.json already exists on SERVER -- left untouched.
INSTALL_OK
Deployed.
```

**Defect (tooling, fixed):** the task brief's restart command does not work.
`Restart-ScheduledTask` is not a cmdlet on SERVER's PowerShell 5.1:

```
Restart-ScheduledTask : The term 'Restart-ScheduledTask' is not recognized as
the name of a cmdlet, function, script file, or operable program.
```

Added `scripts/04-restart-daemon.ps1`, which does Stop, waits for the task to
actually leave `Running`, then Starts. The wait is not decoration —
`Start-ScheduledTask` against a still-terminating task is a silent no-op, which
would have left the *old* daemon serving `:8710` while every check below
appeared to pass.

```
$ .\scripts\04-restart-daemon.ps1
STOPPED_STATE=Ready
STARTED_STATE=Running
{"state":"stopped",...,"lastError":null,"activeTasks":[]}
```

`activeTasks: []` present. Prerequisite met.

The script was afterwards hardened to *throw* rather than print — on a failed
`ssh`, on the task still being `Running` when the wait expires, and on a
`/api/status` that comes back with no `activeTasks` (which would mean the
restart did not pick up the new `dist`). As first written it would have exited 0
on all three. The hardened version has **not** been re-run — see
[Not verified](#not-verified).

---

## Step 1 — Timestamp format

This was the one genuine unknown in the plan. `log-lines.ts` tolerated server
output both with and without a leading `[YYYY-MM-DD HH:MM:SS] ` prefix because
nobody had ever seen which one stdout produces.

**It produces neither.** The real format carries an ANSI SGR colour escape
*before* the timestamp. First lines off the live server:

```
console line="\u001b[34m[2026-07-27 03:27:25] (DEBUG) Started logging to: C:\Users\jeffp\AppData\Roaming\Necesse\latest-server-log.txt"
console line="\u001b[39m[2026-07-27 03:27:25] Launched game with arguments: -nogui -world Tulsa -owner Jeff -owner Eli"
console line="\u001b[34m[2026-07-27 03:27:26] (DEBUG) Initializing DesktopPlatform"
console line="\u001b[39m[2026-07-27 03:27:28] Loading dedicated server on version 1.2.0."
console line="\u001b[39m[2026-07-27 03:27:28] Found mod: Advanced Starter Kit (eryr.starter.kit, 1.1) from ModsFolderModProvider"
console line="\u001b[33m[2026-07-27 03:27:28] (WARN) Invalid mod jar located at C:\Users\jeffp\AppData\Roaming\Necesse\mods\torvians-qol.cfg"
```

Three colours, one per severity: `ESC[39m` normal, `ESC[34m` `(DEBUG)`,
`ESC[33m` `(WARN)`. The escape is always first, ahead of the timestamp.

### Why this was a real defect, not a cosmetic one

`stripTimestamp` anchored on `^\[\d{4}-...`. With an escape in front, the anchor
never matched, so the timestamp was never removed, so every parser that compares
against a *whole* or *leading* string silently failed:

| Parser | Test | Against the real line | Live consequence |
|---|---|---|---|
| `parseReady` | unanchored `RegExp.exec` | **worked by luck** | none — the pattern is a substring search, so the leading escape is irrelevant |
| `isStopped` | `=== "Server has stopped"` | **always false** | **the whole of it** — see below |
| `isLoadingExistingWorld` | `.startsWith(...)` | **always false** | **none: it has no production caller** |

`isLoadingExistingWorld` is exported and unit-tested but called from nowhere in
`daemon/src` or `client/src` — grep finds it only in `log-lines.ts` and its own
test. New-vs-existing world detection is done by `GET /api/worlds?name=`
returning `candidate.exists`, which is what Step 3 below actually used, and that
path never touches this function. So its being broken had **no** live effect. It
is fixed and regression-tested because a dead function that silently returns the
wrong answer is a trap for the next caller, not because anything depended on it.

`isStopped` drives `process-manager.ts:166`:

```ts
if (isStopped(line) && this.state === "running") this.setState("stopping");
```

That is the path for a shutdown the daemon did *not* initiate — an in-game admin
issuing stop. With `isStopped` never firing, `state` stays `running` until the
process exits, `onExit` sees `wasStopping === false`, and the daemon reports a
clean, fully-saved shutdown as **`crashed`** with
`lastError: "Server process exited with code 0"`.

This did **not** break the API-initiated stop, because `ProcessManager.stop()`
sets `stopping` itself before writing to stdin. That is exactly why the bug was
survivable enough to reach live testing — the common path masks it.

### Fix

- `daemon/src/log-lines.ts`: added `stripAnsi` and a composed `normalize()`
  (ANSI, then timestamp); `isStopped` / `isLoadingExistingWorld` / `parseReady`
  now go through `normalize`. `stripTimestamp` keeps its original narrow meaning.
- The ESC is built with `String.fromCharCode(27)` rather than written as a regex
  literal. A raw control byte in source is invisible in every editor and diff and
  cannot be matched by a later search-and-replace; that hazard bit twice while
  writing this fix.
- `daemon/src/process-manager.ts`: strips ANSI once at ingest, so the recorded
  backlog and the parsers see identical text. Without it the client — which
  renders console lines as plain text with no terminal emulator behind it — would
  show the operator a literal `[39m` before every message.
- `daemon/test/fixtures/log-fixtures.ts`: six `REAL_*` fixtures captured from the
  transcript above.
- `daemon/test/log-lines.test.ts`, `daemon/test/process-manager.test.ts`: new
  cases, including one that ingests the real captured shutdown line — escapes
  intact — through `ProcessManager` and asserts an externally-initiated shutdown
  ends `stopped` with `lastError` null rather than `crashed`. That wiring, not
  `isStopped` in isolation, is what the bug actually broke.

**Which of the new tests are bug reproductions, and which are only guards.** Not
all of them fail pre-fix, and saying otherwise would overstate the cover. Measured
by reverting `isStopped` and `isLoadingExistingWorld` to `stripTimestamp` and
removing the ingest-time strip, then re-running:

```
 ❯ test/log-lines.test.ts (14 tests | 2 failed)
   × the real stdout format ... > recognises the shutdown line
   × the real stdout format ... > recognises an existing-world load
 ❯ test/process-manager.test.ts (32 tests | 2 failed)
   × start > drives the real coloured stdout, and strips the colour out of the backlog
   × stop  > reports an externally-initiated shutdown as stopped, not crashed
      Tests  4 failed | 42 passed (46)
```

Exactly **four** are pre-fix-sensitive — the two above plus the backlog
assertion and the new end-to-end stop test. The rest are regression guards:
`parseReady(REAL_READY)` **passes pre-fix** because `READY` is an unanchored
substring search, the `normalize`/`stripAnsi` cases exercise API that did not
exist before the fix, and the last case pins behaviour that was already correct.

```
$ npx vitest run
 Test Files  9 passed (9)
      Tests  129 passed (129)
```

122 → 129. Rebuilt, redeployed, daemon restarted. Console lines after the fix,
same server:

```
console line="[2026-07-27 03:33:23] AphoreaMod started"
console line="[2026-07-27 03:34:20] Loading existing world at C:\Users\jeffp\AppData\Roaming\Necesse\saves\worlds\Tulsa.zip"
```

---

## Step 2 — Start an existing world (`Tulsa`)

*Ran **pre-fix**, at 03:27 local — this is the run that produced the Step 1
capture.*

```
$ POST /api/server/start  {"world":"Tulsa"}
{"ok":true,"status":{"state":"starting","world":"Tulsa","pid":13296,
 "startedAt":"2026-07-27T08:27:24.887Z","port":null,...,"activeTasks":[]}}
```

State `starting` → `running` on the ready line, 16s later. **Console lines below
are quoted with the leading colour escape stripped for readability** — see Step 1
for the same lines raw:

```
console "Loading existing world at C:\Users\jeffp\AppData\Roaming\Necesse\saves\worlds\Tulsa.zip"
console "Started server using port 14159 with 5 slots on world "Tulsa.zip", game version 1.2.0."
status  {"state":"running","world":"Tulsa","pid":13296,"port":14159,"slots":5,
         "gameVersion":"1.2.0","lastError":null,"activeTasks":[]}
```

Confirmed: port **14159**, 5 slots, version 1.2.0, `.zip` stripped from the world
name, `Loading existing world at` present. Mod loading streamed live — all 8
managed mods enumerated, plus the two expected `(WARN) Invalid mod jar` lines for
`torvians-qol.cfg` and `torvians-qol-settlements.txt`, which are config files the
game finds in the mods folder and is right to skip.

## Step 3 — Create a new world (`Claude Test World`)

Pre-check:

```
$ GET /api/worlds?name=Claude%20Test%20World
"candidate":{"name":"Claude Test World","valid":true,"exists":false}
```

Also confirms world listing filters correctly: the five `LATEST_BACKUP*.zip`
files in the worlds folder are excluded, leaving the four real worlds.

After starting, the console shows creation rather than load:

```
console "Creating new world at C:\Users\jeffp\AppData\Roaming\Necesse\saves\worlds\Claude Test World.zip"
console "Creating save with name: Claude Test World.zip"
console "Could not find world file, creating new one: Claude Test World.zip"
console "Finding spawn position..."
console "Started server using port 14159 with 5 slots on world "Claude Test World.zip", game version 1.2.0."
```

**`Loading existing world` did not appear** — grepped the whole session log for
it, zero hits during this run. Afterwards:

```
$ GET /api/worlds
{"name":"Claude Test World","modifiedAt":"2026-07-27T08:33:43.958Z","sizeBytes":26433}
$ GET /api/worlds?name=Claude%20Test%20World
"candidate":{"name":"Claude Test World","valid":true,"exists":true}
```

`exists` flipped false → true. World generation to ready took ~16s.

## Step 4 — Graceful stop

The single most important behaviour in the project — the only thing between the
user and a corrupted save. Exercised twice, once per world: `Tulsa` at 03:29:27
**pre-fix**, `Claude Test World` at 03:33:41 post-fix. Both clean.

```
$ curl.exe -X POST http://192.168.1.106:8710/api/server/stop
{"ok":true,"status":{"state":"stopped","world":"Tulsa",...,"lastError":null}}
HTTP=200
```

**First exercise (pre-fix), quoted exactly as logged** — escapes included,
because this is the load-bearing evidence in the document and it should be
checkable against the raw capture:

```
status  {"state":"stopping",...}
console line="\u001b[39m[2026-07-27 03:29:27] > stop"
console line="\u001b[39m[2026-07-27 03:29:27] Starting world save"
console line="\u001b[39m[2026-07-27 03:29:27] Completed world save before stopping server"
console line="\u001b[39m[2026-07-27 03:29:27] Stopped server on 2026/07/27 03:29:27 with code: SERVER_STOPPED"
console line="\u001b[39m[2026-07-27 03:29:27] World time: 172, day 1"
console line="\u001b[39m[2026-07-27 03:29:27] Server has stopped"
console line="\u001b[39m[2026-07-27 03:29:27] Exiting in 2 seconds..."
status  {"state":"stopped","world":"Tulsa","pid":null,"lastError":null,"activeTasks":[]}
```

Second exercise (post-fix), same sequence with the escapes now stripped by the
daemon rather than by the author:

```
console line="[2026-07-27 03:33:41] > stop"
console line="[2026-07-27 03:33:41] Starting world save"
console line="[2026-07-27 03:33:43] Completed world save before stopping server"
console line="[2026-07-27 03:33:43] Stopped server on 2026/07/27 03:33:43 with code: SERVER_STOPPED"
console line="[2026-07-27 03:33:44] Server has stopped"
console line="[2026-07-27 03:33:44] Exiting in 2 seconds..."
status  {"state":"stopped","world":"Claude Test World","pid":null,"lastError":null,"activeTasks":[]}
```

Both required lines present in both runs, `SERVER_STOPPED` exit code, state back
to `stopped`, `lastError` null, no `crashed`.

Worth being precise about why the pre-fix run still worked: `ProcessManager.stop()`
sets `stopping` itself before writing to stdin, so this path never consults
`isStopped`. The broken parser only mattered for a shutdown the daemon did not
initiate — which is exactly the case [not exercised live](#not-verified).

**Note on how the request must be sent.** PowerShell's `Invoke-WebRequest`
attaches a default `Content-Type` to a bodyless POST, and Fastify rejects it
before the handler runs:

```
POST /api/server/stop -> HTTP 415
{"statusCode":415,"code":"FST_ERR_CTP_INVALID_MEDIA_TYPE",...}
```

This is **not** a daemon defect — `client/src/api.ts:14-18` deliberately omits
the header when there is no body, and a `curl.exe -X POST` (which also omits it)
returns 200 as shown above. Recorded because it will look like a broken Stop
button to anyone reaching for `Invoke-RestMethod` to test by hand.

## Step 5 — Install a mod

`3603448084` / `Admin Tools`, server stopped.

```
$ POST /api/mods  {"id":"3603448084","name":"Admin Tools"}
{"ok":true,"taskId":"t1"}
$ GET /api/status
{"state":"stopped",...,"activeTasks":["t1"]}
```

`activeTasks` populated — the round-4 field working end to end for the first
time. steamcmd streamed over the WebSocket:

```
task[t1/mod-install] "Steam Console Client (c) Valve Corporation - version 1784919641"
task[t1/mod-install] "Loading Steam API...OK"
task[t1/mod-install] "Connecting anonymously to Steam Public...OK"
task[t1/mod-install] "Downloading item 3603448084 ..."
task[t1/mod-install] "Success. Downloaded item 3603448084 to "C:\Users\jeffp\steam\steamapps\workshop\content\1169040\3603448084" (339205 bytes) Unloading Steam API...OK"
task-done {"taskId":"t1","kind":"mod-install","ok":true}
status    {...,"activeTasks":[]}
```

Jar landed in the mods folder and registered:

```
$ dir /b ...\Necesse\mods
AdminTools-1.2.0-3.0.0.jar        <- new
AdvancedStarterKit-1.2.0-1.1.jar
... (the other 7 originals)

$ GET /api/mods
{"id":"3603448084","name":"Admin Tools","jar":"AdminTools-1.2.0-3.0.0.jar",
 "lastUpdated":"2026-07-27T08:34:06.422Z"}
```

Whole install, request to `task-done`: ~6 seconds.

## Step 6 — Stale-jar replacement

Installed `3603448084` a second time. The entire mod feature exists to stop the
mods folder accumulating two versions of one mod, which is what the game loads
badly.

```
$ POST /api/mods  {"id":"3603448084","name":"Admin Tools"}
{"ok":true,"taskId":"t2"}
task-done {"taskId":"t2","kind":"mod-install","ok":true}

$ dir /b ...\Necesse\mods\AdminTools*.jar
AdminTools-1.2.0-3.0.0.jar
```

Exactly one. Nine jars total, no duplicates.

## Step 7 — The running-state guard

With `Tulsa` running, both mutations refused, HTTP 409, message names the fix:

```
POST /api/mods -> HTTP 409
{"ok":false,"error":"Cannot change mods while the server is running. Stop it first."}

DELETE /api/mods/3532423990 -> HTTP 409
{"ok":false,"error":"Cannot change mods while the server is running. Stop it first."}
```

Refused outright, not silently queued — nothing appeared in `activeTasks` and the
mods folder was untouched.

### Bonus: the start-during-task interlock, exercised for real

A first attempt to start the server during install `t1` **succeeded** (HTTP 200).
That is not a defect: correcting for the ~0.7s daemon-to-workstation clock skew
visible throughout the log, `t1` had already settled before the request landed. A
green result here would have been a false positive, so it was re-run as a
deliberate race — start and delete fired immediately after the `t2` install
accepted:

```
POST /api/server/start -> HTTP 409
{"ok":false,"error":"Cannot start the server while a background task (mod install,
 mod update, or server update) is still running. Those tasks rewrite the server
 install and the mods folder, so overlapping them - or launching the game against
 a half-written one - risks corruption. Wait for it to finish. In flight: t2."}

DELETE /api/mods/3532423990 -> HTTP 409
{"ok":false,"error":"Cannot remove a mod while a background task ... In flight: t2."}
```

Both interlocks enforced server-side against a real in-flight steamcmd run.

## Step 8 — Cleanup and restoration

```
$ DELETE /api/mods/3603448084
{"ok":true}
HTTP=200
```

Mods folder, after — compare against the pre-verification snapshot:

```
07/26/2026  05:38 PM            26,781 AdvancedStarterKit-1.2.0-1.1.jar
07/26/2026  11:42 AM         3,375,375 AphoreaMod-1.2.0-1.0.38.jar
07/26/2026  06:09 AM           213,022 AutoTorch-1.0.jar
07/26/2026  05:55 AM           149,810 CorruptedRaidMod.jar
07/26/2026  10:40 PM             9,826 ExtendedRange-1.2.0-1.3.jar
07/26/2026  05:55 AM            53,017 FishingOverhaul-1.2.0-1.0.1.jar
07/27/2026  03:36 AM               751 modlist.data
07/26/2026  05:55 AM            43,819 NPCShopsExpanded-1.2.0-1.7.jar
07/26/2026  05:55 AM         3,684,575 SafeHavenQOL-1.2.0-2.6.jar
07/26/2026  09:08 PM                98 torvians-qol-settlements.txt
07/25/2026  04:15 PM            10,308 torvians-qol.cfg
              11 File(s)      7,567,382 bytes
```

All 8 original jars carry their original **size and mtime** — untouched, not
rewritten. Directory total `7,567,382` bytes matches the pre-verification total
exactly. `mods.json` maps all 8, `untracked` empty.

One residual needed chasing: `modlist.data` is the *game's* own enabled-mods
record, not the daemon's, and the game had rewritten it (751 → 839 bytes) to
include `admintools.menu` while the jar was present. Removing the mod left a
stale entry pointing at a jar that no longer exists. Necesse regenerates that
file from the jars it actually finds, so one more `Tulsa` start/stop cleaned it —
`findstr /i admintools modlist.data` now returns nothing and the file is back to
its original 751 bytes.

Worlds folder restored:

```
Goober Goof.zip       5704866 7/26/2026 5:35:06 PM
Infected Toenail.zip  1162220 7/26/2026 11:18:22 PM
Jeff and Eli.zip     12460572 7/24/2026 2:21:40 AM
LATEST_BACKUP1..5.zip                (untouched)
Tulsa.zip              183038 7/27/2026 3:34:33 AM
```

`Claude Test World.zip` deleted. The other three real worlds are untouched.
`Tulsa.zip` is 183038 bytes, up from 182865 — it was loaded and cleanly re-saved
three times during testing, which is the expected and unavoidable cost of using
it as the load-test world.

**Final state:** server `stopped`, daemon running, `activeTasks: []`.

---

## Defects found

| # | Severity | Where | Status |
|---|---|---|---|
| 1 | **High** | ANSI escape before the timestamp defeats `isStopped`, so an externally-initiated shutdown is reported as `crashed` rather than `stopped`; separately, console output reaches the client full of raw escape bytes | Fixed, 4 pre-fix-sensitive tests added, redeployed; **cosmetic half re-verified live, behavioural half not** |
| 2 | Low (tooling) | `Restart-ScheduledTask` does not exist on SERVER; the documented redeploy step fails | Fixed — `scripts/04-restart-daemon.ps1` |

Scope note on #1: `isLoadingExistingWorld` was broken by the same cause but has
**no production caller**, so it contributed nothing to the live blast radius. The
one real consequence was the `crashed` misclassification. Neither defect was
reachable by unit tests; both required a real server.

---

## Not verified

Nothing below was exercised. A green result above says nothing about any of it.

### The behavioural half of the ANSI fix

The fix has two halves, and **only one of them was confirmed live.**

- *Cosmetic half — verified.* Console lines arrive escape-free after the
  redeploy, confirmed by reading the bytes on the WebSocket.
- *Behavioural half — **not verified**.* The consequence that made this defect
  High severity is that an externally-initiated shutdown was misclassified as
  `crashed`. Reproducing that live needs a stop issued from **outside** the
  daemon, which needs a connected game client with admin rights. No such
  shutdown was performed post-fix, so the claim that it now reports `stopped`
  rests on the unit test added for it
  (`process-manager.test.ts` › "reports an externally-initiated shutdown as
  stopped, not crashed"), which was confirmed to fail against the pre-fix
  parser — **not** on live evidence. Every stop in this document was
  API-initiated and therefore took the path that was never broken.

### Deliberately skipped — awaiting user authorization

- **Update All Mods** (`POST /api/mods/update-all`). **Not run.** It would replace
  all 8 installed jars with current Workshop versions and delete the originals,
  which Steam Workshop cannot serve back. The user has not authorized this. The
  only thing touched was its refusal path, and even that only incidentally: a
  bodyless POST was rejected at HTTP 415 before reaching the handler, so no task
  was ever created. Its guard logic is unit-tested but **unexercised live**.
- **Update Server** (`POST /api/server/update`). **Not run**, same reason — not
  authorized. Not even its refusal-while-running path was probed, to remove any
  chance of a mistimed call finding the server stopped and starting a real
  `app_update`. Entirely unverified live.

### Structurally out of reach in this session

- **The `unmanaged` path.** Needs a Necesse server started outside the daemon so
  there is no stdin pipe. Never entered — `state` was never `unmanaged` at any
  point. `refreshUnmanaged`, the unmanaged branch of `kill()`, and the "must be
  shut down before starting a new one" error are all unit-tested only.
- **The `crashed` path.** Needs a deliberately broken mod or a server that dies on
  its own. Never entered. `lastError` was `null` in every status read here. Note
  that defect 1 above meant the daemon *would* have mislabelled a clean external
  shutdown as `crashed` — that specific misbehaviour is fixed and unit-tested, but
  no genuine crash was ever observed live.
- **The stop-timeout path.** Needs a server that refuses to exit within
  `stopTimeoutMs` (90000 on SERVER). Every real stop completed in 2-3 seconds. The
  504 response, the timeout's waiter-nulling, and the "process was left running"
  message are unit-tested only.
- **The 60-minute task expiry** (`TASK_EXPIRY_MS`). Cannot be waited out. The
  longest real task here was ~6 seconds. Untested against a genuinely hung
  steamcmd; the logic is covered by fake timers in `http.test.ts` only.
- **Concurrent clients.** Exactly one WebSocket observer was connected throughout.
  Broadcast fan-out to multiple sockets, the dead-socket collection in
  `broadcast`, and two clients racing the same mutation are all unverified.
- **The Tauri client UI.** No GUI was ever launched. **All verification here was
  API-level**, against HTTP and the raw WebSocket. Nothing is known live about the
  status pill, the busy-gating on `activeTasks`, the "Will create a new world"
  header, console rendering, or any button. The client's 53 tests are the only
  evidence for any of it. In particular, the ANSI fix was verified by reading the
  bytes on the wire, *not* by looking at a rendered console pane.
- **Daemon restart while the server is running.** Not attempted. Known limitation
  rather than a bug: the daemon loses the stdin pipe and can only report
  `unmanaged`. Fixing it needs a detached child plus a named pipe, out of scope
  for v1. Every restart in this session was done with the game stopped.
- **A world whose name needs escaping**, an invalid world name reaching `start`, a
  full disk, a mods folder that is read-only, and steamcmd failing (bad workshop
  id, no network) — all unit-tested, none exercised against the real thing.
- **The hardened `scripts/04-restart-daemon.ps1`.** The version that performed the
  Step 0 restart printed its state and carried on regardless; it was afterwards
  made to *throw* on a failed `ssh`, on a task still `Running` after the 20s wait,
  and on a `/api/status` with no `activeTasks`. **That hardened version has not
  been run.** Re-running it would restart the daemon, which this session was
  directed not to do, so its new failure paths are unexercised — including, by
  construction, all three of the throws.
