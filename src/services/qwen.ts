/*
 * File: qwen.ts
 * Project: deepsproxy
 * Cliente da API do Qwen (chat.qwen.ai), portado do qwenproxy (autor: Pedro
 * Farias). Usa o playwright qwen-específico para extrair headers/PoW.
 */

import { getQwenHeaders, getQwenBasicHeaders, acquireQwenStreamPage, releaseQwenStreamPage, isQwenLoginFlowActive } from './qwen-playwright.ts';
import { browserStreamFetch } from './stream-bridge.ts';
import type { Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { enrichModel } from './qwen-utils.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Detecta o desafio anti-bot (TMD/x5sec) na resposta do chat.qwen.ai. */
function isTmdChallenge(text: string): boolean {
  return text.includes('FAIL_SYS_USER_VALIDATE') || text.includes('_____tmd_____') || text.includes('RGV587_ERROR');
}

const QWEN_WEB_VERSION = '0.2.66';
const CACHED_TIMEZONE = new Date().toString().split(' (')[0];

/** Conta streams de chat Qwen em andamento (usado pela cron de revalidação). */
let activeStreams = 0;
export function qwenStreamsActive(): number {
  return activeStreams;
}

/** Envolve um stream para decrementar o contador quando ele termina/cancela. */
function trackStream(stream: ReadableStream, onDone?: () => void): ReadableStream {
  activeStreams++;
  const reader = stream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    activeStreams--;
    if (onDone) {
      try {
        onDone();
      } catch {
        // ignora
      }
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
        finish();
      }
    },
    async cancel() {
      finish();
      try {
        await reader.cancel();
      } catch {
        // ignora
      }
    },
  });
}

/** Headers mínimos para o fetch de completion DENTRO do browser (same-origin). */
function buildBrowserCompletionHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    'accept': 'application/json',
    'content-type': 'application/json',
    'timezone': CACHED_TIMEZONE,
    'version': QWEN_WEB_VERSION,
    'x-accel-buffering': 'no',
    'x-request-id': uuidv4(),
    'bx-v': headers['bx-v'] || '',
    'bx-ua': headers['bx-ua'] || '',
    'bx-umidtoken': headers['bx-umidtoken'] || '',
    'source': 'web',
  };
}

// Sessões do Qwen são strings (chat_id), separadas das da DeepSeek (números).
const sessionStates: Record<string, string | null> = (globalThis as any)._qwenSessionStates || {};
(globalThis as any)._qwenSessionStates = sessionStates;

