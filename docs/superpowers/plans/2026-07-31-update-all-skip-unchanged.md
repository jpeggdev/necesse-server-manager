# Update All: Skip Unchanged Mods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Update All` skip mods whose workshop entry has not changed since the installed jar was downloaded, instead of reinstalling all of them unconditionally.

**Architecture:** The registry records the workshop entry's `time_updated` for the jar it installed, so the decision compares Steam's clock to Steam's clock rather than to ours. A single shared comparison function is used by both the update badges and the install loop, so the two can never disagree. Skipping additionally requires that the library still holds a current jar, so a lost jar self-heals.

**Tech Stack:** Node 22, TypeScript, Fastify, vitest (daemon); React 19 + Vite + vitest + React Testing Library (client).

**Spec:** `docs/superpowers/specs/2026-07-31-update-all-skip-unchanged-design.html`

## Global Constraints

- `daemon/src/types.ts` and `client/src/types.ts` must stay **byte-identical**. Hash both after editing either.
- Daemon sources must stay **ES2020-library-compatible**. `daemon/tsconfig.json` pins `"lib": ["ES2020"]` because `client/test/api.integration.test.ts` imports the real daemon and typechecks it a second time under the client's ES2020 lib. `Object.hasOwn`, `Array.at`, `findLast` are forbidden. Do not raise the lib setting to silence an error.
- **Errors are never swallowed or reworded.** `ENOENT` is distinguished from a real failure; everything else rethrows with the path and the underlying message. A `catch` that returns a default is a defect here, not a convenience.
- Every HTTP route and the WebSocket upgrade require an access token as `Authorization: Bearer`. An empty `authToken` is the documented trusted-LAN opt-out.
- **Mod mutations are refused while the server runs or a task is in flight.** Do not change that; `POST /api/mods/update-all` already reserves a task.
- Verify from `daemon/`: `npx vitest run` and `npx tsc --noEmit`. From `client/`: `npx vitest run` and `npx tsc --noEmit`.
- Never run anything under `scripts/`. Never `git push`. Never deploy or touch the live server at 192.168.1.106.
- **Every test must fail when the code it covers is removed.** Prove it by substitution: break the implementation, run the test by name, confirm RED, restore. Ten vacuous tests were caught in the previous feature branch; this is the most common defect in this repo.

---

## File Structure

| File | Responsibility |
|---|---|
| `daemon/src/mod-updates.ts` | **New.** The single comparison function both the badge route and the install loop use. Pure, no IO. |
| `daemon/src/types.ts`, `client/src/types.ts` | `ModEntry.workshopUpdatedAt`, `InstallResult.skipped`. Byte-identical. |
| `daemon/src/mod-registry.ts` | Normalise the new field on load so a pre-existing registry reads as `null`, not `undefined`. |
| `daemon/src/mod-installer.ts` | Records the timestamp on install; the gate in `updateAll`; skipped results and the summary line. |
| `daemon/src/mod-library.ts` | Lookup by workshop id, for condition 5. |
| `daemon/src/http.ts` | Badge route onto the shared function; `POST /api/mods` passes the fetched timestamp. |
| `daemon/src/index.ts` | `ModInstaller` gains the `SteamWorkshop` dependency. |
| `client/src/ModsPanel.tsx` | Renders a skipped mod as skipped. |

---

### Task 1: The shared comparison and the stored field

**Files:**
- Create: `daemon/src/mod-updates.ts`
- Create: `daemon/test/mod-updates.test.ts`
- Modify: `daemon/src/types.ts` (`ModEntry`, near line 150), `client/src/types.ts` (identical edit)
- Modify: `daemon/src/mod-registry.ts:7-22` (`load`)
- Modify: `daemon/test/mod-registry.test.ts`, `daemon/test/mod-migration.test.ts`, `daemon/test/http.test.ts:764` (existing `ModEntry` literals need the new field)

**Interfaces:**
- Produces: `workshopEntryUnchanged(stored: string | null, entry: Pick<WorkshopItem, "updatedAt"> | undefined): boolean`
- Produces: `ModEntry.workshopUpdatedAt: string | null`

Background the implementer needs: `WorkshopItem.updatedAt` is Steam's `time_updated` as ISO, or `null` when Steam sent none. It is never the epoch, so "unknown" cannot read as 1970.

