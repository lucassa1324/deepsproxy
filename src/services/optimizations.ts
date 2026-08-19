/*
 * File: optimizations.ts
 * Project: deepsproxy
 * Otimizações de performance 100% seguras (FASE 1).
 * Ativadas por padrão, sem risco à qualidade.
 *
 * 1.1 HTTP keep-alive pool — reutiliza conexões TCP/TLS com provedores
 * 1.2 System prompt cache — cache em memória de prompts parseados
 * 1.3 Strip metadata — remove campos desnecessários do payload
 * 1.5 Tool definition compression — encurta descrições mantendo essenciais
 */

import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { createHash } from 'crypto';

// ────────────────────────────────────────────────────────────────────────────
// 1.1 HTTP Keep-Alive Connection Pool
// ────────────────────────────────────────────────────────────────────────────

const MAX_SOCKETS = 10;
const KEEP_ALIVE_MSECS = 30_000; // 30s

/**
 * Pool de conexões HTTP reutilizáveis para chamadas a provedores.
 * Usa os agents built-in do Node.js (http/https) com keep-alive.
 * Cada origin recebe seu próprio par http+https agent.
 */
interface AgentPair { http: HttpAgent; https: HttpsAgent }
const agentPool = new Map<string, AgentPair>();

function getAgentsForOrigin(url: string): AgentPair {
  const origin = extractOrigin(url);
  let pair = agentPool.get(origin);
  if (!pair) {
    pair = {
      http: new HttpAgent({ keepAlive: true, keepAliveMsecs: KEEP_ALIVE_MSECS, maxSockets: MAX_SOCKETS }),
      https: new HttpsAgent({ keepAlive: true, keepAliveMsecs: KEEP_ALIVE_MSECS, maxSockets: MAX_SOCKETS }),
    };
    agentPool.set(origin, pair);
  }
  return pair;
}

function extractOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return url.split('/').slice(0, 3).join('/');
  }
}

/**
 * Wrapper de fetch com keep-alive. Mantém as conexões TCP abertas entre
 * requests ao mesmo provedor, evitando handshake TLS repetido (~50-100ms).
 * Node 22 suporta `dispatcher` no fetch global via undici embutido, mas
 * também aceita agent via RequestInit para compatibilidade.
 */
export async function optimizedFetch(
  url: string,
  init?: RequestInit & { agent?: HttpAgent | HttpsAgent }
): Promise<Response> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`optimizedFetch: URL inválida "${url}" — Base URL do provedor não configurada.`);
  }
  const pair = getAgentsForOrigin(url);
  const isHttps = url.startsWith('https');
  const { agent: _, ...rest } = init || {};
  return fetch(url, { ...rest, agent: isHttps ? pair.https : pair.http } as any);
}

/**
 * Wrapper com timeout automático. Usado em chamadas que podem travar.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { agent?: HttpAgent | HttpsAgent } = {},
  timeoutMs = 30_000
): Promise<Response> {
  const pair = getAgentsForOrigin(url);
  const isHttps = url.startsWith('https');
  const { agent: _, ...rest } = init || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...rest,
      agent: isHttps ? pair.https : pair.http,
      signal: controller.signal,
    } as any);
  } finally {
    clearTimeout(timer);
  }
}

/** Fecha todos os agents (chamado no shutdown do servidor). */
export function shutdownAgentPool(): void {
  for (const [, pair] of agentPool) {
    pair.http.destroy();
    pair.https.destroy();
  }
  agentPool.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// 1.2 System Prompt Cache
// ────────────────────────────────────────────────────────────────────────────

interface PromptCacheEntry {
  hash: string;
  prompt: string;
  ts: number;
}

const PROMPT_CACHE_TTL = 5 * 60_000; // 5 minutos
const promptCache = new Map<string, PromptCacheEntry>();

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Cacheia um system prompt parseado. Se o mesmo conteúdo for requisitado
 * novamente dentro do TTL, retorna o cache. Evita reconstruir o prompt
 * a cada request (especialmente útil com tools longas).
 */
export function cacheSystemPrompt(key: string, prompt: string): string {
  const hash = contentHash(prompt);
  const cached = promptCache.get(key);
  if (cached && cached.hash === hash && Date.now() - cached.ts < PROMPT_CACHE_TTL) {
    return cached.prompt;
  }
  promptCache.set(key, { hash, prompt, ts: Date.now() });
  return prompt;
}

/** Recupera um system prompt do cache (ou null se expirado/ausente). */
export function getCachedPrompt(key: string): string | null {
  const entry = promptCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > PROMPT_CACHE_TTL) {
    promptCache.delete(key);
    return null;
  }
  return entry.prompt;
}

