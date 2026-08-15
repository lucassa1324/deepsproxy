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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export type ProviderType =
  | 'openai-compatible'
  | 'gemini'
  | 'anthropic'
  | 'ollama'
  | 'deepseek'
  | 'qwen'
  | 'gemini-web';

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

const VALID_PROVIDER_TYPES: ProviderType[] = [
  'deepseek', 'qwen', 'gemini', 'anthropic', 'ollama', 'openai-compatible', 'gemini-web',
];

/** Converte um valor arbitrário em ProviderType válido (fallback: openai-compatible). */
export function sanitizeType(raw: unknown): ProviderType {
  const t = String(raw || '');
  return (VALID_PROVIDER_TYPES as string[]).includes(t) ? (t as ProviderType) : 'openai-compatible';
}

/** True para provedores baseados em navegador (Playwright): deepseek, qwen e gemini-web. */
export function isBrowserType(type: ProviderType): boolean {
  return type === 'deepseek' || type === 'qwen' || type === 'gemini-web';
}

/** True para tipos atendidos pelos Adapters HTTP (gemini/anthropic/ollama). */
export function isAdapterType(type: ProviderType): boolean {
  return type === 'gemini' || type === 'anthropic' || type === 'ollama';
}

/** Base URL padrão por tipo (usada quando o usuário deixa o campo vazio). */
export function defaultBaseUrl(type: ProviderType): string {
  switch (type) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'ollama':
      return 'http://localhost:11434';
    default:
      return '';
  }
}

