/*
 * File: base.ts
 * Project: deepsproxy
 * Contrato único dos Adapters: todo provedor HTTP heterogêneo (Gemini,
 * Anthropic, Ollama) implementa ProviderAdapter e devolve respostas no
 * formato OpenAI (/v1/chat/completions), independente do formato nativo.
 */

import type { OpenAIRequest } from '../../utils/types.ts';
import type { Provider } from '../config.ts';

export interface ProviderAdapter {
  /**
   * Traduz o payload OpenAI para o formato nativo do provedor, executa a
   * chamada HTTP e devolve a resposta traduzida de volta para OpenAI.
   * `payload.stream` decide entre SSE e JSON único.
   */
  chatCompletion(payload: OpenAIRequest, provider: Provider): Promise<Response>;

  /** Lista de modelos do provedor (usado no roteamento e dashboard). */
  fetchModels?(provider: Provider): Promise<any[] | null>;
}

/* ------------------------- Helpers de resposta OpenAI ------------------------- */

export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function openaiError(status: number, message: string): Response {
  return jsonResponse({ error: { message } }, status);
}

/**
 * Erro em formato SSE (para requisições com `stream: true`): emite um evento
 * de erro e o [DONE], mantendo o contrato de stream que o cliente espera.
 */
export function openaiStreamError(status: number, message: string): Response {
  const encoder = new TextEncoder();
  const payload = `data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/**
 * Converte o erro final de um adapter (ex.: HttpError de 429/quota após esgotar
 * os retries) numa resposta de erro OpenAI, sem deixar exceção vazar até a rota
 * (que viraria um 500 genérico). `stream` decide entre JSON único e SSE.
 */
export function adapterHttpErrorResponse(err: any, label: string, stream: boolean): Response {
  const status =
    typeof err?.status === 'number' && err.status >= 400 ? err.status : 500;
  const message = `${label}: ${err?.message || String(err)}`;
  return stream ? openaiStreamError(status, message) : openaiError(status, message);
}

export function completionId(): string {
  return 'chatcmpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Monta um chunk SSE no padrão chat.completion.chunk. */
export function openaiChunk(
  id: string,
  model: string,
  delta: any,
  opts: { usage?: any; finishReason?: string | null } = {}
): any {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: opts.finishReason ?? null }],
    ...(opts.usage ? { usage: opts.usage } : {}),
  };
}

/**
 * Monta uma Response SSE (text/event-stream) no formato OpenAI. O callback
 * `emit` escreve eventos via writeEvent(data); o [DONE] final e o tratamento
 * de erro no meio do stream ficam aqui.
 */
export function sseResponse(emit: (writeEvent: (data: unknown) => Promise<void>) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const writeRaw = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      const writeEvent = async (data: unknown) => {
        writeRaw(`data: ${JSON.stringify(data)}\n\n`);
      };
      try {
        await emit(writeEvent);
        if (!closed) writeRaw('data: [DONE]\n\n');
      } catch (err: any) {
        if (!closed) {
          try {
            writeRaw(`data: ${JSON.stringify({ error: { message: err?.message || String(err) } })}\n\n`);
          } catch {
            // ignora
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          // ignora
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/** Converte um payload body (Resposta) em chunks SSE já parseados (async iterator). */
export async function* readSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<any> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // linha parcial/inválida — ignora
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
