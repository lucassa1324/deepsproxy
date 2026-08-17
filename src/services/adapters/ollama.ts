/*
 * File: ollama.ts
 * Project: deepsproxy
 * Adapter para o Ollama (/api/chat, NDJSON). Sem API key. Quando o request
 * traz tools, usa o fallback agentic (<tool_call>) do projeto, pois o Ollama
 * não expõe function-calling confiável entre versões.
 */

import { v4 as uuidv4 } from 'uuid';
import type { OpenAIRequest } from '../../utils/types.ts';
import type { Provider } from '../config.ts';
import {
  ProviderAdapter,
  jsonResponse,
  openaiError,
  openaiChunk,
  sseResponse,
  completionId,
  adapterHttpErrorResponse,
} from './base.ts';
import { withRetry, HttpError } from './throttle.ts';
import { buildAgentPrompt } from '../../utils/prompt.ts';
import { isModelBoosted } from '../booster.ts';
import { parseToolCallsFromContent } from '../../tools/executor.ts';
import { StreamingToolParser } from '../../tools/stream-parser.ts';
import { optimizedFetch } from '../optimizations.ts';

const DEFAULT_BASE = 'http://localhost:11434';

function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (!p || typeof p !== 'object') return String(p ?? '');
        if (p.type === 'image_url') {
          return p.image_url?.url?.startsWith('data:') ? '[imagem anexada]' : `[imagem: ${p.image_url?.url}]`;
        }
        return p.text || '';
      })
      .join('\n');
  }
  return String(content || '');
}

function collectImages(content: any): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images: string[] = [];
  for (const p of content) {
    const url = p?.type === 'image_url' ? p.image_url?.url : undefined;
    if (typeof url !== 'string') continue;
    const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(url);
    if (m) images.push(m[1]);
  }
  return images.length ? images : undefined;
}

function toOllamaMessages(payload: OpenAIRequest): any[] {
  return (payload.messages || []).map((msg) => {
    const out: any = { role: msg.role, content: contentToText(msg.content) };
    const images = collectImages(msg.content);
    if (images) out.images = images;
    return out;
  });
}

function buildOllamaBody(payload: OpenAIRequest, messages: any[]): any {
  const body: any = { model: payload.model, messages, stream: payload.stream ?? false, options: {} };
  const anyPayload = payload as any;
  if (anyPayload.temperature !== undefined) body.options.temperature = anyPayload.temperature;
  if (anyPayload.top_p !== undefined) body.options.top_p = anyPayload.top_p;
  if (anyPayload.max_tokens !== undefined) body.options.num_predict = anyPayload.max_tokens;
  if (Object.keys(body.options).length === 0) delete body.options;
  return body;
}

export function fromOllamaResponse(data: any, model: string): any {
  const text = data?.message?.content || '';
  const { textContent, toolCalls } = parseToolCallsFromContent(text);
  const message: any = {
    role: 'assistant',
    content: toolCalls.length ? textContent || null : textContent,
  };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc: any) => ({
      id: tc.id || 'call_' + uuidv4().slice(0, 8),
      type: 'function',
      function: {
        name: tc.name,
        arguments:
          typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
      },
    }));
  }
  const prompt = data?.prompt_eval_count ?? 0;
  const completion = data?.eval_count ?? 0;
  return {
    id: completionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: toolCalls.length ? 'tool_calls' : data?.done_reason ? 'stop' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

export class OllamaAdapter implements ProviderAdapter {
  async chatCompletion(payload: OpenAIRequest, provider: Provider): Promise<Response> {
    const isStream = payload.stream ?? false;
    const model = payload.model;
    const baseUrl = (provider.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const hasTools = !!(payload.tools && payload.tools.length);

    // Com tools: fallback agentic — a resposta sai como texto com blocos
    // <tool_call>; o agente real é o executor de ferramentas da API.
    const messages = hasTools
      ? [{ role: 'user', content: buildAgentPrompt(payload, { booster: isModelBoosted(payload.model) }) }]
      : toOllamaMessages(payload);

    const body = buildOllamaBody(payload, messages);
    const doFetch = () =>
      withRetry(async () => {
        const res = await optimizedFetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new HttpError(res.status, `Ollama ${res.status}: ${errText.slice(0, 300)}`, errText);
        }
        return res;
      }, { retries: 3 });

    if (!isStream) {
      let res: Response;
      try {
        res = await doFetch();
      } catch (err: any) {
        return adapterHttpErrorResponse(err, 'Ollama', false);
      }
      const data = await res.json();
      if (data?.error) {
        return openaiError(400, `Ollama: ${data.error}`);
      }
      return jsonResponse(fromOllamaResponse(data, model));
    }

    let res: Response;
    try {
      res = await doFetch();
    } catch (err: any) {
      return adapterHttpErrorResponse(err, 'Ollama', true);
    }
    const completion = completionId();
    return sseResponse(async (writeEvent) => {
      await writeEvent(openaiChunk(completion, model, { role: 'assistant', content: '' }));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let promptTokens = 0;
      let completionTokens = 0;
      let doneReason = 'stop';
      const toolParser = hasTools ? new StreamingToolParser() : null;

      const readLine = async (): Promise<any | null> => {
        while (true) {
          const nl = buffer.indexOf('\n');
          if (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
              return JSON.parse(line);
            } catch {
              continue;
            }
          }
          const { done, value } = await reader.read();
          if (done) {
            const line = buffer.trim();
            buffer = '';
            if (!line) return null;
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          }
          buffer += decoder.decode(value, { stream: true });
        }
      };

      try {
        while (true) {
          const item = await readLine();
          if (!item) break;
          if (item.prompt_eval_count) promptTokens = item.prompt_eval_count;
          if (item.eval_count) completionTokens = item.eval_count;
          if (item.done_reason) doneReason = item.done_reason;
          const text = item?.message?.content || '';
          if (!text) continue;
          if (toolParser) {
            const { text: outText, toolCalls } = toolParser.feed(text);
            if (outText) await writeEvent(openaiChunk(completion, model, { content: outText }));
            for (const tc of toolCalls) {
              await writeEvent(
                openaiChunk(completion, model, {
                  tool_calls: [
                    {
                      index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                    },
                  ],
                })
              );
            }
          } else {
            await writeEvent(openaiChunk(completion, model, { content: text }));
          }
        }

        let finishReason: string = 'stop';
        if (toolParser) {
          const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
          if (remainingText) {
            await writeEvent(openaiChunk(completion, model, { content: remainingText }));
          }
          for (const tc of remainingToolCalls) {
            await writeEvent(
              openaiChunk(completion, model, {
                tool_calls: [
                  {
                    index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                  },
                ],
              })
            );
          }
          finishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : doneReason === 'stop' ? 'stop' : 'length';
        }

        await writeEvent(
          openaiChunk(completion, model, {}, {
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
              prompt_tokens_details: { cached_tokens: 0 },
            },
            finishReason,
          })
        );
      } finally {
        reader.releaseLock();
      }
    });
  }

  async fetchModels(provider: Provider): Promise<any[] | null> {
    const baseUrl = (provider.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    try {
      const res = await optimizedFetch(`${baseUrl}/api/tags`);
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!Array.isArray(data?.models)) return null;
      return data.models.map((m: any) => ({
        id: m.name,
        object: 'model',
        owned_by: 'ollama',
        label: undefined,
      }));
    } catch {
      return null;
    }
  }
}
