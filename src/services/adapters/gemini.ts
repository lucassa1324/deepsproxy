/*
 * File: gemini.ts
 * Project: deepsproxy
 * Adapter para a REST nativa do Google Gemini (generativelanguage API).
 * Traduz o payload OpenAI ↔ Gemini, com suporte a streaming (SSE), tools
 * nativos (functionDeclarations), fila de 15 RPM e retry 429/5xx.
 */

import { v4 as uuidv4 } from 'uuid';
import type { OpenAIRequest, Message } from '../../utils/types.ts';
import type { Provider } from '../config.ts';
import { normalizeModelId } from '../config.ts';
import {
  ProviderAdapter,
  jsonResponse,
  openaiError,
  openaiChunk,
  sseResponse,
  readSse,
  completionId,
  adapterHttpErrorResponse,
} from './base.ts';
import { RateLimiter, withRetry, HttpError } from './throttle.ts';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function defaultGeminiRpm(): number {
  const env = parseInt(process.env.GEMINI_RPM || '', 10);
  return env > 0 ? env : 15;
}

/*
 * thought_signature: o Gemini exige que um functionCall do histórico (turnos
 * anteriores) seja reenviado com a mesma `thoughtSignature` da resposta
 * original; sem ela a API responde 400 ("Function call is missing a
 * thought_signature"). O formato OpenAI não tem esse campo, então a assinatura
 * é codificada no id do tool_call (que o cliente ecoa de volta) e também
 * exposta como `thought_signature` no próprio tool_call.
 */
const TS_ID_PREFIX = 'call_ts_';

function encodeThoughtSignature(sig: string): string {
  return Buffer.from(String(sig), 'utf-8').toString('base64url');
}

function thoughtSignatureFromId(id: string | undefined | null): string | null {
  if (!id || !id.startsWith(TS_ID_PREFIX)) return null;
  const encoded = id.slice(TS_ID_PREFIX.length);
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    return decoded || null;
  } catch {
    return null;
  }
}

/* ------------------------- OpenAI → Gemini ------------------------- */

function contentToParts(content: any): any[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return content ? [{ text: String(content) }] : [];
  }
  const parts: any[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text) {
      parts.push({ text: p.text });
    } else if (p.type === 'image_url') {
      const url = p.image_url?.url || '';
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(url);
      if (m) {
        parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
      } else {
        parts.push({ text: `[imagem: ${url}]` });
      }
    }
  }
  return parts;
}

function parseToolResult(content: any): any {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return { result: content };
    }
  }
  if (Array.isArray(content)) {
    return { result: content.map((p: any) => p?.text || '').join('') };
  }
  return content || {};
}

/** Resultado de tool como texto puro (para histórico sem assinatura). */
function toolContentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p === 'string' ? p : JSON.stringify(p)))
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return String(content ?? '');
}

/**
 * Modelos com raciocínio (2.5+, 3.x) exigem `thoughtSignature` em todo
 * functionCall do histórico. Para eles, um call sem assinatura recuperável é
 * convertido em texto (em vez de mandar o functionCall e tomar 400). Modelos
 * antigos (2.0/1.5) não exigem — seguem com functionResponse normalmente.
 */
function requiresThoughtSignature(model: string): boolean {
  const id = normalizeModelId(model);
  if (!id) return true;
  return /(^|[-_/])(2\.[4-9]|3(\.|-|$))/.test(id);
}

// O Gemini (function_declarations.parameters) aceita apenas um subconjunto do
// JSON Schema. IDEs como Trae/Cursor enviam keywords que a API rejeita
// (additionalProperties, anyOf/oneOf, $schema, default, const, nullable...).
// Remove recursivamente o que o Gemini não entende para não estourar 400.
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'title',
]);

