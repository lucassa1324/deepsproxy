/*
 * File: chat.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { uploadDeepSeekImages, prepareDeepSeekVisionFiles, DeepSeekImageInput } from '../services/playwright.ts';
import { forwardChatCompletions, findProviderForModel, isDeepseekModel } from '../services/local.ts';
import { isQwenModel } from '../services/qwen.ts';
import { qwenChatCompletions } from './qwen.ts';
import {
  resolveRegistry,
  resolveActiveProvider,
  enabledProviders,
  isDeepseekProvider,
  isQwenProvider,
} from '../services/config.ts';
import type { Provider } from '../services/config.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { buildAgentPrompt } from '../utils/prompt.ts';
import { parseToolCallsFromContent } from '../tools/executor.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';

interface DeepSeekAccumulated {
  reasoning: string;
  content: string;
  completionTokens: number;
  messageId: number | null;
}

const STREAM_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Lê o stream SSE do backend DeepSeek e acumula raciocínio, conteúdo e
 * tokens — mesmo parsing usado no streaming, mas sem emitir chunks. Usado
 * para responder em JSON único quando o cliente pede `stream: false`.
 */
async function consumeDeepSeekStream(stream: ReadableStream, debug = false): Promise<DeepSeekAccumulated> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentAppendPath = '';
  let timedOut = false;
  const acc: DeepSeekAccumulated = { reasoning: '', content: '', completionTokens: 0, messageId: null };

  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, STREAM_TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || timedOut) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;
        if (debug) console.log('[ds-image]', dataStr);

        try {
          const chunk = JSON.parse(dataStr);

          let dsMessageId: any = null;
          if (chunk.p === 'response/message' && chunk.v && typeof chunk.v === 'object' && typeof chunk.v.id === 'number') {
            dsMessageId = chunk.v.id;
          } else if (chunk.response_message_id) {
            dsMessageId = chunk.response_message_id;
          } else if (chunk.v && typeof chunk.v === 'object') {
            if (chunk.v.response && chunk.v.response.message_id) {
              dsMessageId = chunk.v.response.message_id;
            } else if (chunk.v.message_id) {
              dsMessageId = chunk.v.message_id;
            }
          } else if (chunk.message_id) {
            dsMessageId = chunk.message_id;
          }
          if (dsMessageId) acc.messageId = dsMessageId;

          let vStr = '';
          let foundStr = false;
          let isThinkingChunk = false;

          if (typeof chunk.p === 'string') {
            currentAppendPath = chunk.p;
            if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
              acc.completionTokens = chunk.v;
            }
          }

          if (typeof chunk.v === 'string') {
            vStr = chunk.v;
            foundStr = true;
          } else if (chunk.v && typeof chunk.v === 'object') {
            if (chunk.v.response && chunk.v.response.fragments && chunk.v.response.fragments.length > 0) {
              const frag = chunk.v.response.fragments[0];
              if (typeof frag.content === 'string') {
                vStr = frag.content;
                foundStr = true;
                currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              }
            } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
              const firstObj = chunk.v[0];
              if (typeof firstObj.content === 'string') {
                vStr = firstObj.content;
                foundStr = true;
                currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
              }
            }
          }

          if (currentAppendPath.includes('thinking_content') || currentAppendPath.includes('THINK')) {
            isThinkingChunk = true;
          }

          if (foundStr && vStr !== '') {
            if (vStr === 'FINISHED') continue;
            if (isThinkingChunk) {
              acc.reasoning += vStr;
            } else {
              acc.content += vStr;
            }
          }
        } catch (e) {
          // parse error, ignore partial chunk
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    console.warn(`[ds-image] stream DeepSeek nao terminou em ${STREAM_TIMEOUT_MS / 1000}s; devolvendo resposta parcial (${acc.content.length} chars)`);
  }

  return acc;
}

/**
 * Extrai as imagens base64 (data: URLs) das mensagens para enviar à DeepSeek
 * via upload (ref_file_ids). URLs http(s) não são suportadas pelo upload.
 */
