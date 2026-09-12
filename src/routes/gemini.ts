/*
 * File: gemini.ts
 * Project: deepsproxy
 * Handler de chat do Gemini Web (gemini.google.com). Recebe o corpo
 * OpenAI-compatível já parseado pelo roteador (routes/chat.ts) e responde via
 * streaming (SSE) ou JSON único.
 *
 * Cada requisição pega uma aba do pool (gemini-playwright.ts), digita o prompt
 * na UI e lê a resposta do DOM — sem protocolo RPC interno.
 *
 * Anti-Preguiça (Gateway Puro):
 *  - um turno é REPETIDO 1x com mensagem oculta se a resposta chegar vazia,
 *    curta ou genérica SEM tool_calls (finalização precoce);
 *  - os tool_calls do modelo são repassados TRANSPARENTEMENTE no payload
 *    HTTP/SSE no formato OpenAI/Gemini esperado pela IDE;
 *  - nenhuma ferramenta é executada localmente pelo servidor.
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { OpenAIRequest } from '../utils/types.ts';
import { startKeepAlive } from '../utils/sse.ts';
import { parseToolCallsFromContent } from '../tools/executor.ts';
import type { ParsedToolCall } from '../tools/types.ts';
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
  isLazyCompletion,
  ANTI_LAZY_RETRY_MESSAGE,
  noteToolLoopEvent,
  isToolLoopTripped,
  TOOL_LOOP_BREAKER_LIMIT,
} from '../middlewares/anti-lazy.ts';
import {
  getWorkspaceRootFromContext,
  sanitizeToolCallArguments,
  extractMcpServerNamesFromTools,
  extractKnownRelativePaths,
  toolCallSignature,
} from '../services/relay-path.ts';
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

interface GeminiTurnOutcome {
  rawText: string;
  textContent: string;
  toolCalls: ParsedToolCall[];
  error?: string;
  retried: boolean;
}

/** Log de diagnóstico do payload de tool_call emitido à IDE (nome + args). */
function logEmittedToolCall(name: string, safeArgs: unknown): void {
  const argsStr = typeof safeArgs === 'string' ? safeArgs : JSON.stringify(safeArgs);
  const capped = argsStr.length > 600 ? argsStr.slice(0, 600) + '…(truncado)' : argsStr;
  console.log(`[gemini-web] tool_call → IDE name=${name} args=${capped}`);
}

/**
 * Assinaturas de tool calls já presentes na conversa (mensagens do body) —
 * base para o circuit breaker detectar repetição da mesma chamada no ciclo.
 */
function collectHistoryToolSignatures(body: OpenAIRequest): string[] {
  const signatures: string[] = [];
  for (const msg of (body as any).messages ?? []) {
    const tcs = msg?.tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        signatures.push(
          toolCallSignature(tc?.function?.name, tc?.function?.arguments ?? tc?.arguments)
        );
      }
    }
  }
  return signatures;
}

/**
 * Executa um turno no Gemini Web com retry anti-preguiça (máx. 2 tentativas).
 * Se a 1ª resposta for vazia/curta/genérica SEM tool_calls, re-submete o
 * prompt com a mensagem oculta `ANTI_LAZY_RETRY_MESSAGE` (finalização precoce).
 *
 * CIRCUIT BREAKER: se o histórico da conversa mostra a mesma tool call se
 * repetindo por TOOL_LOOP_BREAKER_LIMIT turnos seguidos no ciclo, o retry
 * oculto é SUPRIMIDO e a resposta é entregue ao usuário como está, para
 * interromper o loop de comandos/falhas da IDE.
 */
async function runGeminiTurnWithAntiLazy(
  page: GeminiPageLike,
  prompt: string,
  opts: { abortSignal?: AbortSignal; historySignatures?: string[] }
): Promise<GeminiTurnOutcome> {
  // Alimenta o breaker com o histórico: repetições consecutivas da mesma tool
  // call no ciclo contam para o limite.
  for (const sig of opts.historySignatures ?? []) {
    noteToolLoopEvent(sig);
  }
  const trippedSignature = (opts.historySignatures ?? []).find((sig) => isToolLoopTripped(sig)) ?? null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const finalPrompt =
      attempt > 0 ? `${prompt}\n\nUser: ${ANTI_LAZY_RETRY_MESSAGE}` : prompt;
    const stream = await createGeminiWebStream(page, finalPrompt, opts);
    const { text, error } = await consumeGeminiWebStream(stream);
    if (error) {
      return { rawText: '', textContent: '', toolCalls: [], error, retried: attempt > 0 };
    }

    const parsed = parseToolCallsFromContent(text);
    if (parsed.toolCalls.length > 0 || !isLazyCompletion(parsed.textContent, parsed.toolCalls)) {
      return { rawText: text, ...parsed, retried: attempt > 0 };
    }

    if (trippedSignature) {
      console.log(
        `[gemini-web] CIRCUIT BREAKER: tool call repetida ${trippedSignature} por ${TOOL_LOOP_BREAKER_LIMIT}+ turnos seguidos — sem retry oculto, resposta entregue ao usuário`
      );
      return { rawText: text, ...parsed, retried: false };
    }

    console.log(
      `[gemini-web] ANTI-LAZY: resposta precoce (${parsed.textContent.length} chars, 0 tool_calls) — retry #${attempt + 1} com mensagem oculta`
    );
  }

  // Fallback teórico (completo em 2 tentativas): retorna a última resposta.
  const stream = await createGeminiWebStream(page, prompt, opts);
  const { text, error } = await consumeGeminiWebStream(stream);
  const parsed = parseToolCallsFromContent(text);
  return error
    ? { rawText: '', textContent: '', toolCalls: [], error, retried: true }
    : { rawText: text, ...parsed, retried: true };
}