export function updateSessionParent(sessionId: string, parentId: string | null) {
  if (sessionId) {
    sessionStates[sessionId] = parentId;
  }
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

/** Limpa o cache de modelos do Qwen (usado no refresh do dashboard). */
export function clearQwenModelsCache(): void {
  cachedModels = null;
  lastModelsFetch = 0;
}

/** Lista estática conhecida de modelos Qwen (usada quando a busca falha). */
export const QWEN_KNOWN_MODELS = [
  enrichModel({ id: 'qwen3.6-plus', owned_by: 'qwen', label: 'Qwen3.6-Plus' }),
  enrichModel({ id: 'qwen3.6-plus-no-thinking', owned_by: 'qwen', label: 'Qwen3.6-Plus (sem thinking)' }),
];

export function isQwenModel(model: string): boolean {
  if (!model) return false;
  const m = String(model).toLowerCase();
  if (m.startsWith('qwen')) return true;
  if (cachedModels && cachedModels.some((x: any) => String(x.id).toLowerCase() === m)) return true;
  return QWEN_KNOWN_MODELS.some((x) => x.id.toLowerCase() === m);
}

export async function disableNativeTools(): Promise<void> {
  const { headers } = await getQwenHeaders();

  const payload = {
    tools_enabled: {
      web_extractor: false,
      web_search_image: false,
      web_search: false,
      image_gen_tool: false,
      code_interpreter: false,
      history_retriever: false,
      image_edit_tool: false,
      bio: false,
      image_zoom_in_tool: false
    }
  };

  console.log('[Qwen] Disabling native tools...');
  const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': headers['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': 'https://chat.qwen.ai/',
      'user-agent': headers['user-agent'],
      'x-request-id': uuidv4(),
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v']
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Qwen] Failed to disable native tools: ${response.status} - ${text}`);
  } else {
    console.log('[Qwen] Native tools disabled successfully.');
  }
}

export async function fetchQwenModels(): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) { // 1 hour cache
    return cachedModels;
  }

  const { cookie, userAgent, bxV } = await getQwenBasicHeaders();

  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': uuidv4(),
      'bx-v': bxV,
      'timezone': new Date().toString(),
      'source': 'web'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.map((m: any) =>
      enrichModel({
        id: m.id,
        object: 'model',
        created: m.info?.created_at || Math.floor(Date.now() / 1000),
        owned_by: m.owned_by || 'qwen',
        label: m.info?.name || m.info?.meta?.short_description || undefined,
        description: m.info?.meta?.description || undefined,
        meta: m.info?.meta,
      })
    );

    // Add -no-thinking versions for models that support thinking
    const extendedModels = [...models];
    for (const m of models) {
      extendedModels.push(
        enrichModel({
          ...m,
          id: `${m.id}-no-thinking`,
        })
      );
    }

    cachedModels = extendedModels;
    lastModelsFetch = now;
    return extendedModels;
  }

  return [];
}

/**
 * Executa o fetch de chat DENTRO de uma aba do pool, com detecção de desafio
 * anti-bot (TMD) e retry com headers novos. Lança em caso de falha; em caso
 * de sucesso devolve o stream de SSE.
 */
async function browserChatFetch(
  page: Page,
  url: string,
  payloadJson: string,
  timeoutMs: number,
  initialHeaders: Record<string, string>,
): Promise<{ stream: ReadableStream, headers: Record<string, string> }> {
  const attempt = async (hdrs: Record<string, string>) =>
    browserStreamFetch(page, url, {
      method: 'POST',
      headers: buildBrowserCompletionHeaders(hdrs),
      body: payloadJson,
      timeoutMs,
    });

  const result = await attempt(initialHeaders);

  if (result.contentType.includes('text/event-stream') && result.status < 400) {
    return { stream: result.stream, headers: initialHeaders };
  }

  if (result.body && isTmdChallenge(result.body)) {
    console.warn('[Qwen] Desafio anti-bot (TMD) detectado via browser; atualizando headers e tentando de novo...');
    await sleep(500 + Math.floor(Math.random() * 1000));
    const { headers: freshHeaders } = await getQwenHeaders(true);
    const retry = await attempt(freshHeaders);
    if (retry.contentType.includes('text/event-stream') && retry.status < 400) {
      return { stream: retry.stream, headers: freshHeaders };
    }
    if (retry.body && isTmdChallenge(retry.body)) {
      throw new Error('Qwen: desafio anti-bot persiste após atualizar headers. Resolva o captcha no navegador antes de usar o chat.');
    }
    throw new Error(`Qwen: falha ao criar stream (retry) — ${retry.status}: ${retry.body.slice(0, 300)}`);
  }

  if (result.status < 400 && !result.contentType.includes('text/event-stream') && !result.body) {
    console.warn('[Qwen] Browser retornou 200 com corpo vazio; tentando com headers novos...');
    await sleep(500 + Math.floor(Math.random() * 1000));
    const { headers: freshHeaders } = await getQwenHeaders(true);
    const retry = await attempt(freshHeaders);
    if (retry.contentType.includes('text/event-stream') && retry.status < 400) {
      return { stream: retry.stream, headers: freshHeaders };
    }
    if (retry.body && isTmdChallenge(retry.body)) {
      throw new Error('Qwen: desafio anti-bot persiste após atualizar headers.');
    }
    throw new Error(`Qwen: falha ao criar stream (retry vazio) — ${retry.status}: ${retry.body.slice(0, 300)}`);
  }

  throw new Error(
    `Qwen: resposta inesperada do stream — ${result.status} ${result.contentType} body=${result.body?.slice(0, 200) || '(vazio)'}`
  );
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  activeStreams++;
  try {
    return await createQwenStreamInner(prompt, enableThinking, modelId, forcedParentId);
  } catch (e) {
    activeStreams--;
    throw e;
  }
}

/**
 * Monta a requisição de chat (headers + payload + URL). O handshake de headers
 * fica aqui porque roda de forma EXCLUSIVA (dentro do slot do pool), evitando
 * que dois handshakes concorrentes quebrem a página de controle.
 */
async function buildQwenChatRequest(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null
): Promise<{ headers: Record<string, string>, chatSessionId: string, url: string, payloadJson: string, timeoutMs: number }> {
  const { headers, chatSessionId, parentMessageId } = await getQwenHeaders(forcedParentId === null);
  let actualParentId: string | null = parentMessageId;

  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (chatSessionId && sessionStates[chatSessionId] !== undefined) {
    actualParentId = sessionStates[chatSessionId];
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  const model = modelId.replace('-no-thinking', '');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatSessionId || null,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: true
        },
        extra: {
          meta: {
            subChatType: 't2t'
          }
        },
        sub_chat_type: 't2t',
        parent_id: actualParentId
      }
    ],
    timestamp: timestamp + 1
  };

  const url = chatSessionId
    ? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatSessionId}`
    : 'https://chat.qwen.ai/api/v2/chat/completions';

  return { headers, chatSessionId, url, payloadJson: JSON.stringify(payload), timeoutMs: 120000 };
}

