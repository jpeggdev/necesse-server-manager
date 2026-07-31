import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { AUTH_FAILURE_MESSAGE, presentedToken, tokenMatches } from "./auth.js";
import { saveConfig } from "./config.js";
import { listWorlds, worldExists, worldZipPath, isValidWorldName } from "./worlds.js";
import { openWorldSettings, WorldSettingsError } from "./world-settings.js";
import type { WorldSettingsFile } from "./world-settings-file.js";
import { knownField, checkChange, isSameValue } from "./world-settings-schema.js";
import type { LaunchOptions } from "./launch-options.js";
import { checkLaunchOption, fieldByName, LAUNCH_OPTION_FIELDS } from "./launch-options-schema.js";
import type { ModInstaller } from "./mod-installer.js";
import type { ModLibrary } from "./mod-library.js";
import type { ModSets } from "./mod-sets.js";
import { NotAModJarError } from "./mod-info.js";
import { installedModIds, ReconcileError, reconcileMods } from "./mod-reconcile.js";
import type { ProcessManager } from "./process-manager.js";
import type { SteamCmd } from "./steamcmd.js";
import { WorkshopError, type SteamWorkshop } from "./steam-workshop.js";
import type {
  DaemonConfig,
  InstallResult,
  LaunchOptionsResponse,
  LaunchOptionValue,
  ModLibraryResponse,
  ModUpdateInfo,
  ModUploadResponse,
  PublicDaemonConfig,
  ReconcileResponse,
  ReconcileSummary,
  StatusPayload,
  TaskKind,
  WorkshopItem,
  WorldModsResponse,
  WorldSettingField,
  WorldSettingType,
  WorldSettingsResponse,
  WorldSettingsWriteResponse,
  WsMessage,
} from "./types.js";

