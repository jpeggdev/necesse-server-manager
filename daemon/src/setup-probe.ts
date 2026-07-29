import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface ProbeEnv {
  appData?: string;
  userProfile?: string;
  pathDirs: string[];
  /** Extra places to look for a server install, most likely first. */
  extraServerRoots: string[];
  exists: (p: string) => Promise<boolean>;
}

export interface Probed {
  dataDir: string | null;
  serverRoot: string | null;
  serverJar: string | null;
  javaExe: string | null;
  steamcmdExe: string | null;
}

export const realExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to check ${p}: ${(e as Error).message}`);
  }
};

const firstExisting = async (
  candidates: string[],
  exists: (p: string) => Promise<boolean>,
): Promise<string | null> => {
  for (const c of candidates) if (await exists(c)) return c;
  return null;
};

/**
 * What this machine appears to have, or null per field.
 *
 * Null rather than a plausible-looking guess: the wizard shows the user what it
 * found and takes that as the default answer, and a guess presented in that
 * position is indistinguishable from a discovery. Every filesystem question
 * goes through `env.exists` so the whole thing is testable without a real disk.
 */
export async function probeConfig(env: ProbeEnv): Promise<Probed> {
  const dataDir =
    env.appData === undefined
      ? null
      : await firstExisting([join(env.appData, "Necesse")], env.exists);

  const serverRoots = [
    ...env.extraServerRoots,
    "C:\\necesseserver",
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Necesse Dedicated Server",
  ];
  let serverRoot: string | null = null;
  let serverJar: string | null = null;
  for (const root of serverRoots) {
    const jar = join(root, "Server.jar");
    if (await env.exists(jar)) {
      serverRoot = root;
      serverJar = jar;
      break;
    }
  }

  // The bundled jre first: it is the JVM the server ships and was tested with,
  // and a PATH java may be any version at all.
  const javaCandidates = [
    ...(serverRoot === null ? [] : [join(serverRoot, "jre", "bin", "java.exe")]),
    ...env.pathDirs.map((d) => join(d, "java.exe")),
  ];
  const javaExe = await firstExisting(javaCandidates, env.exists);

  const steamCandidates = [
    ...env.pathDirs.map((d) => join(d, "steamcmd.exe")),
    "C:\\steamcmd\\steamcmd.exe",
    ...(env.userProfile === undefined ? [] : [join(env.userProfile, "steam", "steamcmd.exe")]),
  ];
  const steamcmdExe = await firstExisting(steamCandidates, env.exists);

  return { dataDir, serverRoot, serverJar, javaExe, steamcmdExe };
}

/** 24 random bytes, base64url. Long enough that guessing is not a strategy. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}
