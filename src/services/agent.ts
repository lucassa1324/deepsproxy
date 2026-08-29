/*
 * File: agent.ts
 * Project: deepsproxy
 * Modo agente nativo do proxy: executa as tools registradas no registry
 * (ex.: web_search) num loop agêntico server-side, sem depender da IDE.
 *
 * Ativação: campo `"agent": true` no corpo do /v1/chat/completions.
 * Provedores suportados: adapters (gemini/anthropic/ollama) e provedores
 * OpenAI-compatíveis via HTTP. Provedores "browser" (deepseek/qwen) não
 * suportam o loop agêntico — respondem 400.
 *
 * O loop é o mesmo `runExecutionLoop` do executor: envia para o LLM, parseia
 * tool calls (estruturados ou tags <tool_call>), executa via registry e
 * re-envia com os resultados até o modelo responder texto final.
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { runExecutionLoop, parseToolCallsFromContent } from '../tools/executor.ts';
import type { LLMResponse } from '../tools/executor.ts';
import { registry } from '../tools/registry.ts';
import type { ParsedToolCall, FunctionToolDefinition, JsonSchema } from '../tools/types.ts';
import type { OpenAIRequest } from '../utils/types.ts';
import type { Provider } from './config.ts';
import { dispatchAdapterChat, isAdapterProvider } from './adapters/index.ts';
import { startKeepAlive } from '../utils/sse.ts';
import { isModelBoosted } from './booster.ts';

const LLM_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 6;

export interface AgentRunResult {
  content: string;
  reasoning: string;
  turns: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ServerToolInfo {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** True quando o provedor pode rodar o loop agêntico (HTTP, OpenAI-format). */
export function isServerAgentSupported(provider: Provider): boolean {
  if (isAdapterProvider(provider)) return true;
  return provider.type === 'openai-compatible' && !!provider.baseUrl;
}

/** Lista as tools que o proxy executa nativamente (registry). */
export function listServerTools(): ServerToolInfo[] {
  return registry.listNames().map((name) => {
    const t = registry.get(name)!;
    return { name: t.name, description: t.description, parameters: t.parameters };
  });
}

/** Remove campos OpenAI-specific (strict/additionalProperties) p/ compatibilidade. */
function stripAdditionalProperties(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripAdditionalProperties);
  const out: any = {};
  for (const key of Object.keys(node)) {
    if (key === 'additionalProperties') continue;
    out[key] = stripAdditionalProperties(node[key]);
  }
  return out;
}

function sanitizeServerTools(tools: FunctionToolDefinition[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: stripAdditionalProperties(t.function.parameters),
    },
  }));
}

function parseArgs(raw: any): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return { value: raw };
    }
  }
  if (raw && typeof raw === 'object') return raw;
  return {};
}

/** Converte a resposta OpenAI do upstream em LLMResponse do executor. */
function toLLMResponse(data: any): { resp: LLMResponse; reasoning: string; usage: any } {
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  let content: string | null = typeof msg.content === 'string' ? msg.content : null;
  let toolCalls: ParsedToolCall[] = [];

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    toolCalls = msg.tool_calls.map((tc: any) => ({
      id: tc.id || 'call_' + uuidv4(),
      name: tc.function?.name || '',
      arguments: parseArgs(tc.function?.arguments),
    }));
  } else if (content) {
    const parsed = parseToolCallsFromContent(content);
    content = parsed.textContent || null;
    toolCalls = parsed.toolCalls;
  }

  const finishReason = choice?.finish_reason || (toolCalls.length > 0 ? 'tool_calls' : 'stop');
  return { resp: { content, toolCalls, finishReason }, reasoning, usage: data?.usage };
}

