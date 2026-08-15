/*
 * File: throttle.ts
 * Project: deepsproxy
 * Controle de taxa (RateLimiter) e retry com exponential backoff para as
 * chamadas HTTP dos Adapters. Evita respostas 429 (ex.: plano gratuito do
 * Gemini) e absorve falhas transitórias de 5xx.
 */

export class HttpError extends Error {
  status: number;
  body?: string;

  constructor(status: number, message: string, body?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Serializa chamadas garantindo no máximo 1 execução a cada `intervalMs`.
 * As chamadas entram numa fila (promise chain); cada uma espera o intervalo
 * após a execução anterior. Funciona para limites de RPM simples.
 */
export class RateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private lastRunAt = 0;
  private readonly intervalMs: number;
  /** Quantas chamadas estão esperando na fila agora. */
  waiting = 0;

  constructor(requestsPerMinute: number) {
    this.intervalMs = requestsPerMinute > 0 ? 60000 / requestsPerMinute : 0;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    this.waiting++;
    return prev.then(async () => {
      try {
        if (this.intervalMs > 0) {
          const wait = this.lastRunAt + this.intervalMs - Date.now();
          if (wait > 0) await sleep(wait);
        }
        this.lastRunAt = Date.now();
        return await fn();
      } finally {
        this.waiting--;
        release();
      }
    });
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (status: number) => boolean;
}

/**
 * Executa `fn` com retry + exponential backoff (com jitter). Retries em 429 e
 * 5xx por padrão; qualquer outro status de erro é propagado imediatamente.
 * Se o erro trouxer uma sugestão de retry (RetryInfo.retryDelay do Gemini,
 * ex.: `"retryDelay": "33s"`), ela é respeitada (limitada a maxDelayMs).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const retryOn = opts.retryOn ?? ((s) => s === 429 || s >= 500);

  let lastErr: any = new Error('unknown error');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt >= retries) break;
      const status = err?.status;
      if (typeof status === 'number' && !retryOn(status)) throw err;
      const suggested = suggestedRetryDelayMs(lastErr);
      const delay = suggested != null
        ? Math.min(maxDelayMs, suggested)
        : Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.round(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Extrai `"retryDelay": "Ns"` do corpo de erro (formato da API do Gemini). */
function suggestedRetryDelayMs(err: any): number | null {
  const body = typeof err?.body === 'string' ? err.body : '';
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}