function sanitizeGeminiSchema(node: any): any {
  if (Array.isArray(node)) {
    const out: any[] = [];
    for (const item of node) {
      const s = sanitizeGeminiSchema(item);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out: any = {};
    for (const key of Object.keys(node)) {
      if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
      const value = node[key];
      if (key === 'properties') {
        const props: any = {};
        for (const pkey of Object.keys(value || {})) {
          const s = sanitizeGeminiSchema(value[pkey]);
          if (s !== undefined && Object.keys(s).length) props[pkey] = s;
        }
        out.properties = props;
      } else if (key === 'items') {
        out.items = sanitizeGeminiSchema(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }
  return node;
}

function toGeminiTools(payload: OpenAIRequest): { tools: any[]; toolConfig?: any } | null {
  const fnTools = (payload.tools || []).filter((t: any) => t && t.type === 'function');
  if (!fnTools.length) return null;
  const functionDeclarations = fnTools.map((t: any) => ({
    name: t.function?.name,
    description: t.function?.description,
    parameters: sanitizeGeminiSchema(t.function?.parameters),
  }));
  const out: { tools: any[]; toolConfig?: any } = { tools: [{ functionDeclarations }] };
  const choice: any = payload.tool_choice;
  if (choice === 'none') {
    out.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  } else if (choice === 'required') {
    out.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
  } else if (choice && typeof choice === 'object' && choice.function?.name) {
    out.toolConfig = {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] },
    };
  }
  return out;
}

export function buildGeminiBody(payload: OpenAIRequest): any {
  const systemParts: string[] = [];
  const contents: any[] = [];

  // Gemini exige `thoughtSignature` em todo functionCall do histórico. Calls
  // gerados por outro caminho (gemini-web/Playwright) ou antes desta correção
  // não têm assinatura recuperável. Para modelos que exigem a assinatura,
  // esses calls são descartados e o resultado da tool vira texto do usuário —
  // sem isso a API responde 400.
  const requiresSig = requiresThoughtSignature(payload.model);
  const unsignedCallIds = new Set<string>();
  const callNameById = new Map<string, string>();
  for (const msg of payload.messages || []) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (!tc?.id) continue;
      callNameById.set(tc.id, tc.function?.name || '');
      if (requiresSig) {
        const sig = (tc as any).thought_signature || thoughtSignatureFromId(tc.id);
        if (!sig) unsignedCallIds.add(tc.id);
      }
    }
  }

  for (const msg of payload.messages || []) {
    if (msg.role === 'system') {
      const text = Array.isArray(msg.content)
        ? msg.content.map((p: any) => (p?.type === 'text' ? p.text : '')).join('\n')
        : String(msg.content || '');
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool' || msg.role === 'function') {
      if (msg.tool_call_id && unsignedCallIds.has(msg.tool_call_id)) {
        const label = callNameById.get(msg.tool_call_id) || msg.name || 'ferramenta';
        const result = toolContentToText(msg.content);
        contents.push({ role: 'user', parts: [{ text: `[Resultado da tool ${label}: ${result}]` }] });
      } else {
        const name = callNameById.get(msg.tool_call_id || '') || msg.name || 'function';
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response: parseToolResult(msg.content) } }],
        });
      }
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = contentToParts(msg.content);
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const sig = (tc as any).thought_signature || thoughtSignatureFromId(tc.id);
        if (requiresSig && !sig) continue; // sem assinatura: não envia o functionCall
        let args: any = {};
        try {
          args =
            typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {};
        } catch {
          args = {};
        }
        const fc: any = { name: tc.function?.name || '', args };
        if (sig) fc.thoughtSignature = sig;
        parts.push({ functionCall: fc });
      }
    }
    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  const body: any = { contents };
  if (systemParts.length) {
    body.systemInstruction = { parts: systemParts.map((t) => ({ text: t })) };
  }

  const gc: any = {};
  const anyPayload = payload as any;
  if (anyPayload.temperature !== undefined) gc.temperature = anyPayload.temperature;
  if (anyPayload.max_tokens !== undefined) gc.maxOutputTokens = anyPayload.max_tokens;
  if (anyPayload.top_p !== undefined) gc.topP = anyPayload.top_p;
  if (anyPayload.top_k !== undefined) gc.topK = anyPayload.top_k;
  if (Object.keys(gc).length) body.generationConfig = gc;

  const tools = toGeminiTools(payload);
  if (tools) {
    body.tools = tools.tools;
    if (tools.toolConfig) body.toolConfig = tools.toolConfig;
  }

  return body;
}

/* ------------------------- Gemini → OpenAI ------------------------- */

const FINISH_MAP: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  IMAGE_SAFETY: 'content_filter',
  OTHER: 'stop',
};

function usageFromGemini(um: any): any {
  return {
    prompt_tokens: um?.promptTokenCount ?? 0,
    completion_tokens: um?.candidatesTokenCount ?? 0,
    total_tokens: um?.totalTokenCount ?? 0,
    prompt_tokens_details: { cached_tokens: um?.cachedContentTokenCount ?? 0 },
  };
}

function messageFromGeminiParts(parts: any[]): any {
  const message: any = { role: 'assistant', content: null };
  const toolCalls: any[] = [];
  const texts: string[] = [];
  const reasoning: string[] = [];
  for (const part of parts || []) {
    if (part?.text !== undefined) {
      if (part.thought) reasoning.push(part.text);
      else texts.push(part.text);
    } else if (part?.functionCall) {
      const fc = part.functionCall;
      const tc: any = {
        id: 'call_' + (fc.id || uuidv4().slice(0, 8)),
        type: 'function',
        function: { name: fc.name || '', arguments: JSON.stringify(fc.args || {}) },
      };
      if (fc.thoughtSignature) {
        tc.thought_signature = fc.thoughtSignature;
        tc.id = TS_ID_PREFIX + encodeThoughtSignature(fc.thoughtSignature);
      }
      toolCalls.push(tc);
    }
  }
  if (toolCalls.length) {
    message.content = texts.join('') || null;
    message.tool_calls = toolCalls;
  } else {
    message.content = texts.join('') || null;
  }
  if (reasoning.length) message.reasoning_content = reasoning.join('');
  return message;
}

