/*
 * File: model-metadata.ts
 * Project: deepsproxy
 * Registro de metadados/capacidades dos modelos.
 *
 * Contém capacidades pré-definidas para modelos conhecidos e permite
 * registro dinâmico de modelos descobertos via providers.
 */

import type { ModelMetadata, ModelCapabilities, ModelCost } from './types.ts';

// ── Metadados de modelos conhecidos ─────────────────────────────────────
// Valores de capabilities: 0-10 (0 = não suporta, 10 = excelente)
// cost: USD por 1M tokens

const KNOWN_MODELS: Omit<ModelMetadata, 'providerId' | 'isAvailable'>[] = [
  // ═══ DeepSeek ═══
  {
    id: 'deepseek-thinking',
    name: 'DeepSeek Thinking',
    capabilities: { reasoning: 10, coding: 9, math: 9, writing: 7, vision: 0, general: 8 },
    cost: { input: 0.14, output: 0.28 },
    speed: 6,
    contextLength: 64000,
    isFree: false,
    tags: ['code', 'reasoning', 'math', 'thinking'],
  },
  {
    id: 'deepseek-no-thinking',
    name: 'DeepSeek',
    capabilities: { reasoning: 7, coding: 8, math: 7, writing: 7, vision: 0, general: 7 },
    cost: { input: 0.14, output: 0.28 },
    speed: 8,
    contextLength: 64000,
    isFree: false,
    tags: ['code', 'general'],
  },

  // ═══ Qwen ═══
  {
    id: 'qwen-max',
    name: 'Qwen Max',
    capabilities: { reasoning: 8, coding: 8, math: 8, writing: 8, vision: 0, general: 9 },
    cost: { input: 1.60, output: 6.40 },
    speed: 6,
    contextLength: 32000,
    isFree: false,
    tags: ['general', 'reasoning'],
  },
  {
    id: 'qwen-plus',
    name: 'Qwen Plus',
    capabilities: { reasoning: 7, coding: 7, math: 7, writing: 7, vision: 0, general: 8 },
    cost: { input: 0.40, output: 1.20 },
    speed: 7,
    contextLength: 131072,
    isFree: false,
    tags: ['general'],
  },
  {
    id: 'qwen-turbo',
    name: 'Qwen Turbo',
    capabilities: { reasoning: 6, coding: 6, math: 6, writing: 6, vision: 0, general: 7 },
    cost: { input: 0.05, output: 0.20 },
    speed: 9,
    contextLength: 131072,
    isFree: false,
    tags: ['fast', 'general'],
  },
  {
    id: 'qwen-long',
    name: 'Qwen Long',
    capabilities: { reasoning: 6, coding: 6, math: 5, writing: 7, vision: 0, general: 7 },
    cost: { input: 0.05, output: 0.20 },
    speed: 7,
    contextLength: 1000000,
    isFree: false,
    tags: ['long-context', 'general'],
  },

  // ═══ Gemini ═══
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    capabilities: { reasoning: 9, coding: 9, math: 9, writing: 8, vision: 9, general: 9 },
    cost: { input: 1.25, output: 10.00 },
    speed: 6,
    contextLength: 1048576,
    isFree: false,
    tags: ['code', 'reasoning', 'vision', 'math'],
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    capabilities: { reasoning: 7, coding: 7, math: 7, writing: 7, vision: 8, general: 8 },
    cost: { input: 0.15, output: 0.60 },
    speed: 9,
    contextLength: 1048576,
    isFree: false,
    tags: ['fast', 'vision', 'general'],
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    capabilities: { reasoning: 6, coding: 6, math: 6, writing: 6, vision: 7, general: 7 },
    cost: { input: 0.10, output: 0.40 },
    speed: 9,
    contextLength: 1048576,
    isFree: false,
    tags: ['fast', 'vision', 'general'],
  },

  // ═══ Anthropic ═══
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    capabilities: { reasoning: 10, coding: 10, math: 8, writing: 10, vision: 8, general: 9 },
    cost: { input: 15.00, output: 75.00 },
    speed: 4,
    contextLength: 200000,
    isFree: false,
    tags: ['code', 'reasoning', 'writing', 'vision'],
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    capabilities: { reasoning: 9, coding: 9, math: 8, writing: 9, vision: 8, general: 8 },
    cost: { input: 3.00, output: 15.00 },
    speed: 7,
    contextLength: 200000,
    isFree: false,
    tags: ['code', 'reasoning', 'writing', 'vision'],
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    capabilities: { reasoning: 6, coding: 7, math: 6, writing: 7, vision: 6, general: 7 },
    cost: { input: 0.80, output: 4.00 },
    speed: 9,
    contextLength: 200000,
    isFree: false,
    tags: ['fast', 'code', 'general'],
  },

  // ═══ Ollama (modelos locais — custo 0) ═══
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1 8B',
    capabilities: { reasoning: 5, coding: 5, math: 4, writing: 5, vision: 0, general: 6 },
    cost: { input: 0, output: 0 },
    speed: 9,
    contextLength: 128000,
    isFree: true,
    tags: ['local', 'fast', 'general'],
  },
  {
    id: 'llama3.1:70b',
    name: 'Llama 3.1 70B',
    capabilities: { reasoning: 7, coding: 7, math: 6, writing: 7, vision: 0, general: 8 },
    cost: { input: 0, output: 0 },
    speed: 5,
    contextLength: 128000,
    isFree: true,
    tags: ['local', 'general', 'reasoning'],
  },
  {
    id: 'codellama:13b',
    name: 'CodeLlama 13B',
    capabilities: { reasoning: 5, coding: 8, math: 4, writing: 3, vision: 0, general: 4 },
    cost: { input: 0, output: 0 },
    speed: 8,
    contextLength: 16000,
    isFree: true,
    tags: ['local', 'code'],
  },
  {
    id: 'mistral:7b',
    name: 'Mistral 7B',
    capabilities: { reasoning: 5, coding: 5, math: 5, writing: 5, vision: 0, general: 6 },
    cost: { input: 0, output: 0 },
    speed: 9,
    contextLength: 32000,
    isFree: true,
    tags: ['local', 'fast', 'general'],
  },
  {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen 2.5 Coder 7B',
    capabilities: { reasoning: 5, coding: 8, math: 5, writing: 4, vision: 0, general: 5 },
    cost: { input: 0, output: 0 },
    speed: 9,
    contextLength: 32000,
    isFree: true,
    tags: ['local', 'code'],
  },
  {
    id: 'phi3:14b',
    name: 'Phi-3 14B',
    capabilities: { reasoning: 6, coding: 6, math: 6, writing: 5, vision: 0, general: 6 },
    cost: { input: 0, output: 0 },
    speed: 7,
    contextLength: 128000,
    isFree: true,
    tags: ['local', 'reasoning', 'math'],
  },
  {
    id: 'deepseek-coder-v2:16b',
    name: 'DeepSeek Coder V2 16B',
    capabilities: { reasoning: 6, coding: 9, math: 5, writing: 3, vision: 0, general: 5 },
    cost: { input: 0, output: 0 },
    speed: 7,
    contextLength: 128000,
    isFree: true,
    tags: ['local', 'code'],
  },
  {
    id: 'llava:13b',
    name: 'LLaVA 13B',
    capabilities: { reasoning: 4, coding: 3, math: 3, writing: 4, vision: 7, general: 5 },
    cost: { input: 0, output: 0 },
    speed: 7,
    contextLength: 4096,
    isFree: true,
    tags: ['local', 'vision'],
  },
];

