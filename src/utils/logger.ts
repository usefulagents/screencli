import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

// ── Log sinks ──
// A sink receives a plain (un-colored) formatted line for EVERY log call,
// regardless of the console log level. This is what feeds the consolidated
// per-recording log shipped to the cloud: we want the full trail for
// debugging even when the console is running at `info`. Sinks must never
// throw into the logger — they're wrapped defensively.
export type LogSink = (line: string, level: LogLevel) => void;
const sinks: LogSink[] = [];

export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

function stringifyData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return ` ${data}`;
  if (data instanceof Error) return ` ${data.stack || data.message}`;
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` ${String(data)}`;
  }
}

function emit(level: LogLevel, color: (s: string) => string, msg: string, data?: unknown): void {
  if (shouldLog(level)) {
    console.error(color(`[${timestamp()}] ${level.toUpperCase().padEnd(5)} ${msg}`), data ?? '');
  }
  // Feed sinks unconditionally — the shipped log is the complete trail.
  if (sinks.length > 0) {
    const line = `[${timestamp()}] ${level.toUpperCase().padEnd(5)} ${msg}${stringifyData(data)}`;
    for (const sink of sinks) {
      try { sink(line, level); } catch { /* a broken sink must not break logging */ }
    }
  }
}

export const logger = {
  debug(msg: string, data?: unknown): void {
    emit('debug', chalk.gray, msg, data);
  },

  info(msg: string, data?: unknown): void {
    emit('info', chalk.blue, msg, data);
  },

  warn(msg: string, data?: unknown): void {
    emit('warn', chalk.yellow, msg, data);
  },

  error(msg: string, data?: unknown): void {
    emit('error', chalk.red, msg, data);
  },
};