/** Nome de exibição de um tipo de provedor (UI). */
export function providerTypeLabel(type: ProviderType): string {
  switch (type) {
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
      return 'Anthropic';
    case 'ollama':
      return 'Ollama';
    case 'deepseek':
      return 'DeepSeek';
    case 'qwen':
      return 'Qwen';
    case 'gemini-web':
      return 'Gemini (Web)';
    default:
      return 'OpenAI-compatível';
  }
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

/**
 * Normaliza o id de um modelo para o formato OpenAI. A API REST do Gemini
 * retorna `name` com prefixo `models/` (ex.: "models/gemini-2.5-flash");
 * removê-lo evita que o frontend filtre o modelo por achar que é um path.
 */
export function normalizeModelId(id: unknown): string {
  return String(id ?? '').trim().replace(/^models\//, '');
}

export function isDeepseekProvider(p: Provider): boolean {
  return p.type === 'deepseek';
}

export function isQwenProvider(p: Provider): boolean {
  return p.type === 'qwen';
}

export function isGeminiWebProvider(p: Provider): boolean {
  return p.type === 'gemini-web';
}

/** True para provedores baseados em navegador (Playwright): deepseek, qwen e gemini-web. */
export function isBrowserProvider(p: Provider): boolean {
  return isBrowserType(p.type);
}

/** True para provedores atendidos pelos Adapters (gemini/anthropic/ollama). */
export function isAdapterProvider(p: Provider): boolean {
  return isAdapterType(p.type);
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
    const type: ProviderType = sanitizeType(raw.type);
    const isBrowser = isBrowserType(type);
    const rawBaseUrl = isBrowser ? '' : normalizeBaseUrl(String(raw.baseUrl || ''));
    const provider: Provider = {
      id: raw.id ? String(raw.id) : newProviderId(),
      name: String(raw.name || providerTypeLabel(type)).trim(),
      type,
      baseUrl: isBrowser ? '' : (rawBaseUrl || defaultBaseUrl(type)),
      apiKey: isBrowser ? '' : String(raw.apiKey || ''),
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

// Registro persistido em disco: o dashboard salva aqui para que clientes sem
// cookie (CLI, apps OpenAI-compatíveis) continuem enxergando os provedores
// mesmo depois de reiniciar o servidor (a memória é perdida no restart).
function providersFile(): string {
  return process.env.PROVIDERS_FILE || join(process.cwd(), 'providers.json');
}

function saveRegistryToDisk(registry: ProviderRegistry): void {
  try {
    const file = providersFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ active: registry.active, providers: registry.providers }, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[config] falha ao persistir provedores em ${providersFile()}:`, err.message);
  }
}

function loadRegistryFromDisk(): ProviderRegistry | null {
  try {
    const file = providersFile();
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const { registry } = sanitizeRegistry(raw);
    if (!registry) return null;
    return registry;
  } catch {
    return null;
  }
}

export function getMemoryRegistry(): ProviderRegistry | null {
  return memoryRegistry;
}

export function saveRegistryToMemory(registry: ProviderRegistry): void {
  memoryRegistry = {
    active: registry.active,
    providers: registry.providers.map((p) => ({ ...p })),
  };
  saveRegistryToDisk(memoryRegistry);
}

function providersFromEnv(): ProviderRegistry {
  const providerName = (process.env.PROVIDER || 'deepseek').toLowerCase();
  if (providerName === 'local') {
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
  // Provedores de navegador aparecem juntos por padrão: o escolhido via
  // PROVIDER fica como principal, mas DeepSeek e Qwen ficam disponíveis
  // para login e roteamento por modelo.
  const deepseek: Provider = {
    id: 'env_deepseek',
    name: 'DeepSeek (env)',
    type: 'deepseek',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
  };
  const qwen: Provider = {
    id: 'env_qwen',
    name: 'Qwen (env)',
    type: 'qwen',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
  };
  const geminiWeb: Provider = {
    id: 'env_gemini_web',
    name: 'Gemini (Web)',
    type: 'gemini-web',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
  };
  if (providerName === 'qwen') {
    return { active: qwen.id, providers: [qwen, deepseek, geminiWeb] };
  }
  if (providerName === 'gemini-web') {
    return { active: geminiWeb.id, providers: [geminiWeb, deepseek, qwen] };
  }
  return { active: deepseek.id, providers: [deepseek, qwen, geminiWeb] };
}

/**
 * Migração de registro: se houver qualquer provedor de navegador (deepseek ou
 * qwen), garante que o outro também esteja presente (habilitado). Isso mantém
 * registros antigos (salvos antes do suporte ao Qwen, só com DeepSeek) com os
 * dois backends disponíveis para login e roteamento por modelo.
 */
function ensureBrowserProviders(registry: ProviderRegistry): ProviderRegistry {
  const hasDeepseek = registry.providers.some((p) => p.type === 'deepseek');
  const hasQwen = registry.providers.some((p) => p.type === 'qwen');
  const hasGeminiWeb = registry.providers.some((p) => p.type === 'gemini-web');
  if (!hasDeepseek && !hasQwen && !hasGeminiWeb) return registry;
  const providers = [...registry.providers];
  if (!hasDeepseek) {
    providers.push({ id: 'builtin_deepseek', name: 'DeepSeek (env)', type: 'deepseek', baseUrl: '', apiKey: '', model: '', enabled: true });
  }
  if (!hasQwen) {
    providers.push({ id: 'builtin_qwen', name: 'Qwen (env)', type: 'qwen', baseUrl: '', apiKey: '', model: '', enabled: true });
  }
  if (!hasGeminiWeb) {
    providers.push({ id: 'builtin_gemini_web', name: 'Gemini (Web)', type: 'gemini-web', baseUrl: '', apiKey: '', model: '', enabled: true });
  }
  if (providers.length === registry.providers.length) return registry;
  return { active: registry.active, providers };
}

/**
 * Resolve o provedor ativo para um request: cookie > memória > disco > env.
 * Leitura lazy do env (imports ESM são hoisted, então o .env/testes podem
 * ser carregados somente depois do import).
 */
export function resolveRegistry(cookieHeader?: string): ProviderRegistry {
  const fromCookie = parseRegistryFromCookie(cookieHeader);
  if (fromCookie) return ensureBrowserProviders(fromCookie);
  if (memoryRegistry) return ensureBrowserProviders(memoryRegistry);
  const fromDisk = loadRegistryFromDisk();
  if (fromDisk) {
    memoryRegistry = fromDisk;
    return ensureBrowserProviders(fromDisk);
  }
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
