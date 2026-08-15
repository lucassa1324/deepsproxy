/*
 * File: local.ts
 * Project: deepsproxy
 * Forwarder para qualquer provedor OpenAI-compatível (Ollama, LM Studio,
 * OpenAI, Groq, Together, ...) via HTTP.
 *
 * Quando o request traz `tools`, usa o mesmo mecanismo agentic do backend
 * DeepSeek: injeta as ferramentas no system prompt, pede que o modelo emita
 * blocos <tool_call> e converte a resposta em tool_calls OpenAI. Assim modelos
 * sem suporte nativo a function-calling (editar arquivos etc.) também
 * conseguem usar ferramentas.
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import type { Provider, ProviderType } from './config.ts';
import { defaultBaseUrl, isAdapterType, normalizeModelId } from './config.ts';
import { isAdapterProvider, fetchProviderModels, dispatchAdapterChat } from './adapters/index.ts';
import { buildAgentPrompt, buildToolsInstructions, contentPartToText } from '../utils/prompt.ts';
import { OpenAIRequest } from '../utils/types.ts';
import { parseToolCallsFromContent } from '../tools/executor.ts';
import { startKeepAlive } from '../utils/sse.ts';

const TOOL_START = '<tool_call>';
const TOOL_END = '</tool_call>';

function buildHeaders(provider: Provider): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider.apiKey) {
    headers['authorization'] = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

export function hasTools(body: OpenAIRequest): boolean {
  return !!(body.tools && Array.isArray(body.tools) && body.tools.length > 0);
}

/**
 * Modelo a enviar ao upstream:
 *  - se o cliente mandou um modelo, respeita o que ele escolheu (o roteamento
 *    depende do nome do modelo);
 *  - se não mandou, usa o `model` do provedor (override) quando definido.
 */
function effectiveModel(provider: Provider, body: OpenAIRequest): string {
  if (body.model) return body.model;
  return provider.model || '';
}

/* ------------------------- Roteamento por modelo ------------------------- */

const DEEPSEEK_MODELS = ['deepseek-thinking', 'deepseek-no-thinking'];

export function isDeepseekModel(model: string): boolean {
  return DEEPSEEK_MODELS.includes(model);
}

// Cache dos modelos por provedor (os seletores e o roteamento dependem disso).
const MODELS_TTL = 30_000;
const modelsCache = new Map<string, { models: any[]; ts: number }>();

/**
 * Escolhe o provedor habilitado que "dona" do modelo requisitado:
 *  1. match pelo override (`provider.model`);
 *  2. match pelos modelos reais do provedor (lista /models, com cache).
 * Retorna null se nenhum provedor conhece o modelo.
 */
export async function findProviderForModel(
  providers: Provider[],
  model: string
): Promise<Provider | null> {
  if (!model) return null;
  const normalized = String(model).toLowerCase();

  // 1. Match pelo override do provedor (qualquer tipo).
  for (const p of providers) {
    if (p.model && p.model === model) return p;
  }

  // 2. Heurística por prefixo de modelo para provedores com namespace claro.
  for (const p of providers) {
    if (normalized.startsWith('gemini-') && p.type === 'gemini') return p;
    if (normalized.startsWith('claude-') && p.type === 'anthropic') return p;
  }

  // 3. Match pela lista real de modelos do provedor (openai-compatible e adapters).
  for (const p of providers) {
    if (p.type === 'deepseek' || p.type === 'qwen') continue;
    const models = isAdapterProvider(p) ? await fetchProviderModels(p) : await fetchModels(p);
    if (models && models.some((m: any) => m.id === model)) return p;
  }

  return null;
}

export async function forwardChatCompletions(c: Context, body: OpenAIRequest, provider: Provider) {
  // Provedores heterogêneos (gemini/anthropic/ollama) passam pela camada de
  // Adapters; a resposta já vem no formato OpenAI (JSON ou SSE).
  if (isAdapterProvider(provider)) {
    const resp = await dispatchAdapterChat(body, provider);
    if (resp) return resp;
  }
  if (hasTools(body)) {
    return forwardAgentic(c, body, provider);
  }
  return forwardPassthrough(c, body, provider);
}

/* ------------------------- Sem ferramentas (proxy direto) ------------------------- */

async function forwardPassthrough(c: Context, body: OpenAIRequest, provider: Provider) {
  const isStream = body.stream ?? false;

  const payload: any = { ...body, stream: isStream };
  const model = effectiveModel(provider, body);
  if (model) {
    payload.model = model;
  } else {
    delete payload.model;
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(provider),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return c.json(
      { error: { message: `Upstream ${provider.baseUrl} respondeu ${response.status}: ${errText}` } },
      502
    );
  }

  if (!isStream) {
    const data = await response.json();
    return c.json(data);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return honoStream(c, async (streamWriter: any) => {
    const stopKeepAlive = startKeepAlive((chunk) => streamWriter.write(chunk));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await streamWriter.write(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) {
        await streamWriter.write(tail);
      }
    } finally {
      stopKeepAlive();
      reader.releaseLock();
    }
  });
}

