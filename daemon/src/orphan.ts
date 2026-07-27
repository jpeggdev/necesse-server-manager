import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

export async function listJavaProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='java.exe' OR Name='javaw.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    { windowsHide: true },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as
    | { ProcessId: number; CommandLine: string | null }
    | { ProcessId: number; CommandLine: string | null }[];
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((p) => ({ pid: p.ProcessId, commandLine: p.CommandLine ?? "" }));
}

export async function findOrphanServer(
  listProcesses: () => Promise<ProcessInfo[]>,
  serverJar: string,
): Promise<ProcessInfo | null> {
  let procs: ProcessInfo[];
  try {
    procs = await listProcesses();
  } catch {
    // Not being able to enumerate is not the same as there being no orphan,
    // but it must not prevent the daemon from starting.
    return null;
  }
  const needle = serverJar.toLowerCase();
  return procs.find((p) => p.commandLine.toLowerCase().includes(needle)) ?? null;
}
