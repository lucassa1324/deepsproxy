/*
 * File: rotation.ts
 * Project: deepsproxy
 * Rotação de API Keys por provedor (Round-Robin com Fallback).
 *
 * Driver genérico usado pelos call sites do proxy (local.ts, adapters,
 * agent.ts, embeddings): dado um provedor com uma lista de contas
 * (`apiKeys`), tenta executar a chamada API com a primeira chave ativa.
 * Se a API responde 429 / RESOURCE_EXHAUSTED / rate_limit_exceeded /
 * insufficient_quota, a chave é marcada como `rate_limited` com um cooldown
 * (1h por padrão, ou o valor do header `retry-after`) e a chamada é refeita
 * imediatamente com a próxima chave. Se TODAS falharem por cota, o caller
 * devolve HTTP 429 informando que as contas do provedor esgotaram.
 *
 * Provedores sem chaves (Ollama/LM Studio) seguem sem autenticação — basta o
 * caller usar o fluxo atual quando `activeAccountKeys` retornar vazio.
 */

import type { AccountKey, Provider } from './config.ts';
import {
  activeAccountKeys,
  detectRateLimit,
  markKeyRateLimited,
  normalizeAccountKeys,
} from './config.ts';

/** Erro interno que representa "todas as chaves do provedor excederam a cota". */
export class AllQuotaExhaustedError extends Error {
  status = 429;
  constructor(public providerName: string) {
    super(
      `Todas as contas associadas ao provedor "${providerName}" atingiram o limite de cota (Rate Limit / Quota Exceeded). Tente novamente mais tarde ou cadastre novas chaves.`
    );
    this.name = 'AllQuotaExhaustedError';
  }
}

export interface RotationResult<T> {
  /** Valor final (resposta ao cliente) quando houve sucesso ou erro não-quota. */
  value?: T;
  /** true quando todas as chaves falharam por cota (caller deve responder 429). */
  allQuotaExhausted?: boolean;
  /** Último erro não-quota (conexão/HTTP) quando todos falharam. */
  lastError?: any;
  /** Quantas chaves foram tentadas (para logs). */
  attempts?: number;
}

/** Body JSON OpenAI para o caso de exaustão total de cota. */
export function quotaExhaustedBody(providerName: string): string {
  const err = new AllQuotaExhaustedError(providerName);
  return JSON.stringify({ error: { message: err.message, type: 'insufficient_quota' } });
}

/** Response OpenAI JSON (ou SSE) de exaustão total de cota. */
export function quotaExhaustedResponse(providerName: string, stream = false): Response {
  const body = quotaExhaustedBody(providerName);
  if (stream) {
    const encoder = new TextEncoder();
    const payload = `data: ${JSON.stringify({ error: { message: new AllQuotaExhaustedError(providerName).message } })}\n\ndata: [DONE]\n\n`;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    });
    return new Response(readable, {
      status: 429,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }
  return new Response(body, {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Driver de rotação: executa `call` com cada chave ativa do provedor até obter
 * uma resposta utilizável (não-quota). Em caso de cota (429 / RESOURCE_EXHAUSTED
 * etc.), marca a chave em cooldown e tenta a próxima imediatamente.
 *
 * - `call(key, attempt)` deve executar a chamada HTTP e devolver a Response crua
 *   do upstream (ou lançar para erro de conexão).
 * - `handle(res, key, attempt)` converte a Response não-quota no valor final
 *   (ex.: Response OpenAI json/stream ou erro HTTP traduzido).
 * - Quando o provedor não tem chaves ativas, retorna `allQuotaExhausted` para o
 *   caller decidir (provedores locais seguem sem autenticação).
 */
export async function driveRotation<T>(opts: {
  provider: Provider;
  call: (key: AccountKey, attempt: number) => Promise<Response>;
  handle: (res: Response, key: AccountKey, attempt: number) => Promise<T> | T;
}): Promise<RotationResult<T>> {
  const keys = activeAccountKeys(opts.provider);
  let lastError: any = null;
  let attempts = 0;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    attempts = i + 1;
    let res: Response;
    try {
      res = await opts.call(key, i);
    } catch (err: any) {
      // Exceção pode carregar além do HTTP status um corpo (ex.: HttpError dos
      // adapters). Se for cota/rate limit, marca a chave e tenta a próxima.
      const det = detectRateLimit({ status: err?.status, body: typeof err?.body === 'string' ? err.body : undefined });
      if (det.quota) {
        markKeyRateLimited(opts.provider.id, key.id, det.cooldownMs);
        console.warn(
          `[rotation] "${opts.provider.name}" chave "${key.label || key.id}" atingiu a cota (${err?.status || 'quota'}); cooldown de ${Math.round(det.cooldownMs / 1000)}s. Tentando próxima chave...`
        );
        lastError = new Error(`quota: ${key.label || key.id}`);
        continue;
      }
      console.warn(
        `[rotation] "${opts.provider.name}" chave "${key.label || key.id}" falhou na conexão: ${err?.message || String(err)}`
      );
      lastError = err;
      continue; // tentativa de rede: tenta a próxima chave
    }

    // Só inspeciona corpo em falhas (evita ler streams de sucesso por inteiro).
    let quota = false;
    if (res.status === 429 || res.status >= 500) {
      const bodyText = await res.clone().text().catch(() => '');
      const retryAfter = res.headers.get('retry-after');
      const det = detectRateLimit({ status: res.status, body: bodyText, retryAfter });
      quota = det.quota;
      if (quota) {
        markKeyRateLimited(opts.provider.id, key.id, det.cooldownMs);
        console.warn(
          `[rotation] "${opts.provider.name}" chave "${key.label || key.id}" atingiu a cota (HTTP ${res.status}); cooldown de ${Math.round(det.cooldownMs / 1000)}s. Tentando próxima chave...`
        );
        lastError = new Error(`quota: ${key.label || key.id}`);
        continue;
      }
    }

    return { value: await opts.handle(res, key, i), attempts };
  }

  if (attempts === 0 && keys.length === 0) {
    return { allQuotaExhausted: true, attempts: 0 };
  }
  if (lastError) {
    // Se todas as tentativas foram POR COTA, o caller responde 429.
    const quotaOnly = keys.length === attempts && lastError?.message && /^quota:/.test(String(lastError.message));
    if (quotaOnly) return { allQuotaExhausted: true, attempts };
    return { lastError, attempts };
  }
  return { allQuotaExhausted: true, attempts };
}

/** Existe ao menos uma chave configurada (ativa ou não) no provedor? */
export function hasProviderKeys(provider: Provider): boolean {
  return normalizeAccountKeys(provider).length > 0;
}