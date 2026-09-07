/*
 * File: modelCatalog.ts
 * Project: deepsproxy
 * Catálogo unificado de modelos.
 *
 * Junta os modelos fixos (DeepSeek/Qwen) com os modelos dinâmicos em cache
 * (provedores OpenAI-compatíveis, Gemini, Anthropic, Ollama) e associa cada
 * model_id ao seu provedor, Base URL e API Key. O roteamento das portas
 * 3005 (direta) e 3006 (gateway) resolve o provedor automaticamente pelo nome
 * do modelo — sem seleção manual de provedor no painel.
 */

import type { Provider, ProviderRegistry, ProviderType } from './config.ts';
import {
  enabledProviders,
  isAdapterProvider,
  isDeepseekProvider,
  isQwenProvider,
  normalizeModelId,
  resolveRegistry,
  defaultBaseUrl,
  primaryApiKey,
  getActiveApiKey,
} from './config.ts';
import { fetchModels } from './local.ts';
import { fetchProviderModels } from './adapters/index.ts';
import { fetchQwenModels, QWEN_KNOWN_MODELS } from './qwen.ts';
import { GEMINI_KNOWN_MODELS } from './gemini-web.ts';

export interface CatalogModel {
  id: string;
  /** Nome de exibição (label) do modelo. */
  name: string;
  /** Id do provedor dono do modelo (registry). */
  provider: string;
  /** Nome de exibição do provedor. */
  providerName: string;
  providerType: ProviderType;
  baseUrl: string;
  apiKeyEnvVar: string;
  /** Chave resolvida (registry → env), usada no reenvio. */
  apiKey: string;
}

const CATALOG_TTL_MS = 30 * 1000;

let catalogCache: { key: string; models: CatalogModel[]; ts: number } | null = null;

function apiKeyEnvVarFor(p: Provider): string {
  switch (p.type) {
    case 'gemini':
      return 'GOOGLE_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'ollama':
      return 'OLLAMA_API_KEY';
    case 'openai-compatible':
      return 'LLM_API_KEY';
    default:
      return '';
  }
}

function resolvedApiKey(p: Provider): string {
  const explicit = primaryApiKey(p);
  if (explicit) return explicit;
  const envVar = apiKeyEnvVarFor(p);
  return envVar ? process.env[envVar] || '' : '';
}

/** Assinatura do registro: mudou provedores/config -> rebuild do catálogo. */
function registryKey(registry: ProviderRegistry): string {
  return registry.providers
    .map((p) => `${p.id}|${p.type}|${p.baseUrl}|${p.model}|${p.enabled}|${resolvedApiKey(p) ? 'k' : ''}`)
    .join(';');
}

