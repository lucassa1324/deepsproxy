/*
 * File: qwen.ts
 * Project: deepsproxy
 * Handler de chat do Qwen (portado do qwenproxy — autor: Pedro Farias).
 * Recebe o corpo OpenAI-compatível já parseado pelo roteador e responde via
 * streaming (SSE) ou JSON único, com suporte a raciocínio e tool calls.
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createQwenStream, updateSessionParent } from '../services/qwen.ts';
import { OpenAIRequest } from '../utils/types.ts';
import { buildAgentPrompt } from '../utils/prompt.ts';
import { injectHighPrecisionProtocol } from '../utils/system-prompt.ts';
import { robustParseJSON } from '../utils/robust-json.ts';
import { isModelBoosted } from '../services/booster.ts';
import { StreamingToolParser } from '../tools/stream-parser.ts';
import { startKeepAlive } from '../utils/sse.ts';
import {
  getWorkspaceRootFromContext,
  sanitizeToolCallArguments,
} from '../services/relay-path.ts';

function getIncrementalDelta(oldStr: string, newStr: string): string {
  if (!oldStr) return newStr;
  if (newStr === oldStr) return '';
  if (newStr.startsWith(oldStr)) return newStr.substring(oldStr.length);
  // If it doesn't start with oldStr, assume it's a delta
  return newStr;
}

export interface QwenAccumulated {
  reasoning: string;
  content: string;
  completionTokens: number;
  messageId: string | null;
}

/**
 * Lê o stream do Qwen e acumula raciocínio/conteúdo/tokens — usado para a
 * resposta em JSON único quando o cliente pede `stream: false`.
 */
async function consumeQwenStream(stream: ReadableStream): Promise<QwenAccumulated> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentThoughtIndex = 0;
  let lastFullContent = '';
  const acc: QwenAccumulated = { reasoning: '', content: '', completionTokens: 0, messageId: null };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);

        if (chunk['response.created'] && chunk['response.created'].response_id) {
          acc.messageId = chunk['response.created'].response_id;
        } else if (chunk.response_id) {
          acc.messageId = chunk.response_id;
        }

        if (chunk.usage && chunk.usage.output_tokens) {
          acc.completionTokens = chunk.usage.output_tokens;
        }

        if (!chunk.choices || !chunk.choices[0] || !chunk.choices[0].delta) continue;
        const delta = chunk.choices[0].delta;

        if (delta.phase === 'thinking_summary') {
          if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
            const thoughts = delta.extra.summary_thought.content;
            if (thoughts.length > currentThoughtIndex) {
              acc.reasoning += thoughts.slice(currentThoughtIndex).join('\n');
              currentThoughtIndex = thoughts.length;
            }
          }
        } else if (delta.phase === 'answer') {
          if (delta.content !== undefined) {
            const newContent = delta.content || '';
            const vStr = getIncrementalDelta(lastFullContent, newContent);
            if (vStr) {
              lastFullContent += vStr;
              acc.content += vStr;
            }
          }
        }
      } catch (e) {
        // parse error, ignore partial chunk
      }
    }
  }

  return acc;
}

