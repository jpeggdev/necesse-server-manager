import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { saveConfig } from "./config.js";
import { listWorlds, worldExists, isValidWorldName } from "./worlds.js";
import type { ModInstaller } from "./mod-installer.js";
import type { ProcessManager } from "./process-manager.js";
import type { SteamCmd } from "./steamcmd.js";
import { WorkshopError, type SteamWorkshop } from "./steam-workshop.js";
import type {
  DaemonConfig,
  InstallResult,
  ModUpdateInfo,
  PublicDaemonConfig,
  StatusPayload,
  TaskKind,
  WorkshopItem,
  WsMessage,
} from "./types.js";

export interface Deps {
  cfg: DaemonConfig;
  configFile: string;
  pm: ProcessManager;
  installer: ModInstaller;
  steam: SteamCmd;
  workshop: SteamWorkshop;
}

const WORKSHOP_ID = /^\d+$/;

/**
 * How long a task may sit in `activeTasks` before the daemon gives up on it.
 *
 * Sized to be unreachable by any legitimate run rather than tuned close to
 * one: the longest real case is `app_update <id> validate`, which re-hashes
 * every file in the install and re-downloads whatever fails, so on a slow link
 * it is plausibly tens of minutes. An hour is several times that worst case,
 * which is the right trade here - expiring a task that is actually still
 * working produces a misleading "timed out" line and re-enables Start while
 * steamcmd writes, so a false expiry is far more costly than a late one. The
 * daemon still self-heals within a single sitting instead of needing a
 * restart, which is the whole point.
 */
export const TASK_EXPIRY_MS = 60 * 60 * 1000;

/**
 * Fields a LAN client may patch via PUT /api/config. Everything else
 * (paths, jvmArgs, port, app ids) is edited by hand in config.json on the
 * machine itself — the no-auth design accepts "anyone on the LAN can
 * control the game server," not "anyone on the LAN can repoint javaExe/
 * serverJar/steamcmdExe (or inject a -javaagent) and get the daemon to
 * spawn an arbitrary executable."
 */
const ALLOWED_CONFIG_KEYS = new Set<keyof DaemonConfig>(["owners", "lastWorld", "stopTimeoutMs"]);

/**
 * The config as it may leave the daemon. `steamApiKey` is dropped entirely
 * rather than blanked in place: this API has no authentication by deliberate
 * design, so anything either config route returns is readable by every device
 * on the LAN, and a boolean is all a client can do anything with anyway.
 */
const publicConfig = (c: DaemonConfig): PublicDaemonConfig => {
  const { steamApiKey, ...rest } = c;
  return { ...rest, steamApiKeyConfigured: steamApiKey.trim().length > 0 };
};

/**
 * A workshop call that failed maps to a status the client can act on: 503 when
 * the box is missing a key (an operator fixes it), 502 when Steam itself was
 * unreachable or unhappy (try later). Never 200 - a Steam outage must not be
 * indistinguishable from "nothing to report".
 */
const workshopFailureCode = (e: unknown): number =>
  e instanceof WorkshopError && e.kind === "not-configured" ? 503 : 502;

