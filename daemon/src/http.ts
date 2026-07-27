import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { saveConfig } from "./config.js";
import { listWorlds, worldExists, isValidWorldName } from "./worlds.js";
import type { ModInstaller } from "./mod-installer.js";
import type { ProcessManager } from "./process-manager.js";
import type { SteamCmd } from "./steamcmd.js";
import type { DaemonConfig, TaskKind, WsMessage } from "./types.js";

export interface Deps {
  cfg: DaemonConfig;
  configFile: string;
  pm: ProcessManager;
  installer: ModInstaller;
  steam: SteamCmd;
}

const WORKSHOP_ID = /^\d+$/;

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

  pm.on("line", (l) => broadcast({ type: "console", line: l.line, ts: l.ts }));
  pm.on("state", (status) => {
    broadcast({ type: "status", status });
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

  const runTask = (
    kind: TaskKind,
    fn: (onLine: (l: string) => void) => Promise<{ ok: boolean; error?: string }>,
  ): string => {
    const taskId = `t${++taskSeq}`;
    const onLine = (line: string) => broadcast({ type: "task", taskId, kind, line });
    fn(onLine)
      .then((r) => broadcast({ type: "task-done", taskId, kind, ok: r.ok, error: r.error }))
      .catch((e: Error) =>
        broadcast({ type: "task-done", taskId, kind, ok: false, error: e.message }),
      );
    return taskId;
  };

  void app.register(cors, { origin: true });
  void app.register(websocket);

  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(
        JSON.stringify({ type: "backlog", lines: pm.backlog, status: pm.status } satisfies WsMessage),
      );
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });
  });

  app.get("/api/status", async () => {
    pm.refreshUnmanaged();
    return pm.status;
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
    try {
      pm.start(world);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
    return { ok: true, status: pm.status };
  });

  app.post("/api/server/stop", async (_req, reply) => {
    try {
      await pm.stop();
      return { ok: true, status: pm.status };
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(/did not exit/.test(msg) ? 504 : 409).send({ ok: false, error: msg });
    }
  });

  app.post("/api/server/kill", async (_req, reply) => {
    try {
      pm.kill();
      return { ok: true, status: pm.status };
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
    const taskId = `t${++taskSeq}`;
    const onLine = (line: string) =>
      broadcast({ type: "task", taskId, kind: "mod-update-all", line });
    installer
      .updateAll(onLine)
      .then((results) =>
        broadcast({
          type: "task-done",
          taskId,
          kind: "mod-update-all",
          ok: results.every((r) => r.ok),
          results,
        }),
      )
      .catch((e: Error) =>
        broadcast({ type: "task-done", taskId, kind: "mod-update-all", ok: false, error: e.message }),
      );
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

  return app;
}
