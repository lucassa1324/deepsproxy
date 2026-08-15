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
import { buildFullHistoryPrompt } from '../utils/prompt.ts';
import { startKeepAlive } from '../utils/sse.ts';
import {
  createGeminiWebStream,
  consumeGeminiWebStream,
  getMockGeminiPage,
  FakeGeminiPage,
  toGeminiPageLike,
  type GeminiPageLike,
} from '../services/gemini-web.ts';
import {
  acquireGeminiStreamPage,
  releaseGeminiStreamPage,
} from '../services/gemini-playwright.ts';

/** Retorna a página a usar no turno (fake nos testes, pool em produção). */
async function pageForGeminiTurn(): Promise<{ page: GeminiPageLike; release: () => void }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mock = getMockGeminiPage();
    if (mock) return { page: mock, release: () => {} };
    return { page: new FakeGeminiPage(), release: () => {} };
  }
  const page = await acquireGeminiStreamPage();
  return { page: toGeminiPageLike(page), release: () => releaseGeminiStreamPage(page) };
}

async function handleGeminiNonStreaming(c: Context, body: OpenAIRequest, finalPrompt: string) {
  const { page, release } = await pageForGeminiTurn();
  try {
    const stream = await createGeminiWebStream(page, finalPrompt);
    const { text, error } = await consumeGeminiWebStream(stream);
    if (error) throw new Error(error);

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
          message: { role: 'assistant', content: text },
          logprobs: null,
          finish_reason: 'stop',
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
    const finalPrompt = buildFullHistoryPrompt(body);

    console.log(
      `[gemini-web] request model=${body.model} stream=${isStream ? 'yes' : 'no'} messages=${(body.messages || []).length} promptChars=${finalPrompt.length}`
    );

    if (!isStream) {
      return handleGeminiNonStreaming(c, body, finalPrompt);
    }

    const { page, release } = await pageForGeminiTurn();
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await createGeminiWebStream(page, finalPrompt);
    } catch (err: any) {
      release();
      throw err;
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const completionId = 'chatcmpl-' + uuidv4();

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const stopKeepAlive = startKeepAlive((chunk) => streamWriter.write(chunk));

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

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let contentLength = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      let streamError: string | null = null;

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
            contentLength += ev.text.length;
            await writeEvent({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [makeChoice({ content: ev.text })],
            });
          } else if (ev.type === 'error') {
            streamError = ev.message;
          }
        }
      }

      if (streamError) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, 'error')],
        });
        await streamWriter.write('data: [DONE]\n\n');
        stopKeepAlive();
        release();
        throw new Error(streamError);
      }

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
        choices: [makeChoice({}, 'stop')],
        usage,
      });
      await streamWriter.write('data: [DONE]\n\n');

      stopKeepAlive();
      release();

      console.log(`[gemini-web] done model=${body.model} ${Date.now() - startedAt}ms chars=${contentLength}`);
    });
  } catch (err: any) {
    console.error('[gemini-web] erro no chat:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