async function handleGeminiNonStreaming(c: Context, body: OpenAIRequest, finalPrompt: string) {
  const signal = c.req.raw?.signal;
  const { page, release } = await pageForGeminiTurn(signal);
  try {
    const { textContent, toolCalls, error } = await runGeminiTurnWithAntiLazy(page, finalPrompt, {
      abortSignal: signal,
      historySignatures: collectHistoryToolSignatures(body),
    });
    if (error) throw new Error(error);

    // O modelo do Gemini Web expressa tools no texto via <tool_call>...</tool_call>
    // (mesmo formato do DeepSeek/Qwen web). Sem esse parse o Trae recebe o JSON
    // cru como conteúdo e NUNCA executa a ferramenta.
    const message: any = {
      role: 'assistant',
      content: toolCalls.length > 0 ? (textContent || null) : textContent,
    };
    if (toolCalls.length > 0) {
      // Camada de Relay: sanitiza caminhos dos args (relativo -> absoluto via
      // x-workspace-root, '\' -> '/') ANTES de entregar a Tool Call à IDE. Sem
      // I/O local — só manipulação de string pura.
      const workspaceRoot = getWorkspaceRootFromContext(c, body);
      const mcpServers = extractMcpServerNamesFromTools((body as any).tools);
      const knownPaths = extractKnownRelativePaths((body as any).messages);
      message.tool_calls = toolCalls.map((tc) => {
        const safeArgs = sanitizeToolCallArguments(tc.name, tc.arguments, workspaceRoot, mcpServers, knownPaths);
        logEmittedToolCall(tc.name, safeArgs);
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
    const promptTokens = Math.ceil(finalPrompt.length / 3.5);
    const completionTokens = Math.ceil((textContent || '').length / 3.5);

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

/** Emite conteúdo textual em fatias para simular streaming após o turno. */
async function emitBufferedText(
  writeEvent: (data: any) => Promise<void>,
  completionId: string,
  model: string,
  textContent: string
): Promise<number> {
  const chunkSize = 256;
  let emitted = 0;
  for (let i = 0; i < textContent.length; i += chunkSize) {
    const slice = textContent.substring(i, i + chunkSize);
    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { content: slice },
          logprobs: null,
          finish_reason: null,
        },
      ],
    });
    emitted += slice.length;
  }
  return emitted;
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
    // Injeta HIGH-PRECISION AGENT PROTOCOL + ANTI-LAZY DIRECTIVE
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

    // Raiz do workspace (header 'x-workspace-root' ou body) para a camada de
    // Relay: sanitize dos caminhos dos tool_calls emitidos no SSE.
    const relayWorkspaceRoot = getWorkspaceRootFromContext(c, body);
    const mcpServers = extractMcpServerNamesFromTools((body as any).tools);
    const knownPaths = extractKnownRelativePaths((body as any).messages);

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

        // Anti-Preguiça: executa o turno COMPLETO (com 1 retry se precoce) e só
        // então emite o SSE. Trade-off: TTFB deixa de ser ~0 (a latência do
        // Gemini Web entra no primeiro chunk), porém garante que o cliente só
        // receba uma resposta final não-lazy do modelo.
        const { rawText, textContent, toolCalls, error, retried } = await runGeminiTurnWithAntiLazy(
          page,
          finalPrompt,
          {
            abortSignal: c.req.raw?.signal,
            historySignatures: collectHistoryToolSignatures(body),
          }
        );

        if (error) {
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({}, 'error')],
          });
          await streamWriter.write('data: [DONE]\n\n');
          throw new Error(error);
        }

        // Regra de streaming (preservada do parser incremental): texto APÓS
        // <tool_call> não é emitido no SSE — o conteúdo para quando a tool começa.
        const toolIdx = rawText.indexOf('<tool_call>');
        const streamText = toolIdx === -1 ? rawText : rawText.slice(0, toolIdx);

        if (streamText) {
          await emitBufferedText(writeEvent, completionId, body.model, streamText);
        }

        // Repassa os tool_calls do modelo de forma TRANSPARENTE (formato
        // OpenAI/Gemini esperado pela IDE) — sem execução local. A camada de
        // Relay sanitiza os caminhos antes de entregá-los para a IDE.
        for (const tc of toolCalls) {
          const safeArgs = sanitizeToolCallArguments(tc.name, tc.arguments, relayWorkspaceRoot, mcpServers, knownPaths);
          logEmittedToolCall(tc.name, safeArgs);
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              makeChoice({
                tool_calls: [
                  {
                    index: toolCalls.indexOf(tc),
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: typeof safeArgs === 'string' ? safeArgs : JSON.stringify(safeArgs),
                    },
                  },
                ],
              }),
            ],
          });
        }

        const toolCallCount = toolCalls.length;
        const finalFinishReason = toolCallCount > 0 ? 'tool_calls' : 'stop';

        const promptTokens = Math.ceil(finalPrompt.length / 3.5);
        const contentLength = streamText.length;

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
          `[gemini-web] done model=${body.model} ${Date.now() - startedAt}ms chars=${contentLength} toolCalls=${toolCallCount}${retried ? ' (após retry anti-lazy)' : ''}`
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