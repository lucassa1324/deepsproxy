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
    capabilities: data.capabilities || existing?.capabilities || inferCapabilities(id),
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

/**
 * Infere capacidades de modelos dinâmicos (descobertos via provider) a partir
 * do nome. Antes, todo modelo desconhecido recebia 5 em tudo (exceto visão 0),
 * então o score do router não diferenciava nada entre eles. As heurísticas são
 * conservadoras: promovem capacidades só com sinais fortes (família, sufixo,
 * tamanho) e nunca atribuem extremos que enganariam o router numa tarefa
 * crítica.
 */
export function inferCapabilities(modelId: string): ModelCapabilities {
  const id = modelId.toLowerCase();
  const caps: ModelCapabilities = defaultCapabilities();
  const has = (...words: string[]) => words.some((w) => id.includes(w));

  // ── Visão ───────────────────────────────────────────────────────────────
  if (has('gemini', 'claude', 'llava', 'pixtral', 'vision', 'multimodal', 'omni', 'vlm', '4v', '4o', '5o', 'minicpm', 'qwen-vl')) {
    caps.vision = 8;
  }
  if (has('flash', 'mini', 'small', 'lite', 'haiku') && caps.vision > 0) {
    caps.vision = Math.max(6, caps.vision - 1);
  }

  // ── Raciocínio e matemática (modelos de pensamento) ────────────────────
  if (has('o1', 'o3', 'o4', 'reasoning', 'thinking', 'thought', 'qwq', 'deepseek-r', 'deepseek-reasoner', 'r1')) {
    caps.reasoning = 9;
    caps.math = 9;
  }
  if (has('pro', 'opus', 'max', 'ultra')) {
    caps.reasoning = Math.max(caps.reasoning, 8);
    caps.math = Math.max(caps.math, 7);
  }

  // ── Famílias conhecidas ─────────────────────────────────────────────────
  if (has('gemini')) {
    caps.general = Math.max(caps.general, 7);
    caps.reasoning = Math.max(caps.reasoning, 7);
    caps.coding = Math.max(caps.coding, 7);
    caps.writing = Math.max(caps.writing, 6);
    if (has('pro')) {
      caps.reasoning = 9;
      caps.coding = 9;
      caps.math = Math.max(caps.math, 8);
      caps.writing = Math.max(caps.writing, 8);
    }
  }
  if (has('gpt-5')) {
    caps.general = 8;
    caps.reasoning = Math.max(caps.reasoning, 8);
    caps.coding = 8;
    caps.math = Math.max(caps.math, 8);
    caps.writing = Math.max(caps.writing, 8);
  }
  if (has('gpt-4o', 'gpt-4-turbo')) {
    caps.general = 8;
    caps.coding = 8;
    caps.writing = 8;
    caps.reasoning = Math.max(caps.reasoning, 7);
    caps.math = Math.max(caps.math, 7);
  }
  if (has('deepseek')) {
    caps.reasoning = Math.max(caps.reasoning, 8);
    caps.coding = Math.max(caps.coding, 8);
    caps.math = Math.max(caps.math, 8);
    caps.general = Math.max(caps.general, 7);
  }
  if (has('claude')) {
    caps.coding = Math.max(caps.coding, 8);
    caps.writing = Math.max(caps.writing, 8);
    caps.reasoning = Math.max(caps.reasoning, 7);
    caps.general = Math.max(caps.general, 7);
    if (has('opus')) {
      caps.reasoning = 9;
      caps.math = 9;
      caps.coding = 9;
      caps.writing = 9;
    }
  }
  if (has('qwen')) {
    caps.general = Math.max(caps.general, 6);
    if (has('coder') || has('code')) caps.coding = Math.max(caps.coding, 9);
    if (has('plus')) {
      caps.reasoning = Math.max(caps.reasoning, 8);
      caps.coding = Math.max(caps.coding, 8);
    }
  }
  if (has('mistral')) {
    if (has('codestral') || has('code')) caps.coding = Math.max(caps.coding, 9);
    if (has('large')) {
      caps.reasoning = Math.max(caps.reasoning, 8);
      caps.coding = Math.max(caps.coding, 8);
      caps.general = 7;
    }
  }

  // ── Código explícito ────────────────────────────────────────────────────
  if (has('coder', 'codex', 'codestral', 'code')) {
    caps.coding = Math.max(caps.coding, 8);
  }

  // ── Tamanho de modelos locais (7b/8b leves; 32b/70b fortes) ─────────────
  const sizeMatch = id.match(/(\d{1,3})b/);
  if (sizeMatch) {
    const size = parseInt(sizeMatch[1], 10);
    if (size >= 30) {
      caps.reasoning = Math.max(caps.reasoning, 7);
      caps.coding = Math.max(caps.coding, 7);
      caps.writing = Math.max(caps.writing, 6);
      caps.general = Math.max(caps.general, 7);
    }
  }

  // ── Clamp final (0-10) ──────────────────────────────────────────────────
  for (const k of Object.keys(caps) as Array<keyof ModelCapabilities>) {
    caps[k] = Math.max(0, Math.min(10, Math.round(caps[k])));
  }
  return caps;
}

// ── Saúde dos modelos (circuit breaker) ────────────────────────────────────
// Modelos que falham na prática (timeout, erro HTTP, resposta vazia) saem do
// roteamento por um cooldown com backoff exponencial (30s → até 10min). Isso
// separa "está no catálogo" de "está respondendo" — o router só escolhe modelos
// que provaram funcionar recentemente.

interface ModelHealth {
  failures: number; // falhas consecutivas (dirige o backoff)
  downUntil: number; // timestamp até quando fica fora do roteamento
  totalFailures: number;
  lastFailAt: number;
}

