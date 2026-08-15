/*
 * File: token-economy.ts
 * Project: deepsproxy
 * Modo Economia de Tokens: conjunto de otimizações configuráveis, aplicadas
 * ANTES de encaminhar a requisição ao provedor. Cada opção é independente e
 * pode ser ligada/desligada no painel (aba Apps -> "Modo Economia de Tokens").
 *
 * Opções:
 *  - enabled (master): desliga todas as outras;
 *  - cachePrefix: mantém prefixo estável e marca cache_control (Anthropic);
 *  - truncateHistory: corta turnos antigos quando o histórico estoura a janela;
 *  - summarizeHistory: resume turnos que seriam descartados pelo truncamento;
 *  - stripReasoning: remove reasoning_content (pensamento) do histórico;
 *  - truncateToolOutput: limita o tamanho de resultados de ferramentas;
 *  - responseCache: cache de respostas idênticas (hash do payload);
 *  - tokenEstimation: estima tokens por requisição e loga no servidor.
 *
 * As configurações são persistidas em `gateway-economy.json` (ou o arquivo
 * definido por ECONOMY_FILE), ao lado de `gateway-apps.json`.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export interface TokenEconomySettings {
  /** Master: se false, nenhuma das opções abaixo é aplicada. */
  enabled: boolean;
  /** cachePrefix: prompt caching (prefixo estável + cache_control). */
  cachePrefix: boolean;
  /** truncateHistory: cortar turnos antigos pela janela de contexto. */
  truncateHistory: boolean;
  /** summarizeHistory: resumir os turnos que seriam descartados. */
  summarizeHistory: boolean;
  /** stripReasoning: não reenviar o raciocínio no histórico. */
  stripReasoning: boolean;
  /** truncateToolOutput: limitar resultado de tools enviado ao modelo. */
  truncateToolOutput: boolean;
  /** responseCache: devolver respostas idênticas do cache. */
  responseCache: boolean;
  /** tokenEstimation: estimar tokens por request e logar. */
  tokenEstimation: boolean;
  /** Janela máxima de contexto (tokens) usada pelo truncateHistory. */
  maxContextTokens: number;
}

export const DEFAULT_ECONOMY: TokenEconomySettings = {
  enabled: false,
  cachePrefix: true,
  truncateHistory: false,
  summarizeHistory: false,
  stripReasoning: false,
  truncateToolOutput: false,
  responseCache: false,
  tokenEstimation: false,
  maxContextTokens: 56000,
};

/** Tamanho máximo de um resultado de tool enviado ao modelo. */
export const TOOL_OUTPUT_MAX_CHARS = 4000;
/** TTL do cache de respostas idênticas. */
export const CACHE_TTL_MS = 60_000;
/** Nº máximo de entradas no cache de respostas. */
export const CACHE_MAX_ENTRIES = 200;
/** max_tokens usado na chamada de resumo. */
export const SUMMARY_MAX_TOKENS = 512;

function economyFile(): string {
  return process.env.ECONOMY_FILE || join(process.cwd(), 'gateway-economy.json');
}

let economyCache: TokenEconomySettings | null = null;

