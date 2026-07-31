# Per-world launch options verification — 2026-07-31

Task 8 of the `2026-07-31-launch-options` plan: the final task, documentation
plus a record of what was and was not verified. Read
[Not verified](#not-verified) before treating anything below as proof the
feature works against a real game server. It does not; it proves the daemon
and client packages are internally consistent with each other and with the
decompiled source, nothing more.

**Branch** `feat/launch-options`. Everything recorded below was run against
`4cee321`. That was **not** the branch head even when this file was first
written: the documentation commit `663f587` sits on top of it, and the
whole-branch review's fix pass sits on top of that. So the numbers in this
record (532 daemon tests, and the file counts under Step 1) describe `4cee321`
and nothing later. They are left as measured rather than restated, because
re-running a suite is not the same evidence as having run it.

---

## What was run, and the real output

### Step 1 — daemon suite and typecheck

`daemon/`, `npx vitest run`:

```
 Test Files  26 passed (26)
      Tests  532 passed (532)
   Start at  15:46:15
   Duration  3.01s (transform 634ms, setup 0ms, collect 1.89s, tests 7.51s, environment 3ms, prepare 1.15s)

EXIT=0
```

Of those 26 files, five are new to this feature: `test/launch-options.test.ts`
(15 tests, the store), `test/launch-options-schema.test.ts` (14 tests, field
validation), `test/launch-options-migration.test.ts` (8 tests, the owner
migration), plus launch-options coverage folded into `test/http.test.ts` (150
tests total for that file) and `test/process-manager.test.ts` (44 tests,
including `buildArgs`).

`daemon/`, `npx tsc --noEmit`: no output, `EXIT=0`.

### Step 2 — client typecheck only

`client/`, `npx tsc --noEmit`: no output, `EXIT=0`.

**The client's `npx vitest run` was deliberately not run for this task.**
Another agent was reviewing `client/test/api.integration.test.ts` at the time
this task ran, and this task's brief said explicitly not to touch anything
under `client/test/`. Running the client suite was avoidable without
touching that file, but the brief's own verify list for this task omits it,
so it was skipped rather than run speculatively against a file mid-review.
That means **this document carries no fresh evidence that the client test
suite (including `LaunchOptionsDialog`'s jsdom tests) passes on this exact
commit** — only that the daemon suite and both typechecks do.

### Step 3 — shared types are byte-identical

```
A=CF5A8AD31B5EEE29188BDDDF30A176BA5F6F42EDE8ABA02C844093A748D640AE
B=CF5A8AD31B5EEE29188BDDDF30A176BA5F6F42EDE8ABA02C844093A748D640AE
MATCH=True
```

`daemon/src/types.ts` and `client/src/types.ts` hash identically.

### Step 4 — `owners` is gone from the source, outside the migration

```powershell
Select-String -Path daemon\src\*.ts,client\src\*.ts,daemon\test\*.ts,client\test\*.ts -Pattern "\bowners\b"
```

Five hits, all in exactly the two files expected:

```
daemon\src\launch-options-migration.ts:5:  * Moves `config.json`'s retired `owners` array to the default launch owner.
daemon\src\launch-options-migration.ts:9:  * LAST survives - an install with two owners has silently had one this whole
daemon\src\launch-options-migration.ts:35:  `config.json listed ${names.length} owners (${names.join(", ")}), but the game accepts one: `
daemon\src\launch-options-migration.ts:74:  const message = await migrateOwners((stored as { owners?: unknown }).owners, store);
daemon\test\launch-options-migration.test.ts:71:  await writeFile(configFile(), JSON.stringify({ owners: ["Jeff", "Eli"] }), "utf8");
```

No other source or test file under either package's `src/` or `test/`
mentions `owners`. `DaemonConfig` no longer carries the field at all; the
only place the word survives is the one-time migration reading it out of an
old `config.json`, and that migration's own test.

**This is a statement about the source tree, not about any `config.json` on
disk.** `owners` is still present in every real config file that ever had it,
and stays there: `loadConfig` and `saveConfig` round-trip every stored key they
do not explicitly derive, so nothing ever removes it. The grep above proves the
daemon no longer *acts* on the array except in the migration, not that the
array is gone from the live install. That distinction is why the migration's
re-run guard is a durable `ownersMigratedAt` marker in `launch-options.json`
rather than an inference from whether a default owner is currently set.

---

## What this feature is, stated plainly

The game's own `parseLaunchOptions` (decompiled, `necesse/engine/GameLaunch.java`)
accumulates command-line flags into a plain `HashMap<String,String>`. Passed
repeated `-owner` flags, only the last one survives. The old `config.json`
modeled owners as an array and emitted one `-owner` flag per entry, so any
install with more than one configured owner had been silently applying only
the last name in that array the entire time this project has existed. This
was a real, live bug, not a hypothetical one.

The fix is `daemon/src/launch-options-migration.ts`: on first boot after
upgrading, it reads the old `owners` array out of `config.json`, and if a
default launch owner has not already been set, seeds it from the array's
FIRST entry (not the last one the game happened to be using) and returns a
message naming exactly what changed. This is a deliberate behaviour change,
not a silent one: at the next start of any world, owner permissions move to
that name, and the message says so.

---

## Not verified

Nothing in this section was exercised by this task or any task in this plan.
Do not read the four green checks above as coverage of any of it.

### No world has ever been launched with a real launch option

Every claim in this codebase that "the game accepts flag X" — the field list
in `LAUNCH_OPTION_FIELDS`, the clamping behaviour `checkLaunchOption` refuses
against, the fact that an unparseable integer only warns and falls back to a
default rather than failing the launch, the last-flag-wins behaviour the
`owner` migration exists because of — rests entirely on reading the
decompiled source at `C:\Users\jpegg\code\necesse-projects\decompiled\`,
specifically `necesse/engine/loading/ServerLoader.java`'s `handleLaunchArgs`
and `necesse/engine/GameLaunch.java`'s `parseLaunchOptions`. No world, on this
task or any earlier one in this plan, has ever actually been started with a
non-empty set of launch options and observed to boot, refuse a bad value, or
apply a value at all. Every one of the 17 fields in `LAUNCH_OPTION_FIELDS`,
the daemon-owned exclusions (`nogui`, `datadir`, `world`, `settings`, `logs`),
and the clamp-vs-reject distinction are inference from source, not
observation of the running game.

### The dialog has never run in a built Tauri app

`LaunchOptionsDialog.tsx` has unit-test coverage under jsdom only
(`client/test/LaunchOptionsDialog.test.tsx`, not touched by this task).
jsdom does not run a real browser or a real WebView2 control. Two concrete
consequences follow from that: real-WebView2 keystroke behaviour on the
`int` fields (typing, backspace, paste, the browser's native number-input
spinners) has never been observed, and the `.lo-*` CSS classes
(`.lo-group`, `.lo-fields`, `.lo-row`, `.lo-note`, `.lo-status`,
`.lo-firewall-note`) have never been looked at rendered — no screenshot, no
`npm run tauri build`, no `npm run tauri dev` was taken of this dialog at any
point in this plan.

### The owner migration has never run against a real `config.json`

`launch-options-migration.test.ts`'s 8 tests exercise `migrateOwners` and
`runOwnerMigration` against synthetic `config.json` content written to a temp
directory for the test. Neither this task nor any earlier task in this plan
ran the migration against the real `config.json` on the server box
(`192.168.1.106`), or against any config file that predates this feature and
was written by an earlier version of `setup.cmd`. Whether the real file's
shape matches what the migration expects, and what its actual `owners` value
is, is unknown from this work. Per this task's constraints, the live server
was not touched at all — it was not reachable and no code ran there.

### Everything already on record as unverified in prior documents

`docs/verification-2026-07-30-installer.md` and its predecessors' own "Not
verified" sections (the elevated install path, an upgrade over an existing
installation, `scripts/03-register-task.ps1` actually running, steamcmd under
SYSTEM, and more) are untouched by this task and remain exactly as unverified
as recorded there. This document adds new gaps specific to launch options; it
closes none of the old ones.

### Summary table

| Area | What exists | What was actually exercised |
|---|---|---|
| Daemon launch-options code (schema, store, migration, routes, `buildArgs`) | 532 daemon tests, all passing; `tsc --noEmit` clean | Unit and integration tests against real Fastify `inject()` and the real filesystem; never a real game process |
| Game **parsing** of a command line | `checkLaunchOption`'s text and negative-number rules | **Measured** against the real `C:\necesseserver\Server.jar` with a compiled probe calling `GameLaunch.parseLaunchOptions` directly — see "Probe against the real parser" below |
| Game **acceptance/handling** of any flag once parsed | 17-field schema, clamp/reject rules, daemon-owned exclusions | Still read from decompiled source only; zero observed launches. The probe proves what the game *parses*, not what it then does with the value |
| `LaunchOptionsDialog` client UI | Full dialog with 17 fields, grouped, jsdom-tested | jsdom only; never rendered in a built app or WebView2 |
| Owner migration | Retires `DaemonConfig.owners`, seeds `defaults.owner` from the first entry | Tested against synthetic input only; never run against the real `config.json` |
| Shared `types.ts` | `LaunchOptionValue`, `LaunchOptionField`, `LaunchOptionsResponse` | Hash-verified byte-identical across `daemon/src` and `client/src` |
| `owners` retirement | Removed from `DaemonConfig`; survives only in the migration module and its test | Confirmed by exhaustive grep across both packages' `src/` and `test/` |

---

## Probe against the real parser — 2026-07-31

Added after the whole-branch re-review found that the text-value rule shipped in
`checkLaunchOption` was **wrong**, having been derived by reading the decompiled
`GameLaunch.parseLaunchOptions` rather than by measuring it. The correction was
found by compiling a probe against the real
`C:\necesseserver\Server.jar` and calling `parseLaunchOptions` directly, with
the argument vector `ProcessManager.buildArgs` actually produces (supplied
options first, `-nogui -datadir <dir> -world <world>` last).

The decompile's trace stops one line short. After the parser consumes a value it
does **not** advance past it; it resynchronises with

```java
nextOption = Math.max(full.indexOf("-", currentIndex), full.indexOf("+", currentIndex));
```

which finds a `-` **anywhere, including inside a word**. Measured output, copied
from the probe run:

```
a-dev                  owner=[a-dev]                  intact=true  INJECTED=true  dev=[]
a-dev 42               owner=[a-dev 42]               intact=true  INJECTED=true  dev=[42]
x-settings C:/evil.cfg owner=[x-settings C:/evil.cfg] intact=true  INJECTED=true  settings=[C:/evil.cfg]
x-logs C:/evil         owner=[x-logs C:/evil]         intact=true  INJECTED=true  logs=[C:/evil]
Jean-Luc               owner=[Jean-Luc]               intact=true  INJECTED=true  Luc=[]
co-op night            motd=[co-op night]             intact=true  INJECTED=true  op=[night]
```

Note `intact=true` on every row: **the option the operator set arrives
correctly**, so nothing looks wrong from either end, while a second option they
never asked for is also set. `dev`, `settings` and `logs` are all real options
this daemon deliberately withholds, on a process running as SYSTEM.

The previous rule (`/^[-+]|\s[-+]|["']/`) blocked none of these. Worse, two of
them were **asserted as safe** in `launch-options-schema.test.ts` and
`launch-options-migration.test.ts`, and documented as safe in `README.md`. Those
assertions were inverted rather than deleted so the hole cannot be
reintroduced. The rule is now `/[-+"']/`.

### Negative numbers — the same defect, separately measured

```
worldborder -1     worldborder=[]  intact=false INJECTED=true  1=[]
maxsettlers -1     maxsettlers=[]  intact=false INJECTED=true  1=[]
maxsettlements -1  maxsettlements=[] intact=false INJECTED=true 1=[]
worldborder 0      worldborder=[0] intact=true  INJECTED=false
worldborder 5000   worldborder=[5000] intact=true INJECTED=false
```

A negative number cannot be put on this game's command line at all. The schema
had been declaring `-1` as the legal minimum for `worldborder`,
`maxsettlements` and `maxsettlers`, and its help text advertised "-1 for none"
and "-1 for unlimited" — a value the game can never receive.

**Decision: reject the negative and raise those minimums to 0, rather than
keeping `-1` and silently emitting it.** Rejecting alone would have left the
form offering a minimum it would then refuse; raising the minimum alone would
have implied `0` is a substitute for `-1`, which it is not (a zero-size border
is not "no border"). So both were done, and the help text now says where the
sentinel went and that leaving the option unset gets the game's own default.
The negative check runs *before* the range check so the operator is told the
parser limitation rather than a bare "must be 0 or more".

### One result that did not match expectation

A lone `+` inside a value does **not** currently inject: `2+2 is 4` parses
cleanly. That is because `Math.max` takes the later of the two
first-occurrences, and `buildArgs` always appends `-nogui -datadir -world`
after the value, so a `-` further right always wins. It is a property of this
daemon's argument **order**, not of the value — `a-dev+x` still injects through
the `+`. `+` is refused anyway, so the rule stays true of the value in
isolation and does not depend on argument ordering staying as it is.

### What this probe does and does not establish

It establishes what `GameLaunch.parseLaunchOptions` **parses** a given command
line into. It establishes nothing about what the game then **does** with a
parsed option, and no game process was launched. The gaps recorded above are
unchanged: still no real launch, still nothing run against the live server, and
the owner migration is still tested only against synthetic input.
