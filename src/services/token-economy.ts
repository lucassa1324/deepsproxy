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
  /** compressTools: comprimir definições de tools (descrições). */
  compressTools: boolean;
  /** stripMetadata: remover metadados desnecessários do payload. */
  stripMetadata: boolean;
  /** smartTruncation: truncar por importância em vez de ordem cronológica. */
  smartTruncation: boolean;
  /** dedupConsecutive: remover mensagens consecutivas idênticas. */
  dedupConsecutive: boolean;
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
  compressTools: true,
  stripMetadata: true,
  smartTruncation: false,
  dedupConsecutive: false,
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

/**
 * Janelas de contexto efetivas por tipo de provedor (tokens). Ajusta o teto
 * global do usuário aos limites reais de cada provedor: para provedores com
 * janela curta (gemini-web) o corte da economia acontece antes e de forma mais
 * suave (preservando a cauda); para provedores com janela grande o teto do
 * usuário continua valendo (nunca aumentamos além dele).
 */
export const PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-web': 20000,
  deepseek: 120000,
  qwen: 60000,
  gemini: 980000,
  anthropic: 190000,
  'openai-compatible': 120000,
};

/**
 * Janela de contexto efetiva para um provedor. Sem tipo → retorna o teto base.
 * Com tipo → `min(base, janela do provedor)`: nunca aumenta o orçamento do
 * usuário, só impede que a economia prometa mais contexto do que o provedor
 * consegue segurar (o que levaria o provedor a cortar a cauda com violência).
 */
export function contextWindowFor(providerType: string | undefined, base: number): number {
  if (!providerType) return base;
  const window = PROVIDER_CONTEXT_WINDOWS[providerType];
  if (!window) return base;
  return Math.min(base, window);
}

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
    compressTools: sanitizeBool(patch.compressTools, current.compressTools),
    stripMetadata: sanitizeBool(patch.stripMetadata, current.stripMetadata),
    smartTruncation: sanitizeBool(patch.smartTruncation, current.smartTruncation),
    dedupConsecutive: sanitizeBool(patch.dedupConsecutive, current.dedupConsecutive),
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

/* ------------------------- 2.1 Smart Truncation (importância) ------------------------- */

/**
 * Score de importância de uma mensagem (maior = mais importante).
 * Critérios:
 *  1. System prompt → sempre fica (não chega aqui)
 *  2. Tool calls/results → densas de informação
 *  3. Mensagens com código, números ou dados específicos
 *  4. Mensagens longas (>200 chars)
 *  5. Mensagens curtas ("ok", "entendi") → baixa prioridade
 */
