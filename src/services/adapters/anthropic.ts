/*
 * File: anthropic.ts
 * Project: deepsproxy
 * Adapter para a Messages API do Anthropic (Claude). Traduz o payload OpenAI
 * ↔ Anthropic REST, com streaming (SSE), tools nativos (tool_use/tool_result)
 * e retry 429/5xx.
 */

import { v4 as uuidv4 } from 'uuid';
import type { OpenAIRequest, Message } from '../../utils/types.ts';
import type { Provider } from '../config.ts';
import { getActiveApiKey } from '../config.ts';
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
import { withRetry, HttpError } from './throttle.ts';
import { optimizedFetch } from '../optimizations.ts';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

/* ------------------------- OpenAI → Anthropic ------------------------- */

function contentToBlocks(content: any, role: string): any[] {
  if (role === 'tool') {
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p: any) => p?.text || '').join('')
          : String(content || '');
    return [{ type: 'text', text }];
  }
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return content ? [{ type: 'text', text: String(content) }] : [];
  }
  const blocks: any[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text) {
      blocks.push({ type: 'text', text: p.text });
    } else if (p.type === 'image_url') {
      const url = p.image_url?.url || '';
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(url);
      if (m) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] },
        });
      } else {
        blocks.push({ type: 'text', text: `[imagem: ${url}]` });
      }
    }
  }
  return blocks;
}

export function toAnthropicMessages(payload: OpenAIRequest): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  const messages: any[] = [];

  for (const msg of payload.messages || []) {
    if (msg.role === 'system') {
      const text = Array.isArray(msg.content)
        ? msg.content.map((p: any) => (p?.type === 'text' ? p.text : '')).join('\n')
        : String(msg.content || '');
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool' || msg.role === 'function') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p: any) => p?.text || '').join('')
            : String(msg.content || '');
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || 'call_' + uuidv4().slice(0, 8), content: text || '' }],
      });
      continue;
    }

    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks = contentToBlocks(msg.content, role);
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input: any = {};
        try {
          input =
            typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments || {};
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id || 'call_' + uuidv4().slice(0, 8),
          name: tc.function?.name || '',
          input,
        });
      }
    }
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: ' ' });
    }
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }

  // Anthropic exige alternância user/assistant começando por user. Se o
  // histórico começa com assistant, prefixa um turno vazio de user.
  if (messages.length && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  }

  return { system: systemParts.join('\n\n'), messages };
}

function toAnthropicTools(payload: OpenAIRequest): any[] {
  return (payload.tools || [])
    .filter((t: any) => t && t.type === 'function')
    .map((t: any) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters || { type: 'object', properties: {} },
    }));
}

function toAnthropicToolChoice(payload: OpenAIRequest): any {
  const choice: any = payload.tool_choice;
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return undefined;
  if (choice && typeof choice === 'object' && choice.function?.name) {
    return { type: 'tool', name: choice.function.name };
  }
  return undefined;
}

/* ------------------------- Anthropic → OpenAI ------------------------- */

const STOP_MAP: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  pause_turn: 'stop',
};

function usageFromAnthropic(usage: any): any {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: usage?.cache_read_input_tokens ?? 0 },
  };
}

export function fromAnthropicResponse(data: any, model: string): any {
  const message: any = { role: 'assistant', content: null };
  const toolCalls: any[] = [];
  const texts: string[] = [];
  for (const block of data?.content || []) {
    if (block?.type === 'text') texts.push(block.text);
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id || 'call_' + uuidv4().slice(0, 8),
        type: 'function',
        function: { name: block.name || '', arguments: JSON.stringify(block.input || {}) },
      });
    }
  }
  if (toolCalls.length) {
    message.content = texts.join('') || null;
    message.tool_calls = toolCalls;
  } else {
    message.content = texts.join('') || null;
  }
  const finish = toolCalls.length ? 'tool_calls' : STOP_MAP[data?.stop_reason] || 'stop';
  return {
    id: completionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
    usage: usageFromAnthropic(data?.usage),
  };
}

/* ------------------------- Adapter ------------------------- */

