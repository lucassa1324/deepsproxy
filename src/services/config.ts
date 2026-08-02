/*
 * File: config.ts
 * Project: deepsproxy
 * Registro central de provedores.
 *
 * Um provedor pode ser qualquer endpoint compatível com a API da OpenAI
 * (Ollama, LM Studio, OpenAI, Groq, Together, ...) ou o backend DeepSeek
 * (via Playwright). Os provedores ficam salvos em um cookie do navegador
 * (`deepsproxy_providers`) — por enquanto — e o dashboard centraliza a
 * adição/edição/seleção.
 *
 * Resolução do provedor ativo por request:
 *   1. Cookie "deepsproxy_providers" (JSON { active, providers }) enviado
 *      pelo navegador.
 *   2. Registro em memória (atualizado pelo POST /api/providers) — permite
 *      que clientes CLI sem cookie usem a última config salva no dashboard.
 *   3. Fallback do .env (PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).
 */

import { v4 as uuidv4 } from 'uuid';

export type ProviderType = 'deepseek' | 'openai-compatible';

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Se ativo (participa do roteamento e aparece nos seletores). */
  enabled: boolean;
}

export interface ProviderRegistry {
  active: string;
  providers: Provider[];
}

export const PROVIDERS_COOKIE = 'deepsproxy_providers';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 ano

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function isDeepseekProvider(p: Provider): boolean {
  return p.type === 'deepseek';
}

export function newProviderId(): string {
  return 'pv_' + uuidv4().slice(0, 8);
}

/* ------------------------- Cookie ------------------------- */

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

export function serializeProvidersCookie(registry: ProviderRegistry): string {
  const value = encodeURIComponent(JSON.stringify(registry));
  return `${PROVIDERS_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`;
}

export function parseRegistryFromCookie(header: string | undefined): ProviderRegistry | null {
  const raw = parseCookieHeader(header, PROVIDERS_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return sanitizeRegistry(parsed).registry ?? null;
  } catch {
    return null;
  }
}

/* ------------------------- Sanitização ------------------------- */

export function sanitizeRegistry(input: any): { registry?: ProviderRegistry; error?: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'Corpo inválido: esperado { providers, active }' };
  }
  const list = Array.isArray(input.providers) ? input.providers : [];
  const providers: Provider[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const type: ProviderType = raw.type === 'deepseek' ? 'deepseek' : 'openai-compatible';
    const provider: Provider = {
      id: raw.id ? String(raw.id) : newProviderId(),
      name: String(raw.name || (type === 'deepseek' ? 'DeepSeek' : 'Provedor')).trim(),
      type,
      baseUrl: type === 'deepseek' ? '' : normalizeBaseUrl(String(raw.baseUrl || '')),
      apiKey: type === 'deepseek' ? '' : String(raw.apiKey || ''),
      model: String(raw.model || '').trim(),
      enabled: raw.enabled !== false,
    };
    if (type === 'openai-compatible' && !provider.baseUrl) {
      return { error: `Provedor "${provider.name || '?'}": Base URL é obrigatória.` };
    }
    providers.push(provider);
  }
  if (providers.length === 0) return { error: 'Nenhum provedor válido.' };
  const active = providers.some((p) => p.id === input.active) ? input.active : providers[0].id;
  return { registry: { active, providers } };
}

/* ------------------------- Resolução ------------------------- */

// Registro em memória: fallback para clientes sem cookie (CLI) e para testes.
let memoryRegistry: ProviderRegistry | null = null;

export function getMemoryRegistry(): ProviderRegistry | null {
  return memoryRegistry;
}

export function saveRegistryToMemory(registry: ProviderRegistry): void {
  memoryRegistry = {
    active: registry.active,
    providers: registry.providers.map((p) => ({ ...p })),
  };
}

function providersFromEnv(): ProviderRegistry {
  const isLocal = (process.env.PROVIDER || 'deepseek').toLowerCase() === 'local';
  if (isLocal) {
    const provider: Provider = {
      id: 'env_local',
      name: 'Local (env)',
      type: 'openai-compatible',
      baseUrl: normalizeBaseUrl(process.env.LLM_BASE_URL || 'http://localhost:11434/v1'),
      apiKey: process.env.LLM_API_KEY || '',
      model: process.env.LLM_MODEL || '',
      enabled: true,
    };
    return { active: provider.id, providers: [provider] };
  }
  const deepseek: Provider = {
    id: 'env_deepseek',
    name: 'DeepSeek (env)',
    type: 'deepseek',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
  };
  return { active: deepseek.id, providers: [deepseek] };
}

/**
 * Resolve o provedor ativo para um request: cookie > memória > env.
 * Leitura lazy do env (imports ESM são hoisted, então o .env/testes podem
 * ser carregados somente depois do import).
 */
export function resolveRegistry(cookieHeader?: string): ProviderRegistry {
  const fromCookie = parseRegistryFromCookie(cookieHeader);
  if (fromCookie) return fromCookie;
  if (memoryRegistry) return memoryRegistry;
  return providersFromEnv();
}

export function enabledProviders(registry: ProviderRegistry): Provider[] {
  return registry.providers.filter((p) => p.enabled !== false);
}

/**
 * Resolve o provedor "principal" (fallback do roteamento): o `active` do
 * registro, ou o primeiro habilitado. O roteamento por modelo pode escolher
 * qualquer outro provedor habilitado.
 */
export function resolveActiveProvider(cookieHeader?: string): Provider {
  const registry = resolveRegistry(cookieHeader);
  const enabled = enabledProviders(registry);
  const pool = enabled.length ? enabled : registry.providers;
  return pool.find((p) => p.id === registry.active) ?? pool[0];
}
