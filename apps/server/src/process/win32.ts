import { Effect } from "effect";

import type { TerminalProcessInspectionError } from "./Services/TerminalProcessInspector";
import { parsePortList } from "./utils";

interface InspectorCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface WindowsRunCommand {
  (
    input: Readonly<{
      operation: string;
      terminalPid: number;
      command: string;
      args: ReadonlyArray<string>;
      timeoutMs: number;
      maxOutputBytes: number;
    }>,
  ): Effect.Effect<InspectorCommandResult, TerminalProcessInspectionError>;
}

export const collectWindowsChildPids = Effect.fn("process.collectWindowsChildPids")(function* (
  terminalPid: number,
  runCommand: WindowsRunCommand,
): Effect.fn.Return<number[], TerminalProcessInspectionError> {
  const command = [
    "$procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId -ErrorAction SilentlyContinue",
    "if (-not $procs) { exit 0 }",
    '$procs | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
  ].join("; ");
  const result = yield* runCommand({
    operation: "TerminalProcessInspector.collectWindowsChildPids",
    terminalPid,
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", command],
    timeoutMs: 1_500,
    maxOutputBytes: 262_144,
  });
  if (result.exitCode !== 0) {
    return [];
  }

  const childrenByParentPid = new Map<number, number[]>();
  for (const line of result.stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const children = childrenByParentPid.get(ppid);
    if (children) {
      children.push(pid);
    } else {
      childrenByParentPid.set(ppid, [pid]);
    }
  }

  const family = new Set<number>();
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.shift()!;
    const childPids = childrenByParentPid.get(parentPid);
    if (!childPids || childPids.length === 0) continue;
    for (const childPid of childPids) {
      if (family.has(childPid)) continue;
      family.add(childPid);
      pending.push(childPid);
    }
  }

  return [...family];
});

export const checkWindowsListeningPorts = Effect.fn("process.checkWindowsListeningPorts")(
  function* (
    processIds: number[],
    input: {
      terminalPid: number;
      runCommand: WindowsRunCommand;
    },
  ): Effect.fn.Return<number[], TerminalProcessInspectionError> {
    if (processIds.length === 0) return [];

    const processFilter = processIds.map((pid) => `$_.OwningProcess -eq ${pid}`).join(" -or ");
    const command = [
      "$connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue",
      `$matching = $connections | Where-Object { ${processFilter} }`,
      "if (-not $matching) { exit 0 }",
      "$matching | Select-Object -ExpandProperty LocalPort -Unique",
    ].join("; ");
    const result = yield* input.runCommand({
      operation: "TerminalProcessInspector.checkWindowsListeningPorts",
      terminalPid: input.terminalPid,
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      timeoutMs: 1_500,
      maxOutputBytes: 65_536,
    });
    if (result.exitCode !== 0) {
      return [];
    }
    return parsePortList(result.stdout);
  },
);
