# Local verification (no server, no build) — 2026-07-29

Task 14 of the `2026-07-29-shareable-release` plan, run against a clean local
checkout on the workstation. This document is a companion to
[`verification-2026-07-27.md`](verification-2026-07-27.md), not a replacement
for it — that document is the only evidence that the daemon has ever driven a
real Necesse server, and nothing here adds to that. Everything below was run
from the repository root or from `daemon/`/`client/` on the workstation,
touched no SSH target, and started no game process.

**Branch** `feat/shareable-release`, HEAD at commit time `8a0bfa2`.

**Read [Not verified](#not-verified) before deciding this branch is safe to
put on the real server.** Four green suites below prove the two packages are
internally consistent with each other's assumptions. They prove nothing about
deployment, packaging, or the interactive tools an operator actually runs.

---

## What was run, and the real output

### Step 1 — both suites, both typechecks

`daemon/`, `npx vitest run`:

```
 Test Files  23 passed (23)
      Tests  472 passed (472)
   Duration  3.88s
EXIT=0
```

`daemon/`, `npx tsc --noEmit`: no output, `EXIT=0`.

`client/`, `npx vitest run`:

```
 Test Files  13 passed (13)
      Tests  270 passed (270)
   Duration  7.35s
EXIT=0
```

`client/`, `npx tsc --noEmit`: no output, `EXIT=0`.

Four `EXIT=0`, as the brief expected. 472 daemon tests, 270 client tests —
742 total. For scale against the last live-verification document: that run
was against 122 daemon / no separate client count at the time; this branch
has grown the daemon suite to 472 and added a client suite of 270, including
the seam test (`client/test/api.integration.test.ts`) that stands up a real
daemon and drives it with the real client transport.

### Step 2 — shared types are byte-identical

```
A=6B9E829D99A806F52414C80157080633C4724950746C6906C6CC96CCEFC864B2
B=6B9E829D99A806F52414C80157080633C4724950746C6906C6CC96CCEFC864B2
MATCH=True
```

`daemon/src/types.ts` and `client/src/types.ts` hash identically.

### Step 3 — personal values in tracked source

The brief expected no output from this sweep. **That is not what happened.**
Run exactly as specified:

```powershell
git ls-files | Where-Object { $_ -notmatch "^docs/" } | ForEach-Object {
  Select-String -Path $_ -Pattern "jeffp|192\.168\.1\.106" -ErrorAction SilentlyContinue
}
```

Real output, five hits across four files:

```
client\test\ConnectionSettings.test.tsx:24:  await userEvent.type(screen.getByLabelText(/host/i), "192.168.1.106");
client\test\ConnectionSettings.test.tsx:29:  expect(onSave).toHaveBeenCalledWith({ host: "192.168.1.106", port: 8710, token: "s3cret" });
client\test\api.test.ts:4:  const BASE = "http://192.168.1.106:8710";
client\test\settings.test.ts:23:  saveConnection({ host: "192.168.1.106", port: 8710, token: "abc" });
client\test\settings.test.ts:24:  expect(loadConnection()).toEqual({ host: "192.168.1.106", port: 8710, token: "abc" });
client\test\settings.test.ts:106:  const c = { host: "192.168.1.106", port: 8710, token: "abc" };
daemon\test\fixtures\log-fixtures.ts:13:  "[2026-07-26 22:40:42] (WARN) Invalid mod jar located at C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods\\torvians-qol.cfg";
daemon\test\fixtures\log-fixtures.ts:32:  "\u001b[33m[2026-07-27 03:27:28] (WARN) Invalid mod jar located at C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods\\torvians-qol.cfg";
```

Do not read this as a defect this branch introduced — `git log` on all four
files shows they predate the branch (already present on `main` before
`feat/shareable-release` was cut). Task 11's scrub pass (commit `b4e5b66`,
report in
`.superpowers/sdd/2026-07-29-shareable-release/task-11-report.md`) found this
same set, reasoned about each one, and left them deliberately:

- The three `client/test/*` files use `192.168.1.106` as an arbitrary
  private-range sample host for `ConnectionSettings`, `api.ts` and
  `settings.ts` round-trip tests. Any RFC 1918 address would exercise the
  same code path; nothing about the value itself identifies anyone once the
  string is disconnected from the fact that it happens to also be the real
  server's LAN address.
- `daemon/test/fixtures/log-fixtures.ts` is real captured stdout from the
  live server, ANSI escapes included. The project's own `CLAUDE.md` says not
  to normalize these fixtures because they are evidence, not sample data —
  scrubbing the embedded `jeffp` path would be exactly the normalization it
  warns against.

So the honest statement is: **the sweep did not come back clean, the brief's
stated expectation was wrong, and the actual hits are judged acceptable on a
case-by-case basis that predates this task** — not that the check passed as
written. Anyone re-running Step 3 in the future should expect this same
output and treat a *new* hit, not any hit at all, as the signal.

### Step 4 — the daemon build produces the entry points the release zip expects

From a clean `daemon/dist` (removed before the build so the check could not
pass on stale output):