const healthMap = new Map<string, ModelHealth>();
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 10 * 60_000;

/** True quando o modelo está fora do roteamento (circuit breaker aberto). */
export function isModelDown(modelId: string, now: number = Date.now()): boolean {
  const h = healthMap.get(modelId);
  return !!h && now < h.downUntil;
}

/** Registra uma falha: abre o circuito com backoff exponencial (30s → 10min). */
export function recordModelFailure(
  modelId: string,
  status?: number,
  reason?: string
): void {
  const prev = healthMap.get(modelId);
  const failures = (prev?.failures || 0) + 1;
  const backoff = COOLDOWN_BASE_MS * Math.pow(2, Math.min(failures - 1, 5));
  const cooldown = Math.min(backoff, COOLDOWN_MAX_MS);
  healthMap.set(modelId, {
    failures,
    downUntil: Date.now() + cooldown,
    totalFailures: (prev?.totalFailures || 0) + 1,
    lastFailAt: Date.now(),
  });
  console.warn(
    `[auto-router] modelo "${modelId}" indisponível por ${Math.round(cooldown / 1000)}s ` +
      `(${failures} falhas consecutivas) status=${status ?? '-'}${reason ? ` — ${reason}` : ''}`
  );
}

/** Registra sucesso: fecha o circuito e zera as falhas acumuladas. */
export function recordModelSuccess(modelId: string): void {
  if (healthMap.delete(modelId)) {
    console.log(`[auto-router] modelo "${modelId}" voltou ao roteamento`);
  }
}

/** Estado de saúde atual (para status do roteador/dashboard). */
export function getModelHealthState(): Array<{
  modelId: string;
  failures: number;
  totalFailures: number;
  downUntil: number;
  isDown: boolean;
}> {
  const now = Date.now();
  const out: Array<{
    modelId: string;
    failures: number;
    totalFailures: number;
    downUntil: number;
    isDown: boolean;
  }> = [];
  for (const [modelId, h] of healthMap) {
    out.push({
      modelId,
      failures: h.failures,
      totalFailures: h.totalFailures,
      downUntil: h.downUntil,
      isDown: now < h.downUntil,
    });
  }
  return out;
}

/** Limpa o estado de saúde (usado nos testes). */
export function resetModelHealth(): void {
  healthMap.clear();
}

// ── Métricas de saúde por modelo ─────────────────────────────────────────
// Observacionais: latência média, taxa de sucesso e contagem de requests por
// modelo. Não interferem no roteamento (isso é papel do circuit breaker), mas
// alimentam o dashboard para o usuário ver quais modelos são confiáveis.

interface ModelMetrics {
  requests: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
  lastError?: string;
  lastRequestAt?: number;
  lastSuccessAt?: number;
}

const metricsMap = new Map<string, ModelMetrics>();

function getMetricsEntry(modelId: string): ModelMetrics {
  let m = metricsMap.get(modelId);
  if (!m) {
    m = { requests: 0, successes: 0, failures: 0, totalLatencyMs: 0, lastLatencyMs: 0 };
    metricsMap.set(modelId, m);
  }
  return m;
}

/** Marca o início de um request ao modelo (para contar e medir latência). */
export function recordModelRequest(modelId: string): void {
  const m = getMetricsEntry(modelId);
  m.requests++;
  m.lastRequestAt = Date.now();
}

/** Registra a latência de um request (atualiza média e última). */
export function recordModelLatency(modelId: string, latencyMs: number): void {
  const m = getMetricsEntry(modelId);
  m.lastLatencyMs = latencyMs;
  m.totalLatencyMs += latencyMs;
}

/** Registra o desfecho de um request (sucesso/falha + último erro). */
export function recordModelOutcome(modelId: string, ok: boolean, error?: string): void {
  const m = getMetricsEntry(modelId);
  if (ok) {
    m.successes++;
    m.lastSuccessAt = Date.now();
  } else {
    m.failures++;
    if (error) m.lastError = error;
  }
}

/** Métricas observacionais consolidadas por modelo. */
export function getModelMetrics(): Array<{
  modelId: string;
  requests: number;
  successes: number;
  failures: number;
  successRate: number; // 0-1 (0 quando não há requests)
  avgLatencyMs: number; // média aritmética (0 quando não há requests)
  lastLatencyMs: number;
  lastError?: string;
  lastRequestAt?: number;
  lastSuccessAt?: number;
}> {
  const out: Array<{
    modelId: string;
    requests: number;
    successes: number;
    failures: number;
    successRate: number;
    avgLatencyMs: number;
    lastLatencyMs: number;
    lastError?: string;
    lastRequestAt?: number;
    lastSuccessAt?: number;
  }> = [];
  for (const [modelId, m] of metricsMap) {
    out.push({
      modelId,
      requests: m.requests,
      successes: m.successes,
      failures: m.failures,
      successRate: m.requests > 0 ? m.successes / m.requests : 0,
      avgLatencyMs: m.requests > 0 ? Math.round(m.totalLatencyMs / m.requests) : 0,
      lastLatencyMs: m.lastLatencyMs,
      lastError: m.lastError,
      lastRequestAt: m.lastRequestAt,
      lastSuccessAt: m.lastSuccessAt,
    });
  }
  return out;
}

/** Métricas de um único modelo (ou undefined se nunca foi usado). */
export function getModelMetricsFor(modelId: string): ReturnType<typeof getModelMetrics>[number] | undefined {
  return getModelMetrics().find((m) => m.modelId === modelId);
}

/** Limpa as métricas (usado nos testes). */
export function resetModelMetrics(): void {
  metricsMap.clear();
}
