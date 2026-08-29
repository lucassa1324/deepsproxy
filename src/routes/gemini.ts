/*
 * File: gemini.ts
 * Project: deepsproxy
 * Handler de chat do Gemini Web (gemini.google.com). Recebe o corpo
 * OpenAI-compatível já parseado pelo roteador (routes/chat.ts) e responde via
 * streaming (SSE) ou JSON único.
 *
 * Cada requisição pega uma aba do pool (gemini-playwright.ts), digita o prompt
 * na UI e lê a resposta do DOM — sem protocolo RPC interno.
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { OpenAIRequest } from '../utils/types.ts';
import { startKeepAlive } from '../utils/sse.ts';
import { parseToolCallsFromContent } from '../tools/executor.ts';
import { StreamingToolParser } from '../tools/stream-parser.ts';
import {
  buildGeminiWebPrompt,
  smartTruncateHistory,
  MAX_GEMINI_WEB_CHARS,
  GEMINI_WEB_COMPOSER_SAFE_CHARS,
  createGeminiWebStream,
  consumeGeminiWebStream,
  getMockGeminiPage,
  FakeGeminiPage,
  toGeminiPageLike,
  type GeminiPageLike,
} from '../services/gemini-web.ts';
import { injectHighPrecisionProtocol } from '../utils/system-prompt.ts';
import {
  acquireGeminiStreamPage,
  releaseGeminiStreamPage,
} from '../services/gemini-playwright.ts';

/** Retorna a página a usar no turno (fake nos testes, pool em produção). */
async function pageForGeminiTurn(signal?: AbortSignal): Promise<{ page: GeminiPageLike; release: () => void }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mock = getMockGeminiPage();
    if (mock) return { page: mock, release: () => {} };
    return { page: new FakeGeminiPage(), release: () => {} };
  }
  const page = await acquireGeminiStreamPage(signal);
  return { page: toGeminiPageLike(page), release: () => releaseGeminiStreamPage(page) };
}

async function handleGeminiNonStreaming(c: Context, body: OpenAIRequest, finalPrompt: string) {
  const signal = c.req.raw?.signal;
  const { page, release } = await pageForGeminiTurn(signal);
  try {
    const stream = await createGeminiWebStream(page, finalPrompt, { abortSignal: signal });
    const { text, error } = await consumeGeminiWebStream(stream);
    if (error) throw new Error(error);

    // O modelo do Gemini Web expressa tools no texto via <tool_call>...</tool_call>
    // (mesmo formato do DeepSeek/Qwen web). Sem esse parse o Trae recebe o JSON
    // cru como conteúdo e NUNCA executa a ferramenta.
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
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
        },
      }));
    }

    const completionId = 'chatcmpl-' + uuidv4();
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = Math.ceil(finalPrompt.length / 3.5);
    const completionTokens = Math.ceil(text.length / 3.5);

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
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });
  } finally {
    release();
  }
}

/**
 * Handler principal de chat do Gemini Web. `body` já vem parseado pelo
 * roteador (routes/chat.ts), que decidiu enviar para o provedor gemini-web.
 */