```
> necesse-daemon@1.0.0 build
> tsc -p tsconfig.build.json

EXIT=0
```

`Test-Path` confirmed after the build:

```
dist\index.js       True
dist\setup-cli.js   True
dist\migrate-cli.js True
```

These are the exact three paths `daemon/setup.cmd`, `daemon/start-daemon.cmd`
and `daemon/migrate.cmd` invoke. The build producing them is necessary for
those shims to work but is not the same thing as running the shims — see
[Not verified](#not-verified).

---

## How this branch was built, stated plainly

Every task in this plan was implemented, then independently code-reviewed,
then fixed against the review's findings, in that order, before the next task
started. The reviews were not rubber stamps: across the fourteen tasks,
review rounds escalated real Critical and Important findings, and — worth
stating because it changes what the green suites above actually prove — **a
substantial majority of the serious findings originated in the plan's own
test snippets, not in the implementations.**

The pattern repeated across at least four separate tasks (2, 3, 6, 7, and
arguably 9): the plan specified a test that asserted a happy path and one
obvious negative case, and that test turned out to pass against a stubbed or
otherwise weakened implementation — a `probeConfig` that returned a plausible
guess without checking the filesystem, a `verifyTree` that never recursed, a
port validator reduced to `typeof port === "number"`. Each of these was
closed the same way: by deliberately breaking the implementation back down to
the weak version and confirming the existing test suite still failed to
catch it, then rewriting the test so that substitution *would* fail. The
project ledger (`.superpowers/sdd/2026-07-29-shareable-release/progress.md`)
records this explicitly as "the FOURTH task whose only Important finding
originated in the plan's own test snippets rather than in the implementer's
work," and by the end of the run it was the dominant failure mode, not an
outlier.

What this means for a reader of this document: a green test count is
evidence that the currently-committed implementation matches the
currently-committed test, and — because of the substitution-proof discipline
above — reasonably strong evidence that the test would actually fail if that
specific implementation regressed. It is not evidence that the *test itself*
asks the right question, except where a substitution proof is on record. Read
the per-task reports in `.superpowers/sdd/2026-07-29-shareable-release/` for
which tests have that proof and which do not.

The same discipline caught two Critical defects in `scripts/` during Task
11's review (commits `b4e5b66..4d53290`, both fully described in
`task-11-report.md`):

1. `02-deploy.ps1` seeded `mods.json` into the install directory, but
   `mods.json` is one of `LEGACY_STATE_FILES` and the daemon now keeps state
   in `%PROGRAMDATA%`. A deploy onto a fresh box, before the setup wizard had
   ever run, would leave a legacy-shaped file sitting next to `dist/` with
   an empty state directory behind it — which `resolveLegacyState` reads as
   proof of an unmigrated install, and the daemon refuses to boot, naming
   `migrate.cmd`, on a box that was never anything but fresh. The deploy step
   itself caused the daemon it had just deployed to be unable to start.
2. `scripts/deploy.local.ps1.example` shipped `$TaskName = "necesse-daemon"`
   while `03-register-task.ps1`'s actual fallback (and the live box's real
   task name) is `"NecesseDaemon"`. Copying the example verbatim makes the
   stop-existing-task lookup miss, so the script skips straight to
   registering a second scheduled task while the first daemon still holds
   the port. The new process dies on `EADDRINUSE`; the script's own final
   health check is answered by the still-running old daemon; the script
   reports success. This is precisely the failure the stop-and-wait block
   exists to prevent, defeated by one string not matching another.

Both are fixed on this branch as of commit `4d53290`. **Neither could have
been caught any other way than a human (or reviewer) reading the scripts
side by side with the code they configure** — nothing in `scripts/` has ever
been executed in this project's automated verification, on this branch or
any prior one, which is exactly why this class of bug survived to review
instead of to a test failure.

---

## Not verified

Nothing in this section was exercised. Do not read the four green results
above as coverage of any of it.

### Nothing in `scripts/` has run, at all

No script under `scripts/` was executed at any point during this branch's
work, including this task — every task brief for this plan carried the same
prohibition, and Task 14's did too. `01-install-node.ps1` and
`03-register-task.ps1` run **on the server**; `02-deploy.ps1` and
`04-restart-daemon.ps1` run from the workstation but reach the server over
SSH and, in `04`'s case, stop and restart a daemon whose child process may be
a live game session. The two Critical defects described above were found by
code review reading the scripts against the code they configure — nothing
else could have caught them, because nothing executes these scripts as part
of any suite, local or CI. Their presence is direct evidence that this class
of bug is real and that the absence of execution is not a hypothetical gap.

### The Tauri client was never built

`npx tauri build` was not run at any point in this task or any prior one on
this branch — it is on the explicit prohibition list. The CSP change in
`client/src-tauri/tauri.conf.json` (line 22:
`"csp": "default-src 'self'; connect-src 'self' http: https: ws: wss:; img-src 'self' data: https://*.steamusercontent.com https://*.steamstatic.com https://steamuserimages-a.akamaihd.net; style-src 'self' 'unsafe-inline'"`)
is verified only by reading the file and reasoning about what the directives
allow, not by building the app and confirming a `connect-src` violation is
actually blocked or actually permitted at runtime. No Tauri binary of any
kind — dev or release — has been produced from this branch. Everything known
about the client beyond its unit and integration test suites is inference
from source.