async function handleQwenNonStreaming(
  c: Context,
  body: OpenAIRequest,
  finalPrompt: string,
  isThinkingModel: boolean,
  isNewSession: boolean
) {
  let result: { stream: ReadableStream; headers: Record<string, string>; uiSessionId: string };
  let retries = 3;
  while (retries > 0) {
    try {
      result = await createQwenStream(finalPrompt, isThinkingModel, body.model, isNewSession ? null : undefined);
      break;
    } catch (err: any) {
      retries--;
      if (retries === 0) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const acc = await consumeQwenStream(result!.stream);
  if (acc.messageId) updateSessionParent(result!.uiSessionId, acc.messageId);

  // Extrai tool calls do conteúdo acumulado (mesma sintaxe <tool_call>).
  let textContent = acc.content;
  let toolCalls: any[] = [];
  let contentTail = acc.content;
  const extracted: any[] = [];
  while (true) {
    const startIdx = contentTail.indexOf('<tool_call>');
    if (startIdx === -1) {
      textContent = acc.content;
      break;
    }
    const endIdx = contentTail.indexOf('</tool_call>', startIdx);
    if (endIdx === -1) break;
    const jsonStr = contentTail.substring(startIdx + '<tool_call>'.length, endIdx).trim();
    contentTail = contentTail.substring(endIdx + '</tool_call>'.length);
    try {
      const obj = robustParseJSON(jsonStr);
      if (obj) {
        extracted.push({
          id: 'call_' + uuidv4(),
          name: obj.name || '',
          arguments: typeof obj.arguments === 'string'
            ? JSON.parse(obj.arguments)
            : (obj.arguments || {}),
        });
      }
    } catch (e) {
      // ignora tool call malformada
    }
  }
  toolCalls = extracted;
  if (toolCalls.length > 0) {
    textContent = acc.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
  }

  const promptTokens = Math.ceil(finalPrompt.length / 3.5);

  const message: any = {
    role: 'assistant',
    content: toolCalls.length > 0 ? (textContent || null) : textContent,
  };
  if (acc.reasoning) {
    message.reasoning_content = acc.reasoning;
  }
  if (toolCalls.length > 0) {
    // Camada de Relay: sanitiza caminhos (relativo -> absoluto via
    // x-workspace-root; '\' -> '/') antes de entregar a Tool Call à IDE.
    const relayWorkspaceRoot = getWorkspaceRootFromContext(c, body);
    message.tool_calls = toolCalls.map((tc) => {
      const safeArgs = sanitizeToolCallArguments(tc.name, tc.arguments, relayWorkspaceRoot);
      return {
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof safeArgs === 'string' ? safeArgs : JSON.stringify(safeArgs),
        },
      };
    });
  }

  const completionId = 'chatcmpl-' + uuidv4();
  const created = Math.floor(Date.now() / 1000);

  return c.json({
    id: completionId,
    object: 'chat.completion',
    created,
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: acc.completionTokens,
      total_tokens: promptTokens + acc.completionTokens,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
}

/**
 * Handler principal de chat do Qwen. `body` já vem parseado pelo roteador
 * (routes/chat.ts), que decidiu enviar a requisição para o backend Qwen.
 */
export async function qwenChatCompletions(c: Context, body: OpenAIRequest) {
  const startedAt = Date.now();
  try {
    const isStream = body.stream ?? false;
    const messages = body.messages || [];

    let finalPrompt = buildAgentPrompt(body, { booster: isModelBoosted(body.model) });
    // HIGH-PRECISION AGENT PROTOCOL já injetado dentro de buildAgentPrompt
    const isThinkingModel = !body.model.includes('no-thinking');

    // A session is new if it doesn't have any assistant messages yet.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    console.log(
      `[qwen] request model=${body.model} stream=${isStream ? 'yes' : 'no'} messages=${messages.length} promptChars=${finalPrompt.length}`
    );

    if (!isStream) {
      return handleQwenNonStreaming(c, body, finalPrompt, isThinkingModel, isNewSession);
    }

    // Empty response retry logic
    let stream: ReadableStream;
    let uiSessionId = '';
    let retries = 3;
    while (retries > 0) {
      try {
        const result = await createQwenStream(finalPrompt, isThinkingModel, body.model, isNewSession ? null : undefined);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break; // Success
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const completionId = 'chatcmpl-' + uuidv4();

    // Raiz do workspace (header 'x-workspace-root' ou body) para sanitização
    // dos caminhos dos tool_calls emitidos no SSE (relay puro, sem I/O local).
    const relayWorkspaceRoot = getWorkspaceRootFromContext(c, body);

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Mantém a conexão viva enquanto o modelo "pensa" (comentário SSE ignorado pelo cliente).
      const stopKeepAlive = startKeepAlive((chunk) => streamWriter.write(chunk));

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      // Send initial chunk
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let currentThoughtIndex = 0;
      let lastFullContent = '';
      const toolParser = new StreamingToolParser();

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            await streamWriter.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);

            // Extract response_id for session tracking
            if (chunk['response.created'] && chunk['response.created'].response_id) {
              updateSessionParent(uiSessionId, chunk['response.created'].response_id);
            } else if (chunk.response_id) {
              updateSessionParent(uiSessionId, chunk.response_id);
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
              const delta = chunk.choices[0].delta;

              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  vStr = getIncrementalDelta(lastFullContent, newContent);

                  if (vStr) {
                    lastFullContent += vStr;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;

              if (isThinkingChunk) {
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: vStr })]
                });
              } else {
                const { text, toolCalls } = toolParser.feed(vStr);

                if (text) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ content: text })]
                  });
                }

                for (const tc of toolCalls) {
                  const safeArgs = sanitizeToolCallArguments(tc.name, tc.arguments, relayWorkspaceRoot);
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({
                      tool_calls: [{
                        index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                        id: tc.id,
                        type: 'function',
                        function: {
                          name: tc.name,
                          arguments: typeof safeArgs === 'string' ? safeArgs : JSON.stringify(safeArgs)
                        }
                      }]
                    })]
                  });
                }
              }
            }
          } catch (e) {
            // parse error, ignore partial chunk
          }
        }
      }

      // Flush tool parser
      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: remainingText })]
        });
      }
      for (const tc of remainingToolCalls) {
        const safeArgs = sanitizeToolCallArguments(tc.name, tc.arguments, relayWorkspaceRoot);
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: typeof safeArgs === 'string' ? safeArgs : JSON.stringify(safeArgs)
              }
            }]
          })]
        });
      }

      // Send finish reason
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        usage: usage
      });
      await streamWriter.write('data: [DONE]\n\n');

      stopKeepAlive();

      console.log(
        `[qwen] done model=${body.model} ${Date.now() - startedAt}ms tokens=${completionTokens + promptTokens} finish=${finalFinishReason}`
      );
    });
  } catch (err: any) {
    console.error('Error in qwen chatCompletions:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