- [ ] **Step 1: Add the field to both types files**

In `daemon/src/types.ts`, inside `interface ModEntry`, immediately after `lastUpdated: string;`:

```typescript
  /**
   * The workshop entry's `time_updated`, as ISO, for the jar currently
   * installed. `null` when unknown: written by a daemon that predates this
   * field, or installed while Steam could not be reached.
   *
   * Stored rather than derived because `lastUpdated` is this machine's clock at
   * install time. Comparing that against Steam's clock is wrong if the two
   * disagree, and wrong again if a mod is republished while we are downloading
   * it - we would record an install time later than the new `time_updated`,
   * conclude we are current, and keep the older jar forever.
   */
  workshopUpdatedAt: string | null;
```

Make the identical edit in `client/src/types.ts`. Then confirm they match:

```powershell
(Get-FileHash daemon\src\types.ts).Hash; (Get-FileHash client\src\types.ts).Hash
```

- [ ] **Step 2: Write the failing test for registry normalisation**

Add to `daemon/test/mod-registry.test.ts`:

```typescript
it("reads a registry written before workshopUpdatedAt existed as unknown, not undefined", async () => {
  const file = join(dir, "mods.json");
  await writeFile(
    file,
    JSON.stringify([{ id: "123", name: "Old", jar: "Old.jar", lastUpdated: "2026-07-01T00:00:00.000Z" }]),
    "utf8",
  );
  const entries = await new ModRegistry(file).load();
  expect(entries[0].workshopUpdatedAt).toBeNull();
  expect("workshopUpdatedAt" in entries[0]).toBe(true);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run test/mod-registry.test.ts -t "written before workshopUpdatedAt"`
Expected: FAIL, `expected undefined to be null`.

- [ ] **Step 4: Normalise in `load`**

Replace the `JSON.parse` line in `daemon/src/mod-registry.ts`:

```typescript
    try {
      // Normalised on the way in, so a registry written before this field
      // existed reads as an explicit "unknown" rather than as undefined. The
      // gate treats unknown as "reinstall", which is what makes this field its
      // own migration.
      return (JSON.parse(raw) as ModEntry[]).map((m) => ({
        ...m,
        workshopUpdatedAt: m.workshopUpdatedAt ?? null,
      }));
    } catch (e) {
      throw new Error(`Failed to parse mod registry at ${this.file}: ${(e as Error).message}`);
    }
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npx vitest run test/mod-registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing tests for the comparison**

Create `daemon/test/mod-updates.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { workshopEntryUnchanged } from "../src/mod-updates.js";

const AT = "2026-07-20T10:00:00.000Z";

describe("workshopEntryUnchanged", () => {
  it("is true only when the stored timestamp is exactly what Steam reports now", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: AT })).toBe(true);
  });

  it("is false when Steam has no entry for the mod", () => {
    expect(workshopEntryUnchanged(AT, undefined)).toBe(false);
  });

  it("is false when Steam's entry carries no timestamp", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: null })).toBe(false);
  });

  it("is false when nothing was ever recorded for the installed jar", () => {
    expect(workshopEntryUnchanged(null, { updatedAt: AT })).toBe(false);
  });

  it("is false when the entry moved forward", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: "2026-07-21T10:00:00.000Z" })).toBe(false);
  });

  // Equality, not `>`: any movement means the entry is not the one we
  // installed. A `>` test would skip a timestamp that moved backwards in
  // silence, and Steam moving one backwards is exactly the case where we most
  // want to refetch.
  it("is false when the entry moved backwards", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: "2026-07-19T10:00:00.000Z" })).toBe(false);
  });
});
```

- [ ] **Step 7: Run them and confirm they fail**

Run: `npx vitest run test/mod-updates.test.ts`
Expected: FAIL, cannot resolve `../src/mod-updates.js`.

- [ ] **Step 8: Write the comparison**

Create `daemon/src/mod-updates.ts`:

```typescript
import type { ModEntry, WorkshopItem } from "./types.js";