export class AnthropicAdapter implements ProviderAdapter {
  async chatCompletion(payload: OpenAIRequest, provider: Provider, apiKey?: string): Promise<Response> {
    const isStream = payload.stream ?? false;
    const model = payload.model;
    const resolvedKey = apiKey ?? getActiveApiKey(provider);
    if (!resolvedKey) {
      return openaiError(400, 'Anthropic: API Key não configurada para este provedor.');
    }
    const baseUrl = (provider.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const { system, messages } = toAnthropicMessages(payload);
    const wantCache = !!(payload as any)._eco?.cachePrefix;

    const body: any = {
      model,
      max_tokens: (payload as any).max_tokens ?? DEFAULT_MAX_TOKENS,
      stream: isStream,
      messages,
    };
    if (system) {
      // cache_control exige system como array de blocos e um breakpoint no
      // primeiro content block da primeira mensagem (modo economia de tokens).
      body.system = wantCache
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system;
    }
    if (wantCache && Array.isArray(messages) && messages.length) {
      const first = messages[0];
      if (first?.content && Array.isArray(first.content) && first.content.length && !first.content[0].cache_control) {
        first.content[0].cache_control = { type: 'ephemeral' };
      }
    }
    if ((payload as any).temperature !== undefined) body.temperature = (payload as any).temperature;
    if ((payload as any).top_p !== undefined) body.top_p = (payload as any).top_p;
    if (payload.tools?.length) {
      body.tools = toAnthropicTools(payload);
      const tc = toAnthropicToolChoice(payload);
      if (tc) body.tool_choice = tc;
    }

    const url = `${baseUrl}/messages`;
    const doFetch = () =>
      withRetry(async () => {
        const res = await optimizedFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': resolvedKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new HttpError(res.status, `Anthropic ${res.status}: ${errText.slice(0, 300)}`, errText);
        }
        return res;
      }, { retries: 3, retryOn: (s) => s >= 500 });

    if (!isStream) {
      let res: Response;
      try {
        res = await doFetch();
      } catch (err: any) {
        return adapterHttpErrorResponse(err, 'Anthropic', false);
      }
      const data = await res.json();
      if (data?.error) {
        return openaiError(
          400,
          `Anthropic: ${data.error.message || data.error.type || 'erro desconhecido'}`
        );
      }
      return jsonResponse(fromAnthropicResponse(data, model));
    }

    let res: Response;
    try {
      res = await doFetch();
    } catch (err: any) {
      return adapterHttpErrorResponse(err, 'Anthropic', true);
    }
    const completion = completionId();
    return sseResponse(async (writeEvent) => {
      await writeEvent(openaiChunk(completion, model, { role: 'assistant', content: '' }));
      let usage: any = null;
      let finishReason: string | null = null;
      // tool calls em construção (índice do content block → dados)
      const toolBuf = new Map<number, { id: string; name: string; json: string }>();

      for await (const ev of readSse(res.body)) {
        if (ev?.type === 'message_start') {
          if (ev.message?.usage) usage = ev.message.usage;
          continue;
        }
        if (ev?.type === 'content_block_start') {
          const block = ev.content_block || {};
          if (block.type === 'tool_use') {
            toolBuf.set(ev.index, { id: block.id || '', name: block.name || '', json: '' });
          }
          continue;
        }
        if (ev?.type === 'content_block_delta') {
          const delta = ev.delta || {};
          if (delta.type === 'text_delta') {
            await writeEvent(openaiChunk(completion, model, { content: delta.text || '' }));
          } else if (delta.type === 'input_json_delta') {
            const cur = toolBuf.get(ev.index);
            if (cur) {
              cur.json += delta.partial_json || '';
              // OpenAI espera arguments incrementais; o partial_json do
              // Anthropic já vem como delta do JSON a ser acumulado.
              await writeEvent(
                openaiChunk(completion, model, {
                  tool_calls: [
                    {
                      index: ev.index,
                      id: cur.id,
                      type: 'function',
                      function: { name: cur.name, arguments: delta.partial_json || '' },
                    },
                  ],
                })
              );
            }
          }
          continue;
        }
        if (ev?.type === 'message_delta') {
          if (ev.usage) usage = ev.usage;
          const reason = ev.delta?.stop_reason;
          if (reason) finishReason = STOP_MAP[reason] || 'stop';
        }
      }

      const hadTools = toolBuf.size > 0;
      await writeEvent(
        openaiChunk(completion, model, {}, { usage: usageFromAnthropic(usage), finishReason: hadTools ? (finishReason || 'tool_calls') : finishReason })
      );
    });
  }

  async fetchModels(): Promise<any[] | null> {
    // A API do Anthropic não expõe um endpoint público de listagem de modelos.
    return null;
  }
}
