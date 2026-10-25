/*
 * File: fusion.ts
 * Project: deepsproxy
 * Fusion multi-modelo: modelo virtual que roda uma "banca" de modelos em
 * paralelo e sintetiza uma resposta única com um "juiz" (ou retorna a melhor
 * resposta, strategy=best_of). Portado conceitualmente do freellmapi
 * (server/src/services/fusion.ts) e adaptado ao dispatch do deepsproxy
 * (forwardChatCompletions / qwenChatCompletions), sem SQLite/zod.
 *
 * Formas de usar (model):
 *   fusion                 → banca automática (diversidade de provedor + família)
 *   fusion:m1,m2,m3        → banca explícita (ids de modelo do catálogo)
 * Opções no body (campo `fusion`):
 *   { judge, strategy: 'synthesize'|'best_of', expose_panel, k }
 *
 * Piada de design: tool calls NÃO são sintetizados (são ações, não prosa) —
 * se um membro da banca devolver tool_calls, ele vence direto sem juiz. Como o
 * passthrough deste proxy remove tools de provedores compatíveis (só o
 * deepseek-inline conversa tool_calls), na prática o fusion sintetiza prosa.
 */

import { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { stream as honoStream } from 'hono/streaming';
import type { Provider, ProviderRegistry } from './config.ts';
import { isQwenProvider } from './config.ts';
import { resolveModelEntry, providerFromCatalogEntry, getModelCatalog } from './modelCatalog.ts';
import { forwardChatCompletions } from './local.ts';
import { qwenChatCompletions } from '../routes/qwen.ts';
import { getTokenEconomy, applyTokenEconomy } from './token-economy.ts';
import { routedViaValue } from '../utils/header-value.ts';
import { startKeepAlive } from '../utils/sse.ts';

export const FUSION_MODEL_ID = 'fusion';

export function isFusionModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return lower === FUSION_MODEL_ID || lower.startsWith(`${FUSION_MODEL_ID}:`);
}

// Banca: padrão 3, teto 5 (ambos ajustáveis por env).
const DEFAULT_PANEL_K = 3;
const HARD_MAX_PANEL_K = 5;
const SYNTHESIS_QUORUM = 2;
const PANEL_TIMEOUT_MS = 20_000;
const JUDGE_TIMEOUT_MS = 30_000;

function panelK(): number {
  const raw = process.env.FUSION_K;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, HARD_MAX_PANEL_K) : DEFAULT_PANEL_K;
}

export function getFusionMaxK(): number {
  return HARD_MAX_PANEL_K;
}