async function buildModelCatalog(registry: ProviderRegistry): Promise<CatalogModel[]> {
  const enabled = enabledProviders(registry);
  const out: CatalogModel[] = [];
  const seen = new Set<string>();

  // Modelos do Gemini Web (navegador) têm prioridade sobre o Gemini por API:
  // assim, quando ambos estão habilitados, os modelos conhecidos apontam para o
  // provedor gemini-web (sem API key e sem modelo deprecated).
  const hasGeminiWeb = enabled.some((p) => p.type === 'gemini-web');
  const geminiWebIds = new Set(GEMINI_KNOWN_MODELS.map((m) => m.id));

  const push = (m: CatalogModel) => {
    if (!m.id || seen.has(m.id)) return;
    seen.add(m.id);
    out.push(m);
  };

  // Modelo "auto" (Smart Router) — sempre disponível
  push({
    id: 'auto',
    name: 'Auto (Smart Router)',
    provider: 'deepsproxy',
    providerName: 'Auto Router',
    providerType: 'openai-compatible' as ProviderType,
    baseUrl: '',
    apiKeyEnvVar: '',
    apiKey: '',
  });

  // Modelo "auto-free" (Smart Router apenas provedores browser/gratuitos)
  push({
    id: 'auto-free',
    name: 'Auto Free (Browser Only)',
    provider: 'deepsproxy',
    providerName: 'Auto Router',
    providerType: 'openai-compatible' as ProviderType,
    baseUrl: '',
    apiKeyEnvVar: '',
    apiKey: '',
  });

  // Separa provedores que precisam de fetch assíncrono dos que têm modelos fixos
  const providersNeedingFetch = enabled.filter(
    (p) => !isDeepseekProvider(p) && !isQwenProvider(p) && p.type !== 'gemini-web'
  );
  const providersWithFixedModels = enabled.filter(
    (p) => isDeepseekProvider(p) || isQwenProvider(p) || p.type === 'gemini-web'
  );

  // 1. Adiciona modelos fixos (DeepSeek, Qwen, Gemini Web) - rápido, sem I/O
  for (const p of providersWithFixedModels) {
    const base = {
      provider: p.id,
      providerName: p.name,
      providerType: p.type,
      baseUrl: p.baseUrl || defaultBaseUrl(p.type),
      apiKeyEnvVar: apiKeyEnvVarFor(p),
      apiKey: resolvedApiKey(p),
    };

    if (isDeepseekProvider(p)) {
      push({ id: 'deepseek-thinking', name: 'DeepSeek Think (raciocínio)', ...base });
      push({ id: 'deepseek-no-thinking', name: 'DeepSeek (sem raciocínio)', ...base });
    } else if (isQwenProvider(p)) {
      let qwenModels: any[] = [];
      try {
        qwenModels = await fetchQwenModels();
      } catch {
        // Playwright indisponível: usa a lista conhecida (fallback).
      }
      const list = qwenModels.length ? qwenModels : QWEN_KNOWN_MODELS;
      for (const m of list) {
        const id = normalizeModelId(m.id);
        push({ id, name: m.name || id, ...base });
      }
    } else if (p.type === 'gemini-web') {
      for (const m of GEMINI_KNOWN_MODELS) {
        push({ id: m.id, name: m.name || m.id, ...base });
      }
    }

    // Modelo de override do provedor
    if (p.model) {
      push({ id: p.model, name: p.model, ...base });
    }
  }

  // 2. Busca modelos dos provedores que precisam de I/O EM PARALELO
  if (providersNeedingFetch.length > 0) {
    const fetchPromises = providersNeedingFetch.map(async (p) => {
      const base = {
        provider: p.id,
        providerName: p.name,
        providerType: p.type,
        baseUrl: p.baseUrl || defaultBaseUrl(p.type),
        apiKeyEnvVar: apiKeyEnvVarFor(p),
        apiKey: resolvedApiKey(p),
      };

      let models: any[] | null = null;
      try {
        models = isAdapterProvider(p) ? await fetchProviderModels(p, getActiveApiKey(p)) : await fetchModels(p);
      } catch {
        models = null;
      }

      const result: CatalogModel[] = [];
      if (models) {
        for (const m of models) {
          const id = normalizeModelId(m.id);
          if (!id) continue;
          if (hasGeminiWeb && geminiWebIds.has(id)) continue;
          result.push({ id, name: m.name || m.model || id, ...base });
        }
      }
      // Modelo de override do provedor
      if (p.model) {
        result.push({ id: p.model, name: p.model, ...base });
      }
      return result;
    });

    const results = await Promise.allSettled(fetchPromises);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const m of result.value) {
          push(m);
        }
      }
    }
  }

  return out;
}

export function getCachedModelCatalog(): CatalogModel[] {
  return catalogCache ? catalogCache.models : [];
}

export async function getModelCatalog(registry?: ProviderRegistry): Promise<CatalogModel[]> {
  const reg = registry || resolveRegistry();
  const key = registryKey(reg);
  if (catalogCache && catalogCache.key === key && Date.now() - catalogCache.ts < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  const models = await buildModelCatalog(reg);
  catalogCache = { key, models, ts: Date.now() };
  return models;
}

export function resetModelCatalogCache(): void {
  catalogCache = null;
}

/** Resolve o provedor (entrada do catálogo) a partir do id de um modelo. */
export async function resolveModelEntry(
  modelId: string,
  registry?: ProviderRegistry
): Promise<CatalogModel | null> {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  const catalog = await getModelCatalog(registry);
  return catalog.find((m) => m.id === id) ?? null;
}

/** Agrupa os modelos do catálogo por nome de provedor (para <optgroup>). */
export function groupModelsByProvider(models: CatalogModel[]): Record<string, CatalogModel[]> {
  const groups: Record<string, CatalogModel[]> = {};
  for (const m of models) {
    const key = m.providerName || m.provider || 'outros';
    (groups[key] ||= []).push(m);
  }
  return groups;
}

/** Reconstrói um Provider (config.ts) a partir de uma entrada do catálogo. */
export function providerFromCatalogEntry(entry: CatalogModel): Provider {
  return {
    id: entry.provider,
    name: entry.providerName,
    type: entry.providerType,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    model: '',
    enabled: true,
  };
}