// ── Cache de metadados construídos ──────────────────────────────────────

let metadataCache: Map<string, ModelMetadata> = new Map();

function buildMetadataCache(): void {
  metadataCache = new Map();
  for (const m of KNOWN_MODELS) {
    metadataCache.set(m.id, { ...m, providerId: '', isAvailable: true });
  }
}

buildMetadataCache();

// ── API pública ─────────────────────────────────────────────────────────

/** Retorna metadados de um modelo por ID (normalizado). */
export function getModelMetadata(modelId: string): ModelMetadata | undefined {
  return metadataCache.get(modelId);
}

/** Retorna todos os metadados registrados. */
export function getAllModelMetadata(): ModelMetadata[] {
  return Array.from(metadataCache.values());
}

/**
 * Registra ou atualiza metadados de um modelo dinâmico (descoberto via provider).
 * Se o modelo já tiver metadados conhecidos, mescla com os novos dados.
 */
export function registerModel(
  id: string,
  data: Partial<ModelMetadata> & { providerId: string }
): ModelMetadata {
  const existing = metadataCache.get(id);
  const merged: ModelMetadata = {
    id,
    name: data.name || existing?.name || id,
    providerId: data.providerId,
    capabilities: data.capabilities || existing?.capabilities || defaultCapabilities(),
    cost: data.cost || existing?.cost || { input: 0, output: 0 },
    speed: data.speed ?? existing?.speed ?? 5,
    contextLength: data.contextLength ?? existing?.contextLength ?? 128000,
    isFree: data.isFree ?? existing?.isFree ?? (data.cost?.input === 0 && data.cost?.output === 0),
    isAvailable: data.isAvailable ?? true,
    tags: data.tags || existing?.tags || [],
  };
  metadataCache.set(id, merged);
  return merged;
}

/** Marca um modelo como disponível/indisponível. */
export function setModelAvailability(modelId: string, available: boolean): void {
  const m = metadataCache.get(modelId);
  if (m) m.isAvailable = available;
}

/** Reconstrói o cache a partir de uma lista de modelos do catálogo. */
export function syncWithCatalog(
  models: Array<{ id: string; providerId: string; providerName?: string }>
): void {
  // Marca todos como indisponíveis primeiro
  for (const [id, m] of metadataCache) {
    if (m.providerId) m.isAvailable = false;
  }
  // Registra os que existem no catálogo
  for (const m of models) {
    const existing = metadataCache.get(m.id);
    if (existing) {
      existing.providerId = m.providerId;
      existing.isAvailable = true;
    } else {
      registerModel(m.id, { providerId: m.providerId, name: m.id });
    }
  }
}

/** Retorna IDs de modelos conhecidos por tag. */
export function getModelsByTag(tag: string): ModelMetadata[] {
  return Array.from(metadataCache.values()).filter(
    (m) => m.tags.includes(tag) && m.isAvailable
  );
}

function defaultCapabilities(): ModelCapabilities {
  return { reasoning: 5, coding: 5, math: 5, writing: 5, vision: 0, general: 5 };
}