function messageImportance(msg: any): number {
  const text = messageText(msg);
  const len = text.length;

  // Tool calls e results são sempre importantes
  if (msg.role === 'tool' || msg.role === 'function') return 100;
  if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return 90;

  // Mensagens com código, números ou dados específicos
  const hasCode = /```|`[^`]+`|import |export |function |class |def |const |let |var /.test(text);
  const hasNumbers = /\d{2,}/.test(text);
  const hasData = /\btrue\b|\bfalse\b|\bnull\b|\bundefined\b|\b\d+\.\d+\b/.test(text);

  let score = 0;
  if (hasCode) score += 40;
  if (hasNumbers) score += 10;
  if (hasData) score += 10;

  // Mensagens longas são mais informativas
  if (len > 500) score += 30;
  else if (len > 200) score += 20;
  else if (len > 50) score += 10;

  // Mensagens curtas demais ("ok", "sim", "obrigado") são menos importantes
  if (len < 10) score -= 20;
  else if (len < 30) score -= 10;

  // Tool results com output longo são muito importantes
  if (msg.role === 'tool' || msg.role === 'function') {
    if (len > 1000) score += 50;
    else if (len > 200) score += 30;
  }

  return Math.max(0, score);
}

/**
 * Truncamento inteligente por importância: em vez de cortar pelas mensagens
 * mais antigas, descarta as menos importantes primeiro.
 *
 * Regras obrigatórias:
 *  - System prompts SEMPRE ficam
 *  - Últimas 3 mensagens SEMPRE ficam
 *  - Mensagens são ordenadas por importância (menor primeiro) e descartadas
 *    até caber na janela
 */
export function smartTruncateMessages(
  messages: any[],
  maxTokens: number
): { messages: any[]; dropped: any[] } {
  const input = messages || [];
  if (estimateMessagesTokens(input) <= maxTokens) return { messages: [...input], dropped: [] };
  if (input.length <= 4) return { messages: [...input], dropped: [] };

  // Separa system prompts (sempre ficam)
  const systemMsgs: any[] = [];
  const nonSystem: any[] = [];
  for (const m of input) {
    if (m.role === 'system') systemMsgs.push(m);
    else nonSystem.push(m);
  }

  if (nonSystem.length <= 3) return { messages: [...input], dropped: [] };

  // Últimas 3 mensagens sempre ficam (âncoras)
  const anchors = nonSystem.slice(-3);
  const candidates = nonSystem.slice(0, -3);

  // Verifica se já cabe com system + anchors
  const anchorCost = estimateMessagesTokens([...systemMsgs, ...anchors]);
  if (anchorCost >= maxTokens) {
    // Mesmo as âncoras estouram? Mantém só a última
    const lastOnly = [nonSystem[nonSystem.length - 1]];
    return {
      messages: [...systemMsgs, ...lastOnly],
      dropped: nonSystem.slice(0, -1),
    };
  }

  const budget = maxTokens - anchorCost;

  // Ordena candidatos por importancia (menor primeiro = descartados primeiro)
  const scored = candidates.map((m, i) => ({ msg: m, score: messageImportance(m), idx: i }));
  scored.sort((a, b) => a.score - b.score || a.idx - b.idx);

  // Descarta candidatos de menor importância até caber no orçamento
  const keptCandidates: any[] = [];
  const dropped: any[] = [];

  // Primeiro, adiciona todos (precisamos saber quais descartar)
  const candidatesTokens = estimateMessagesTokens(candidates);
  if (candidatesTokens <= budget) {
    // Todos cabem
    keptCandidates.push(...candidates);
  } else {
    // Precisa descartar os menos importantes
    for (const { msg } of scored) {
      const remaining = [...keptCandidates, msg];
      if (estimateMessagesTokens(remaining) <= budget) {
        keptCandidates.push(msg);
      } else {
        dropped.push(msg);
      }
    }

    // Reordena os mantidos pela posição original
    keptCandidates.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
  }

  return {
    messages: [...systemMsgs, ...keptCandidates, ...anchors],
    dropped,
  };
}

/* ------------------------- 2.3 Deduplicação de mensagens consecutivas ------------------------- */

/**
 * Remove mensagens idênticas consecutivas (mesma role + mesmo conteúdo).
 * Geralmente é erro de digitação ou reenvio acidental.
 * Só remove cópias EXATAS consecutivas — não afeta mensagens repetidas
 * em turnos diferentes.
 */
export function dedupConsecutiveMessages(messages: any[]): { messages: any[]; removed: number } {
  if (!messages || messages.length <= 1) return { messages: [...(messages || [])], removed: 0 };

  const out: any[] = [messages[0]];
  let removed = 0;

  for (let i = 1; i < messages.length; i++) {
    const prev = out[out.length - 1];
    const curr = messages[i];

    if (prev && curr && prev.role === curr.role) {
      const prevText = messageText(prev);
      const currText = messageText(curr);
      if (prevText === currText && prevText !== '') {
        removed++;
        continue; // Duplicata consecutiva — descarta
      }
    }
    out.push(curr);
  }

  return { messages: out, removed };
}

/**
 * Estabiliza o prefixo do prompt para maximizar o prompt caching automático
 * entre requests (DeepSeek/OpenAI/Gemini cacheiam prefixo byte-idêntico; o
 * Anthropic usa os breakpoints cache_control já marcados no adapter).
 *
 * Regras:
 *  - Todas as mensagens de system vão para o início, em ordem estável e sem
 *    duplicatas exatas (system soltas no meio quebram o cache a cada request);
 *  - A conversa segue em ordem cronológica (a cauda volátil — o turno atual do
 *    usuário — permanece no fim, como deve ser para o cache funcionar).
 *
 * Retorna `changed` quando houve reordenação/remoção — útil para o log da
 * economia. Não altera conteúdo de nenhuma mensagem (zero impacto na IA).
 */
export function stabilizePromptPrefix(messages: any[]): { messages: any[]; changed: boolean } {
  const input = messages || [];
  const system: any[] = [];
  const rest: any[] = [];
  let scattered = false;
  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (m?.role === 'system') {
      if (rest.length > 0) scattered = true;
      system.push(m);
    } else {
      rest.push(m);
    }
  }
  const deduped: any[] = [];
  for (const m of system) {
    const prev = deduped[deduped.length - 1];
    if (prev && messageText(prev) === messageText(m)) continue;
    deduped.push(m);
  }
  const changed = scattered || deduped.length !== system.length;
  return changed ? { messages: [...deduped, ...rest], changed } : { messages: [...input], changed };
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
  /**
   * Tipo do provedor de destino (ex.: "gemini-web", "deepseek"). Ajusta a
   * janela de contexto efetiva (contextWindowFor) aos limites do provedor.
   */
  providerType?: string;
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

  // 2.3 Deduplicação de mensagens consecutivas (antes de qualquer truncamento)
  if (settings.dedupConsecutive) {
    const { messages: deduped, removed } = dedupConsecutiveMessages(messages);
    if (removed > 0) actions.push(`dedup(${removed} removidas)`);
    messages = deduped;
  }

  if (settings.stripReasoning) {
    messages = stripReasoningFromMessages(messages);
    actions.push('stripReasoning');
  }

  if (settings.truncateToolOutput) {
    const { messages: kept, truncated } = truncateToolMessages(messages, TOOL_OUTPUT_MAX_CHARS);
    if (truncated > 0) actions.push(`toolOutput(${truncated} truncadas)`);
    messages = kept;
  }

  const maxTokens = contextWindowFor(
    options.providerType,
    settings.maxContextTokens > 0 ? settings.maxContextTokens : DEFAULT_ECONOMY.maxContextTokens
  );
  const wantsTruncate = settings.truncateHistory || settings.summarizeHistory || settings.smartTruncation;
  if (wantsTruncate) {
    const est = estimateMessagesTokens(messages);
    if (est > maxTokens) {
      // 2.1 Smart truncation: escolhe o método baseado na configuração
      const { messages: kept, dropped } = settings.smartTruncation
        ? smartTruncateMessages(messages, maxTokens)
        : truncateMessages(messages, maxTokens);
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
          const method = settings.smartTruncation ? 'smart' : 'chronological';
          actions.push(`truncate(${method}, ${kept.length} mantidas, ${dropped.length} descartadas)`);
          messages = kept;
        }
      }
    }
  }

  let next = { ...payload, messages };
  if (settings.cachePrefix) {
    // Prompt caching real: além de marcar o cache_control (Anthropic),
    // garante um prefixo byte-idêntico entre requests — system no início,
    // em ordem estável e sem duplicatas — para o cache automático do
    // DeepSeek/OpenAI/Gemini reutilizar o prefixo (tokens cacheados custam
    // ~10% do preço normal).
    const { messages: stabilized, changed } = stabilizePromptPrefix(messages);
    if (changed) {
      actions.push('prefixStable');
      next = { ...payload, messages: stabilized };
    }
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

/** True quando o corpo de resposta OpenAI-compatible tem conteúdo útil
 *  (texto ou tool_calls). Respostas vazias não devem ser cacheadas. */
export function hasMeaningfulContent(body: any): boolean {
  const msg = body?.choices?.[0]?.message;
  const content = msg?.content;
  const hasText =
    (typeof content === 'string' && content.trim().length > 0) ||
    (Array.isArray(content) && content.some((p: any) => typeof p?.text === 'string' && p.text.trim().length > 0));
  const hasTools = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
  return hasText || hasTools;
}

export function responseCacheGet(key: string): { status: number; body: any } | null {
  const entry = _responseCacheStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS || !hasMeaningfulContent(entry.body)) {
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
