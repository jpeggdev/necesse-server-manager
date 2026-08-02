# Server Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send any of the game's server commands from the client as a generated, validated form, with the dangerous ones gated.

**Architecture:** The 90 command definitions are extracted once from the running server's own `Server.jar` into a checked-in schema, in the same spirit as `LAUNCH_OPTION_FIELDS`. The daemon validates a `{name, args}` request against that schema, composes the command line itself, and writes it with `ProcessManager.send`. The client renders a form per command from the same schema, served over HTTP so there is one source of truth rather than two copies.

**Tech Stack:** Node 22 + TypeScript + Fastify + vitest (daemon); React 19 + Vite + vitest + RTL (client); CFR for the one-time extraction.

Phase 2 of `docs/superpowers/specs/2026-08-01-player-tracking-and-commands-design.html`. Phase 1 (the roster) is merged into this branch and provides the online-player list the `player` parameter type reads from.

## Global Constraints

- **Daemon sources must stay ES2020-library-compatible.** No `Object.hasOwn`, `Array.prototype.at`, `findLast`, `String.prototype.replaceAll`.
- **`daemon/src/types.ts` and `client/src/types.ts` must stay byte-identical.** Hash both after editing either.
- **Errors are never swallowed or reworded.**
- **A sent command is not a run command.** Measured on the real 1.3.1 server on 2026-08-02: a command sent while the world is still initialising is echoed to the console and then silently does nothing. The UI must never claim a command succeeded on the strength of having sent it.
- **No argument may contain a newline, carriage return or tab.** stdin is line-oriented; `ProcessManager.send` already refuses these, and the route must refuse them earlier with a message naming the parameter.
- Verify from inside `daemon/` or `client/`: `npx vitest run` and `npx tsc --noEmit`.
- Plain ASCII punctuation in user-facing copy.

---

### Task 1: Extract the command schema from the live jar

**Files:**
- Create: `scripts/extract-commands.mjs`
- Create: `daemon/src/server-commands-schema.ts` (generated, checked in)
- Create: `daemon/test/server-commands-schema.test.ts`

**Interfaces:**
- Produces:
  - `interface CommandParam { name: string; type: CommandParamType; optional: boolean }`
  - `type CommandParamType = "int" | "float" | "bool" | "string" | "restString" | "player" | "storedPlayer" | "item" | "buff" | "enchantment" | "biome" | "tile" | "team" | "settler" | "permissionLevel" | "enum" | "other"`
  - `interface CommandDef { name: string; description: string; permission: "USER" | "MODERATOR" | "ADMIN" | "OWNER" | "SERVER"; isCheat: boolean; params: CommandParam[]; excluded?: true; destructive?: true; playerOnly?: true }`
  - `export const SERVER_COMMANDS: readonly CommandDef[]`
  - `export const SCHEMA_GAME_VERSION: string`

- [ ] **Step 1: Get the jar and a decompiler**

```bash
scp -i "$env:USERPROFILE\.ssh\necesse_server" jeffp@192.168.1.106:"C:/necesseserver/Server.jar" "<scratchpad>/Server.jar"
curl -L -o "<scratchpad>/cfr.jar" https://repo1.maven.org/maven2/org/benf/cfr/0.152/cfr-0.152.jar
```

Decompile only what is needed:

```bash
java -jar cfr.jar Server.jar --outputdir src --jarfilter 'necesse.engine.commands.*'
```

- [ ] **Step 2: Write the extractor**

`scripts/extract-commands.mjs` reads every `*ServerCommand.java` under the decompiled `serverCommands/` directory, pulls the single `super(...)` call out of the constructor, and emits the schema. It must:

- Read the name, description, `PermissionLevel.X` and the `isCheat` boolean from the first four arguments.
- Read each `new CmdParameter("<name>", new <Handler>(...), <optional?>, ...)`, mapping the handler class to a `CommandParamType` and defaulting `optional` to false when the overload does not carry it.
- Map handlers: `IntParameterHandler`/`RelativeIntParameterHandler` to `int`, `FloatParameterHandler` to `float`, `BoolParameterHandler` to `bool`, `StringParameterHandler` to `string`, `RestStringParameterHandler` to `restString`, `ServerClientParameterHandler` to `player`, `StoredPlayerParameterHandler` to `storedPlayer`, `ItemParameterHandler` to `item`, `BuffParameterHandler` to `buff`, `EnchantmentParameterHandler` to `enchantment`, `BiomeParameterHandler` to `biome`, `TileParameterHandler` to `tile`, `TeamParameterHandler` to `team`, `SettlerParameterHandler` to `settler`, `PermissionLevelParameterHandler` to `permissionLevel`, `EnumParameterHandler`/`PresetStringParameterHandler` to `enum`, and anything unrecognised to `other`.
- **Fail loudly on an unrecognised handler rather than defaulting silently**, printing the class name, so a new parameter type in a future game version is a build error and not a form that renders wrong.
- Emit the game version it was run against, taken from the caller as an argument.

- [ ] **Step 3: Apply the policy flags in the generated file**