function loadEconomy(): TokenEconomySettings {
  if (economyCache) return economyCache;
  try {
    const file = economyFile();
    if (!existsSync(file)) {
      economyCache = { ...DEFAULT_ECONOMY };
      return economyCache;
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    economyCache = { ...DEFAULT_ECONOMY, ...raw, maxContextTokens: sanitizeWindow(raw.maxContextTokens) };
  } catch {
    economyCache = { ...DEFAULT_ECONOMY };
  }
  return economyCache ?? { ...DEFAULT_ECONOMY };
}

function persistEconomy(): void {
  try {
    const file = economyFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(economyCache ?? DEFAULT_ECONOMY, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[economy] falha ao persistir em ${economyFile()}:`, err.message);
  }
}

function sanitizeWindow(v: any, fallback: number = DEFAULT_ECONOMY.maxContextTokens): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sanitizeBool(v: any, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Invalida o cache em memória (usado em testes). */
export function resetEconomyCache(): void {
  economyCache = null;
}

/** Configuração atual do modo economia (cópia). */
export function getTokenEconomy(): TokenEconomySettings {
  return { ...loadEconomy() };
}

/** Atualiza (parcialmente) e persiste a configuração do modo economia. */
export function updateTokenEconomy(patch: Partial<TokenEconomySettings>): TokenEconomySettings {
  const current = loadEconomy();
  const next: TokenEconomySettings = {
    enabled: sanitizeBool(patch.enabled, current.enabled),
    cachePrefix: sanitizeBool(patch.cachePrefix, current.cachePrefix),
    truncateHistory: sanitizeBool(patch.truncateHistory, current.truncateHistory),
    summarizeHistory: sanitizeBool(patch.summarizeHistory, current.summarizeHistory),
    stripReasoning: sanitizeBool(patch.stripReasoning, current.stripReasoning),
    truncateToolOutput: sanitizeBool(patch.truncateToolOutput, current.truncateToolOutput),
    responseCache: sanitizeBool(patch.responseCache, current.responseCache),
    tokenEstimation: sanitizeBool(patch.tokenEstimation, current.tokenEstimation),
    maxContextTokens: sanitizeWindow(patch.maxContextTokens, current.maxContextTokens),
  };
  economyCache = next;
  persistEconomy();
  return { ...next };
}

/* ------------------------- Estimativa de tokens ------------------------- */

const AVG_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text || '').length / AVG_CHARS_PER_TOKEN));
}

function messageText(msg: any): string {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p === 'string' ? p : ''))
      .join(' ');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

/** Estimativa de tokens do conjunto de mensagens (heurística chars/4). */
export function estimateMessagesTokens(messages: any[]): number {
  let total = 0;
  for (const m of messages || []) {
    total += estimateTokens(messageText(m));
  }
  return total;
}

/* ------------------------- Transformações de mensagens ------------------------- */

/** Remove reasoning_content (raciocínio) de mensagens assistant. */
export function stripReasoningFromMessages(messages: any[]): any[] {
  return (messages || []).map((m) => {
    if (m?.role !== 'assistant' || m?.reasoning_content === undefined) return m;
    const copy = { ...m };
    delete copy.reasoning_content;
    return copy;
  });
}

/** Limita o conteúdo de mensagens role tool/function a maxChars. */
export function truncateToolMessages(
  messages: any[],
  maxChars: number
): { messages: any[]; truncated: number } {
  const limit = maxChars > 0 ? maxChars : TOOL_OUTPUT_MAX_CHARS;
  let truncated = 0;
  const out = (messages || []).map((m) => {
    if (m?.role !== 'tool' && m?.role !== 'function') return m;
    const text = messageText(m);
    if (text.length <= limit) return m;
    truncated++;
    const copy = { ...m, content: text.slice(0, limit) + `\n…[truncado: ${text.length} chars]` };
    return copy;
  });
  return { messages: out, truncated };
}

/**
 * Corta turnos antigos para caber na janela. Sempre preserva as mensagens de
 * system do início e a ÚLTIMA mensagem. Retorna as descartadas para permitir
 * o resumo (summarizeHistory).
 */
export function truncateMessages(messages: any[], maxTokens: number): { messages: any[]; dropped: any[] } {
  const input = messages || [];
  if (estimateMessagesTokens(input) <= maxTokens) return { messages: [...input], dropped: [] };
  if (input.length <= 2) return { messages: [...input], dropped: [] };

  const out: any[] = [];
  const dropped: any[] = [];
  let idx = 0;
  while (idx < input.length && input[idx].role === 'system') {
    out.push(input[idx]);
    idx++;
  }
  const last = input[input.length - 1];
  const middle = input.slice(idx, input.length - 1);
  for (const m of middle) {
    if (estimateMessagesTokens([...out, m, last]) <= maxTokens) {
      out.push(m);
    } else {
      dropped.push(m);
    }
  }
  out.push(last);
  return { messages: out, dropped };
}

/** Digest determinístico dos turnos descartados (fallback do resumo). */
export function buildSummaryDigest(dropped: any[]): string {
  const parts: string[] = [];
  let used = 0;
  const budget = 1400;
  for (const m of dropped || []) {
    const label = m.role === 'assistant' ? 'Resposta' : m.role === 'user' ? 'Usuário' : String(m.role || 'msg');
    const text = messageText(m).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const snippet = text.length > 160 ? text.slice(0, 160) + '…' : text;
    const line = `${label}: ${snippet}`;
    used += line.length;
    if (used > budget) break;
    parts.push(line);
  }
  return parts.join('\n').slice(0, budget);
}

/** Insere o resumo logo após as mensagens de system (ou no início). */
function insertSummary(messages: any[], summary: string): any[] {
  const note = `[Resumo do histórico anterior]\n${summary}`;
  const idx = messages.findIndex((m) => m?.role !== 'system');
  if (idx <= 0) return [{ role: 'system', content: note }, ...messages];
  const head = messages.slice(0, idx);
  const first = { ...head[0], content: head[0].content + '\n\n' + note };
  return [first, ...messages.slice(1)];
}

/* ------------------------- Aplicação da economia ------------------------- */

export interface EconomyApplyOptions {
  /**
   * Resumidor opcional (LLM). Recebe as mensagens descartadas e devolve o
   * resumo. Se ausente ou se lançar, usa o digest local.
   */
  summarize?: (dropped: any[]) => Promise<string>;
}

export interface EconomyApplyResult {
  payload: any;
  /** Descrição das ações aplicadas (para log). */
  actions: string[];
  /** Estimativa de tokens do histórico final. */
  estimatedTokens: number;
}

/**
 * Aplica as transformações do modo economia num payload OpenAI.
 * Retorna um NOVO payload (as mensagens originais não são mutadas).
 * Sempre re-aplica `maxContextTokens` de truncateHistory/summarizeHistory.
 */
export async function applyTokenEconomy(
  payload: any,
  settings: TokenEconomySettings,
  options: EconomyApplyOptions = {}
): Promise<EconomyApplyResult> {
  const actions: string[] = [];
  if (!settings.enabled) {
    return { payload: { ...payload, messages: [...(payload.messages || [])] }, actions, estimatedTokens: estimateMessagesTokens(payload.messages) };
  }

  let messages = [...(payload.messages || [])];

  if (settings.stripReasoning) {
    messages = stripReasoningFromMessages(messages);
    actions.push('stripReasoning');
  }

  if (settings.truncateToolOutput) {
    const { messages: kept, truncated } = truncateToolMessages(messages, TOOL_OUTPUT_MAX_CHARS);
    if (truncated > 0) actions.push(`toolOutput(${truncated} truncadas)`);
    messages = kept;
  }

  const maxTokens = settings.maxContextTokens > 0 ? settings.maxContextTokens : DEFAULT_ECONOMY.maxContextTokens;
  const wantsTruncate = settings.truncateHistory || settings.summarizeHistory;
  if (wantsTruncate) {
    const est = estimateMessagesTokens(messages);
    if (est > maxTokens) {
      const { messages: kept, dropped } = truncateMessages(messages, maxTokens);
      if (dropped.length > 0) {
        if (settings.summarizeHistory) {
          let summary = '';
          let method = 'digest';
          if (options.summarize) {
            try {
              const s = await options.summarize(dropped);
              if (s && s.trim()) {
                summary = s.trim();
                method = 'llm';
              }
            } catch {
              // fallback para digest
            }
          }
          if (!summary) summary = buildSummaryDigest(dropped);
          messages = insertSummary(kept, summary);
          actions.push(`summary(${method}, ${dropped.length} turnos)`);
        } else {
          actions.push(`truncate(${kept.length} mantidas, ${dropped.length} descartadas)`);
          messages = kept;
        }
      }
    }
  }

  const next = { ...payload, messages };
  if (settings.cachePrefix) {
    next._eco = { cachePrefix: true };
  }

  return { payload: next, actions, estimatedTokens: estimateMessagesTokens(messages) };
}

/* ------------------------- Cache de respostas idênticas ------------------------- */

/** Chave estável do payload (independente da ordem das chaves do JSON). */
export function cachePayloadKey(payload: any): string {
  const { model, messages, tools, tool_choice, temperature, max_tokens, top_p } = payload as any;
  const canonical = JSON.stringify({
    model: model || '',
    messages: messages || [],
    tools: tools || undefined,
    tool_choice: tool_choice || undefined,
    temperature: temperature ?? undefined,
    max_tokens: max_tokens ?? undefined,
    top_p: top_p ?? undefined,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

interface CacheEntry {
  ts: number;
  status: number;
  body: any;
}

/** Store interno do cache (exportado para inspeção em testes). */
export const _responseCacheStore = new Map<string, CacheEntry>();

export function responseCacheGet(key: string): { status: number; body: any } | null {
  const entry = _responseCacheStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _responseCacheStore.delete(key);
    return null;
  }
  return { status: entry.status, body: entry.body };
}

export function responseCacheSet(key: string, status: number, body: any): void {
  if (_responseCacheStore.size >= CACHE_MAX_ENTRIES) {
    const oldest = _responseCacheStore.keys().next().value;
    if (oldest) _responseCacheStore.delete(oldest);
  }
  _responseCacheStore.set(key, { ts: Date.now(), status, body });
}

export function responseCacheSize(): number {
  return _responseCacheStore.size;
}

/** Limpa o cache de respostas (usado em testes). */
export function resetResponseCache(): void {
  _responseCacheStore.clear();
}