export function buildServer(deps: Deps): FastifyInstance {
  const { cfg, configFile, pm, installer, steam, workshop } = deps;
  const app = Fastify({ logger: false });
  type Socket = { send(data: string): void };
  const sockets = new Set<Socket>();
  let taskSeq = 0;
  /**
   * Ids of tasks accepted and not yet finished. The daemon is the authority on
   * this - it is the only party that sees both the acceptance and the
   * completion of a task, so it is the only party that can answer "is anything
   * in flight" without racing two channels against each other. It is published
   * in every StatusPayload and enforced server-side by POST /api/server/start.
   */
  const activeTasks = new Set<string>();

  const broadcast = (msg: WsMessage): void => {
    const data = JSON.stringify(msg);
    const dead: Socket[] = [];
    for (const s of sockets) {
      try {
        s.send(data);
      } catch {
        // Collected and removed after the loop rather than deleting mid-
        // iteration, so a throwing send() can't skip a later entry.
        dead.push(s);
      }
    }
    for (const s of dead) sockets.delete(s);
  };

  /** The one place a StatusPayload is built, so every channel reports the same thing. */
  const statusPayload = (): StatusPayload => ({ ...pm.status, activeTasks: [...activeTasks] });

  const broadcastStatus = (): void => broadcast({ type: "status", status: statusPayload() });

  pm.on("line", (l) => broadcast({ type: "console", line: l.line, ts: l.ts }));
  pm.on("state", (status) => {
    broadcastStatus();
    if (status.state === "running" && status.world) {
      cfg.lastWorld = status.world;
      // Fire-and-forget from an event handler with no request to report to;
      // a rejection here must be logged, not left to become an unhandled
      // rejection that could crash the daemon.
      saveConfig(configFile, cfg).catch((e: Error) => {
        console.error(`Failed to persist lastWorld=${status.world}: ${e.message}`);
      });
    }
  });

  const requireStopped = (reply: { code(c: number): unknown }): boolean => {
    const state = pm.status.state;
    if (state === "stopped" || state === "crashed") return true;
    reply.code(409);
    return false;
  };

  /**
   * Registers the task as active, runs it, and guarantees the entry is removed
   * again on every exit path - resolve, reject, or a synchronous throw out of
   * `fn` (the async IIFE turns that into a rejection too), plus the expiry
   * below for the path where none of those ever happen. A leaked entry wedges
   * POST /api/server/start and every client's Start button for the life of the
   * daemon, so `settle` deleting before it broadcasts is load-bearing.
   */
  const runTask = (
    kind: TaskKind,
    fn: (
      onLine: (l: string) => void,
    ) => Promise<{ ok: boolean; error?: string; results?: InstallResult[] }>,
  ): string => {
    const taskId = `t${++taskSeq}`;
    const onLine = (line: string) => broadcast({ type: "task", taskId, kind, line });
    activeTasks.add(taskId);
    broadcastStatus();

    // Exactly one terminal task-done per id is part of the contract clients
    // read, so whichever of the two paths (expiry, real completion) arrives
    // first claims it and the other becomes a no-op. The delete happens before
    // any broadcast, so a throwing broadcast still cannot strand the entry.
    let settled = false;
    const settle = (msg: WsMessage): void => {
      if (settled) {
        console.warn(
          `Task ${taskId} (${kind}) produced a terminal result after it had already ` +
            `been given up on as timed out. Ignoring it; the daemon has moved on.`,
        );
        return;
      }
      settled = true;
      activeTasks.delete(taskId);
      broadcast(msg);
      broadcastStatus();
    };

    // A steamcmd run that never settles - a hung network read, a Steam-side
    // prompt nobody can answer - would otherwise hold the id forever, and
    // since the set now lives in the daemon, reloading the client no longer
    // clears it: only restarting the daemon would. So the entry expires and
    // the daemon self-heals. The child process is deliberately NOT killed:
    // killing steamcmd mid-write can leave a half-written install or a
    // truncated jar, which is worse than a stale flag. It keeps running, and
    // if it finishes later `settle` above discards the result harmlessly.
    const expiry = setTimeout(() => {
      settle({
        type: "task-done",
        taskId,
        kind,
        ok: false,
        error:
          `Timed out: no result after ${Math.round(TASK_EXPIRY_MS / 60000)} minutes. ` +
          `The underlying process was left running rather than killed mid-write, so it ` +
          `may still finish on its own - check the server install before relying on it.`,
      });
    }, TASK_EXPIRY_MS);
    // Without this an idle hour-long timer keeps the event loop alive, so the
    // daemon (and the test runner) would refuse to exit until it fired.
    expiry.unref?.();

    void (async () => {
      try {
        const r = await fn(onLine);
        settle({ type: "task-done", taskId, kind, ok: r.ok, error: r.error, results: r.results });
      } catch (e) {
        settle({ type: "task-done", taskId, kind, ok: false, error: (e as Error).message });
      } finally {
        clearTimeout(expiry);
      }
    })();
    return taskId;
  };

  /**
   * Server-side interlock, applied to starting the server AND to launching or
   * removing anything that writes the install or mods folder. A UI-only guard
   * cannot stop a second client, a page left open from before the task
   * started, or curl. Two steamcmd runs rewriting `serverRoot`/`modsDir` at
   * once, or the game launching against a half-written one, is the corruption
   * this exists to prevent - so these operations serialize rather than
   * interleave.
   */
  const requireNoActiveTask = (
    reply: { code(c: number): { send(b: unknown): unknown } },
    action: string,
  ): boolean => {
    if (activeTasks.size === 0) return true;
    reply.code(409).send({
      ok: false,
      error:
        `Cannot ${action} while a background task (mod install, mod update, or server ` +
        `update) is still running. Those tasks rewrite the server install and the mods ` +
        `folder, so overlapping them - or launching the game against a half-written one - ` +
        `risks corruption. Wait for it to finish. In flight: ${[...activeTasks].join(", ")}.`,
    });
    return false;
  };

  /**
   * Fastify's default JSON parser rejects an empty body under a JSON
   * content-type with FST_ERR_CTP_EMPTY_JSON_BODY (400), before the route
   * handler runs. Half this API's mutations legitimately carry no body
   * (stop, kill, server update, mods update-all), and any sensible client -
   * curl -X POST -H, a deploy script, a second GUI - may still set the header.
   * The client works around it by omitting the header, but only the daemon can
   * fix it for everyone else, so an empty body is treated as an absent one and
   * the routes' own `req.body ?? {}` handles it from there. A body that is
   * present but malformed is still a 400: silently ignoring it would turn a
   * typo'd payload into a request that looks like it worked.
   */
  app.addContentTypeParser<string>(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body.trim().length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  void app.register(cors, { origin: true });
  void app.register(websocket);

  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(
        JSON.stringify({
          type: "backlog",
          lines: pm.backlog,
          status: statusPayload(),
        } satisfies WsMessage),
      );
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });
  });

  app.get("/api/status", async () => {
    pm.refreshUnmanaged();
    return statusPayload();
  });

  app.get("/api/worlds", async (req) => {
    const name = (req.query as { name?: string }).name;
    const worlds = await listWorlds(cfg.worldsDir);
    const candidate =
      name === undefined
        ? null
        : {
            name,
            valid: isValidWorldName(name),
            exists: isValidWorldName(name) ? await worldExists(cfg.worldsDir, name) : false,
          };
    return { worlds, lastWorld: cfg.lastWorld, candidate };
  });

  app.post("/api/server/start", async (req, reply) => {
    const { world } = (req.body ?? {}) as { world?: string };
    if (typeof world !== "string" || !isValidWorldName(world)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(world)}` });
    }
    if (!requireNoActiveTask(reply, "start the server")) return reply;
    try {
      pm.start(world);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
    return { ok: true, status: statusPayload() };
  });

  app.post("/api/server/stop", async (_req, reply) => {
    try {
      await pm.stop();
      return { ok: true, status: statusPayload() };
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(/did not exit/.test(msg) ? 504 : 409).send({ ok: false, error: msg });
    }
  });

  app.post("/api/server/kill", async (_req, reply) => {
    try {
      pm.kill();
      return { ok: true, status: statusPayload() };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/server/update", async (_req, reply) => {
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot update while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    if (!requireNoActiveTask(reply, "update the server")) return reply;
    const taskId = runTask("server-update", async (onLine) => {
      const r = await steam.updateApp(onLine);
      return { ok: r.ok, error: r.ok ? undefined : r.output };
    });
    return { ok: true, taskId };
  });

  app.get("/api/mods", async () => installer.list());

  app.post("/api/mods", async (req, reply) => {
    const { id, name } = (req.body ?? {}) as { id?: string; name?: string };
    if (typeof id !== "string" || !WORKSHOP_ID.test(id)) {
      return reply.code(400).send({ ok: false, error: `Invalid workshop id: ${JSON.stringify(id)}` });
    }
    // Name resolution happens BEFORE the two guards below, and this ordering is
    // load-bearing rather than incidental.
    //
    // `requireNoActiveTask` is only an interlock if checking the set and
    // reserving a slot in it are atomic. `runTask` adds the id synchronously,
    // so the pair is atomic exactly as long as nothing awaits between them -
    // and resolving a name is an await, on a network round trip lasting up to
    // the full request timeout. Sitting it between the check and the reserve
    // let two nameless adds both pass the check while both waited on Steam,
    // and both then ran steamcmd against modsDir at once: the corruption the
    // interlock exists to prevent.
    //
    // Hoisting the await above the guards removes the window rather than
    // policing it. Nothing is ever added to `activeTasks` before `runTask`, so
    // no failed or hung resolution can strand an entry, and there is no
    // reservation to release on an error path. The cost is that a request that
    // was going to be refused may still spend a Steam call first, which is a
    // read-only GET and cheap next to the alternative. Requests carrying an
    // explicit name skip this entirely and reach the guards synchronously,
    // exactly as before.
    let resolved = typeof name === "string" ? name.trim() : "";
    if (resolved.length === 0) {
      // An explicitly supplied name always wins. A placeholder invented here
      // would be written into mods.json and shown in the UI from then on, so
      // failing is better.
      try {
        resolved = (await workshop.getDetails([id]))[0]?.title.trim() ?? "";
      } catch (e) {
        return reply.code(400).send({
          ok: false,
          error:
            `No name was supplied and Steam could not be asked for one (${(e as Error).message}). ` +
            `Supply a name explicitly and try again.`,
        });
      }
      if (resolved.length === 0) {
        return reply.code(400).send({
          ok: false,
          error:
            `No name was supplied and the Steam Workshop has no usable entry for id ${id} ` +
            `(it may be removed, banned, private, or the id may be wrong). Supply a name ` +
            `explicitly if you are sure the id is right.`,
        });
      }
    }
    // Everything from here to `runTask` must stay synchronous.
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot change mods while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    if (!requireNoActiveTask(reply, "install a mod")) return reply;
    const taskId = runTask("mod-install", async (onLine) => {
      const r = await installer.install(id, resolved, onLine);
      return { ok: r.ok, error: r.error };
    });
    return { ok: true, taskId };
  });

  /**
   * Which managed mods have a workshop entry newer than the copy installed
   * here. Deliberately NOT folded into GET /api/mods: that list is read off
   * disk and has to keep working when Steam is unreachable, so this is a
   * second call the client makes afterward and a Steam outage costs badges
   * rather than the mod list itself.
   *
   * Steam moves `time_updated` for ANY edit to the workshop entry - a retitle,
   * a description tweak, a new screenshot - not only for a new file. So
   * `updateAvailable` means "the entry changed after we installed it", which
   * is an indication an update may exist, not proof of a new jar.
   */
  app.get("/api/mods/updates", async (_req, reply) => {
    const { managed } = await installer.list();
    let items: WorkshopItem[];
    try {
      items = await workshop.getDetails(managed.map((m) => m.id));
    } catch (e) {
      // Reported as a failure rather than as an empty set of updates: a
      // fabricated "everything is current" is the one answer that would be
      // actively misleading here.
      return reply.code(workshopFailureCode(e)).send({ ok: false, error: (e as Error).message });
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    const mods: ModUpdateInfo[] = managed.map((m) => {
      const item = byId.get(m.id);
      const installedMs = Date.parse(m.lastUpdated);
      const updatedMs = item?.updatedAt ? Date.parse(item.updatedAt) : NaN;
      return {
        id: m.id,
        title: item !== undefined && item.title.length > 0 ? item.title : m.name,
        workshopUpdatedAt: item?.updatedAt ?? null,
        installedAt: m.lastUpdated,
        onWorkshop: item !== undefined,
        // Both ends must parse for the comparison to mean anything; a registry
        // entry with an unreadable lastUpdated reports "no update" rather than
        // a guess in either direction.
        updateAvailable:
          Number.isFinite(installedMs) && Number.isFinite(updatedMs) && updatedMs > installedMs,
      };
    });
    return { ok: true, checkedAt: new Date().toISOString(), mods };
  });

  /**
   * Workshop search. The only Steam call that needs an API key, so a box
   * without one gets a 503 saying exactly that rather than Steam's bare 403,
   * which reads like a broken daemon.
   */
  app.get("/api/workshop/search", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    // A repeated parameter (?q=a&q=b) arrives as an array, which would throw
    // inside the module and reach the client as a 502 blaming Steam for what is
    // the caller's own mistake. Named plainly as a 400 instead.
    for (const key of ["q", "cursor", "count"]) {
      if (q[key] !== undefined && typeof q[key] !== "string") {
        return reply
          .code(400)
          .send({ ok: false, error: `Query parameter "${key}" must be given at most once.` });
      }
    }
    const { q: text, cursor, count } = q as { q?: string; cursor?: string; count?: string };
    const asked = Number(count);
    try {
      const r = await workshop.search({
        text,
        cursor,
        // Clamped rather than passed through: Steam caps the page size anyway,
        // and an unbounded numperpage from a query string is a free way to
        // make the daemon fetch a very large body.
        count: Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), 50) : 20,
      });
      return { ok: true, ...r };
    } catch (e) {
      return reply.code(workshopFailureCode(e)).send({ ok: false, error: (e as Error).message });
    }
  });

  app.delete("/api/mods/:id", async (req, reply) => {
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot change mods while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    // Not a task itself, but it deletes a jar out of the same modsDir an
    // install or update-all is writing into, so it serializes with them too.
    if (!requireNoActiveTask(reply, "remove a mod")) return reply;
    const { id } = req.params as { id: string };
    try {
      await installer.remove(id);
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/mods/update-all", async (_req, reply) => {
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot update mods while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    if (!requireNoActiveTask(reply, "update mods")) return reply;
    // Goes through runTask like every other task kind so the activeTasks
    // lifecycle has exactly one implementation and no second path to leak from.
    const taskId = runTask("mod-update-all", async (onLine) => {
      const results = await installer.updateAll(onLine);
      return { ok: results.every((r) => r.ok), results };
    });
    return { ok: true, taskId };
  });

  app.get("/api/config", async () => publicConfig(cfg));

  app.put("/api/config", async (req, reply) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      if (!ALLOWED_CONFIG_KEYS.has(key as keyof DaemonConfig)) {
        return reply.code(400).send({ ok: false, error: `Field "${key}" cannot be changed remotely.` });
      }
    }
    if ("owners" in patch) {
      const owners = patch.owners;
      if (!Array.isArray(owners) || !owners.every((o) => typeof o === "string" && o.trim().length > 0)) {
        return reply.code(400).send({ ok: false, error: "owners must be an array of non-empty strings." });
      }
    }
    if ("stopTimeoutMs" in patch) {
      const t = patch.stopTimeoutMs;
      if (typeof t !== "number" || !(t > 0)) {
        return reply.code(400).send({ ok: false, error: "stopTimeoutMs must be a positive number." });
      }
    }
    if ("lastWorld" in patch) {
      const w = patch.lastWorld;
      if (w !== null && typeof w !== "string") {
        return reply.code(400).send({ ok: false, error: "lastWorld must be a string or null." });
      }
    }
    Object.assign(cfg, patch as Partial<DaemonConfig>);
    await saveConfig(configFile, cfg);
    // Same redaction as the GET: this route echoes the whole config back, and
    // the key must not ride out on the response to an unrelated patch either.
    return publicConfig(cfg);
  });

  app.decorate("broadcast", broadcast);
  // The live socket set. Anything with send(string) can join it, which is how
  // a test observes what the daemon pushes without standing up a real
  // websocket client.
  app.decorate("sockets", sockets);

  return app;
}