function collectDeepSeekImages(messages: Message[]): DeepSeekImageInput[] {
  const out: DeepSeekImageInput[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== 'image_url') continue;
      const url = part.image_url?.url;
      if (typeof url !== 'string') continue;
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (!match) continue;
      const mime = match[1];
      const ext = mime.replace('image/', '').split('+')[0].replace('jpeg', 'jpg') || 'jpg';
      out.push({
        filename: `image-${out.length + 1}.${ext}`,
        mimeType: mime,
        buffer: Buffer.from(match[2], 'base64'),
      });
    }
  }
  return out;
}

async function handleDeepSeekNonStreaming(
  c: Context,
  body: OpenAIRequest,
  finalPrompt: string,
  isThinkingModel: boolean,
  isNewSession: boolean,
  refFileIds: string[] = [],
  visionOpts: { chatSessionId?: string; modelType?: string | null } = {}
) {
  let result: { stream: ReadableStream; headers: Record<string, string>; uiSessionId: string };
  let retries = 3;
  const forceNewParent = visionOpts.chatSessionId ? null : (isNewSession ? null : undefined);
  while (retries > 0) {
    try {
      result = await createDeepSeekStream(finalPrompt, isThinkingModel, forceNewParent, refFileIds, visionOpts);
      break;
    } catch (err: any) {
      retries--;
      if (retries === 0) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const acc = await consumeDeepSeekStream(result!.stream, refFileIds.length > 0);
  if (acc.messageId) updateSessionParent(result!.uiSessionId, acc.messageId);

  const { textContent, toolCalls } = parseToolCallsFromContent(acc.content);
  const promptTokens = Math.ceil(finalPrompt.length / 3.5);

  const message: any = {
    role: 'assistant',
    content: toolCalls.length > 0 ? (textContent || null) : textContent,
  };
  if (acc.reasoning) {
    message.reasoning_content = acc.reasoning;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
      },
    }));
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