### Neither GitHub Actions workflow has ever run

`.github/workflows/ci.yml` and `.github/workflows/release.yml` exist on this
branch (added in Task 13, commit `8a0bfa2`) but neither has ever executed on
GitHub Actions — nothing has been pushed, and pushing is out of scope for
this task. Task 13's own report names the most likely first failure
explicitly: the release workflow's `npm run tauri build` step running on
`windows-latest`, because whether `actions/setup-node@v4`,
`dtolnay/rust-toolchain@stable`, the MSVC build tools and WebView2 are
present and sufficient on that runner image was never checked and could not
be checked without running the forbidden build. Separately unverified in the
same workflow: `npm ci --omit=dev` producing a working `node_modules` inside
the staged zip, `Compress-Archive` producing a zip whose `start-daemon.cmd`
actually finds `dist/` and `node_modules` when extracted, and
`softprops/action-gh-release@v2` actually uploading the two installer assets
with the glob patterns used (verified by reading the action's source, not by
running it).

### The setup wizard's interactive path was never driven end to end

`daemon/src/setup-cli.ts` opens a real `readline/promises` interface against
`process.stdin` (`createInterface({ input: process.stdin, output:
process.stdout })`, line 10) and prompts the operator through five path
questions plus the Steam API key. `daemon/test/setup-probe.test.ts` — the
only test file that touches this module — covers exactly two things:
`probeConfig` (the pure filesystem-probing function that guesses candidate
paths) and `generateToken`. Neither test drives a prompt, reads an answer
from stdin, or reaches `main()`. The interactive question-and-answer loop,
its validation of typed answers, and the final `config.json` write from
those answers have zero automated coverage and have never been run by hand
during this branch's work either — every verification claim about
`setup-cli.ts` in the Task 12 README report is sourced from reading the file,
not from running `npm run setup` and typing answers.

### steamcmd under SYSTEM remains unproven

Unchanged from the state recorded in `CLAUDE.md` before this work started.
Both steamcmd invocations (`workshop_download_item`, `app_update ...
validate`) mutate real state — a workshop download or a rewrite of
`C:\necesseserver` — so there has never been a read-only way to exercise the
anonymous-login handshake under SYSTEM's token without either the live
server or a disposable stand-in for it, and this task had access to neither.
What was previously confirmed (SYSTEM holding inherited `FullControl` on the
relevant paths) is still all that is confirmed.

### The `%PROGRAMDATA%` state directory has never been exercised on the real server

`daemon/src/state-dir.ts` and the `NECESSE_MANAGER_DATA` override are
covered by `daemon/test/state-dir.test.ts` against a temp directory on the
workstation, and by the integration suite's use of a temp directory in place
of `%PROGRAMDATA%`. No daemon has ever actually booted against
`C:\ProgramData\NecesseServerManager` on the real server — the only daemon
ever run against that box wrote its config beside `dist/`, which is the
pre-this-branch layout. `daemon/migrate.cmd` and
`daemon/src/migrate-state.ts`'s `migrateState`/`verifyTree` are covered by
`daemon/test/migrate-state.test.ts` against synthetic directory trees only.
The one-time migration has never been run against a real install — real
world saves, a real mod library, a real `config.json` that predates the
state-directory split. Nothing about disk space, permissions, or an
in-progress game session during a real migration has been exercised.

### Everything already on record as unverified in the prior document

`verification-2026-07-27.md`'s own "Not verified" section — the `unmanaged`
path, the `crashed` path, the stop-timeout path, task expiry, concurrent
WebSocket clients, a daemon restart while the server is running, and the
hardened `04-restart-daemon.ps1` — is untouched by anything in this task and
remains exactly as unverified as it was on 2026-07-27. This document adds new
gaps; it closes none of the old ones.

### Summary table

| Area | What exists | What was actually exercised |
|---|---|---|
| `scripts/*.ps1` | Two Critical defects found and fixed by code review | Nothing — never executed, on this branch or ever |
| Tauri client build | CSP and packaging config written | Read only — `tauri build` never run |
| GitHub Actions (`ci.yml`, `release.yml`) | Both files exist, YAML-valid | Never triggered on GitHub |
| Setup wizard interactive prompts | Full readline loop in `setup-cli.ts` | Only its pure probe function (`probeConfig`) and `generateToken` |
| steamcmd under SYSTEM | Filesystem permissions confirmed pre-branch | Anonymous-login handshake under SYSTEM never run |
| `%PROGRAMDATA%` state dir on real server | Code and unit tests against temp dirs | Never booted on the real box |
| `migrate.cmd` | Code and unit tests against synthetic trees | Never run against a real install |
| Everything in `verification-2026-07-27.md`'s own gaps list | Unchanged | Unchanged |