The extractor writes the raw facts; the three policy flags are applied from a table in the script so they survive a re-extraction:

```javascript
const EXCLUDED = ["stop", "exit", "quit"];
const DESTRUCTIVE = ["allowcheats", "regen", "deleteplayer", "clearall"];
const PLAYER_ONLY = ["die", "me", "copyitem", "reveal", "mow", "playtime", "mypermissions", "createteam", "leaveteam", "invite"];
```

Anything in `EXCLUDED` is omitted from the emitted array entirely, so no client can name one.

- [ ] **Step 4: Write the schema tests**

```typescript
import { describe, it, expect } from "vitest";
import { SERVER_COMMANDS, SCHEMA_GAME_VERSION } from "../src/server-commands-schema.js";

describe("the extracted command schema", () => {
  it("carries the commands the wiki documents, with their real parameter types", () => {
    const give = SERVER_COMMANDS.find((c) => c.name === "give");
    expect(give).toMatchObject({ permission: "ADMIN", isCheat: true });
    expect(give?.params).toEqual([
      { name: "player", type: "player", optional: true },
      { name: "item", type: "item", optional: false },
      { name: "amount", type: "int", optional: true },
    ]);
  });

  it("omits the commands that would race the daemon's own lifecycle", () => {
    for (const name of ["stop", "exit", "quit"]) {
      expect(SERVER_COMMANDS.find((c) => c.name === name)).toBeUndefined();
    }
  });

  it("marks the irreversible ones", () => {
    expect(SERVER_COMMANDS.find((c) => c.name === "allowcheats")?.destructive).toBe(true);
    expect(SERVER_COMMANDS.find((c) => c.name === "regen")?.destructive).toBe(true);
  });

  it("records which game version it was taken from", () => {
    expect(SCHEMA_GAME_VERSION).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it("has no duplicate names and no empty parameter names", () => {
    const names = SERVER_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of SERVER_COMMANDS) {
      for (const p of c.params) expect(p.name.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 5: Verify against the running server**

Send `help` through the daemon and compare the command names it lists against the schema. Record any difference in the commit message rather than silently reconciling.

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-commands.mjs daemon/src/server-commands-schema.ts daemon/test/server-commands-schema.test.ts
git commit -m "feat(daemon): extract the server command schema from the live jar"
```

---

### Task 2: Compose and validate a command

**Files:**
- Create: `daemon/src/command-line.ts`
- Create: `daemon/test/command-line.test.ts`

**Interfaces:**
- Consumes: `SERVER_COMMANDS`, `CommandDef`, `CommandParam` (Task 1).
- Produces: `composeCommand(name: string, args: Record<string, string>): string` - returns the line to send, throws `Error` with an operator-readable message when the request is not valid.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { composeCommand } from "../src/command-line.js";

