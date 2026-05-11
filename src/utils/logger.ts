import { appendEventLog } from "../persistence/eventLog.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  run: string;
  file?: string;
  stage?: string;
  tier?: number;
  level: LogLevel;
  msg: string;
  durMs?: number;
  extra?: Record<string, unknown>;
}

type AppendEventLog = (type: string, data: Record<string, unknown>) => Promise<void>;

export async function appendRunEvent(
  workspacePath: string,
  runId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await appendEventLog(workspacePath, runId, type, data);
}

export async function log(
  entry: Omit<LogEntry, "ts"> & { ts?: string },
  appendEventLog?: AppendEventLog,
): Promise<void> {
  const normalizedBase: LogEntry = {
    ts: entry.ts || new Date().toISOString(),
    run: entry.run,
    level: entry.level,
    msg: entry.msg,
  };
  const normalized: LogEntry = {
    ...normalizedBase,
    ...(entry.file !== undefined ? { file: entry.file } : {}),
    ...(entry.stage !== undefined ? { stage: entry.stage } : {}),
    ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
    ...(entry.durMs !== undefined ? { durMs: entry.durMs } : {}),
    ...(entry.extra !== undefined ? { extra: entry.extra } : {}),
  };
  const line = JSON.stringify(normalized);
  if (normalized.level === "error") {
    console.error(line);
  } else if (normalized.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  if (!appendEventLog) {
    return;
  }
  const levelTag = normalized.level.toUpperCase();
  await appendEventLog("LOG_ADDED", {
    logType: levelTag,
    title: normalized.stage || "系统",
    summary: normalized.msg,
    fileId: normalized.file || null,
    tier: normalized.tier || null,
    durMs: normalized.durMs || null,
    structured: normalized,
    ...(normalized.extra || {}),
  });
}