async function createQwenStreamInner(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  // Guarda ANTES de entrar na fila do pool: durante o login do Qwen a janela
  // fica visível e o pool é esvaziado — sem este guard a requisição ficaria
  // esperando para sempre na fila (capacidade 0) sem nunca responder.
  if (isQwenLoginFlowActive()) {
    throw new Error('Login do Qwen em andamento. Conclua o login no dashboard antes de usar o chat.');
  }

  // A API do Qwen processa UMA resposta por vez na mesma sessão do browser (a
  // 2ª completion concorrente volta 200 vazio/bloqueado pelo WAF). Por isso o
  // pool é serializado (capacidade 1): a requisição entra na fila, pega a aba,
  // faz handshake + stream de forma exclusiva e só então libera para a próxima.
  const page = await acquireQwenStreamPage().catch(() => null);
  if (page && !page.isClosed()) {
    if (!page.url().includes('chat.qwen.ai')) {
      await page
        .goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(() => {});
    }
    const release = () => {
      if (page && !page.isClosed()) releaseQwenStreamPage(page);
    };
    try {
      const req = await buildQwenChatRequest(prompt, enableThinking, modelId, forcedParentId);
      const outcome = await browserChatFetch(page, req.url, req.payloadJson, req.timeoutMs, req.headers);
      return {
        stream: trackStream(outcome.stream, release),
        headers: outcome.headers,
        uiSessionId: req.chatSessionId,
      };
    } catch (e) {
      release();
      throw e;
    }
  }
  if (page) releaseQwenStreamPage(page);

  // Sem Playwright ativo (dev/testes): fallback via fetch direto do Node.
  const req = await buildQwenChatRequest(prompt, enableThinking, modelId, forcedParentId);
  const response = await fetch(req.url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': req.headers['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': req.chatSessionId ? `https://chat.qwen.ai/c/${req.chatSessionId}` : 'https://chat.qwen.ai/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'timezone': new Date().toString().split(' (')[0],
      'user-agent': req.headers['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': uuidv4(),
      'bx-ua': req.headers['bx-ua'],
      'bx-umidtoken': req.headers['bx-umidtoken'],
      'bx-v': req.headers['bx-v']
    },
    body: req.payloadJson
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: trackStream(response.body), headers: req.headers, uiSessionId: req.chatSessionId };
}