export interface Deps {
  cfg: DaemonConfig;
  configFile: string;
  pm: ProcessManager;
  installer: ModInstaller;
  library: ModLibrary;
  sets: ModSets;
  steam: SteamCmd;
  workshop: SteamWorkshop;
  /** Non-fatal configuration problems, published so a client can surface them. */
  configWarnings: string[];
  launchOptions: LaunchOptions;
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
 * Fields a client may patch via PUT /api/config. Everything else (paths,
 * jvmArgs, port, app ids) is edited by hand in config.json on the machine
 * itself.
 *
 * The allowlist survives the addition of an access token rather than being
 * relaxed by it: a token establishes that the caller is trusted to control the
 * game server, not that it is trusted to repoint javaExe/serverJar/steamcmdExe
 * (or inject a -javaagent) and have the daemon spawn an arbitrary executable.
 * Those are different powers, and the token is a shared secret on a plain-HTTP
 * LAN rather than a per-user credential.
 */
const ALLOWED_CONFIG_KEYS = new Set<keyof DaemonConfig>(["lastWorld", "stopTimeoutMs"]);

/**
 * The config as it may leave the daemon. Secrets are dropped entirely rather
 * than blanked in place, so there is no shape in which one could survive the
 * trip; a boolean is all a client can act on anyway.
 */
const publicConfig = (c: DaemonConfig): PublicDaemonConfig => {
  const { steamApiKey, authToken, ...rest } = c;
  return {
    ...rest,
    steamApiKeyConfigured: steamApiKey.trim().length > 0,
    // Whitespace-only is treated as unset, same as tokenMatches: it is not a
    // secret a client could ever send back, so reporting it as "required"
    // would tell every client to authenticate against a token it can't use.
    authRequired: authToken.trim().length > 0,
  };
};

/**
 * A workshop call that failed maps to a status the client can act on: 503 when
 * the box is missing a key (an operator fixes it), 502 when Steam itself was
 * unreachable or unhappy (try later). Never 200 - a Steam outage must not be
 * indistinguishable from "nothing to report".
 */
const workshopFailureCode = (e: unknown): number =>
  e instanceof WorkshopError && e.kind === "not-configured" ? 503 : 502;

/**
 * The text of something thrown, whatever it was.
 *
 * `(e as Error).message` is undefined for anything that is not an Error - a
 * thrown string, a rejected non-Error from a library - and the client then shows
 * the user the word "undefined", which says nothing about what went wrong and
 * cannot be searched for. Nothing is reworded here; this only ensures there is
 * something to report.
 */
const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : `Non-error thrown: ${String(e)}`;

export function buildServer(deps: Deps): FastifyInstance {
  const { cfg, configFile, pm, installer, library, sets, steam, workshop, configWarnings, launchOptions } =
    deps;
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
  const statusPayload = (): StatusPayload => ({
    ...pm.status,
    activeTasks: [...activeTasks],
    configWarnings,
  });

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
   * Claims a slot in `activeTasks` and returns its id.
   *
   * Split out of `runTask` because not every operation that must serialize
   * against the others streams over the websocket. A world settings write runs
   * to completion inside its own request - the client is waiting on the
   * response, so there is nothing to stream - but it rewrites a world zip for
   * about a third of a second, and during that time a second write, or a
   * `POST /api/server/start` launching the game against the file being
   * replaced, must be refused exactly as they would be during a steamcmd run.
   * Reusing the same set is what makes that one rule rather than two.
   *
   * Callers MUST release in a `finally`, and MUST NOT await between checking
   * `requireNoActiveTask` and calling this: the check and the claim are only an
   * interlock if nothing can run between them.
   */
  const reserveTask = (): string => {
    const taskId = `t${++taskSeq}`;
    activeTasks.add(taskId);
    broadcastStatus();
    return taskId;
  };

  const releaseTask = (taskId: string): void => {
    activeTasks.delete(taskId);
    broadcastStatus();
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
    const taskId = reserveTask();
    const onLine = (line: string) => broadcast({ type: "task", taskId, kind, line });

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
        `Cannot ${action} while a background task (mod install, mod update, server update, ` +
        `or a world settings write) is still running. Those rewrite the server install, the ` +
        `mods folder, or a world zip, so overlapping them - or launching the game against a ` +
        `half-written one - risks corruption. Wait for it to finish. In flight: ` +
        `${[...activeTasks].join(", ")}.`,
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

  /**
   * Jar uploads arrive as a raw body under one of these types, deliberately
   * rather than as multipart/form-data.
   *
   * A jar upload is one file and nothing else - there are no other form fields
   * to carry - so multipart would buy nothing but a dependency, a streaming
   * parser, and a second place for a size limit to be enforced. The filename is
   * a query parameter, and it is only a label anyway: the mod's identity comes
   * from the `mod.info` inside the bytes.
   *
   * The limit is applied here, one byte above the configured maximum, so that a
   * body which is merely over the line still reaches the route and is refused
   * with a message saying so, while anything wildly larger is cut off by Fastify
   * before it is ever held in memory.
   */
  app.addContentTypeParser<Buffer>(
    ["application/java-archive", "application/octet-stream", "application/zip"],
    { parseAs: "buffer", bodyLimit: cfg.modUploadMaxBytes + 1 },
    (_req, body, done) => {
      done(null, body);
    },
  );

  void app.register(cors, {
    origin: true,
    // Named explicitly because the client now sends Authorization. With
    // origin: true @fastify/cors reflects what was asked for, but an explicit
    // list is what makes a future change to this header visible here rather
    // than as an unexplained preflight failure in the app.
    allowedHeaders: ["content-type", "authorization"],
  });
  void app.register(websocket);

  /**
   * One authorization decision for every route and for the socket upgrade.
   *
   * onRequest rather than preHandler so it runs before a body is parsed - an
   * unauthorized request should not get a 64MB upload buffered on its behalf -
   * and because @fastify/websocket runs the same lifecycle hooks for the
   * upgrade request, which is what lets the socket be guarded by this one
   * implementation instead of a second copy.
   *
   * OPTIONS is exempt, though it is belt-and-braces rather than the thing that
   * makes preflight work: @fastify/cors registers its own onRequest hook
   * before this one and already answers (and short-circuits) every OPTIONS
   * request, so in practice this branch never runs. It stays as a second line
   * of defence against that ordering changing - a CORS preflight never
   * carries Authorization (the browser strips it), so if this hook ever did
   * see one, rejecting it would fail every cross-origin request with a
   * message about a token that was, in fact, about to be sent.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    if (tokenMatches(cfg.authToken, presentedToken(req))) return;
    await reply.code(401).send({ ok: false, error: AUTH_FAILURE_MESSAGE });
  });

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

  /**
   * Stricter than `requireStopped`, and deliberately so.
   *
   * Everything else in this API guards a folder of jars: get it wrong and a mod
   * is reinstalled. This guards the single file that holds somebody's world,
   * and there is no reinstalling that. So `crashed` is refused here even though
   * the process is demonstrably gone - a crash is precisely the case where
   * nobody can say what the server was doing to the zip when it died - and
   * `unmanaged` is refused because a server this daemon did not start may still
   * have the world open. Only a clean, observed `stopped` is enough.
   *
   * This never stops the server to get there. Ending someone's session to
   * satisfy a settings edit is not a trade this daemon is allowed to make.
   */
  const requireVerifiedStopped = (
    reply: { code(c: number): { send(b: unknown): unknown } },
    action: string,
  ): boolean => {
    const state = pm.status.state;
    if (state === "stopped") return true;
    reply.code(409).send({
      ok: false,
      error:
        `Cannot ${action} while the server is ${state}. A world zip is the only copy of that ` +
        `save, so this needs the server confirmed stopped - not stopping, not crashed, not ` +
        `running outside this daemon. Stop it and try again.`,
    });
    return false;
  };

  /** One settings file rendered for a client, in the file's own key order. */
  const settingsFields = (file: WorldSettingsFile): WorldSettingField[] =>
    file.entries().map(({ key, value }) => {
      const known = knownField(key);
      // A key this daemon does not know is a mod's. It is reported so nobody
      // is surprised by what is in their file, and it is not editable, because
      // nothing here knows what values that mod accepts.
      if (known === undefined) return { key, value, type: null, editable: false };
      return {
        key,
        value,
        type: known.type,
        ...(known.options === undefined ? {} : { options: [...known.options] }),
        ...(known.min === undefined ? {} : { min: known.min }),
        ...(known.max === undefined ? {} : { max: known.max }),
        editable: known.editable,
      };
    });

  /**
   * Maps a failure from the world-settings layer onto a status. ENOENT means
   * the zip went away between listing it and opening it; a missing settings
   * entry means this zip is not a world this daemon can edit. Neither is
   * reworded - the underlying message is what says which it was.
   */
  const settingsFailure = (
    reply: { code(c: number): { send(b: unknown): unknown } },
    e: unknown,
  ): unknown => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return reply.code(404).send({ ok: false, error: (e as Error).message });
    }
    const missing = e instanceof WorldSettingsError && e.kind === "missing-entry";
    return reply.code(missing ? 404 : 500).send({ ok: false, error: (e as Error).message });
  };

