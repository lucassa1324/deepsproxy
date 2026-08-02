/*
 * File: logger.ts
 * Project: deepsproxy
 * Purpose: Captura os logs do console e os distribui em tempo real
 * para o dashboard via SSE.
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  message: string;
}

const MAX_LOGS = 2000;

let seq = 0;
const logs: LogEntry[] = [];
const subscribers = new Set<(entry: LogEntry) => void>();

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function emit(level: LogLevel, message: string) {
  const entry: LogEntry = { id: ++seq, ts: Date.now(), level, message };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function getLogs(): LogEntry[] {
  return logs.slice();
}

export function subscribe(callback: (entry: LogEntry) => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function clearLogs() {
  logs.length = 0;
}

let attached = false;

export function attachLogger() {
  if (attached) return;
  attached = true;

  const original: Record<string, (...args: unknown[]) => void> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    (console as any)[level] = (...args: unknown[]) => {
      emit(level, formatArgs(args));
      original[level](...args);
    };
  }

  process.on('uncaughtException', (err) => {
    emit('error', 'Uncaught exception: ' + (err.stack || String(err)));
  });

  process.on('unhandledRejection', (reason) => {
    emit('error', 'Unhandled rejection: ' + (reason instanceof Error ? reason.stack : String(reason)));
  });
}