/* ------------------------- Agentic (ferramentas via prompt) ------------------------- */

/** True quando alguma mensagem traz imagens no formato OpenAI (image_url). */
function hasImageParts(messages: any[]): boolean {
  return (messages || []).some(
    (m) => Array.isArray(m.content) && m.content.some((p: any) => p && p.type === 'image_url')
  );
}

/**
 * Mantém as partes multimodais (imagens) das mensagens originais e injeta as
 * instruções de ferramentas num system message. Usado quando o request traz
 * ferramentas E imagens, para que modelos de visão recebam a imagem de fato
 * em vez do marcador de texto.
 */
function buildAgenticMessagesWithImages(body: OpenAIRequest): any[] {
  const systemParts: string[] = [];
  const messages: any[] = [];

  for (const m of body.messages || []) {
    if (m.role === 'system') {
      systemParts.push(
        Array.isArray(m.content)
          ? m.content.map(contentPartToText).join('\n')
          : String(m.content || '')
      );
      continue;
    }
    messages.push({
      ...m,
      content: Array.isArray(m.content)
        ? m.content
            .filter((p: any) => p && (p.type === 'image_url' || (p.type === 'text' && p.text != null)))
            .map((p: any) =>
              p.type === 'image_url' ? { type: 'image_url', image_url: { url: p.image_url?.url } } : { type: 'text', text: p.text }
            )
        : m.content,
    });
  }

  const toolInstructions = buildToolsInstructions(body);
  if (toolInstructions) systemParts.push(toolInstructions);
  if (systemParts.length > 0) {
    messages.unshift({ role: 'system', content: systemParts.join('\n\n').trim() });
  }
  return messages;
}

async function forwardAgentic(c: Context, body: OpenAIRequest, provider: Provider) {
  const isStream = body.stream ?? false;
  const hasImages = hasImageParts(body.messages || []);
  const messages = hasImages
    ? buildAgenticMessagesWithImages(body)
    : [{ role: 'user', content: buildAgentPrompt(body) }];
  const model = effectiveModel(provider, body);

  const payload: any = { ...body, messages, stream: isStream };
  if (model) {
    payload.model = model;
  } else {
    delete payload.model;
  }
  delete payload.tools;
  delete payload.tool_choice;

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(provider),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return c.json(
      { error: { message: `Upstream ${provider.baseUrl} respondeu ${response.status}: ${errText}` } },
      502
    );
  }

  if (!isStream) {
    return finishNonStreaming(c, response, body, model);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const completionId = 'chatcmpl-' + uuidv4();
  const created = Math.floor(Date.now() / 1000);

  return honoStream(c, async (streamWriter: any) => {
    const writeEvent = async (data: any) => {
      await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const chunkObj = (delta: any) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: model || body.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
    });

    // Mantém a conexão viva enquanto o modelo "pensa" (comentário SSE ignorado pelo cliente).
    const stopKeepAlive = startKeepAlive((chunk) => streamWriter.write(chunk));

    await writeEvent(chunkObj({ role: 'assistant', content: '' }));

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let contentEmitBuffer = '';
    let insideTool = false;
    let emittedToolCallCount = 0;
    let upstreamUsage: any = null;
    let completionTokens = 0;
    const promptTokens = Math.ceil(
      (Array.isArray(messages[0]?.content) ? JSON.stringify(messages) : messages[0]?.content || '').length / 3.5
    );

    const emitContent = async (text: string) => {
      if (text && emittedToolCallCount === 0) {
        await writeEvent(chunkObj({ content: text }));
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(dataStr);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta || {};
        if (chunk.usage) {
          upstreamUsage = chunk.usage;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }

        if (delta.reasoning_content) {
          await writeEvent(chunkObj({ reasoning_content: delta.reasoning_content }));
        }

        if (typeof delta.content !== 'string' || delta.content === '') continue;

        contentEmitBuffer += delta.content;

        while (contentEmitBuffer.length > 0) {
          if (!insideTool) {
            const startIdx = contentEmitBuffer.indexOf(TOOL_START);
            if (startIdx !== -1) {
              await emitContent(contentEmitBuffer.substring(0, startIdx));
              insideTool = true;
              contentEmitBuffer = contentEmitBuffer.substring(startIdx + TOOL_START.length);
              continue;
            }

            // No full start tag: check for a partial match at the end
            let flushIndex = contentEmitBuffer.length;
            for (let i = 1; i <= TOOL_START.length; i++) {
              if (contentEmitBuffer.endsWith(TOOL_START.substring(0, i))) {
                flushIndex = contentEmitBuffer.length - i;
                break;
              }
            }
            await emitContent(contentEmitBuffer.substring(0, flushIndex));
            contentEmitBuffer = contentEmitBuffer.substring(flushIndex);
            break;
          } else {
            // Inside a tool: wait for the closing tag
            const endIdx = contentEmitBuffer.indexOf(TOOL_END);
            if (endIdx === -1) break;

            let toolJsonStr = contentEmitBuffer.substring(0, endIdx).trim();
            try {
              toolJsonStr = toolJsonStr.replace(/```json/g, '').replace(/```/g, '').trim();
              const startJ = toolJsonStr.indexOf('{');
              const endJ = toolJsonStr.lastIndexOf('}');
              if (startJ !== -1 && endJ !== -1 && endJ >= startJ) {
                toolJsonStr = toolJsonStr.substring(startJ, endJ + 1);
              }

              const toolCallObj = JSON.parse(toolJsonStr);
              const toolId = 'call_' + uuidv4();
              await writeEvent(
                chunkObj({
                  tool_calls: [
                    {
                      index: emittedToolCallCount,
                      id: toolId,
                      type: 'function',
                      function: {
                        name: toolCallObj.name || '',
                        arguments:
                          typeof toolCallObj.arguments === 'object'
                            ? JSON.stringify(toolCallObj.arguments)
                            : String(toolCallObj.arguments || ''),
                      },
                    },
                  ],
                })
              );
              emittedToolCallCount++;
            } catch {
              // Failed to parse the tool JSON, emit as regular text
              await emitContent(TOOL_START + toolJsonStr + TOOL_END);
            }

            insideTool = false;
            contentEmitBuffer = contentEmitBuffer.substring(endIdx + TOOL_END.length);
          }
        }
      }
    }

    // Flush any remaining content buffer
    if (!insideTool && contentEmitBuffer.length > 0 && emittedToolCallCount === 0) {
      await emitContent(contentEmitBuffer);
    }

    const usage = upstreamUsage ?? {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0 },
    };
    const finalFinishReason = emittedToolCallCount > 0 ? 'tool_calls' : 'stop';

    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: model || body.model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finalFinishReason }],
      usage,
    });
    await streamWriter.write('data: [DONE]\n\n');

    stopKeepAlive();
  });
}