export async function geminiChatCompletions(c: Context, body: OpenAIRequest) {
  const startedAt = Date.now();
  try {
    const isStream = body.stream ?? false;

    // Teto de segurança em duas camadas:
    //   1. smartTruncateHistory: descarta o miolo do histórico (mantém system +
    //      turnos recentes) para conversas longas;
    //   2. buildGeminiWebPrompt: garante que o prompt CAIBA no composer do
    //      Gemini (limite ~32k chars). Sem isso o fim do prompt (a pergunta do
    //      usuário) é descartado e o Gemini responde só o system prompt.
    const originalMsgCount = (body.messages || []).length;
    body = smartTruncateHistory(body);
    let finalPrompt = buildGeminiWebPrompt(body);
    // Injeta HIGH-PRECISION AGENT PROTOCOL
    finalPrompt = injectHighPrecisionProtocol(finalPrompt);
    const truncatedMsgCount = (body.messages || []).length;

    if (truncatedMsgCount !== originalMsgCount) {
      console.log(
        `[gemini-web] teto aplicado (max=${MAX_GEMINI_WEB_CHARS} chars): msgs ${originalMsgCount} -> ${truncatedMsgCount}, prompt ${finalPrompt.length} chars`
      );
    }
    if (finalPrompt.length >= GEMINI_WEB_COMPOSER_SAFE_CHARS) {
      console.log(
        `[gemini-web] composer cap (max=${GEMINI_WEB_COMPOSER_SAFE_CHARS} chars): prompt de ${finalPrompt.length} chars enviado — cauda (pergunta atual) preservada`
      );
    }

    const toolsOf = (body as any).tools as any[] | undefined;
    const toolNames = (toolsOf || []).map((t: any) => t?.function?.name || t?.name).filter(Boolean);

    console.log(
      `[gemini-web] request model=${body.model} stream=${isStream ? 'yes' : 'no'} messages=${truncatedMsgCount} promptChars=${finalPrompt.length} tools=[${toolNames.join(', ') || 'nenhuma'}]${toolNames.length ? '' : ' (contrato fallback no prompt)'}`
    );
    // Diagnóstico: mostra o início e o FIM do prompt (onde fica a mensagem do
    // usuário). Se o tail não contém a pergunta do usuário, o Gemini responde
    // só o system prompt (saudação "Hello! I am your AI collaborator...").
    console.log(
      `[gemini-web] prompt head=${JSON.stringify(finalPrompt.slice(0, 160))} tail=${JSON.stringify(finalPrompt.slice(-240))}`
    );

    if (!isStream) {
      return handleGeminiNonStreaming(c, body, finalPrompt);
    }

    const { page, release } = await pageForGeminiTurn(c.req.raw?.signal);

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const completionId = 'chatcmpl-' + uuidv4();

    // A stream HTTP (headers + primeiro chunk) começa ANTES de tocar no
    // Playwright: o Trae vê TTFB ~0 em vez de esperar o goto+fill+send.
    return honoStream(c, async (streamWriter: any) => {
      let stopKeepAlive: () => void = () => {};
      try {
        const writeEvent = async (data: any) => {
          await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        stopKeepAlive = startKeepAlive((chunk) => streamWriter.write(chunk));

        const makeChoice = (delta: any, finishReason: string | null = null) => ({
          index: 0,
          delta,
          logprobs: null,
          finish_reason: finishReason,
        });

        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ role: 'assistant', content: '' })],
        });

        const stream = await createGeminiWebStream(page, finalPrompt, { abortSignal: c.req.raw?.signal });

        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let contentLength = 0;
        let promptTokens = Math.ceil(finalPrompt.length / 3.5);
        let streamError: string | null = null;
        // O Gemini Web expressa tools no texto via <tool_call>...</tool_call>;
        // o parser extrai os blocos do fluxo e emite tool_calls no SSE (senão o
        // Trae recebe o JSON cru como texto e não executa a ferramenta).
        const toolParser = new StreamingToolParser();

        const emitToolCalls = async (toolCalls: any[]) => {
          for (const tc of toolCalls) {
            await writeEvent({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                makeChoice({
                  tool_calls: [
                    {
                      index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                      id: tc.id,
                      type: 'function',
                      function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments),
                      },
                    },
                  ],
                }),
              ],
            });
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
            if (!trimmed) continue;
            let ev: any;
            try {
              ev = JSON.parse(trimmed);
            } catch {
              continue;
            }
            if (ev.type === 'content') {
              if (contentLength === 0) {
                console.log(`[gemini-web] primeiro token ${Date.now() - startedAt}ms`);
              }
              contentLength += ev.text.length;
              const { text, toolCalls } = toolParser.feed(ev.text);
              if (text) {
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ content: text })],
                });
              }
              await emitToolCalls(toolCalls);
            } else if (ev.type === 'error') {
              streamError = ev.message;
            }
          }
        }

        // Flush: resto de texto + tool calls parciais que fecharam no fim.
        const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
        if (remainingText) {
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: remainingText })],
          });
        }
        await emitToolCalls(remainingToolCalls);

        if (streamError) {
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({}, 'error')],
          });
          await streamWriter.write('data: [DONE]\n\n');
          throw new Error(streamError);
        }

        const toolCallCount = toolParser.getEmittedToolCallCount();
        const finalFinishReason = toolCallCount > 0 ? 'tool_calls' : 'stop';

        const usage = {
          prompt_tokens: promptTokens,
          completion_tokens: Math.ceil(contentLength / 3.5),
          total_tokens: promptTokens + Math.ceil(contentLength / 3.5),
          prompt_tokens_details: { cached_tokens: 0 },
        };

        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, finalFinishReason)],
          usage,
        });
        await streamWriter.write('data: [DONE]\n\n');

        console.log(
          `[gemini-web] done model=${body.model} ${Date.now() - startedAt}ms chars=${contentLength} toolCalls=${toolCallCount}`
        );
      } finally {
        stopKeepAlive();
        release();
        if (c.req.raw?.signal?.aborted) {
          console.log(`[gemini-web] request cancelado pelo cliente model=${body.model}`);
        }
      }
    });
  } catch (err: any) {
    console.error('[gemini-web] erro no chat:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