async function sendTurn(
  messages: unknown[],
  tools: FunctionToolDefinition[] | undefined,
  model: string,
  provider: Provider,
  baseBody: OpenAIRequest
): Promise<{ resp: LLMResponse; reasoning: string; usage: any }> {
  const payload: any = { ...baseBody, model, messages, stream: false };
  delete payload.agent;
  delete payload._eco;
  if (tools && tools.length > 0) {
    payload.tools = sanitizeServerTools(tools);
  } else {
    delete payload.tools;
  }
  delete payload.tool_choice;

  if (isAdapterProvider(provider)) {
    const resp = await dispatchAdapterChat(payload, provider);
    if (!resp) throw new Error('Falha ao chamar o adapter do provedor.');
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`LLM ${provider.name} respondeu ${resp.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    const data = await resp.json();
    return toLLMResponse(data);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (provider.apiKey) headers['authorization'] = `Bearer ${provider.apiKey}`;
    const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`LLM ${provider.name} respondeu ${resp.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    const data = await resp.json();
    return toLLMResponse(data);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Roda o loop agêntico completo. Retorna a resposta final (texto), o
 * raciocínio acumulado, o número de turnos e o uso de tokens somado.
 * Lança erro quando o provedor não suporta ou o loop estourar maxTurns.
 */
export async function runServerAgent(
  baseBody: OpenAIRequest,
  provider: Provider,
  opts: { maxTurns?: number; debug?: boolean } = {}
): Promise<AgentRunResult> {
  if (!isServerAgentSupported(provider)) {
    throw new Error(
      `Modo agente não é suportado para o provedor do tipo "${provider.type}". Use Gemini, Anthropic ou OpenAI-compatível via HTTP.`
    );
  }
  if (registry.listNames().length === 0) {
    throw new Error('Nenhuma tool de servidor registrada (registry vazio).');
  }

  let turns = 0;
  let reasoning = '';
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const messages: unknown[] = [...(baseBody.messages || [])];
  
  // Injeta workspaceRoot na primeira mensagem se não estiver presente
  if (messages.length > 0 && (baseBody as any).workspaceRoot) {
    messages[0] = {
      ...messages[0] as Record<string, unknown>,
      workspaceRoot: (baseBody as any).workspaceRoot,
    };
  }

  const content = await runExecutionLoop(
    async (msgs, toolsArr, model) => {
      turns++;
      const { resp, reasoning: r, usage: u } = await sendTurn(
        msgs,
        toolsArr as FunctionToolDefinition[] | undefined,
        model,
        provider,
        baseBody
      );
      if (r) reasoning += (reasoning ? '\n\n' : '') + r;
      if (u) {
        usage.prompt_tokens += Number(u.prompt_tokens) || 0;
        usage.completion_tokens += Number(u.completion_tokens) || 0;
        usage.total_tokens +=
          Number(u.total_tokens) || Number(u.prompt_tokens) + Number(u.completion_tokens) || 0;
      }
      return resp;
    },
    messages,
    baseBody.model,
    { maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS, debug: opts.debug, booster: isModelBoosted(baseBody.model) }
  );

  return { content: content || '', reasoning, turns, usage };
}

/**
 * Monta a resposta final ao cliente (JSON único ou SSE), após o loop agêntico.
 */
export function respondAgentResult(c: Context, body: OpenAIRequest, result: AgentRunResult) {
  const isStream = body.stream ?? false;
  const completionId = 'chatcmpl-' + uuidv4();
  const created = Math.floor(Date.now() / 1000);
  const usage = {
    prompt_tokens: result.usage.prompt_tokens,
    completion_tokens: result.usage.completion_tokens,
    total_tokens: result.usage.total_tokens,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  const toolNames = listServerTools().map((t) => t.name);

  if (!isStream) {
    const message: any = { role: 'assistant', content: result.content || null };
    if (result.reasoning) message.reasoning_content = result.reasoning;
    return c.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model: body.model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: 'stop' }],
      usage,
      agent: { turns: result.turns, tools: toolNames },
    });
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return honoStream(c, async (streamWriter: any) => {
    const writeEvent = (data: any) => streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
    const chunkObj = (delta: any) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
    });

    const stopKeepAlive = startKeepAlive((chunk) => streamWriter.write(chunk));

    await writeEvent(chunkObj({ role: 'assistant', content: '' }));

    if (result.reasoning) {
      for (let i = 0; i < result.reasoning.length; i += 120) {
        await writeEvent(chunkObj({ reasoning_content: result.reasoning.slice(i, i + 120) }));
      }
    }
    for (let i = 0; i < result.content.length; i += 160) {
      await writeEvent(chunkObj({ content: result.content.slice(i, i + 160) }));
    }

    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
      usage,
      agent: { turns: result.turns, tools: toolNames },
    });
    await streamWriter.write('data: [DONE]\n\n');
    stopKeepAlive();
  });
}