export function familyKey(modelId: string): string {
  return modelId.toLowerCase().replace(/^.*\//, '').replace(/:.*$/, '');
}

/** Diversifica a lista por provedor E família de modelo (fiel ao freellmapi). */
export function diversifyPanelMembers<T extends { modelId: string; provider: Provider }>(ordered: T[]): T[] {
  const seenPlatform = new Set<string>();
  const platformFirst: T[] = [];
  const platformRest: T[] = [];
  for (const c of ordered) {
    if (seenPlatform.has(c.provider.name)) platformRest.push(c);
    else {
      seenPlatform.add(c.provider.name);
      platformFirst.push(c);
    }
  }
  const seenFamily = new Set<string>();
  const fresh: T[] = [];
  const dupFamily: T[] = [];
  for (const c of [...platformFirst, ...platformRest]) {
    const fam = familyKey(c.modelId);
    if (seenFamily.has(fam)) dupFamily.push(c);
    else {
      seenFamily.add(fam);
      fresh.push(c);
    }
  }
  return [...fresh, ...dupFamily];
}

// Tipos que podem responder em JSON via forwardChatCompletions (API/adapters).
const API_TYPES = new Set(['gemini', 'anthropic', 'ollama', 'openai-compatible']);

export interface FusionMember {
  modelId: string;
  provider: Provider;
}

/** Seleciona a banca: lista explícita (fusion:a,b) ou automática diversa. */
export async function selectFusionPanel(
  explicitIds: string[] | undefined,
  registry: ProviderRegistry,
  enabled: Provider[]
): Promise<{ panel: FusionMember[]; dropped: string[] }> {
  const maxK = HARD_MAX_PANEL_K;
  const dropped: string[] = [];

  if (explicitIds && explicitIds.length > 0) {
    const panel: FusionMember[] = [];
    const seen = new Set<string>();
    for (const id of explicitIds) {
      if (panel.length >= maxK) {
        dropped.push(`${id} (over cap of ${maxK})`);
        continue;
      }
      const entry = await resolveModelEntry(id, registry);
      if (!entry) {
        dropped.push(`${id} (desconhecido ou desabilitado)`);
        continue;
      }
      const provider = providerFromCatalogEntry(entry);
      const key = `${provider.name}/${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      panel.push({ modelId: id, provider });
    }
    return { panel, dropped };
  }

  const enabledNames = new Set(enabled.map((p) => p.name));
  const members: FusionMember[] = [];
  for (const entry of (await getModelCatalog()) ?? []) {
    const provider = providerFromCatalogEntry(entry);
    if (!enabledNames.has(provider.name)) continue;
    if (!API_TYPES.has(provider.type)) continue;
    members.push({ modelId: entry.id, provider });
  }

  const panel = diversifyPanelMembers(members).slice(0, panelK());
  return { panel, dropped: [] };
}

interface PanelAnswer {
  modelId: string;
  providerName: string;
  status: 'ok' | 'failed';
  content?: string;
  toolCalls?: any[];
  rawMessage?: any;
  finishReason?: string;
  usage?: any;
  error?: string;
}

async function runPanelMember(
  c: Context,
  body: any,
  member: FusionMember,
  timeoutMs: number
): Promise<PanelAnswer> {
  const satBody = { ...body, stream: false };
  const started = Date.now();
  const run = (): Promise<PanelAnswer> =>
    Promise.resolve()
      .then(async (): Promise<PanelAnswer> => {
        const res = isQwenProvider(member.provider)
          ? await qwenChatCompletions(c, satBody)
          : await forwardChatCompletions(c, satBody, member.provider);
        if (!res) throw new Error('sem resposta');
        let data: any;
        try {
          data = await res.json();
        } catch {
          throw new Error(`HTTP ${res.status} (corpo não-JSON)`);
        }
        if (!res.ok) {
          const msg = data?.error?.message || `HTTP ${res.status}`;
          throw new Error(String(msg));
        }
        const choice = data?.choices?.[0];
        const message = choice?.message;
        const content =
          typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
            ? message.content
                .map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
                .join('')
            : '';
        const toolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : undefined;
        if (!content && !toolCalls) {
          throw new Error('empty completion');
        }
        return {
          modelId: member.modelId,
          providerName: member.provider.name,
          status: 'ok',
          content: content || undefined,
          toolCalls,
          rawMessage: message,
          finishReason: choice?.finish_reason,
          usage: data?.usage,
        };
      })
      .catch((err: any): PanelAnswer => ({
        modelId: member.modelId,
        providerName: member.provider.name,
        status: 'failed',
        error: err?.message || String(err),
      }));

  const timer = new Promise<PanelAnswer>((resolve) =>
    setTimeout(
      () => resolve({ modelId: member.modelId, providerName: member.provider.name, status: 'failed', error: 'timeout' }),
      timeoutMs
    )
  );
  const answer = await Promise.race([run(), timer]);
  if (answer.status === 'ok') {
    console.log(`[fusion] banca ok ${member.provider.name}/${member.modelId} (${Date.now() - started}ms)`);
  } else {
    console.warn(`[fusion] banca falhou ${member.provider.name}/${member.modelId}: ${answer.error}`);
  }
  return answer;
}

const JUDGE_SYSTEM_PROMPT =
  'You are the final author of a single answer. Several AI assistants each independently answered the user\'s most recent message; their answers are provided below, anonymized as "Response 1", "Response 2", etc. ' +
  'IMPORTANT: the user will NEVER see any of those individual responses — they only ever see what you write — so your answer must be COMPLETE and fully STAND-ALONE on its own. ' +
  'Take the best parts of every response, combine the correct and most useful ideas into one coherent whole, resolve any contradictions by reasoning about which is actually right (do not just average or list options), and fill in anything they all missed. ' +
  'Then REWRITE it all from scratch, in your own words, as one clear, well-structured, self-contained answer that makes complete sense by itself. ' +
  'Do not mention that other answers exist, do not refer to "Response 1/2/3", do not compare the responses, and do not describe your process — just deliver the final, authoritative answer directly to the user.';

function buildJudgeMessages(messages: any[], answers: PanelAnswer[]): any[] {
  const ok = answers.filter((a) => a.status === 'ok' && a.content);
  const panelBlock = ok.map((a, i) => `--- Response ${i + 1} ---\n${a.content}`).join('\n\n');
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    ...messages,
    {
      role: 'user',
      content:
        `Here are ${ok.length} independent answers to my most recent message:\n\n${panelBlock}\n\n` +
        'Take the best parts of these, then rewrite one complete, self-contained answer to my most recent message in your own words. ' +
        'I will only see your answer — not these — so do not reference them.',
    },
  ];
}

async function runJudge(
  c: Context,
  messages: any[],
  judgeProvider: Provider,
  timeoutMs: number
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const satBody = { messages, model: judgeProvider.model || messages[0]?.model, stream: false, temperature: 0.4 };
  const run = (): Promise<{ ok: boolean; text?: string; error?: string }> =>
    Promise.resolve()
      .then(async () => {
        const res = isQwenProvider(judgeProvider)
          ? await qwenChatCompletions(c, satBody)
          : await forwardChatCompletions(c, satBody, judgeProvider);
        if (!res) throw new Error('sem resposta');
        let data: any;
        try {
          data = await res.json();
        } catch {
          throw new Error(`HTTP ${res.status} (corpo não-JSON)`);
        }
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
        const text =
          typeof data?.choices?.[0]?.message?.content === 'string'
            ? data.choices[0].message.content
            : '';
        if (!text) throw new Error('empty judge completion');
        return { ok: true, text };
      })
      .catch((err: any) => ({ ok: false, error: err?.message || String(err) }));
  const timer = new Promise<{ ok: boolean; error?: string }>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs)
  );
  return Promise.race([run(), timer]);
}

export interface FusionConfigInput {
  models?: string[];
  judge?: string;
  strategy?: 'synthesize' | 'best_of';
  expose_panel?: boolean;
  k?: number;
}

/** Executa a requisição fusion e devolve a Response final (stream ou JSON). */
export async function runFusionChat(
  c: Context,
  body: any,
  registry: ProviderRegistry,
  enabled: Provider[],
  primary: Provider
): Promise<Response> {
  // Config inline vinda do body (campo `fusion`) sobre o default.
  const rawSpec = typeof body.model === 'string' ? body.model : '';
  const explicit =
    rawSpec.startsWith(`${FUSION_MODEL_ID}:`)
      ? rawSpec
          .slice(FUSION_MODEL_ID.length + 1)
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined;
  const fusionCfg: FusionConfigInput =
    body.fusion && typeof body.fusion === 'object' ? body.fusion : {};
  const k = fusionCfg.k ?? panelK();
  const strategy = fusionCfg.strategy ?? 'synthesize';
  const exposePanel = !!fusionCfg.expose_panel;
  const isStream = body.stream ?? false;

  const { panel, dropped } = await selectFusionPanel(explicit ?? fusionCfg.models, registry, enabled);
  if (panel.length === 0) {
    return c.json(
      {
        error: {
          message:
            'fusion: nenhum modelo disponível para a banca. Passe fusion:m1,m2,m3 com modelos do catálogo habilitados.',
        },
      },
      400
    );
  }
  const targets = [...panel].slice(0, Math.min(k, panel.length));

  // Aplica o modo economia ao payload da banca (uma vez, reutilizado por todos).
  const economy = getTokenEconomy();
  const ecoResult = await applyTokenEconomy(body, economy, {});
  const panelBody = ecoResult.payload;

  // Banca: paralela para prosa; limits de tempo por membro.
  const answers: PanelAnswer[] = await Promise.all(
    targets.map((m) => runPanelMember(c, panelBody, m, PANEL_TIMEOUT_MS))
  );

  const survivors = answers.filter((a) => a.status === 'ok' && (a.content || (a.toolCalls?.length ?? 0) > 0));

  if (survivors.length === 0) {
    return c.json(
      {
        error: {
          message:
            'fusion: todos os modelos da banca falharam ou foram limitados. Tente novamente ou escolha outros fusion.models.',
        },
      },
      429
    );
  }

  // tool_calls vencem direto — ações não são sintetizadas.
  const toolCallWinner = survivors.find((a) => (a.toolCalls?.length ?? 0) > 0);
  if (toolCallWinner) {
    const finalMsg = {
      role: 'assistant',
      content: toolCallWinner.content ?? null,
      tool_calls: toolCallWinner.toolCalls,
    };
    const response = buildFusionResponse(body.model, finalMsg, 'tool_calls', survivors, false, null, {
      panelAll: answers,
      dropped,
      exposePanel,
      strategy,
    });
    c.set('usageProviderName', 'fusion');
    c.set('usageFinalModel', `tool_call:${toolCallWinner.modelId}`);
    c.header('X-Routed-Via', routedViaValue('fusion', `tool_call:${toolCallWinner.modelId}`));
    return emitFusionResponse(c, response, isStream);
  }

  const textSurvivors = survivors.filter((a) => a.content);

  // Decide resposta final.
  let finalText: string;
  let synthesized = false;
  let judgeLabel: string | null = null;

  if (textSurvivors.length < SYNTHESIS_QUORUM || strategy === 'best_of') {
    finalText = textSurvivors
      .slice()
      .sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
  } else {
    const judgeMessages = buildJudgeMessages(panelBody.messages, textSurvivors);
    const judgeProvider =
      (fusionCfg.judge ? panel.find((m) => m.modelId === fusionCfg.judge)?.provider : undefined) ||
      primary;
    const judge = await runJudge(c, judgeMessages, judgeProvider, JUDGE_TIMEOUT_MS);
    if (judge.ok && judge.text) {
      finalText = judge.text;
      synthesized = true;
      judgeLabel = `${judgeProvider.name}`;
    } else {
      console.warn(`[fusion] juiz falhou (${judge.error}); usando best_of da banca`);
      finalText = textSurvivors
        .slice()
        .sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
    }
  }

  const finalMsg = { role: 'assistant', content: finalText };
  const response = buildFusionResponse(body.model, finalMsg, 'stop', textSurvivors, synthesized, judgeLabel, {
    panelAll: answers,
    dropped,
    exposePanel,
    strategy,
  });

  const via = `fusion(${textSurvivors.map((a) => a.modelId).join('+')}${synthesized && judgeLabel ? ` -> ${judgeLabel}` : ''})`;
  c.set('usageProviderName', 'fusion');
  c.set('usageFinalModel', via.slice('fusion('.length, -1));
  c.header('X-Routed-Via', routedViaValue('fusion', via.slice('fusion('.length, -1)));

  console.log(`[fusion] via=${via} stream=${isStream ? 'yes' : 'no'} banca=${targets.length}`);
  return emitFusionResponse(c, response, isStream);
}

function buildFusionResponse(
  model: string,
  message: any,
  finishReason: string,
  survivors: PanelAnswer[],
  synthesized: boolean,
  judge: string | null,
  meta: { panelAll: PanelAnswer[]; dropped: string[]; exposePanel: boolean; strategy: string }
): any {
  const resp: any = {
    id: `fusion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(String(message.content || '').length / 4),
      total_tokens: Math.ceil(String(message.content || '').length / 4),
    },
    _fusion: {
      panel: survivors.map((a) => ({ model: a.modelId, provider: a.providerName })),
      judge,
      synthesized,
      strategy: meta.strategy,
    },
  };
  if (meta.exposePanel) {
    resp.x_fusion = {
      strategy: meta.strategy,
      synthesized,
      judge,
      panel_requested: survivors.map((a) => a.modelId),
      dropped: meta.dropped,
      panel: meta.panelAll.map((a) => ({
        model: a.modelId,
        provider: a.providerName,
        status: a.status,
        ...(a.status === 'ok' ? { content: a.content, tool_calls: a.toolCalls } : { error: a.error }),
      })),
    };
  }
  return resp;
}

function emitFusionResponse(c: Context, response: any, isStream: boolean): Response {
  if (!isStream) return c.json(response);

  const completionId = 'chatcmpl-' + uuidv4();
  const created = Math.floor(Date.now() / 1000);
  const content = response.choices[0].message.content || '';
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return honoStream(c, async (streamWriter: any) => {
    const stopKeepAlive = startKeepAlive((chunk) => streamWriter.write(chunk));
    const writeEvent = async (data: any) => {
      await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const chunk = (delta: any, finish: string | null = null) => ({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: response.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });

    await writeEvent(chunk({ role: 'assistant', content: '' }));
    if (content) await writeEvent(chunk({ content }));
    await writeEvent({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: response.model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: response.choices[0].finish_reason }],
      usage: response.usage,
    });
    await streamWriter.write('data: [DONE]\n\n');
    stopKeepAlive();
  });
}