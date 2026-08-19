/*
 * File: router.ts
 * Project: deepsproxy
 * Router principal do Auto — orquestra classificação, seleção e fallback.
 *
 * Quando o modelo "auto" é selecionado, este módulo:
 *   1. Sincroniza metadados com o catálogo de modelos disponível
 *   2. Classifica a tarefa do usuário
 *   3. Seleciona o melhor modelo
 *   4. Retorna o modelo + provedor para o chat handler
 */

import type {
  AutoRouterConfig,
  RoutingDecision,
  ModelMetadata,
  CostPolicy,
} from './types.ts';
import { classifyTask, hasImageInput } from './task-classifier.ts';
import { selectBestModel } from './model-selector.ts';
import {
  getModelMetadata,
  getAllModelMetadata,
  syncWithCatalog,
  setModelAvailability,
} from './model-metadata.ts';

// ── Configuração padrão ────────────────────────────────────────────────

const DEFAULT_CONFIG: AutoRouterConfig = {
  costPolicy: 'balanced',
  showDecision: true,
  minCapabilityThreshold: 3,
};

let currentConfig: AutoRouterConfig = { ...DEFAULT_CONFIG };

/** Atualiza a configuração do Auto Router. */
export function updateAutoRouterConfig(config: Partial<AutoRouterConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/** Retorna a configuração atual. */
export function getAutoRouterConfig(): AutoRouterConfig {
  return { ...currentConfig };
}

// ── Cache de decisões recentes (para estabilidade) ──────────────────────

interface DecisionCache {
  conversationHash: string;
  modelId: string;
  timestamp: number;
}

const DECISION_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const decisionCache = new Map<string, DecisionCache>();

// ── Função principal do router ──────────────────────────────────────────

/**
 * Roteia uma requisição para o melhor modelo disponível.
 *
 * @param messages - Histórico completo da conversa
 * @param currentMessage - Mensagem atual do usuário
 * @param availableModels - Modelos disponíveis do catálogo
 * @param previousModelId - Modelo usado na última resposta (para estabilidade)
 * @param browserOnly - Se true, considera apenas modelos de provedores browser (Playwright)
 * @param hasTools - Se true, a requisição traz tools (agente/IDE): prioriza
 *                   modelos com programação/raciocínio fortes
 */
export function routeRequest(
  messages: Array<{ role: string; content: string | any[] }>,
  currentMessage: string,
  availableModels: Array<{ id: string; providerId: string; providerName?: string; providerType?: string }>,
  previousModelId?: string,
  browserOnly = false,
  hasTools = false
): RoutingDecision {
  // 1. Sincronizar metadados com o catálogo
  syncWithCatalog(availableModels);

  // 2. Classificar a tarefa
  const classification = classifyTask(messages, currentMessage, { hasTools });

  // 3. Verificar se precisa de visão (imagens no input)
  const needsVision = hasImageInput(messages) || hasImageInput([{ role: 'user', content: currentMessage }]);
  if (needsVision) {
    classification.categories.vision = Math.max(classification.categories.vision || 0, 8);
  }

  // 4. Obter metadados apenas dos modelos disponíveis no catálogo
  const availableIds = new Set(availableModels.map((m) => m.id));
  let candidates = getAllModelMetadata().filter((m) => m.isAvailable && availableIds.has(m.id));

  // 4b. Se browserOnly, filtrar para apenas provedores Playwright (gratuitos)
  if (browserOnly) {
    const BROWSER_TYPES = new Set(['deepseek', 'qwen', 'gemini-web']);
    const browserProviderIds = new Set(
      availableModels
        .filter((m) => m.providerType && BROWSER_TYPES.has(m.providerType))
        .map((m) => m.providerId)
    );
    candidates = candidates.filter((m) => browserProviderIds.has(m.providerId));
  }

  if (candidates.length === 0) {
    return {
      selectedModelId: '',
      selectedModelName: 'Nenhum modelo disponível',
      providerId: '',
      taskClassification: classification,
      score: 0,
      reason: 'Nenhum modelo registrado no sistema',
      alternatives: [],
      fallbackChain: [],
    };
  }

  // 5. Verificar cache de decisão (estabilidade)
  const convHash = buildConversationHash(messages, hasTools);
  const cached = decisionCache.get(convHash);
  if (cached && Date.now() - cached.timestamp < DECISION_CACHE_TTL) {
    const cachedModel = candidates.find((m) => m.id === cached.modelId);
    if (cachedModel) {
      const decision = selectBestModel(candidates, classification, currentConfig, cached.modelId);
      // Se o modelo cached ainda está entre os top 3, mantê-lo
      if (decision.alternatives.includes(cached.modelId) || decision.selectedModelId === cached.modelId) {
        return decision;
      }
    }
  }

  // 6. Selecionar melhor modelo
  const decision = selectBestModel(candidates, classification, currentConfig, previousModelId);

  // 7. Atualizar cache
  if (decision.selectedModelId) {
    decisionCache.set(convHash, {
      conversationHash: convHash,
      modelId: decision.selectedModelId,
      timestamp: Date.now(),
    });
  }

  // 8. Log da decisão
  logDecision(decision);

  return decision;
}

// ── Log de decisões ─────────────────────────────────────────────────────

function logDecision(decision: RoutingDecision): void {
  const tc = decision.taskClassification;
  const cats = Object.entries(tc.categories)
    .filter(([, v]) => v && v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

  console.log(
    `[auto-router] modelo=${decision.selectedModelId} score=${decision.score} ` +
    `tarefa="${tc.description}" complexidade=${tc.complexity.toFixed(2)} ` +
    `capacidades=[${cats}] motivo="${decision.reason}"`
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildConversationHash(messages: Array<{ role: string; content: string | any[] }>, hasTools = false): string {
  // Hash simples: últimas 3 mensagens (role + primeiros 100 chars)
  const recent = messages.slice(-3);
  const hash = recent
    .map((m) => {
      const text = typeof m.content === 'string'
        ? m.content.slice(0, 100)
        : Array.isArray(m.content)
          ? m.content.map((p: any) => p.text || p.type || '').join('').slice(0, 100)
          : '';
      return `${m.role}:${text}`;
    })
    .join('|');
  // Inclui o sinal de tools: uma decisão feita SEM tools não deve ser reusada
  // numa requisição COM tools (e vice-versa).
  return `${hasTools ? 'tools' : 'text'}:${hash}`;
}

// ── API para o dashboard ────────────────────────────────────────────────

export function getAutoRouterStatus() {
  return {
    config: currentConfig,
    modelCount: getAllModelMetadata().length,
    availableCount: getAllModelMetadata().filter((m) => m.isAvailable).length,
    cacheSize: decisionCache.size,
  };
}

/** Limpa cache de decisões (útil para testes). */
export function clearDecisionCache(): void {
  decisionCache.clear();
}
