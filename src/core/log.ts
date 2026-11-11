// Console logging. Lines carry constants, route names, statuses and error codes only: never message
// text, names, emails, tokens, secrets, ids or URLs with ids: no personal data in logs.
import { GLOBAL_NAME } from "../constants.js";

export type LogLevel = "off" | "error" | "info" | "debug";
const RANK: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

/** One SDK log line for `logHandler`. Lines are already redacted (constants, route names, codes). */
export type LogEntry = { level: Exclude<LogLevel, "off">; message: string };
export type LogHandler = (entry: LogEntry) => void;

export type Logger = {
  level: LogLevel;
  error(line: string): void;
  info(line: string): void;
  debug(line: string): void;
};

/** Console logging, plus the host's handler, for lines at or above `level`. A throwing handler is ignored. */
export function createLogger(level: LogLevel = "info", handler?: LogHandler): Logger {
  const emit = (lvl: LogEntry["level"], line: string) => {
    if (RANK[log.level] < RANK[lvl]) return;
    console[lvl](`${GLOBAL_NAME}: ${line}`);
    try {
      handler?.({ level: lvl, message: line });
    } catch {
      // The host's logger must never break the chat.
    }
  };
  const log: Logger = {
    level,
    error: (line) => emit("error", line),
    info: (line) => emit("info", line),
    debug: (line) => emit("debug", line),
  };
  return log;
}

/** Keeps error codes printable and harmless: [a-z0-9_] only. */
export const safeCode = (code: string | undefined) => (code ?? "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40) || "unknown";