  app.get("/api/worlds/:name/settings", async (req, reply) => {
    const { name } = req.params as { name: string };
    // The name reaches the filesystem, so it is validated before anything is
    // built from it - and `worldZipPath` still resolves it against the real
    // listing rather than trusting it, so ".." can neither pass here nor
    // address anything if it did.
    if (!isValidWorldName(name)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(name)}` });
    }
    const zipPath = await worldZipPath(cfg.worldsDir, name);
    if (zipPath === null) {
      return reply.code(404).send({ ok: false, error: `No world named ${JSON.stringify(name)}.` });
    }
    // Reading is allowed whatever the server is doing: it cannot damage
    // anything, and a save in progress can at worst make the zip unreadable
    // for a moment, which surfaces as the error it is.
    try {
      const open = await openWorldSettings(zipPath);
      return {
        ok: true,
        world: name,
        entry: open.entryName,
        fields: settingsFields(open.file),
      } satisfies WorldSettingsResponse;
    } catch (e) {
      return settingsFailure(reply, e);
    }
  });

  /**
   * Applies a partial set of changes to a world's settings file.
   *
   * Every check that can be made without opening the zip is made first, and the
   * zip is only opened once all of them pass. Nothing is written until the
   * whole replacement has been built elsewhere and verified; see
   * `world-settings.ts` for that half.
   */
  app.put("/api/worlds/:name/settings", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidWorldName(name)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(name)}` });
    }
    const body = req.body ?? {};
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ ok: false, error: "Body must be an object of setting name to new value." });
    }
    const patch = body as Record<string, unknown>;
    if (!requireVerifiedStopped(reply, "change world settings")) return reply;
    if (!requireNoActiveTask(reply, "change world settings")) return reply;
    // Claimed here, with nothing awaited since the check above, because the
    // check and the claim are only an interlock if they are atomic. Two clients
    // saving the same world at once otherwise both pass the guard, both rebuild
    // from the same starting text, and the second rename silently discards the
    // first one's edit. Released in the `finally` at the bottom, on every path
    // including the 400s and 404s below.
    const reservation = reserveTask();
    try {
      const zipPath = await worldZipPath(cfg.worldsDir, name);
      if (zipPath === null) {
        return reply.code(404).send({ ok: false, error: `No world named ${JSON.stringify(name)}.` });
      }

      // Validation before the zip is opened, not during the edit. An unknown
      // key, a wrong type, an out-of-range number or a value outside an enum's
      // real option set all fail here, with the file still unread.
      const wanted = new Map<string, string>();
      for (const [key, value] of Object.entries(patch)) {
        const check = checkChange(key, value);
        if (!check.ok) return reply.code(400).send({ ok: false, error: check.error });
        wanted.set(key, check.text);
      }

      const open = await openWorldSettings(zipPath);
      // A key this daemon knows but this world's file does not have is still a
      // refusal: writing it would add a field the game left out, which is a
      // change to how the world behaves and not what anyone asked for.
      for (const key of wanted.keys()) {
        if (!open.file.has(key)) {
          return reply.code(400).send({
            ok: false,
            error:
              `This world's worldSettings.cfg has no "${key}" line. This daemon only changes ` +
              `values that are already there; it never adds a field the game left out.`,
          });
        }
      }

      const changed: string[] = [];
      for (const [key, text] of wanted) {
        const current = open.file.get(key) as string;
        // Non-null: `checkChange` above already refused every key this daemon
        // does not know, which is the only way `knownField` returns undefined.
        const type = (knownField(key) as { type: WorldSettingType }).type;
        if (isSameValue(current, text, type)) continue;
        open.file.set(key, text);
        changed.push(key);
      }

      // Nothing to do means nothing is written - no rebuild, no backup, no
      // replacement. A form saved without edits must not rewrite a world zip.
      const backup =
        changed.length === 0 ? null : (await open.save()).backupPath;

      return {
        ok: true,
        world: name,
        entry: open.entryName,
        fields: settingsFields(open.file),
        backup,
        changed,
      } satisfies WorldSettingsWriteResponse;
    } catch (e) {
      return settingsFailure(reply, e);
    } finally {
      // A leaked entry wedges Start and every other mutation for the life of
      // the daemon, so this runs on every path out of the block above.
      releaseTask(reservation);
    }
  });

  /**
   * The mod set a world will start with, seeding one if it has none.
   *
   * A world nobody has chosen a set for - one just typed into the header field,
   * or one that appeared after the migration ran - inherits exactly what is
   * installed right now. That is the same rule the migration applies, for the
   * same reason: a world's first start under this feature must load what its
   * last start loaded, and choosing anything else on the operator's behalf would
   * silently change a save's mod list.
   */
  const setFor = async (world: string): Promise<string[]> => {
    const existing = await sets.get(world);
    if (existing !== undefined) return existing.modIds;
    return (await sets.set(world, await installedModIds(cfg.modsDir))).modIds;
  };

  /**
   * A reconcile failure mapped onto a status. All of them mean the same thing
   * operationally - the server was not started - so what the code carries is
   * whose problem it is: a set naming a mod that is gone, or a folder holding a
   * jar nothing can account for, are both things an operator fixes (409), while
   * an unreadable folder is the box misbehaving (500).
   */
  const reconcileFailure = (
    reply: { code(c: number): { send(b: unknown): unknown } },
    e: unknown,
  ): unknown => {
    const kind = e instanceof ReconcileError ? e.kind : "unreadable";
    const operator = kind === "missing-mod" || kind === "unknown-jar" || kind === "jar-collision";
    return reply.code(operator ? 409 : 500).send({ ok: false, error: errorText(e) });
  };

  app.post("/api/server/start", async (req, reply) => {
    const { world } = (req.body ?? {}) as { world?: string };
    if (typeof world !== "string" || !isValidWorldName(world)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(world)}` });
    }
    if (!requireNoActiveTask(reply, "start the server")) return reply;
    // Asked before anything is reconciled rather than discovered by `pm.start`
    // throwing afterwards: reconciling deletes jars out of the mods folder, and
    // rewriting that folder for a launch that was never going to be allowed is
    // exactly the damage this ordering prevents.
    const refusal = pm.startRefusal();
    if (refusal !== null) return reply.code(409).send({ ok: false, error: refusal });
    // Claimed with nothing awaited since `requireNoActiveTask`, so the check and
    // the claim stay atomic - reconcile mutates the mods folder and must
    // serialize against every other mutation exactly as they do with each other.
    const reservation = reserveTask();
    try {
      await reconcileMods({
        modsDir: cfg.modsDir,
        library,
        world,
        modIds: await setFor(world),
      });
    } catch (e) {
      // The server is deliberately not started. A half-reconciled folder must
      // never be launched: the game would run a set nobody chose and write it
      // into the save.
      return reconcileFailure(reply, e);
    } finally {
      releaseTask(reservation);
    }
    // Loaded outside the try/catch below on purpose: a failure here must not
    // be folded into the 409-means-"already running" mapping that surrounds
    // pm.start, and it must never be swallowed into an empty options object.
    // Starting with zero options is the same silent-success shape this whole
    // feature exists to prevent - the world loads, the launch reports success,
    // and nobody holds owner - so a broken launch-options.json fails the start
    // outright, naming the file and the underlying error, rather than being
    // treated as "no options configured".
    let options: Record<string, LaunchOptionValue>;
    try {
      options = await launchOptions.effectiveFor(world);
    } catch (e) {
      return reply.code(500).send({
        ok: false,
        error: `Could not read launch options for "${world}": ${(e as Error).message}`,
      });
    }
    try {
      pm.start(world, options);
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
        // Free: the WorkshopItem this route already fetched to compare
        // timestamps carries both, so the client gets mod-list thumbnails and
        // descriptions for no additional Steam traffic. Empty when Steam had
        // no usable entry, which is the same condition as onWorkshop: false.
        previewUrl: item?.previewUrl ?? "",
        description: item?.description ?? "",
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

  /**
   * Every mod this daemon holds a jar for, whatever any world is set to load.
   *
   * This, not the mods folder, is what a set is chosen from: the folder only
   * ever holds one world's worth at a time.
   */
  app.get("/api/mods/library", async () => {
    return { ok: true, mods: await library.load() } satisfies ModLibraryResponse;
  });

  /**
   * Takes a jar into the library by raw body.
   *
   * Everything is checked before a byte is written anywhere: the size, the
   * filename if one was given, and then the `mod.info` inside the bytes. A jar
   * with no parseable `mod.info` carrying an `id` is not a Necesse mod, and is
   * refused saying exactly that rather than being stored under a guess.
   *
   * Not gated on the server being stopped: this writes only into the library,
   * never into the folder the game reads, so it cannot disturb a running
   * session. It does serialize against the other mutations, because reconcile
   * reads the library it writes.
   */
  app.post("/api/mods/upload", async (req, reply) => {
    const filename = (req.query as { filename?: unknown }).filename;
    if (filename !== undefined && typeof filename !== "string") {
      return reply
        .code(400)
        .send({ ok: false, error: `Query parameter "filename" must be given at most once.` });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({
        ok: false,
        error:
          `Send the jar as the raw request body with Content-Type: application/java-archive ` +
          `(application/octet-stream and application/zip are accepted too), and the original ` +
          `filename as ?filename=. Nothing was uploaded.`,
      });
    }
    if (body.length > cfg.modUploadMaxBytes) {
      return reply.code(413).send({
        ok: false,
        error:
          `That jar is ${body.length} bytes, over this daemon's ${cfg.modUploadMaxBytes}-byte upload ` +
          `limit. Nothing was written.`,
      });
    }
    if (!requireNoActiveTask(reply, "upload a mod")) return reply;
    const reservation = reserveTask();
    try {
      const before = await library.load();
      const mod = await library.addBytes(body, filename, { kind: "local", how: "upload" });
      return {
        ok: true,
        mod,
        replaced: before.some((m) => m.id === mod.id),
      } satisfies ModUploadResponse;
    } catch (e) {
      if (e instanceof NotAModJarError) {
        return reply.code(400).send({ ok: false, error: e.message });
      }
      return reply.code(500).send({ ok: false, error: errorText(e) });
    } finally {
      releaseTask(reservation);
    }
  });

  /**
   * Applies a world's set to the mods folder without starting the server.
   *
   * The same work `POST /api/server/start` does first, exposed on its own so an
   * operator can see what a set would do - and so the guards around it are
   * testable as themselves. It rewrites the folder the game reads, so it is
   * refused while the server is running and while any other task is in flight,
   * exactly like every other mutation of that folder.
   */
  app.post("/api/mods/reconcile", async (req, reply) => {
    const { world } = (req.body ?? {}) as { world?: string };
    if (typeof world !== "string" || !isValidWorldName(world)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(world)}` });
    }
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error:
          `Cannot reconcile the mods folder while the server is ${pm.status.state}. It reads its ` +
          `mod set once at startup, and rewriting the folder underneath a running server is not ` +
          `something this daemon will do. Stop it first.`,
      });
    }
    if (!requireNoActiveTask(reply, "reconcile the mods folder")) return reply;
    const reservation = reserveTask();
    try {
      const reconcile: ReconcileSummary = await reconcileMods({
        modsDir: cfg.modsDir,
        library,
        world,
        modIds: await setFor(world),
      });
      return { ok: true, reconcile } satisfies ReconcileResponse;
    } catch (e) {
      return reconcileFailure(reply, e);
    } finally {
      releaseTask(reservation);
    }
  });

  /**
   * Which mods a world will load, and which of them the library has lost.
   *
   * For a world nobody has chosen a set for, this reports what `start` would
   * seed the set with - what is installed right now - rather than an empty list,
   * which would read as "this world loads no mods" when it is about to load
   * eight. `configured: false` is what says the choice has not been made yet.
   */
  app.get("/api/worlds/:name/mods", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidWorldName(name)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(name)}` });
    }
    const existing = await sets.get(name);
    let modIds: string[];
    try {
      modIds = existing?.modIds ?? (await installedModIds(cfg.modsDir));
    } catch (e) {
      // The mods folder holds something that cannot be accounted for, so `start`
      // would refuse too. Answering with the same failure is more use than an
      // empty list that would turn into a refusal only on the next start.
      return reconcileFailure(reply, e);
    }
    const held = new Set((await library.load()).map((m) => m.id));
    return {
      ok: true,
      world: existing?.world ?? name,
      modIds,
      missing: modIds.filter((id) => !held.has(id)),
      configured: existing !== undefined,
    } satisfies WorldModsResponse;
  });

  /**
   * Chooses which mods a world loads. Takes effect at that world's next start,
   * because the game reads its mod set once, at startup.
   *
   * Every id is checked against the library before anything is written, so a set
   * cannot be saved in a state that would refuse to start later. Nothing here
   * touches the mods folder, so it is allowed while the server is running - the
   * running session keeps the mods it started with either way.
   *
   * Removing a mod whose content is already placed in the world is a real way to
   * damage a save. It is allowed: the operator decides, and this daemon does not
   * pretend to know which mods a world has content from.
   */
  app.put("/api/worlds/:name/mods", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidWorldName(name)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(name)}` });
    }
    const { modIds } = (req.body ?? {}) as { modIds?: unknown };
    if (!Array.isArray(modIds) || !modIds.every((m) => typeof m === "string" && m.trim().length > 0)) {
      return reply
        .code(400)
        .send({ ok: false, error: "Body must be { modIds: string[] } of mod ids from the library." });
    }
    if (!requireNoActiveTask(reply, "change a world's mod set")) return reply;
    const reservation = reserveTask();
    try {
      const wanted = (modIds as string[]).map((m) => m.trim());
      const held = new Set((await library.load()).map((m) => m.id));
      const unknown = wanted.filter((id) => !held.has(id));
      if (unknown.length > 0) {
        return reply.code(400).send({
          ok: false,
          error:
            `The library has no jar for ${unknown.join(", ")}. A set may only name mods the ` +
            `library holds, so that a world can never be set to something it would then refuse ` +
            `to start with.`,
        });
      }
      const written = await sets.set(name, wanted);
      return {
        ok: true,
        world: written.world,
        modIds: written.modIds,
        missing: [],
        configured: true,
      } satisfies WorldModsResponse;
    } finally {
      releaseTask(reservation);
    }
  });

  /**
   * The four launch-option routes below are deliberately NOT gated on
   * `requireStopped` or `requireNoActiveTask`. They only write a small JSON
   * file, never the mods folder or a world zip, so there is nothing here for a
   * concurrent steamcmd run or reconcile to corrupt. And unlike a world
   * setting, the game reads its command line exactly once, at process launch -
   * an edit saved while a session is running cannot partially apply or land in
   * an inconsistent state; it simply has no effect until that world's next
   * start. Refusing the write would only make the operator wait for a stop
   * that buys nothing.
   */

  /**
   * Validates a whole payload before storing any of it.
   *
   * All-or-nothing on purpose: a partial apply leaves the operator looking at a
   * form where some edits took and some did not, with a single error message to
   * explain the difference.
   */
  const checkAll = (changes: Record<string, unknown>): string | null => {
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) {
        // A null clears an option; there is nothing to range-check, but the
        // name still has to be one we know, or it is a typo that silently does
        // nothing.
        if (fieldByName(name) === undefined) return `"${name}" is not a known launch option.`;
        continue;
      }
      const bad = checkLaunchOption(name, value);
      if (bad !== null) return bad;
    }
    return null;
  };

  app.get("/api/launch-options", async () => {
    const defaults = await launchOptions.defaults();
    return {
      ok: true,
      world: null,
      effective: defaults,
      overrides: defaults,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });

  app.put("/api/launch-options", async (req, reply) => {
    const changes = (req.body ?? {}) as Record<string, unknown>;
    const bad = checkAll(changes);
    if (bad !== null) return reply.code(400).send({ ok: false, error: bad });
    const defaults = await launchOptions.setDefaults(
      changes as Record<string, LaunchOptionValue | null>,
    );
    return {
      ok: true,
      world: null,
      effective: defaults,
      overrides: defaults,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });

  app.get("/api/worlds/:world/launch-options", async (req) => {
    const { world } = req.params as { world: string };
    const [defaults, overrides] = await Promise.all([
      launchOptions.defaults(),
      launchOptions.forWorld(world),
    ]);
    return {
      ok: true,
      world,
      effective: { ...defaults, ...overrides },
      overrides,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });

  app.put("/api/worlds/:world/launch-options", async (req, reply) => {
    const { world } = req.params as { world: string };
    const changes = (req.body ?? {}) as Record<string, unknown>;
    const bad = checkAll(changes);
    if (bad !== null) return reply.code(400).send({ ok: false, error: bad });
    const overrides = await launchOptions.setForWorld(
      world,
      changes as Record<string, LaunchOptionValue | null>,
    );
    const defaults = await launchOptions.defaults();
    return {
      ok: true,
      world,
      effective: { ...defaults, ...overrides },
      overrides,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });

  app.get("/api/config", async () => publicConfig(cfg));

  app.put("/api/config", async (req, reply) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      if (!ALLOWED_CONFIG_KEYS.has(key as keyof DaemonConfig)) {
        return reply.code(400).send({ ok: false, error: `Field "${key}" cannot be changed remotely.` });
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