describe("composeCommand", () => {
  it("composes a command with all its arguments in declaration order", () => {
    expect(composeCommand("give", { player: "eli", item: "iron_bar", amount: "10" })).toBe(
      "give eli iron_bar 10",
    );
  });

  it("omits a trailing optional argument that was not supplied", () => {
    expect(composeCommand("kick", { player: "eli" })).toBe("kick eli");
  });

  it("refuses an unknown command by name", () => {
    expect(() => composeCommand("definitelynotacommand", {})).toThrow(/not a server command/i);
  });

  it("refuses a command the daemon does not expose", () => {
    // stop/exit/quit are absent from the schema entirely, so this is the same
    // failure as an unknown name - which is the point.
    expect(() => composeCommand("stop", {})).toThrow(/not a server command/i);
  });

  it("refuses a missing required argument, naming it", () => {
    expect(() => composeCommand("give", { player: "eli" })).toThrow(/item/);
  });

  it("refuses an argument the command does not have", () => {
    expect(() => composeCommand("kick", { player: "eli", nonsense: "x" })).toThrow(/nonsense/);
  });

  it("refuses a non-numeric value for an int parameter, naming it", () => {
    expect(() => composeCommand("give", { player: "eli", item: "iron_bar", amount: "ten" })).toThrow(
      /amount/,
    );
  });

  /*
   * stdin is line-oriented: a value carrying a newline runs as a second
   * command. ProcessManager.send refuses it too, but this is the layer that can
   * say WHICH argument was wrong.
   */
  it("refuses control whitespace in a value, naming the parameter", () => {
    expect(() => composeCommand("say", { message: "hello\nallowcheats" })).toThrow(/message/);
    expect(() => composeCommand("say", { message: "hello\tworld" })).toThrow(/message/);
  });

  it("keeps an ordinary sentence intact for a rest-of-line parameter", () => {
    expect(composeCommand("say", { message: "server going down in 5" })).toBe(
      "say server going down in 5",
    );
  });

  it("sends no leading slash, which is what the console takes", () => {
    expect(composeCommand("players", {})).not.toMatch(/^\//);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

From `daemon/`: `npx vitest run test/command-line.test.ts` - FAIL, module missing.

- [ ] **Step 3: Implement**

Look the command up in `SERVER_COMMANDS`; unknown or absent is one error. Walk `params` in order, take each supplied value, reject unknown keys, reject a missing non-optional, reject control whitespace, and type-check `int`, `float` and `bool`. Join the name and the values with single spaces. A gap in the middle of the parameter list (an optional omitted before a supplied one) is an error, because the game parses positionally.

- [ ] **Step 4: Run and confirm passing, then substitution proof**

Delete the control-whitespace check; the two `say` cases must go red. Restore.

- [ ] **Step 5: Commit**

---

### Task 3: The command endpoints

**Files:**
- Modify: `daemon/src/http.ts`
- Modify: `daemon/src/types.ts`, `client/src/types.ts`
- Modify: `daemon/test/http.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/commands` -> `{ ok: true, commands: CommandDef[], gameVersion: string, schemaGameVersion: string }`
  - `POST /api/command` `{ name, args }` -> `{ ok: true }` or `{ ok: false, error }`

- [ ] **Step 1: Write the failing tests**

Cover: the schema is served; a valid command reaches stdin exactly once and with no leading slash; an excluded name is refused with 400; a bad argument is refused with 400 naming the parameter; a command sent while the server is stopped is refused with the same message `send` gives; and the response never claims more than "sent".

- [ ] **Step 2: Implement**

`GET /api/commands` returns the schema plus both versions, so the client can compare them itself. `POST /api/command` calls `composeCommand`, then `pm.send`, mapping a compose failure to 400 and a send failure to 409. Echo the composed line into the console stream as a `task`-kind line so the operator sees what was run alongside the server's reply.

- [ ] **Step 3: Verify, substitution proof, commit**

---

### Task 4: The client transport and the command dialog

**Files:**
- Modify: `client/src/api.ts`, `client/src/useDaemon.ts`
- Create: `client/src/CommandDialog.tsx`, `client/test/CommandDialog.test.tsx`
- Modify: `client/src/PlayersPanel.tsx` (a Run command button), `client/src/App.tsx`

- [ ] **Step 1: Write the failing tests**

Assert on what the operator sees: choosing a command renders its parameters with the right controls; a required field left empty blocks Send; the player parameter offers the live roster; a destructive command requires typing its name before Send enables; and the dialog reports "sent" rather than "succeeded", with the console named as where the answer appears.

- [ ] **Step 2: Implement**

`api.commands()` and `api.runCommand(name, args)`. The dialog: a searchable `<select>` of commands grouped by permission, generated fields per parameter, cheat commands badged, destructive ones behind a typed confirmation. Reuse `LaunchOptionsDialog`'s structure and focus handling (`useModalFocus`).

- [ ] **Step 3: Version mismatch banner**

When `gameVersion` differs from `schemaGameVersion`, show a line saying the table was taken from a different game version and may be wrong. Not a block: a stale table is usually still mostly right, and refusing to show it would be worse than saying so.

- [ ] **Step 4: Verify, substitution proof, commit**

---

### Task 5: The seam, the docs, and a live check

**Files:**
- Modify: `client/test/api.integration.test.ts`, `README.md`

- [ ] **Step 1: Seam test**

Drive `POST /api/command` through the real client transport against a real daemon: one accepted command reaching a fake child's stdin, and one refusal. This is a new shape crossing the wire.

- [ ] **Step 2: README**

Document the commands UI: that it sends the game's own commands, that output appears in the console, that `stop`/`exit`/`quit` are deliberately absent because the daemon owns the lifecycle, that irreversible commands need a typed confirmation, and that a command is reported as sent rather than as succeeded.

- [ ] **Step 3: Live check on SERVER**

With a world running, send `players` and one harmless command (`say`) from the client, and confirm both appear in the console with the server's reply. Record the result.

- [ ] **Step 4: Commit**

---

## Self-Review

**Spec coverage.** Extraction from the live jar with the version stamped: Task 1. Policy flags, and exclusion by absence: Task 1 steps 3 and 4, enforced in Task 2. Parameter-type to control mapping: Task 1 step 2 and Task 4 step 2. Structured request rather than a raw line: Tasks 2 and 3. Newline injection: Task 2, with a second refusal already in `ProcessManager.send` from phase 1. Output through the existing console: Task 3 step 2. Version mismatch warning: Task 4 step 3. Seam test and docs: Task 5. The online-player dropdown is the one place phase 1 is consumed: Task 4.

**Placeholder scan.** No TBD. Task 4's steps describe the dialog's required behaviour and name the file to imitate rather than reproducing `LaunchOptionsDialog`, which this plan cannot see in full.

**Type consistency.** `CommandDef` and `CommandParam` are declared once in Task 1 and consumed with those field names in Tasks 2, 3 and 4. `composeCommand(name, args)` has one signature in Tasks 2 and 3.

**One thing this plan deliberately does not do.** It does not try to confirm a command actually ran. Tonight showed the server accepts a command and silently ignores it during startup, and there is no general way to tell from the output that any given command took effect. The honest interface is to report what was sent and show the server's own reply, which is why Task 4 says "sent" and never "succeeded".
