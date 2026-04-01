export type LogLevel = "silent" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  info: 1,
  debug: 2,
};

export class Logger {
  private level: number;

  constructor(level: LogLevel = "silent") {
    this.level = LEVELS[level];
  }

  info(...args: unknown[]): void {
    if (this.level >= LEVELS.info) {
      console.log("[aimock]", ...args);
    }
  }

  debug(...args: unknown[]): void {
    if (this.level >= LEVELS.debug) {
      console.log("[aimock]", ...args);
    }
  }

  warn(...args: unknown[]): void {
    console.warn("[aimock]", ...args);
  }

  error(...args: unknown[]): void {
    console.error("[aimock]", ...args);
  }
}
