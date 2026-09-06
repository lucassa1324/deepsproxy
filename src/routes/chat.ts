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
import { forwardChatCompletions, findProviderForModel, isDeepseekModel, hasTools } from '../services/local.ts';
import { isQwenModel } from '../services/qwen.ts';
import { qwenChatCompletions } from './qwen.ts';
import { geminiChatCompletions } from './gemini.ts';
import {
  getWorkspaceRootFromContext,
  sanitizeToolCallArguments,
} from '../services/relay-path.ts';
import {
  resolveRegistry,
  resolveActiveProvider,
  enabledProviders,
  isDeepseekProvider,
  isQwenProvider,
  isGeminiWebProvider,
  normalizeModelId,
} from '../services/config.ts';
import type { Provider, ProviderRegistry } from '../services/config.ts';
import { resolveModelEntry, providerFromCatalogEntry, getModelCatalog } from '../services/modelCatalog.ts';
import type { GatewayApp } from '../services/gateway.ts';
import { dispatchAdapterChat, isAdapterProvider } from '../services/adapters/index.ts';
import {
  validateResponse,
  maybeInjectDiagnosticDirective,
  buildGenericRejection,
  buildNullEditRejection,
} from '../services/validation-guard.ts';
import { injectAntiLazyDirective } from '../middlewares/anti-lazy.ts';
import { applyPromptCaching } from '../services/prompt-cache.ts';
import {
  getTokenEconomy,
  applyTokenEconomy,
  cachePayloadKey,
  responseCacheGet,
  responseCacheSet,
  hasMeaningfulContent,
  buildSummaryDigest,
  SUMMARY_MAX_TOKENS,
} from '../services/token-economy.ts';
import type { TokenEconomySettings } from '../services/token-economy.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { buildAgentPrompt } from '../utils/prompt.ts';
import { parseToolCallsFromContent } from '../tools/executor.ts';
import { robustParseJSON } from '../utils/robust-json.ts';
import { isModelBoosted } from '../services/booster.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { startKeepAlive } from '../utils/sse.ts';
import { applyPhase1Optimizations, cacheSystemPrompt, getCachedPrompt, optimizedFetch } from '../services/optimizations.ts';
import { routeRequest, getAutoRouterConfig, getModelMetadata, isModelDown, recordModelFailure, recordModelSuccess, getPreviousAutoModel, rememberAutoModel, buildAutoFailoverChain, recordModelRequest, recordModelLatency, recordModelOutcome } from '../services/auto-router/index.ts';

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

  // Camada de Relay: sanitiza os caminhos dos tool_calls (relativo -> absoluto
  // via x-workspace-root; '\' -> '/') antes de entregá-los à IDE. Sem I/O local.
  const relayWorkspaceRoot = getWorkspaceRootFromContext(c, body);
  const normalizedToolCalls = toolCalls.map((tc) => {
    const safeArgs = sanitizeToolCallArguments(tc.name, tc.arguments, relayWorkspaceRoot);
    return {
      ...tc,
      arguments: typeof safeArgs === 'string' ? safeArgs : JSON.stringify(safeArgs),
    };
  });

  const message: any = {
    role: 'assistant',
    content: toolCalls.length > 0 ? (textContent || null) : textContent,
  };
  if (acc.reasoning) {
    message.reasoning_content = acc.reasoning;
  }
  if (normalizedToolCalls.length > 0) {
    message.tool_calls = normalizedToolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: tc.arguments,
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

/**
 * Resumo dos turnos descartados pelo truncamento (modo economia). Tenta a
 * chamada de resumo com o provedor ativo (adapter ou openai-compatible); se
 * não for possível (deepseek/qwen por browser, sem API), usa o digest local.
 */
async function summarizeDropped(dropped: any[], target: Provider): Promise<string> {
  const digest = buildSummaryDigest(dropped);
  const sys =
    'Você é um compressor de contexto. Produza um resumo objetivo e conciso, no mesmo idioma das mensagens. Mantenha decisões, fatos, nomes de arquivos e código relevantes. Responda apenas com o resumo.';
  const user = `Resuma o histórico abaixo:\n\n${digest}`;
  try {
    if (isAdapterProvider(target)) {
      const resp = await dispatchAdapterChat(
        {
          model: target.model || 'default',
          stream: false,
          max_tokens: SUMMARY_MAX_TOKENS,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ],
        },
        target
      );
      if (resp && resp.status === 200) {
        const j: any = await resp.clone().json();
        const c = j?.choices?.[0]?.message?.content;
        if (c) return c;
      }
    } else if (target.type === 'openai-compatible' && target.baseUrl && target.apiKey) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const resp = await optimizedFetch(`${target.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + target.apiKey,
          },
          body: JSON.stringify({
            model: target.model || 'default',
            stream: false,
            max_tokens: SUMMARY_MAX_TOKENS,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: user },
            ],
          }),
          signal: controller.signal,
        });
        if (resp.ok) {
          const j: any = await resp.json();
          const c = j?.choices?.[0]?.message?.content;
          if (c) return c;
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // fallback para digest
  }
  return digest;
}

/**
 * Anti-Lazy Loop com 3 travas de validação:
 * 1. Validação de Diff Efetivo (Anti-Nulo): rejeita edições +0 -0
 * 2. Injeção Dinâmica de Diagnóstico Terminal: obriga rodar build/tsc antes de editar
 * 3. Circuit Breaker Progressivo: max 2 tentativas, depois aborta com aviso
 * 
 * @param res - Response do provedor
 * @param currentBody - Body da requisição original
 * @param currentTarget - Provider usado
 * @returns Response final (original, retry enriquecido, ou resposta final com aviso)
 */
async function applyAntiLazyLoop(
  c: Context,
  res: Response,
  currentBody: OpenAIRequest,
  currentTarget: Provider
): Promise<Response> {
  if (res.status !== 200) return res;

  // Extrai flags com padrão TRUE (enabled by default).
  // Cliente pode desativar enviando explicitamente: false
  const enableDiagnosticDirective = (currentBody as any).enableDiagnosticDirective !== false;
  const enableNullDiffValidation = (currentBody as any).enableNullDiffValidation !== false;
  const enableAntiLazyLoop = (currentBody as any).enableAntiLazyLoop !== false;

  // Se todas as flags foram explicitamente desativadas, passa direto
  if (!enableDiagnosticDirective && !enableNullDiffValidation && !enableAntiLazyLoop) {
    return res;
  }

  // 1. Injeta diretiva de diagnóstico se flag ativa e usuário mencionar erro técnico
  let bodyWithDiagnostic = currentBody;
  if (enableDiagnosticDirective) {
    bodyWithDiagnostic = maybeInjectDiagnosticDirective(currentBody);
  }

  // 2. Validação completa via validation-guard (flags são lidas dentro do body)
  const validation = await validateResponse(c, res, bodyWithDiagnostic, currentTarget);
  
  if (validation.isValid) {
    return res;
  }

  // 3. Se deve abortar (circuit breaker): em vez de devolver ao usuário,
  // injeta Re-Prompt Interno Forçado (Emergency Step) para tentar recuperar
  if (validation.shouldAbort) {
    console.log('[anti-lazy] Circuit breaker ativado. Injetando Emergency Re-Prompt forçado...');
    if (validation.rejectionMessage && validation.modifiedBody) {
      const emergencyBody = validation.modifiedBody;
      
      // Injeta mensagem de emergência no system prompt para forçar uso do WORKSPACE MAP
      const emergencyPrompt = 
        `[PROXY EMERGENCY STEP]: Você está preso em um loop de buscas vazias. ` +
        `Consulte a mensagem inicial [WORKSPACE MAP] onde o caminho dos arquivos já foi listado. ` +
        `Execute read_file com o caminho exato da subpasta (ex: 'github-edit-view/src/lib/interaction-math.ts'). ` +
        `NÃO responda com texto — USE A FERRAMENTA read_file AGORA com o caminho completo.`;
      
      // Adiciona a mensagem de emergência como system message
      emergencyBody.messages = [
        ...emergencyBody.messages,
        { role: 'system', content: emergencyPrompt }
      ];
      
      // Re-chama o provedor com o emergency prompt
      let emergencyRes: Response;
      if (isQwenProvider(currentTarget)) {
        emergencyRes = await qwenChatCompletions(c, emergencyBody);
      } else if (isGeminiWebProvider(currentTarget)) {
        emergencyRes = await geminiChatCompletions(c, emergencyBody);
      } else {
        emergencyRes = await forwardChatCompletions(c, emergencyBody, currentTarget);
      }
      
      // Valida a resposta de emergência
      const emergencyValidation = await validateResponse(c, emergencyRes, emergencyBody, currentTarget);
      if (emergencyValidation.isValid) {
        console.log('[anti-lazy] Emergency re-prompt bem-sucedido. Loop quebrado.');
        return emergencyRes;
      }
      
      // Se ainda falhar, devolve a resposta de emergência mesmo assim (evita loop infinito)
      console.log('[anti-lazy] Emergency re-prompt falhou. Devolvendo resposta de emergência para evitar loop.');
      return emergencyRes;
    }
    return res;
  }

  // 4. Re-prompt forçado (tentativa 1 de 2)
  console.log('[anti-lazy] Rejeição detectada. Iniciando re-prompt forçado...');
  if (!validation.rejectionMessage || !validation.modifiedBody) {
    return res;
  }

  const retryBody = validation.modifiedBody;
  
  // Re-chama o provedor
  let retryRes: Response;
  if (isQwenProvider(currentTarget)) {
    retryRes = await qwenChatCompletions(c, retryBody);
  } else if (isGeminiWebProvider(currentTarget)) {
    retryRes = await geminiChatCompletions(c, retryBody);
  } else {
    retryRes = await forwardChatCompletions(c, retryBody, currentTarget);
  }

  // 5. Valida a retry
  const retryValidation = await validateResponse(c, retryRes, retryBody, currentTarget);
  
  if (retryValidation.isValid) {
    console.log('[anti-lazy] Re-prompt bem-sucedido. Resposta enriquecida.');
    return retryRes;
  }

  // 6. Se retry também falhou e deve abortar: injeta Emergency Re-Prompt final
  if (retryValidation.shouldAbort) {
    console.log('[anti-lazy] Segunda tentativa falhou. Injetando Emergency Re-Prompt final...');
    if (retryValidation.rejectionMessage && retryValidation.modifiedBody) {
      const emergencyBody = retryValidation.modifiedBody;
      
      const emergencyPrompt = 
        `[PROXY FINAL EMERGENCY STEP]: Segunda tentativa falhou. ` +
        `Você DEVE usar o [WORKSPACE MAP] para localizar o arquivo exato. ` +
        `Se o arquivo é 'interaction-math.ts' e o mapa mostra 'github-edit-view/src/lib/interaction-math.ts', ` +
        `use EXATAMENTE esse caminho no read_file. ` +
        `NÃO responda com explicações — EXECUTE A FERRAMENTA AGORA.`;
      
      emergencyBody.messages = [
        ...emergencyBody.messages,
        { role: 'system', content: emergencyPrompt }
      ];
      
      let emergencyRes: Response;
      if (isQwenProvider(currentTarget)) {
        emergencyRes = await qwenChatCompletions(c, emergencyBody);
      } else if (isGeminiWebProvider(currentTarget)) {
        emergencyRes = await geminiChatCompletions(c, emergencyBody);
      } else {
        emergencyRes = await forwardChatCompletions(c, emergencyBody, currentTarget);
      }
      
      return emergencyRes;
    }
    return retryRes;
  }

  // 7. Retry melhorou mas ainda não ideal - devolve mesmo assim
  return retryRes;
}

/**
 * Resolve o modelo "auto"/"auto-free" via Smart Router.
 *
 * Usa sempre o catálogo atual (não o cache, que pode estar vazio no primeiro
 * request), exclui os placeholders "auto"/"auto-free" das opções (não são
 * modelos encaminháveis) e garante que o modelo escolhido exista no catálogo —
 * nunca devolvendo o próprio "auto"/"auto-free" (que tem Base URL vazia e
 * quebraria o encaminhamento com "Failed to parse URL from /chat/completions").
 */
async function resolveAutoModel(
  c: Context,
  body: OpenAIRequest,
  isBrowserOnly: boolean
): Promise<{ model: string; message?: string; status?: number; failoverChain?: string[] }> {
  const registry = resolveRegistry(c.req.header('Cookie'));
  const catalog = await getModelCatalog(registry);
  const availableModels = catalog
    .filter((m) => m.id !== 'auto' && m.id !== 'auto-free')
    .map((m) => ({ id: m.id, providerId: m.provider, providerType: m.providerType }));

  const messages = body.messages || [];
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const currentMessage =
    typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.map((p: any) => p.text || '').join('')
        : '';

  // Namespace evita colisão entre clientes/apps do gateway que compartilham o
  // servidor: a estabilidade da conversa vale por app/cliente, não global.
  const gwEntry = (c as any).get('gatewayAppEntry') as GatewayApp | undefined;
  const namespace = gwEntry?.id ?? 'direct';
  const mode = isBrowserOnly ? 'auto-free' : 'auto';
  const previousModelId = getPreviousAutoModel(messages as Array<{ role: string; content: string | any[] }>, namespace, mode);

  const decision = routeRequest(
    messages as Array<{ role: string; content: string | any[] }>,
    currentMessage,
    availableModels,
    previousModelId,
    isBrowserOnly,
    hasTools(body)
  );

  if (!decision.selectedModelId) {
    return { model: '', status: 503, message: `Auto Router: ${decision.reason}` };
  }

  // Reutiliza o catálogo já obtido (evita buscar duas vezes)
  const fullCatalog = catalog;
  let model = fullCatalog.find((m) => m.id === decision.selectedModelId)?.id ?? '';
  if (!model) {
    console.warn(`[auto-router] modelo selecionado "${decision.selectedModelId}" não está no catálogo; usando fallback`);
    const realCatalog = fullCatalog.filter((m) => m.id !== 'auto' && m.id !== 'auto-free');
    const realUp = realCatalog.filter((m) => !isModelDown(m.id));
    const browserPool = realUp.filter(
      (m) => m.providerType === 'gemini-web' || m.providerType === 'deepseek' || m.providerType === 'qwen'
    );
    const pool = browserPool.length ? browserPool : realUp;
    if (pool.length) {
      const sorted = hasTools(body)
        ? [...pool].sort(
            (a, b) =>
              (getModelMetadata(b.id)?.capabilities.coding ?? 0) -
              (getModelMetadata(a.id)?.capabilities.coding ?? 0)
          )
        : pool;
      model = sorted[0].id;
      console.log(`[auto-router] fallback para "${model}"`);
    } else {
      return { model: '', status: 503, message: 'Auto Router: nenhum modelo disponível. Configure um provedor na aba Conexão do dashboard.' };
    }
  }

  console.log(
    `[auto-router] redirecionando "${body.model}" → "${model}" ` +
    `(${decision.reason})`
  );

  // Header visível para clientes API (Postman, curl, libs).
  // Sanitize to ASCII for HTTP header compliance.
  const sanitizeHeader = (s: string) => s.replace(/[^\x00-\x7F]/g, '').slice(0, 200);
  c.header('X-AutoRouter-Model', decision.selectedModelId);
  c.header('X-AutoRouter-Score', String(decision.score));
  c.header('X-AutoRouter-Task', sanitizeHeader(decision.taskClassification.description));
  c.header('X-AutoRouter-Reason', sanitizeHeader(decision.reason));
  if (isBrowserOnly) {
    c.header('X-AutoRouter-Mode', 'free-browser');
  }

  // Guarda o modelo escolhido no contexto para o chatCompletions reportar o
  // resultado (sucesso/falha) ao circuit breaker do Auto Router.
  c.set('autoRoutedModel', model);

  // Cadeia de failover: ordem de modelos a tentar se o escolhido falhar.
  // Usada pelo chatCompletions para retentar com o próximo melhor modelo.
  const failoverChain = buildAutoFailoverChain(
    model,
    decision,
    fullCatalog.map((m) => m.id)
  );

  // Registra o modelo usado nesta conversa: o próximo turno o usará como
  // previousModelId (bonus de estabilidade no selectBestModel).
  rememberAutoModel(messages as Array<{ role: string; content: string | any[] }>, namespace, mode, model);

  return { model, failoverChain };
}

/**
 * Reporta o resultado de um request roteado via "auto"/"auto-free" ao circuit
 * breaker: sucesso fecha o circuito, falha HTTP/erro/reposta vazia abre com
 * backoff. Quando o request não veio do auto router (autoRouted vazio), não faz
 * nada.
 */
function reportAutoOutcome(autoRouted: string | undefined, ok: boolean, extra?: string): void {
  if (!autoRouted) return;
  // Métricas observacionais: contagem de sucesso/falha e último erro.
  recordModelOutcome(autoRouted, ok, ok ? undefined : extra);
  // Circuit breaker: sucesso fecha o circuito, falha abre com backoff.
  if (ok) {
    recordModelSuccess(autoRouted);
  } else {
    recordModelFailure(autoRouted, undefined, extra);
  }
}

/**
 * Tenta os candidatos da cadeia de failover na ordem até um responder com
 * sucesso (status < 400). Cada tentativa reporta ao circuit breaker e às
 * métricas o resultado do modelo tentado. Retorna null quando o primeiro
 * candidato é DeepSeek (fluxo próprio do chat.ts cuida dele) ou quando não há
 * candidatos não-DeepSeek a tentar.
 */
async function attemptFailoverChain(
  c: Context,
  body: OpenAIRequest,
  registry: ProviderRegistry,
  enabled: Provider[],
  primary: Provider,
  chain: string[],
  maybeStoreCache: (res: Response, modelId?: string) => Promise<Response>
): Promise<Response | null> {
  const tried: string[] = [];
  let lastRes: Response | null = null;
  let lastError: any = null;

  for (const modelId of chain) {
    if (tried.includes(modelId)) continue;
    tried.push(modelId);

    // Resolve o provedor deste candidato (mesma lógica do fluxo principal).
    const t = await resolveTargetForModel(c, modelId, registry, enabled, primary);
    if (!t) continue;
    if (isDeepseekProvider(t)) {
      // DeepSeek é o fluxo original (streaming/sessão própria): não entra no
      // failover. Se for o primeiro candidato, devolve o controle ao fluxo.
      if (tried.length === 1) return null;
      continue;
    }

    const startedLat = Date.now();
    recordModelRequest(modelId);
    try {
      body.model = modelId;

      // Prompt Caching no failover também
      body = applyPromptCaching(body, t);

      let res: Response;
      if (isQwenProvider(t)) {
        res = await qwenChatCompletions(c, body);
      } else if (isGeminiWebProvider(t)) {
        res = await geminiChatCompletions(c, body);
      } else {
        res = await forwardChatCompletions(c, body, t);
      }
      
      // Anti-Lazy Loop no failover
      res = await applyAntiLazyLoop(c, res, body, t);
      
      recordModelLatency(modelId, Date.now() - startedLat);
      const stored = await maybeStoreCache(res, modelId);
      lastRes = stored;
      if (stored.status < 400) {
        c.header('X-AutoRouter-FinalModel', modelId);
        if (tried.length > 1) c.header('X-AutoRouter-Failover', String(tried.length - 1));
        console.log(`[auto-router] failover: "${modelId}" respondeu OK na ${tried.length}ª tentativa`);
        return stored;
      }
    } catch (err: any) {
      lastError = err;
      recordModelLatency(modelId, Date.now() - startedLat);
      reportAutoOutcome(modelId, false, err?.message);
      console.warn(`[auto-router] tentativa "${modelId}" falhou: ${err?.message}`);
    }
  }

  // Esgotou os candidatos não-DeepSeek: devolve a última falha (ou 502).
  if (lastRes) return lastRes;
  return c.json(
    { error: { message: lastError?.message || 'Auto Router: todos os modelos falharam.' } },
    502 as any
  );
}

/**
 * Resolve o provedor que atende um modelo, replicando a lógica do fluxo
 * principal: catálogo → roteamento por nome (DeepSeek/Qwen) → dono do modelo →
 * provedor principal. Retorna null quando nenhum provedor atende (ex.: app do
 * gateway com modelo fora do catálogo).
 */
async function resolveTargetForModel(
  c: Context,
  modelId: string,
  registry: ProviderRegistry,
  enabled: Provider[],
  primary: Provider
): Promise<Provider | null> {
  const gwEntry = (c as any).get('gatewayAppEntry') as GatewayApp | undefined;
  const entry = await resolveModelEntry(modelId, registry);
  if (entry) return providerFromCatalogEntry(entry);
  if (gwEntry) return null;
  // Porta 3005 (direta): fallback por nome de modelo conhecido.
  const deepseekEnabled = enabled.some((p) => isDeepseekProvider(p));
  const qwenEnabled = enabled.some((p) => isQwenProvider(p));
  if (isDeepseekModel(modelId) && deepseekEnabled) {
    return enabled.find((p) => isDeepseekProvider(p)) ?? primary;
  }
  if (isQwenModel(modelId) && qwenEnabled) {
    return enabled.find((p) => isQwenProvider(p)) ?? primary;
  }
  if (!isDeepseekModel(modelId) && !isQwenModel(modelId)) {
    const owner = await findProviderForModel(enabled, modelId);
    if (owner) return owner;
  }
  return primary;
}

export async function chatCompletions(c: Context) {
  const startedAt = Date.now();
  let autoRouted: string | undefined = undefined;
  try {
    let body: OpenAIRequest = await c.req.json();
    // Normaliza o id do modelo (ex.: cliente envia "models/gemini-2.5-flash"
    // com prefixo da REST do Google). Sem isso o roteamento e os adapters
    // falham ao montar a URL (ex.: /models/models/...).
    body.model = normalizeModelId(body.model);
    const isStream = body.stream ?? false;
    const economy: TokenEconomySettings = getTokenEconomy();

    // Sanitização de prompt do Gateway Puro: injeta a diretiva ANTI-LAZY &
    // AGENTIC EXECUTION no INÍCIO do system message de TODAS as requisições
    // que atravessam o proxy (idempotente). O I/O local de arquivos foi
    // removido — o servidor jamais ler/edita/deleta arquivos do workspace.
    body = injectAntiLazyDirective(body);

    // ── Roteamento multi-provedor: o provedor é resolvido AUTOMATICAMENTE ──
    // pelo catálogo unificado de modelos (model_id -> provider/baseUrl/apiKey).
    //  - porta 3006 (gateway): o model enviado pelo cliente é ignorado; vale o
    //    modelo configurado na aplicação da chave virtual (painel);
    //  - porta 3005 (direta): o model do cliente define o provedor.
    const registry = resolveRegistry(c.req.header('Cookie'));
    const enabled = enabledProviders(registry);
    const primary = resolveActiveProvider(c.req.header('Cookie'));

    // AI Gateway (porta 3006): o middleware do gatewayApp já validou a chave
    // virtual e guardou a aplicação no contexto. Injeta o modelo do painel.
    const gwEntry = (c as any).get('gatewayAppEntry') as GatewayApp | undefined;
    if (gwEntry) {
      const appModel = (gwEntry.model || '').trim();
      if (!appModel) {
        return c.json(
          {
            error: {
              message: `Aplicação "${gwEntry.name}" não tem modelo configurado. Selecione um modelo na aba Apps do dashboard.`,
            },
          },
          400
        );
      }
      body.model = appModel;

      // Aplica parâmetros LLM por aplicação (se configurados)
      if (gwEntry.temperature !== undefined && body.temperature === undefined) {
        body.temperature = gwEntry.temperature;
      }
      if (gwEntry.top_p !== undefined && body.top_p === undefined) {
        body.top_p = gwEntry.top_p;
      }
      if (gwEntry.maxTokens !== undefined && body.max_tokens === undefined) {
        body.max_tokens = gwEntry.maxTokens;
      }
      if (gwEntry.systemPromptOverride) {
        // Anexa o system prompt override ao system prompt existente ou cria novo
        const existingSystem = body.messages.find(m => m.role === 'system');
        const override = gwEntry.systemPromptOverride.trim();
        if (existingSystem) {
          existingSystem.content = (existingSystem.content || '') + '\n\n' + override;
        } else {
          body.messages.unshift({ role: 'system', content: override });
        }
      } else {
        // Diretiva autônoma de arquivos padrão (injeção quando app não tem override próprio)
        // Ensina a IA a NÃO perguntar "onde está o arquivo" e usar ferramentas para localizar.
        const autonomousFileDirective = `AUTONOMIA DE ARQUIVOS (Padrão do Proxy):
- NÃO pergunte "onde está o arquivo", "qual o caminho", "me dê o path".
- O usuário PODE ser leigo e não saber o caminho exato.
- Use as ferramentas disponíveis (glob, grep, read_file, list_dir) para LOCALIZAR e LER arquivos automaticamente.
- Se o usuário disser "altere o título do relatório", use glob/grep para achar "relatório", leia, e altere.
- Assuma que você tem acesso ao sistema de arquivos do projeto. Aja como engenheiro autônomo.

BUSCA POR CURINGA (Wildcard Search) — OBRIGATÓRIA EM FALHA DE CAMINHO EXATO:
- Se uma busca por caminho exato falhar (ex: "front_end", "src/components"), NÃO trave no literal.
- IMEDIATAMENTE use busca por curinga/regex: *front*, *src*, *component*, *dashboard*, etc.
- Use glob com padrões: **/*front*/**, **/front_end/**, **/*front*/**.
- Tente variações: front-end, front_end, frontend, front, FE, fe.
- A busca exata é tentativa 1; a busca por curinga é tentativa 2 AUTOMÁTICA.`;

        const existingSystem = body.messages.find(m => m.role === 'system');
        if (existingSystem) {
          existingSystem.content = autonomousFileDirective + '\n\n' + (existingSystem.content || '');
        } else {
          body.messages.unshift({ role: 'system', content: autonomousFileDirective });
        }
      }
    }

    // ── Auto Router: quando modelo="auto" ou "auto-free", seleciona o melhor
    // modelo (vale para o cliente direto e para apps do gateway com modelo auto).
    const isAutoMode = body.model === 'auto' || body.model === 'auto-free';
    const isBrowserOnly = body.model === 'auto-free';
    let autoFailoverChain: string[] = [];
    if (isAutoMode) {
      const resolved = await resolveAutoModel(c, body, isBrowserOnly);
      if (resolved.status || !resolved.model) {
        return c.json(
          { error: { message: resolved.message || 'Auto Router: sem modelo disponível.' } },
          (resolved.status || 503) as any
        );
      }
      body.model = resolved.model;
      autoFailoverChain = resolved.failoverChain || [];
    }
    autoRouted = c.get('autoRoutedModel') as string | undefined;

    let target: Provider = primary;

    if (gwEntry) {
      const entry = await resolveModelEntry(body.model, registry);
      if (entry) {
        target = providerFromCatalogEntry(entry);
      } else {
        // Fallback: tenta encontrar o provedor pela lista de modelos (igual à porta 3005)
        // Isso evita 404 quando o catálogo ainda não carregou os modelos do provedor API.
        const owner = await findProviderForModel(enabled, body.model);
        if (owner) {
          target = owner;
          console.log(`[gateway] modelo "${body.model}" roteado via fallback para provedor "${owner.name}" (${owner.type})`);
        } else {
          return c.json(
            {
              error: {
                message: `Modelo "${body.model}" não encontrado no catálogo. Configure o provedor na aba Conexão (a lista de modelos é carregada automaticamente).`,
              },
            },
            404
          );
        }
      }
    } else {
      // Porta 3005 (direta): o model enviado pelo cliente decide o provedor.
      const entry = await resolveModelEntry(body.model, registry);
      if (entry) {
        target = providerFromCatalogEntry(entry);
      } else {
        // Fallback: roteamento por nome de modelo conhecido (DeepSeek/Qwen)
        // ou, se nada reconhecer, o provedor principal.
        const deepseekEnabled = enabled.some((p) => isDeepseekProvider(p));
        const qwenEnabled = enabled.some((p) => isQwenProvider(p));
        if (isDeepseekModel(body.model) && deepseekEnabled) {
          target = enabled.find((p) => isDeepseekProvider(p)) ?? primary;
        } else if (isQwenModel(body.model) && qwenEnabled) {
          target = enabled.find((p) => isQwenProvider(p)) ?? primary;
        } else if (!isDeepseekModel(body.model) && !isQwenModel(body.model)) {
          const owner = await findProviderForModel(enabled, body.model);
          if (owner) target = owner;
        }
      }
    }

    // Modo economia de tokens: aplica as transformações configuradas ANTES de
    // encaminhar ao provedor (truncar/resumir histórico, remover raciocínio,
    // limitar saída de tools, marcar cache de prefixo).
    if (economy.enabled) {
      const { payload: ecoPayload, actions, estimatedTokens } = await applyTokenEconomy(body, economy, {
        summarize: async (dropped: any[]) => summarizeDropped(dropped, target),
        providerType: target?.type,
      });
      body = ecoPayload;
      if (economy.tokenEstimation) {
        console.log(
          `[economy] tokens~${estimatedTokens} janela=${economy.maxContextTokens} msgs=${body.messages.length} [${actions.join(', ') || 'sem ações'}]`
        );
      }
    }

    // Otimizações da Fase 1 (100% seguras): aplicadas ANTES de enviar ao provedor.
    // - Strip metadata: remove campos que o modelo não usa (created_at, etc.)
    // - Compress tools: encurta descrições mantendo nomes/parâmetros/tipos
    body = applyPhase1Optimizations(body, {
      stripMetadata: economy.stripMetadata,
      compressTools: economy.compressTools,
});
 
    // Reforço de contexto + limpeza de arquivo ativo: se a última mensagem do usuário
    // for uma confirmação curta (ex.: "pode implementar", "sim", "faz aí"), o Proxy:
    // Modo agente nativo — DESATIVADO no Gateway HTTP Puro: o proxy não executa
    // ferramentas localmente (sem I/O de arquivos, web_search, loop agêntico).
    // As Tool Calls do modelo são repassadas no payload HTTP/SSE para a IDE.
    if ((body as any).agent === true) {
      return c.json(
        {
          error: {
            message:
              'Modo agente (agent:true) desativado no Gateway HTTP Puro: o servidor não executa ferramentas localmente. ' +
              'Envie as ferramentas via tools[] e receba as tool_calls no formato OpenAI/Gemini compatível com a IDE.',
          },
        },
        400
      );
    }

    // Cache de respostas idênticas (apenas non-streaming): hash do payload
    // final (após economia). Se o mesmo request voltar, responde do cache.
    const cacheKey =
      economy.enabled && economy.responseCache && !isStream ? cachePayloadKey(body) : null;
    if (cacheKey) {
      const hit = responseCacheGet(cacheKey);
      if (hit) {
        console.log(`[economy] cache HIT ${cacheKey.slice(0, 10)}… (${hit.body.choices?.[0]?.message?.content?.length ?? 0} chars)`);
        return c.json(hit.body, hit.status as any);
      }
    }

    const maybeStoreCache = async (res: Response, modelId?: string): Promise<Response> => {
      // modelId é o modelo desta tentativa (no failover cada tentativa usa um
      // modelo diferente; fora dele usa o autoRouted original).
      const m = modelId ?? autoRouted;
      if (cacheKey && res.status === 200) {
        try {
          const json = await res.clone().json();
          if (hasMeaningfulContent(json)) {
            responseCacheSet(cacheKey, res.status, json);
            reportAutoOutcome(m, true);
          } else {
            console.log(`[economy] resposta vazia NÃO cacheada ${cacheKey.slice(0, 10)}…`);
            reportAutoOutcome(m, false, 'resposta vazia');
          }
        } catch {
          // stream ou corpo não-JSON: não cacheia
          reportAutoOutcome(m, res.status < 400);
        }
      } else {
        reportAutoOutcome(m, res.status < 400, res.status >= 400 ? `HTTP ${res.status}` : undefined);
      }
      return res;
    };

    // ── Failover automático (provedores não-DeepSeek) ─────────────────────
    // Quando o modelo roteado falhar (erro HTTP/resposta vazia), tenta o
    // próximo melhor modelo da cadeia antes de devolver erro ao cliente. Cada
    // tentativa alimenta o circuit breaker e as métricas do modelo tentado.
    if (autoFailoverChain.length > 1) {
      const failoverRes = await attemptFailoverChain(c, body, registry, enabled, primary, autoFailoverChain, maybeStoreCache);
      if (failoverRes) return failoverRes;
    }

    // Mede latência do request para as métricas do modelo (apenas auto-router).
    const trackSend = async (modelId: string | undefined, fn: () => Promise<Response>): Promise<Response> => {
      const t0 = Date.now();
      if (modelId) recordModelRequest(modelId);
      const res = await fn();
      if (modelId) recordModelLatency(modelId, Date.now() - t0);
      return res;
    };

    // Prompt Caching: aplica cache_control (Anthropic) ou garante system estável (OpenAI)
    body = applyPromptCaching(body, target);

    if (isQwenProvider(target)) {
      return await trackSend(autoRouted, async () => {
        const res = await maybeStoreCache(await qwenChatCompletions(c, body));
        return applyAntiLazyLoop(c, res, body, target);
      });
    }

    if (isGeminiWebProvider(target)) {
      return await trackSend(autoRouted, async () => {
        const res = await maybeStoreCache(await geminiChatCompletions(c, body));
        return applyAntiLazyLoop(c, res, body, target);
      });
    }

    if (!isDeepseekProvider(target)) {
      return await trackSend(autoRouted, async () => {
        const res = await maybeStoreCache(await forwardChatCompletions(c, body, target));
        return applyAntiLazyLoop(c, res, body, target);
      });
    }

    const finalPrompt = buildAgentPrompt(body, { booster: isModelBoosted(body.model) });
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
      const t0 = Date.now();
      if (autoRouted) recordModelRequest(autoRouted);
      const res = await handleDeepSeekNonStreaming(c, body, finalPrompt, isThinkingModel, isNewSession, refFileIds, visionOpts);
      if (autoRouted) recordModelLatency(autoRouted, Date.now() - t0);
      reportAutoOutcome(autoRouted, res.status < 400, res.status >= 400 ? `HTTP ${res.status}` : undefined);
      return res;
    }

    // Empty response retry logic
    const t0 = Date.now();
    if (autoRouted) recordModelRequest(autoRouted);
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
    if (autoRouted) recordModelLatency(autoRouted, Date.now() - t0);

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

                        const toolCallObj = robustParseJSON(toolJsonStr);
                        const toolId = 'call_' + uuidv4();

                        // Scanner de tool_call: sanitiza os caminhos (relativo -> absoluto via
                        // x-workspace-root; '\' -> '/') antes de entregar à IDE.
                        const safeArgs = sanitizeToolCallArguments(
                          toolCallObj.name,
                          toolCallObj.arguments,
                          relayWorkspaceRoot
                        );
                        const normalizedArgs = safeArgs;

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
                                arguments: typeof normalizedArgs === 'object'
                                  ? JSON.stringify(normalizedArgs)
                                  : String(normalizedArgs || '')
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

      stopKeepAlive();

      console.log(
        `[chat] done model=${body.model} ${Date.now() - startedAt}ms tokens=${completionTokens + promptTokens} finish=${finalFinishReason}`
      );
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    reportAutoOutcome(autoRouted, false, err?.message);
    return c.json({ error: { message: err.message } }, 500);
  }
}