export function fromGeminiResponse(data: any, model: string): any {
  const cand = data?.candidates?.[0] || {};
  const message = messageFromGeminiParts(cand?.content?.parts);
  const finish = message.tool_calls?.length
    ? 'tool_calls'
    : FINISH_MAP[cand?.finishReason] || 'stop';
  return {
    id: completionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
    usage: usageFromGemini(data?.usageMetadata),
  };
}

/* ------------------------- Adapter ------------------------- */

export class GeminiAdapter implements ProviderAdapter {
  private limiter: RateLimiter;

  constructor(rpm?: number) {
    this.limiter = new RateLimiter(rpm ?? defaultGeminiRpm());
  }

  get queueWaiting(): number {
    return this.limiter.waiting;
  }

  async chatCompletion(payload: OpenAIRequest, provider: Provider): Promise<Response> {
    const isStream = payload.stream ?? false;
    // Cliente pode mandar "models/gemini-2.5-flash" (prefixo da REST do
    // Google); sem normalizar a URL viraria /models/models/... (404).
    const model = normalizeModelId(payload.model);
    const apiKey = provider.apiKey;
    if (!apiKey) {
      return openaiError(400, 'Gemini: API Key não configurada para este provedor.');
    }
    const baseUrl = (provider.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const body = buildGeminiBody(payload);
    const endpoint = isStream ? 'streamGenerateContent' : 'generateContent';
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:${endpoint}?key=${encodeURIComponent(apiKey)}${isStream ? '&alt=sse' : ''}`;

    const doFetch = () =>
      withRetry(async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new HttpError(res.status, `Gemini ${res.status}: ${errText.slice(0, 300)}`, errText);
        }
        return res;
      }, { retries: 3 });

    if (!isStream) {
      return this.limiter.run(async () => {
        let res: Response;
        try {
          res = await doFetch();
        } catch (err: any) {
          // Retries esgotados (ex.: 429 de quota): vira erro OpenAI claro,
          // em vez de exceção que vazaria como 500 na rota.
          return adapterHttpErrorResponse(err, 'Gemini', false);
        }
        const data = await res.json();
        if (data?.error) {
          return openaiError(
            400,
            `Gemini: ${data.error.message || data.error.status || 'erro desconhecido'}`
          );
        }
        return jsonResponse(fromGeminiResponse(data, model));
      });
    }

    return this.limiter.run(async () => {
      let res: Response;
      try {
        res = await doFetch();
      } catch (err: any) {
        return adapterHttpErrorResponse(err, 'Gemini', true);
      }
      const completion = completionId();
      return sseResponse(async (writeEvent) => {
        await writeEvent(openaiChunk(completion, model, { role: 'assistant', content: '' }));
        let usage: any = null;
        let finishReason: string | null = null;
        for await (const chunk of readSse(res.body)) {
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          const cand = chunk?.candidates?.[0];
          if (!cand?.content?.parts?.length && !cand?.content?.role) continue;
          const message = messageFromGeminiParts(cand.content.parts);
          if (message.reasoning_content) {
            await writeEvent(openaiChunk(completion, model, { reasoning_content: message.reasoning_content }));
          }
          if (message.content) {
            await writeEvent(openaiChunk(completion, model, { content: message.content }));
          }
          if (message.tool_calls?.length) {
            await writeEvent(
              openaiChunk(completion, model, {
                tool_calls: message.tool_calls.map((tc: any, i: number) => ({ index: i, ...tc })),
              })
            );
          }
          if (cand.finishReason) {
            finishReason = message.tool_calls?.length ? 'tool_calls' : FINISH_MAP[cand.finishReason] || 'stop';
          }
        }
        await writeEvent(
          openaiChunk(completion, model, {}, { usage: usageFromGemini(usage), finishReason })
        );
      });
    });
  }

  async fetchModels(provider: Provider): Promise<any[] | null> {
    const apiKey = provider.apiKey;
    if (!apiKey) return null;
    const baseUrl = (provider.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    try {
      const res = await fetch(`${baseUrl}/models?key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) return null;
      const data: any = await res.json();
      const list = Array.isArray(data?.models) ? data.models : [];
      return list
        .filter(
          (m: any) =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes('generateContent')
        )
        .map((m: any) => ({
          id: String(m.name || '').replace(/^models\//, ''),
          object: 'model',
          owned_by: 'gemini',
          label: m.displayName || undefined,
        }));
    } catch {
      return null;
    }
  }
}