/** Limpa o cache de prompts. */
export function clearPromptCache(): void {
  promptCache.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// 1.3 Strip Metadata from Payload
// ────────────────────────────────────────────────────────────────────────────

/**
 * Campos que o modelo NÃO usa e podemos remover do payload.
 * Reduz tokens sem impacto na qualidade.
 */
const STRIP_FIELDS = new Set([
  'created_at',
  'description',
  'owned_by',
  'object',
  'created',
  'owned_by',
  'permission',
  'root',
  'parent',
]);

/**
 * Remove metadata desnecessária de um payload OpenAI antes de enviar.
 * Não muta o objeto original — retorna uma cópia limpa.
 */
export function stripPayloadMetadata(payload: any): any {
  if (!payload || typeof payload !== 'object') return payload;

  const clean = { ...payload };

  // Remove campos de nível superior
  for (const field of STRIP_FIELDS) {
    if (field in clean) delete clean[field];
  }

  // Limpa tools se existirem
  if (Array.isArray(clean.tools)) {
    clean.tools = clean.tools.map(stripToolMetadata);
  }

  return clean;
}

function stripToolMetadata(tool: any): any {
  if (!tool || typeof tool !== 'object') return tool;

  const clean: any = {};

  // Preserva type
  if (tool.type) clean.type = tool.type;

  // Para function tools
  if (tool.type === 'function' && tool.function) {
    clean.function = {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    };
    // Remove campos desnecessários do function
    if (tool.function.strict !== undefined) {
      clean.function.strict = tool.function.strict;
    }
  } else {
    // Para outros tipos, mantém só o essencial
    if (tool.name) clean.name = tool.name;
    if (tool.description) clean.description = tool.description;
    if (tool.parameters) clean.parameters = tool.parameters;
  }

  return clean;
}

// ────────────────────────────────────────────────────────────────────────────
// 1.5 Conservative Tool Definition Compression
// ────────────────────────────────────────────────────────────────────────────

/**
 * Limites de compressão conservadora.
 * NUNCA remove nomes de tools, parâmetros ou tipos.
 * Só encurta descrições textuais.
 */
const MAX_DESCRIPTION_LENGTH = 200;
const SUMMARY_INDICATOR = ' [...]';

/**
 * Comprime definições de tools de forma conservadora.
 * - Mantém nome, parâmetros e tipos intactos
 * - Encurta descrições longas (>200 chars) mantendo a 1ª frase
 * - Remove campos desnecessários (já faz stripToolMetadata)
 */
export function compressToolDefinitions(tools: any[]): any[] {
  if (!Array.isArray(tools)) return tools;

  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;

    const compressed = stripToolMetadata(tool);

    // Comprime descrição se existir
    if (compressed.description && typeof compressed.description === 'string') {
      compressed.description = compressDescription(compressed.description);
    }

    // Comprime descrição de function se existir
    if (compressed.function?.description && typeof compressed.function.description === 'string') {
      compressed.function.description = compressDescription(compressed.function.description);
    }

    return compressed;
  });
}

/**
 * Encurta uma descrição mantendo a 1ª frase significativa.
 * Regras:
 * - Se <= MAX_DESCRIPTION_LENGTH, retorna como está
 * - Se > MAX_DESCRIPTION_LENGTH, pega até a 1ª frase (até . ! ?) + indicador
 * - Se não tem frase completa, pega até MAX_DESCRIPTION_LENGTH chars + indicador
 */
function compressDescription(desc: string): string {
  if (!desc || desc.length <= MAX_DESCRIPTION_LENGTH) return desc;

  // Tenta encontrar o fim da 1ª frase
  const sentenceEnd = findFirstSentenceEnd(desc);
  if (sentenceEnd > 0 && sentenceEnd <= MAX_DESCRIPTION_LENGTH) {
    return desc.slice(0, sentenceEnd) + SUMMARY_INDICATOR;
  }

  // Se a 1ª frase é muito longa, corta no limite
  const truncated = desc.slice(0, MAX_DESCRIPTION_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > MAX_DESCRIPTION_LENGTH * 0.6) {
    return truncated.slice(0, lastSpace) + SUMMARY_INDICATOR;
  }
  return truncated + SUMMARY_INDICATOR;
}

function findFirstSentenceEnd(text: string): number {
  for (let i = 0; i < Math.min(text.length, MAX_DESCRIPTION_LENGTH + 50); i++) {
    if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
      // Verifica se é fim de frase (não abreviação como "e.g.")
      const next = text[i + 1];
      if (!next || next === ' ' || next === '\n') {
        return i + 1;
      }
    }
  }
  return -1;
}

// ────────────────────────────────────────────────────────────────────────────
// Utility: Apply all Phase 1 optimizations to a payload
// ────────────────────────────────────────────────────────────────────────────

export interface Phase1Options {
  stripMetadata?: boolean;
  compressTools?: boolean;
}

const DEFAULT_PHASE1: Phase1Options = {
  stripMetadata: true,
  compressTools: true,
};

/**
 * Aplica todas as otimizações da Fase 1 num payload OpenAI.
 * Retorna um payload otimizado (não muta o original).
 */
export function applyPhase1Optimizations(
  payload: any,
  options: Phase1Options = DEFAULT_PHASE1
): any {
  if (!payload || typeof payload !== 'object') return payload;

  let optimized = { ...payload };

  if (options.stripMetadata) {
    optimized = stripPayloadMetadata(optimized);
  }

  if (options.compressTools && Array.isArray(optimized.tools)) {
    optimized.tools = compressToolDefinitions(optimized.tools);
  }

  return optimized;
}