/**
 * Whether the workshop entry we installed from is the entry Steam has now.
 *
 * The one place this comparison lives. `GET /api/mods/updates` paints badges
 * from it and `ModInstaller.updateAll` decides whether to download from it; if
 * they each had their own copy they could disagree, and the client would show
 * "update available" on a mod that Update All then skips. Both would look
 * correct in isolation, which is what would make it hard to find.
 *
 * False whenever the answer is not knowable - no entry, no timestamp on the
 * entry, nothing recorded for the installed jar. Unknown means "might have
 * changed", so the caller refetches rather than guessing.
 */
export function workshopEntryUnchanged(
  stored: ModEntry["workshopUpdatedAt"],
  entry: Pick<WorkshopItem, "updatedAt"> | undefined,
): boolean {
  if (entry === undefined) return false;
  if (entry.updatedAt === null) return false;
  if (stored === null) return false;
  return stored === entry.updatedAt;
}
```

- [ ] **Step 9: Run them and confirm they pass**

Run: `npx vitest run test/mod-updates.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 10: Fix the existing ModEntry literals**

`workshopUpdatedAt` is now required, so every `ModEntry` literal must carry it. `npx tsc --noEmit` names them. Known sites: `daemon/test/mod-registry.test.ts:19`, `daemon/test/mod-migration.test.ts:54,148,169`, `daemon/test/http.test.ts:765`, and `daemon/src/mod-installer.ts:126` (Task 2 rewrites that one; for now pass `null`).

Give each test literal `workshopUpdatedAt: null` unless that test is about the timestamp.

- [ ] **Step 11: Verify and prove the tests are not vacuous**

Run from `daemon/`: `npx vitest run` then `npx tsc --noEmit`. Both must be clean. Then from `client/`: `npx tsc --noEmit`.

Substitution proof: change `return stored === entry.updatedAt;` to `return true;`. Run `npx vitest run test/mod-updates.test.ts`. Expect 4 failures. Restore, confirm green, confirm `git status` clean.

- [ ] **Step 12: Commit**

```bash
git add daemon/src/mod-updates.ts daemon/test/mod-updates.test.ts daemon/src/types.ts client/src/types.ts daemon/src/mod-registry.ts daemon/test/
git commit -m "feat(daemon): record the workshop timestamp a jar was installed from"
```

---

### Task 2: Record Steam's timestamp on install

**Files:**
- Modify: `daemon/src/mod-installer.ts:33` (`install` signature), `:126` (the upsert)
- Modify: `daemon/src/http.ts:751` (`POST /api/mods`)
- Modify: `daemon/test/mod-installer.test.ts`, `daemon/test/http.test.ts`

**Interfaces:**
- Consumes: `ModEntry.workshopUpdatedAt` from Task 1.
- Produces: `install(id: string, name: string, onLine: (line: string) => void, workshopUpdatedAt: string | null): Promise<InstallResult>`

The fourth parameter is **required, not optional**. An optional one would let a call site forget it and silently record `null` forever, which reads as "unknown" and quietly disables the gate for that mod. A compile error at each call site is the point.

- [ ] **Step 1: Write the failing test**

Add to `daemon/test/mod-installer.test.ts`:

```typescript
it("records the workshop timestamp it installed from, not this machine's clock", async () => {
  const inst = build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" });
  await inst.install("3731244177", "Safe Haven QOL", () => {}, "2026-07-20T10:00:00.000Z");
  const entry = await registry.get("3731244177");
  expect(entry?.workshopUpdatedAt).toBe("2026-07-20T10:00:00.000Z");
  // lastUpdated stays this machine's clock: it answers "when did this daemon
  // install it", which is what the UI reports and is not what the gate uses.
  expect(entry?.lastUpdated).not.toBe("2026-07-20T10:00:00.000Z");
});

it("records unknown when Steam could not say when the entry changed", async () => {
  const inst = build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" });
  await inst.install("3731244177", "Safe Haven QOL", () => {}, null);
  expect((await registry.get("3731244177"))?.workshopUpdatedAt).toBeNull();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/mod-installer.test.ts -t "records the workshop timestamp"`
Expected: FAIL, `install` takes 3 arguments.

- [ ] **Step 3: Change the signature and the upsert**

In `daemon/src/mod-installer.ts`, change the signature:

```typescript
  async install(
    id: string,
    name: string,
    onLine: (line: string) => void,
    workshopUpdatedAt: string | null,
  ): Promise<InstallResult> {
```

and line 126:

```typescript
    await this.registry.upsert({
      id,
      name,
      jar,
      lastUpdated: new Date().toISOString(),
      workshopUpdatedAt,
    });
```

- [ ] **Step 4: Pass it from the single-install route**

In `daemon/src/http.ts`, in `POST /api/mods`, before calling `installer.install`, fetch the entry for this one id. A failure here must not fail the install:

```typescript
      // Fetched so a fresh install is gated correctly from its first run. A
      // Steam failure here is not fatal: the install proceeds recording
      // "unknown", and the next Update All reinstalls it once and records the
      // real value. Losing the install over a badge-grade lookup would be a
      // worse trade.
      let workshopUpdatedAt: string | null = null;
      try {
        const [item] = await workshop.getDetails([id]);
        workshopUpdatedAt = item?.updatedAt ?? null;
      } catch {
        workshopUpdatedAt = null;
      }
```

Then pass `workshopUpdatedAt` as the fourth argument to `installer.install(...)`.

**Note on the bare `catch`:** this is the one place in this change where a failure is deliberately absorbed, and it is absorbed into a value the system already models as "unknown" rather than into a default that pretends success. Keep the comment. Do not copy this shape anywhere else in the plan.

- [ ] **Step 5: Run and confirm passing**

Run: `npx vitest run test/mod-installer.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and prove**

Run from `daemon/`: `npx vitest run` and `npx tsc --noEmit`.

Substitution proof: change the upsert to `workshopUpdatedAt: null`. Run `npx vitest run test/mod-installer.test.ts -t "records the workshop timestamp"`. Expect RED. Restore, confirm green, `git status` clean.

- [ ] **Step 7: Commit**

```bash
git add daemon/src/mod-installer.ts daemon/src/http.ts daemon/test/
git commit -m "feat(daemon): store the workshop timestamp each install came from"
```

---

### Task 3: The gate

**Files:**
- Modify: `daemon/src/mod-library.ts` (add `currentForWorkshopId`)
- Modify: `daemon/src/mod-installer.ts` (constructor gains `SteamWorkshop`; `updateAll` rewritten)
- Modify: `daemon/src/types.ts`, `client/src/types.ts` (`InstallResult.skipped`)
- Modify: `daemon/src/index.ts:87` (pass `workshop` into `ModInstaller`)
- Modify: `daemon/test/mod-installer.test.ts`, `daemon/test/mod-library.test.ts`

**Interfaces:**
- Consumes: `workshopEntryUnchanged` (Task 1), `install(..., workshopUpdatedAt)` (Task 2).
- Produces: `ModLibrary.currentForWorkshopId(workshopId: string): Promise<ModLibraryEntry | undefined>`; `InstallResult.skipped?: boolean`.

**Critical background — read before writing condition 5.** The library and the registry use **different keyspaces**. `ModLibrary` keys entries by `ModInfo.id`, the mod id read out of the jar, because `place()` calls `this.get(info.id)`. A managed mod is keyed by its Steam **published-file id**. So `library.get(workshopId)` and `library.resolve(workshopId)` return `undefined` for essentially every mod. Using either would make condition 5 always fail, meaning nothing is ever skipped and the whole feature silently does nothing — while a test asserting "a missing jar forces a reinstall" still passes, because a lookup that always returns nothing produces exactly that. The workshop id lives on `ModLibraryEntry.source` as `{ kind: "workshop", workshopId }`. Match on that.

- [ ] **Step 1: Write the failing library test**

Add to `daemon/test/mod-library.test.ts`:

```typescript
it("finds the current entry by workshop id, which is not the id it files jars under", async () => {
  const lib = new ModLibrary(manifest, dir);
  await lib.add(jarPath, { kind: "workshop", workshopId: "3731244177" }, "SafeHavenQOL-1.2.0-2.6.jar");

  const found = await lib.currentForWorkshopId("3731244177");
  expect(found?.jar).toBe("SafeHavenQOL-1.2.0-2.6.jar");

  // The guard against keying this off the wrong id: the library files this jar
  // under the mod id from inside it, so a lookup by that id must NOT be how
  // this works, and an unknown workshop id must miss.
  expect(await lib.currentForWorkshopId("0000000000")).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/mod-library.test.ts -t "finds the current entry by workshop id"`
Expected: FAIL, `currentForWorkshopId is not a function`.

- [ ] **Step 3: Add the lookup**

In `daemon/src/mod-library.ts`, beside `get`:

```typescript
  /**
   * The entry whose current jar came from this workshop id.
   *
   * Not `get(id)`: the library files entries under the mod id read out of the
   * jar, while a managed mod is keyed by its Steam published-file id. The two
   * are different keyspaces and a lookup by the wrong one silently finds
   * nothing.
   */
  async currentForWorkshopId(workshopId: string): Promise<ModLibraryEntry | undefined> {
    return (await this.load()).find(
      (e) => e.source.kind === "workshop" && e.source.workshopId === workshopId,
    );
  }
```

- [ ] **Step 4: Run and confirm passing**

Run: `npx vitest run test/mod-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `skipped` to both types files**

In `daemon/src/types.ts`, inside `interface InstallResult` (near line 471), after `replacedJar?: string;`:

```typescript
  /**
   * Set when the workshop entry had not changed and the library still held the
   * jar, so nothing was downloaded. `ok` is true and `jar` is the jar that was
   * already installed.
   */
  skipped?: boolean;
```

Identical edit in `client/src/types.ts`. Hash both.

- [ ] **Step 6: Write the failing gate tests**

Add to `daemon/test/mod-installer.test.ts`. `build()` in this file must be extended to accept a fake `SteamWorkshop` whose `getDetails` returns given items or throws; follow the existing fake style in the file.

```typescript
describe("updateAll gate", () => {
  const AT = "2026-07-20T10:00:00.000Z";

  // The central test. Delete the gate and this is what goes red.
  it("does not download a mod whose entry is unchanged and whose jar is still held", async () => {
    const inst = buildGated({ stored: AT, steam: AT, jarInLibrary: true });
    const results = await inst.updateAll(() => {});
    expect(results[0].skipped).toBe(true);
    expect(results[0].ok).toBe(true);
    expect(downloadedIds).toEqual([]);
  });

  it("downloads when Steam has no entry for it", async () => {
    const inst = buildGated({ stored: AT, steam: "absent", jarInLibrary: true });
    await inst.updateAll(() => {});
    expect(downloadedIds).toEqual(["3731244177"]);
  });

  it("downloads when Steam's entry carries no timestamp", async () => {
    const inst = buildGated({ stored: AT, steam: null, jarInLibrary: true });
    await inst.updateAll(() => {});
    expect(downloadedIds).toEqual(["3731244177"]);
  });

  it("downloads when nothing was recorded for the installed jar", async () => {
    const inst = buildGated({ stored: null, steam: AT, jarInLibrary: true });
    await inst.updateAll(() => {});
    expect(downloadedIds).toEqual(["3731244177"]);
  });

  it("downloads when the entry changed", async () => {
    const inst = buildGated({ stored: AT, steam: "2026-07-21T10:00:00.000Z", jarInLibrary: true });
    await inst.updateAll(() => {});
    expect(downloadedIds).toEqual(["3731244177"]);
  });

  it("downloads when the library no longer holds the jar", async () => {
    const inst = buildGated({ stored: AT, steam: AT, jarInLibrary: false });
    await inst.updateAll(() => {});
    expect(downloadedIds).toEqual(["3731244177"]);
  });

  it("downloads everything and says why when Steam cannot be reached", async () => {
    const lines: string[] = [];
    const inst = buildGated({ stored: AT, steam: "throw", jarInLibrary: true });
    await inst.updateAll((l) => lines.push(l));
    expect(downloadedIds).toEqual(["3731244177"]);
    expect(lines.join("\n")).toContain("Could not reach Steam");
  });

  it("closes with a summary of what it did", async () => {
    const lines: string[] = [];
    const inst = buildGated({ stored: AT, steam: AT, jarInLibrary: true });
    await inst.updateAll((l) => lines.push(l));
    expect(lines.at(-1) ?? lines[lines.length - 1]).toBe("Updated 0, skipped 1, failed 0.");
  });
});
```

**Note:** `Array.prototype.at` is forbidden by the ES2020 lib pin. Write `lines[lines.length - 1]` and delete the `.at(-1)` alternative above; it is shown only to make the intent unambiguous.

- [ ] **Step 7: Run and confirm they fail**

Run: `npx vitest run test/mod-installer.test.ts -t "updateAll gate"`
Expected: FAIL — nothing is skipped yet, so the first test fails on `downloadedIds`.

- [ ] **Step 8: Give ModInstaller the workshop dependency**

Add `private workshop: SteamWorkshop` to the `ModInstaller` constructor, after `library`. Update `daemon/src/index.ts` where `new ModInstaller(cfg, registry, steam, library)` is constructed to pass `workshop`. `workshop` is already constructed above it in that file.

- [ ] **Step 9: Write the gate**

Replace `updateAll` in `daemon/src/mod-installer.ts`:

```typescript
  async updateAll(onLine: (line: string) => void): Promise<InstallResult[]> {
    const managed = await this.registry.load();
    const results: InstallResult[] = [];

    // One call for the whole run rather than one per mod.
    let byId = new Map<string, WorkshopItem>();
    try {
      const items = await this.workshop.getDetails(managed.map((m) => m.id));
      byId = new Map(items.map((i) => [i.id, i]));
    } catch (e) {
      // Not fatal and not silent. Every mod becomes unknown, so every mod is
      // reinstalled, which is exactly what this did before the gate existed - a
      // Steam outage costs time and nothing else. Reporting "no updates" here
      // would be the one answer that is actively misleading.
      onLine(`--- Could not reach Steam (${(e as Error).message}). Updating every mod.`);
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    // Sequential by design: ModRegistry does load-modify-write with no locking,
    // so concurrent installs here would clobber each other's writes.
    for (const mod of managed) {
      const entry = byId.get(mod.id);
      const held =
        workshopEntryUnchanged(mod.workshopUpdatedAt, entry) &&
        (await this.library.currentForWorkshopId(mod.id)) !== undefined;

      if (held) {
        onLine(`--- ${mod.name} (${mod.id}) is unchanged, skipping`);
        results.push({ id: mod.id, name: mod.name, jar: mod.jar, ok: true, skipped: true });
        skipped += 1;
        continue;
      }

      onLine(`--- Updating ${mod.name} (${mod.id})`);
      try {
        const r = await this.install(mod.id, mod.name, onLine, entry?.updatedAt ?? null);
        results.push(r);
        if (r.ok) updated += 1;
        else failed += 1;
      } catch (e) {
        results.push({
          id: mod.id,
          name: mod.name,
          jar: null,
          ok: false,
          error: (e as Error).message,
        });
        failed += 1;
      }
    }

    onLine(`Updated ${updated}, skipped ${skipped}, failed ${failed}.`);
    return results;
  }
```

Add `workshopEntryUnchanged` and the `WorkshopItem` type to the imports at the top of the file.

- [ ] **Step 10: Run and confirm passing**

Run: `npx vitest run test/mod-installer.test.ts`
Expected: PASS. Existing `updateAll` tests in this file assume unconditional reinstall; give their registry entries `workshopUpdatedAt: null` so they keep asserting what they were written to assert.

- [ ] **Step 11: Verify and prove**

Run from `daemon/`: `npx vitest run` and `npx tsc --noEmit`. Then from `client/`: `npx vitest run` and `npx tsc --noEmit`.

Two substitution proofs, each restored afterwards with `git status` confirmed clean:
1. Replace `const held = ...` with `const held = false;`. Run `-t "does not download a mod whose entry is unchanged"`. Expect RED.
2. Replace the library half with `true` (`workshopEntryUnchanged(...) && true`). Run `-t "downloads when the library no longer holds the jar"`. Expect RED. This is the one that proves condition 5 is wired to the right keyspace.

- [ ] **Step 12: Commit**

```bash
git add daemon/src/ client/src/types.ts daemon/test/
git commit -m "feat(daemon): skip mods whose workshop entry has not changed"
```

---

### Task 4: The badge uses the same comparison

**Files:**
- Modify: `daemon/src/http.ts:840-861` (the `mods.map` in `GET /api/mods/updates`)
- Modify: `daemon/test/http.test.ts`

**Interfaces:**
- Consumes: `workshopEntryUnchanged` (Task 1), `ModEntry.workshopUpdatedAt` (Task 1).

Why this task exists: leaving the badge on `updatedAt > lastUpdated` while the gate uses the stored value lets the client show "update available" on a mod Update All then skips. Both look correct in isolation.

- [ ] **Step 1: Write the failing test**

Add to `daemon/test/http.test.ts`:

```typescript
it("does not badge a mod that Update All would skip", async () => {
  await registry.upsert({
    id: "3731244177",
    name: "Safe Haven QOL",
    jar: "SafeHavenQOL.jar",
    lastUpdated: "2026-07-01T00:00:00.000Z",
    workshopUpdatedAt: "2026-07-20T10:00:00.000Z",
  });
  // Steam reports exactly what we recorded, but the entry changed AFTER our
  // install wall-clock time. The old comparison badged this; the gate skips it.
  workshopItems = [{ id: "3731244177", title: "Safe Haven QOL", updatedAt: "2026-07-20T10:00:00.000Z", previewUrl: "", description: "" }];

  const res = await app.inject({ method: "GET", url: "/api/mods/updates", headers: auth });
  expect(res.json().mods[0].updateAvailable).toBe(false);
});

it("badges a mod whose entry moved since the jar we installed", async () => {
  await registry.upsert({
    id: "3731244177",
    name: "Safe Haven QOL",
    jar: "SafeHavenQOL.jar",
    lastUpdated: "2026-07-01T00:00:00.000Z",
    workshopUpdatedAt: "2026-07-20T10:00:00.000Z",
  });
  workshopItems = [{ id: "3731244177", title: "Safe Haven QOL", updatedAt: "2026-07-21T10:00:00.000Z", previewUrl: "", description: "" }];

  const res = await app.inject({ method: "GET", url: "/api/mods/updates", headers: auth });
  expect(res.json().mods[0].updateAvailable).toBe(true);
});
```

- [ ] **Step 2: Run and confirm the first fails**

Run: `npx vitest run test/http.test.ts -t "does not badge a mod that Update All would skip"`
Expected: FAIL, `expected true to be false` — the old comparison sees `2026-07-20 > 2026-07-01`.

- [ ] **Step 3: Switch the route to the shared function**

In `daemon/src/http.ts`, replace the `installedMs`/`updatedMs` lines and the `updateAvailable` expression:

```typescript
    const mods: ModUpdateInfo[] = managed.map((m) => {
      const item = byId.get(m.id);
      return {
        id: m.id,
        title: item !== undefined && item.title.length > 0 ? item.title : m.name,
        previewUrl: item?.previewUrl ?? "",
        description: item?.description ?? "",
        workshopUpdatedAt: item?.updatedAt ?? null,
        // Still this daemon's install time: it answers "when did we install
        // this", which is what a reader wants, and is deliberately not what the
        // decision below is made from.
        installedAt: m.lastUpdated,
        onWorkshop: item !== undefined,
        // The same function Update All gates on, so a badge and the action can
        // never contradict each other. Update All additionally reinstalls when
        // the library has lost the jar, which this cannot see - an asymmetry
        // that can only make Update All do MORE than the badge implies, never
        // less.
        updateAvailable: !workshopEntryUnchanged(m.workshopUpdatedAt, item),
      };
    });
```

Import `workshopEntryUnchanged` at the top of `http.ts`.

- [ ] **Step 4: Run and confirm passing**

Run: `npx vitest run test/http.test.ts`
Expected: PASS. Existing badge tests that set only `lastUpdated` now need `workshopUpdatedAt` to express their intent; update them.

- [ ] **Step 5: Verify and prove**

Run from `daemon/`: `npx vitest run` and `npx tsc --noEmit`.

Substitution proof: change `updateAvailable` to `false`. Run `-t "badges a mod whose entry moved"`. Expect RED. Restore, confirm green, `git status` clean.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/http.ts daemon/test/http.test.ts
git commit -m "fix(daemon): badge updates from the same comparison Update All gates on"
```

---

### Task 5: The client shows what was skipped, plus the seam and docs

**Files:**
- Modify: `client/src/ModsPanel.tsx` (wherever `InstallResult[]` from update-all is rendered)
- Modify: `client/src/ModsPanel.test.tsx`
- Modify: `client/test/api.integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `InstallResult.skipped` (Task 3).

- [ ] **Step 1: Write the failing client test**

In `client/src/ModsPanel.test.tsx`, drive the component with an update-all response containing one updated and one skipped result, and assert on what a user sees:

```typescript
it("reports a skipped mod as skipped, not as updated", async () => {
  // ... render with results:
  // [{ id: "1", name: "Alpha", jar: "Alpha.jar", ok: true },
  //  { id: "2", name: "Beta", jar: "Beta.jar", ok: true, skipped: true }]
  expect(await screen.findByText(/Beta/)).toBeInTheDocument();
  expect(screen.getByText(/unchanged|skipped/i)).toBeInTheDocument();
  // The point of the feature: it must not claim two updates.
  expect(screen.queryAllByText(/updated/i)).toHaveLength(1);
});
```

Match the file's existing render helpers and assertion style rather than inventing new ones.

- [ ] **Step 2: Run and confirm failure**

Run from `client/`: `npx vitest run src/ModsPanel.test.tsx -t "reports a skipped mod as skipped"`
Expected: FAIL.

- [ ] **Step 3: Render skipped results distinctly**

In `ModsPanel.tsx`, where each `InstallResult` is rendered, branch on `r.skipped` to show an "unchanged" state instead of the updated state. Do not introduce a new status vocabulary; reuse the panel's existing visual language for a no-op row.

- [ ] **Step 4: Run and confirm passing**

Run from `client/`: `npx vitest run src/ModsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the seam test**

In `client/test/api.integration.test.ts`, add a test that drives `POST /api/mods/update-all` through the **real client API layer against the real daemon**, with one managed mod whose stored `workshopUpdatedAt` matches what the stubbed workshop returns, and asserts the response carries `skipped: true` for it.

Do not mock either side and do not hand-build the URL — this file exists because the daemon's `inject()` tests never set a content-type and the client's unit tests never reach Fastify, and five actions once shipped broken for exactly that reason. `skipped` is a new shape crossing the wire, which is why it needs to be here.

- [ ] **Step 6: Update the README**

In the mods section, state that Update All now skips a mod whose workshop entry has not changed since its jar was installed, that a moved timestamp indicates rather than proves a new jar, and that the first run after upgrading reinstalls everything once because nothing has a recorded workshop timestamp yet.

Plain ASCII punctuation, no em dashes, no curly quotes.

- [ ] **Step 7: Verify everything**

From `daemon/`: `npx vitest run` and `npx tsc --noEmit`. From `client/`: `npx vitest run` and `npx tsc --noEmit`. All four clean.

Substitution proof: delete the `r.skipped` branch in `ModsPanel.tsx`. Run the client test by name. Expect RED. Restore, confirm green, `git status` clean.

- [ ] **Step 8: Commit**

```bash
git add client/src/ client/test/ README.md
git commit -m "feat(client): show which mods Update All skipped"
```

---

## Self-Review

**Spec coverage.** Decisions table: trust the timestamp (Task 3 gate), unknown reinstalls (Task 1 comparison returns false for every unknown), Steam unreachable reinstalls everything and says so (Task 3 step 9 + its test), Steam-to-Steam comparison (Tasks 1-2), no force switch (absent by construction). Data model: Task 1. The five conditions: Task 3, one test each. Flow and `install()` signature: Tasks 2-3. One comparison two callers: Tasks 1 and 4. Reporting: Task 3 (`skipped`, log lines, summary) and Task 5 (client). Errors: Task 3 step 9 and the Task 2 note. Testing: every task carries substitution proofs. Out of scope items appear nowhere, as intended.

**Placeholder scan.** No TBD or "handle edge cases". The two places that say "match the file's existing style" (Task 5 steps 1 and 3) are deliberate — the client panel's render structure is not reproduced here and the implementer must read it, which is why those steps name the file and the exact assertion targets instead.

**Type consistency.** `workshopEntryUnchanged(stored, entry)` has one signature across Tasks 1, 3 and 4. `install(id, name, onLine, workshopUpdatedAt)` is used identically in Tasks 2 and 3. `currentForWorkshopId` matches between Task 3 steps 3 and 9. `ModEntry.workshopUpdatedAt` and `InstallResult.skipped` are declared once each and consumed with those exact names.

**One correction made during review:** Task 3 step 6's summary assertion originally used `lines.at(-1)`, which the ES2020 lib pin forbids. The step now says so explicitly rather than leaving a trap that fails in the other package.