export async function chatCompletions(c: Context) {
  const startedAt = Date.now();
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;

    // Roteamento multi-provedor: vários provedores podem estar ativos.
    //  - nome de modelo deepseek -> backend DeepSeek (se houver um habilitado);
    //  - modelo conhecido por um provedor habilitado -> esse provedor;
    //  - senão -> o provedor principal (fallback).
    const registry = resolveRegistry(c.req.header('Cookie'));
    const enabled = enabledProviders(registry);
    const primary = resolveActiveProvider(c.req.header('Cookie'));

    const deepseekEnabled = enabled.some((p) => isDeepseekProvider(p));
    const qwenEnabled = enabled.some((p) => isQwenProvider(p));
    let target: Provider = primary;
    if (isDeepseekModel(body.model) && deepseekEnabled) {
      target = enabled.find((p) => isDeepseekProvider(p)) ?? primary;
    } else if (isQwenModel(body.model) && qwenEnabled) {
      target = enabled.find((p) => isQwenProvider(p)) ?? primary;
    } else if (!isDeepseekModel(body.model) && !isQwenModel(body.model)) {
      const owner = await findProviderForModel(enabled, body.model);
      if (owner) target = owner;
    }

    if (isQwenProvider(target)) {
      return qwenChatCompletions(c, body);
    }

    if (!isDeepseekProvider(target)) {
      return forwardChatCompletions(c, body, target);
    }

    const finalPrompt = buildAgentPrompt(body);
    const messages = body.messages || [];

    // DeepSeek web enxerga imagens via upload (ref_file_ids), mas imagens só
    // são processadas numa sessão de visão (model_type "vision"). O upload
    // simples vira CONTENT_EMPTY no modelo normal; o helper faz o fork do
    // arquivo para o model_kind VISION e cria a sessão de visão. Falha é
    // tolerada: a requisição segue sem imagem.
    let refFileIds: string[] = [];
    let visionOpts: { chatSessionId?: string; modelType?: string | null } = {};
    const dsImages = collectDeepSeekImages(messages);
    if (dsImages.length) {
      try {
        const uploadedIds = await uploadDeepSeekImages(dsImages);
        if (!uploadedIds.length) {
          console.log('[chat] deepseek image upload falhou; enviando sem imagem');
        } else {
          const vision = await prepareDeepSeekVisionFiles(uploadedIds);
          if (vision) {
            refFileIds = vision.refFileIds;
            visionOpts = { chatSessionId: vision.chatSessionId, modelType: 'vision' };
            console.log(`[chat] visão pronta: ${refFileIds.length} arquivo(s), sessão ${vision.chatSessionId}`);
          } else {
            console.warn('[chat] falha ao preparar sessão de visão; enviando sem imagem');
          }
        }
      } catch (err: any) {
        console.warn('[chat] deepseek image upload erro:', err.message);
      }
    }

    console.log(
      `[chat] request model=${body.model} stream=${body.stream ? 'yes' : 'no'} messages=${messages.length} promptChars=${finalPrompt.length} images=${dsImages.length} refFiles=${refFileIds.length}`
    );

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    // Requisição não-streaming: responde com JSON único em vez de SSE.
    if (!isStream) {
      return handleDeepSeekNonStreaming(c, body, finalPrompt, isThinkingModel, isNewSession, refFileIds, visionOpts);
    }

    // Empty response retry logic
    let stream: ReadableStream;
    let uiSessionId = '';
    let retries = 3;
    while (retries > 0) {
      try {
        // If it's a new session (or a vision session), force parent_message_id to null
        const result = await createDeepSeekStream(finalPrompt, isThinkingModel, visionOpts.chatSessionId ? null : (isNewSession ? null : undefined), refFileIds, visionOpts);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break; // Success
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        // Wait a bit before retrying
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const completionId = 'chatcmpl-' + uuidv4();

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

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

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      
      let inThinkingState = false;
      let thinkingFragments: Record<string, boolean> = {};
      let currentFragIndex = 0;
      let currentAppendPath = '';
      
      let reasoningBuffer = '';
      let contentEmitBuffer = '';
      let insideTool = false;
      let emittedToolCallCount = 0;
      const TOOL_START = '<tool_call>';
      const TOOL_END = '</tool_call>';

      let buffer = '';
      let completionTokens = 0;
      const promptTokens = Math.ceil(finalPrompt.length / 3.5);

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
          if (refFileIds.length > 0) console.log('[ds-image]', dataStr);
          if (dataStr === '[DONE]') {
            await streamWriter.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);

            // Extract message_id for session tracking to avoid overwriting messages
            let dsMessageId: any = null;
            if (chunk.p === 'response/message' && chunk.v && typeof chunk.v === 'object' && typeof chunk.v.id === 'number') {
              // Real DeepSeek protocol: the assistant message id lives at p:"response/message", v.id
              dsMessageId = chunk.v.id;
            } else if (chunk.response_message_id) {
              dsMessageId = chunk.response_message_id;
            } else if (chunk.v && typeof chunk.v === 'object') {
              if (chunk.v.response && chunk.v.response.message_id) {
                dsMessageId = chunk.v.response.message_id;
              } else if (chunk.v.message_id) {
                dsMessageId = chunk.v.message_id;
              }
            } else if (chunk.message_id) {
              dsMessageId = chunk.message_id;
            }

            if (dsMessageId) {
              updateSessionParent(uiSessionId, dsMessageId);
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (typeof chunk.p === 'string') {
              currentAppendPath = chunk.p;
              if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
                completionTokens = chunk.v;
              }
            }

            // Extract string value
            if (typeof chunk.v === 'string') {
              vStr = chunk.v;
              foundStr = true;
            } else if (chunk.v && typeof chunk.v === 'object') {
              // Handle old fragments format if it ever occurs
              if (chunk.v.response && chunk.v.response.fragments && chunk.v.response.fragments.length > 0) {
                const frag = chunk.v.response.fragments[0];
                if (typeof frag.content === 'string') {
                  vStr = frag.content;
                  foundStr = true;
                  currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
                }
              } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
                const firstObj = chunk.v[0];
                if (typeof firstObj.content === 'string') {
                  vStr = firstObj.content;
                  foundStr = true;
                  currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
                }
              }
            }

            // Determine if it's thinking based on the current path
            if (currentAppendPath.includes('thinking_content') || currentAppendPath.includes('THINK')) {
              isThinkingChunk = true;
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;

              const delta: ChoiceDelta = {};
              
              // Map chunk to either reasoning_content or content
              if (isThinkingChunk) {
                inThinkingState = true;
                reasoningBuffer += vStr;
                delta.reasoning_content = vStr;

                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice(delta)]
                });
              } else {
                inThinkingState = false;
                contentEmitBuffer += vStr;

                while (contentEmitBuffer.length > 0) {
                  if (!insideTool) {
                    const startIdx = contentEmitBuffer.indexOf(TOOL_START);
                    if (startIdx !== -1) {
                      // Found tool start. Emit everything before it as text
                      const textToEmit = contentEmitBuffer.substring(0, startIdx);
                      if (textToEmit && emittedToolCallCount === 0) {
                        await writeEvent({
                          id: completionId,
                          object: 'chat.completion.chunk',
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [makeChoice({ content: textToEmit })]
                        });
                      }
                      insideTool = true;
                      contentEmitBuffer = contentEmitBuffer.substring(startIdx + TOOL_START.length);
                      continue; // re-evaluate loop for tool end
                    } else {
                      // No full start tag. Check for partial match at the end
                      let flushIndex = contentEmitBuffer.length;
                      for (let i = 1; i <= TOOL_START.length; i++) {
                        if (contentEmitBuffer.endsWith(TOOL_START.substring(0, i))) {
                          flushIndex = contentEmitBuffer.length - i;
                          break;
                        }
                      }
                      
                      const textToEmit = contentEmitBuffer.substring(0, flushIndex);
                      if (textToEmit && emittedToolCallCount === 0) {
                        await writeEvent({
                          id: completionId,
                          object: 'chat.completion.chunk',
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [makeChoice({ content: textToEmit })]
                        });
                      }
                      contentEmitBuffer = contentEmitBuffer.substring(flushIndex);
                      break; // wait for more chunks
                    }
                  } else {
                    // Inside tool
                    const endIdx = contentEmitBuffer.indexOf(TOOL_END);
                    if (endIdx !== -1) {
                      let toolJsonStr = contentEmitBuffer.substring(0, endIdx).trim();
                      try {
                        // Robust JSON sanitization
                        toolJsonStr = toolJsonStr.replace(/```json/g, '').replace(/```/g, '').trim();
                        const startJ = toolJsonStr.indexOf('{');
                        const endJ = toolJsonStr.lastIndexOf('}');
                        if (startJ !== -1 && endJ !== -1 && endJ >= startJ) {
                          toolJsonStr = toolJsonStr.substring(startJ, endJ + 1);
                        }

                        const toolCallObj = JSON.parse(toolJsonStr);
                        const toolId = 'call_' + uuidv4();
                        
                        await writeEvent({
                          id: completionId,
                          object: 'chat.completion.chunk',
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [makeChoice({
                            tool_calls: [{
                              index: emittedToolCallCount,
                              id: toolId,
                              type: 'function',
                              function: {
                                name: toolCallObj.name || '',
                                arguments: typeof toolCallObj.arguments === 'object'
                                  ? JSON.stringify(toolCallObj.arguments)
                                  : String(toolCallObj.arguments || '')
                              }
                            }]
                          })]
                        });
                        emittedToolCallCount++;
                      } catch (e) {
                        // Failed to parse tool call JSON, emit as regular text
                        if (emittedToolCallCount === 0) {
                          await writeEvent({
                            id: completionId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: body.model,
                            choices: [makeChoice({ content: TOOL_START + toolJsonStr + TOOL_END })]
                          });
                        }
                      }
                      
                      insideTool = false;
                      contentEmitBuffer = contentEmitBuffer.substring(endIdx + TOOL_END.length);
                    } else {
                      // Waiting for TOOL_END, buffer the content
                      break;
                    }
                  }
                }
              }
            }
          } catch (e) {
            // parse error, ignore partial chunk
          }
        }
      }

      // Flush any remaining content emit buffer
      if (!insideTool && contentEmitBuffer.length > 0 && emittedToolCallCount === 0) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: contentEmitBuffer })]
        });
      }
  
      // Send finish reason
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
          cached_tokens: 0 // Mock cache compatibility
        }
      };
  
      const finalFinishReason = emittedToolCallCount > 0 ? 'tool_calls' : 'stop';
  
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        usage: usage
      });
      await streamWriter.write('data: [DONE]\n\n');

      console.log(
        `[chat] done model=${body.model} ${Date.now() - startedAt}ms tokens=${completionTokens + promptTokens} finish=${finalFinishReason}`
      );
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