async function finishNonStreaming(c: Context, response: Response, body: OpenAIRequest, model: string) {
  const data: any = await response.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const { textContent, toolCalls } = parseToolCallsFromContent(text);

  const message: any = {
    role: 'assistant',
    content: toolCalls.length > 0 ? (textContent || null) : textContent,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments:
          typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
      },
    }));
  }

  if (data.choices && data.choices[0]) {
    data.choices[0].message = message;
    data.choices[0].finish_reason =
      toolCalls.length > 0 ? 'tool_calls' : data.choices[0].finish_reason || 'stop';
  }

  return c.json(data);
}

/* ------------------------- Modelos / conexão ------------------------- */

/**
 * Lista os modelos disponíveis no provedor (com cache de 30s).
 * Retorna null se falhar.
 */
export async function fetchModels(provider: Provider, force = false): Promise<any[] | null> {
  const cached = modelsCache.get(provider.id);
  if (!force && cached && Date.now() - cached.ts < MODELS_TTL) {
    return cached.models;
  }
  try {
    const models = await fetchModelsFrom(provider.baseUrl, provider.apiKey, 5000);
    modelsCache.set(provider.id, { models, ts: Date.now() });
    return models;
  } catch {
    return null;
  }
}

/** Limpa o cache de modelos (ex.: após editar um provedor). */
export function clearModelsCache(providerId?: string): void {
  if (providerId) modelsCache.delete(providerId);
  else modelsCache.clear();
}

export interface ConnectionTestResult {
  ok: boolean;
  baseUrl: string;
  models?: string[];
  error?: string;
}

export async function testProviderConnection(
  baseUrl?: string,
  apiKey?: string,
  timeoutMs = 5000,
  type: ProviderType = 'openai-compatible'
): Promise<ConnectionTestResult> {
  const url = (baseUrl || '').replace(/\/+$/, '');
  try {
    if (isAdapterType(type)) {
      const provider: Provider = {
        id: 'test',
        name: 'Test',
        type,
        baseUrl: url || defaultBaseUrl(type),
        apiKey: apiKey || '',
        model: '',
        enabled: true,
      };
      const models = await fetchProviderModels(provider);
      if (!models) {
        return {
          ok: false,
          baseUrl: provider.baseUrl,
          error: 'Não foi possível listar modelos (verifique Base URL e API Key).',
        };
      }
      return { ok: true, baseUrl: provider.baseUrl, models: models.map((m: any) => m.id) };
    }
    const models = await fetchModelsFrom(url, apiKey || '', timeoutMs);
    return { ok: true, baseUrl: url, models: models.map((m: any) => m.id) };
  } catch (e: any) {
    return { ok: false, baseUrl: url, error: e?.message || String(e) };
  }
}

async function fetchModelsFrom(baseUrl: string, apiKey: string, timeoutMs: number): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const data: any = await resp.json();
    if (Array.isArray(data?.data)) {
      return data.data.map((m: any) => ({ ...m, id: normalizeModelId(m.id) }));
    }
    if (Array.isArray(data?.models)) {
      return data.models.map((m: any) => ({
        id: normalizeModelId(m.name || m.model || String(m)),
        object: 'model',
        owned_by: 'local',
      }));
    }
    throw new Error('Resposta inválida (sem lista de modelos)');
  } finally {
    clearTimeout(timer);
  }
}
