import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { saveConfig } from "./config.js";
import { listWorlds, worldExists, isValidWorldName } from "./worlds.js";
import type { ModInstaller } from "./mod-installer.js";
import type { ProcessManager } from "./process-manager.js";
import type { SteamCmd } from "./steamcmd.js";
import type { DaemonConfig, InstallResult, StatusPayload, TaskKind, WsMessage } from "./types.js";

export interface Deps {
  cfg: DaemonConfig;
  configFile: string;
  pm: ProcessManager;
  installer: ModInstaller;
  steam: SteamCmd;
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

export function buildServer(deps: Deps): FastifyInstance {
  const { cfg, configFile, pm, installer, steam } = deps;
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
    if (typeof name !== "string" || name.trim().length === 0) {
      return reply.code(400).send({ ok: false, error: "Mod name is required." });
    }
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot change mods while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    if (!requireNoActiveTask(reply, "install a mod")) return reply;
    const taskId = runTask("mod-install", async (onLine) => {
      const r = await installer.install(id, name.trim(), onLine);
      return { ok: r.ok, error: r.error };
    });
    return { ok: true, taskId };
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

  app.get("/api/config", async () => cfg);

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
    return cfg;
  });

  app.decorate("broadcast", broadcast);
  // The live socket set. Anything with send(string) can join it, which is how
  // a test observes what the daemon pushes without standing up a real
  // websocket client.
  app.decorate("sockets", sockets);

  return app;
}
