/*
 * File: types.ts
 * Project: deepsproxy
 * Tipos centrais do Auto Router — sistema de roteamento automático de modelos.
 */

// ── Capacidades do modelo (0-10, onde 0 = não suporta) ──────────────────

export interface ModelCapabilities {
  reasoning: number;  // Raciocínio lógico, dedução, planejamento
  coding: number;     // Programação, debug, arquitetura de código
  math: number;       // Matemática, cálculos, estatística
  writing: number;    // Escrita criativa, redação, copywriting
  vision: number;     // Análise de imagens, OCR, compreensão visual
  general: number;    // Conhecimento geral, conversação, FAQs
}

// ── Custo do modelo (por 1M tokens) ─────────────────────────────────────

export interface ModelCost {
  input: number;   // Custo por 1M tokens de input (USD)
  output: number;  // Custo por 1M tokens de output (USD)
}

// ── Metadados completos de um modelo ────────────────────────────────────

/**
 * Recursos binários do modelo (suporta ou não). Separado das capacidades
 * numéricas (0-10) porque um requisito como "tools" é obrigatório: um modelo
 * sem suporte não pode ser escolhido nem como fallback daquela requisição.
 * Opcional para preservar compatibilidade com metadados antigos/testes.
 */
export interface ModelFeatures {
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  streaming: boolean;
}

export interface ModelMetadata {
  id: string;                    // ID normalizado do modelo
  name: string;                  // Nome de exibição
  providerId: string;            // ID do provedor no registry
  capabilities: ModelCapabilities;
  cost: ModelCost;
  speed: number;                 // 0-10 (10 = mais rápido)
  contextLength: number;         // Janela de contexto em tokens
  isFree: boolean;               // true se custo = 0
  isAvailable: boolean;          // false se indisponível (health check)
  tags: string[];                // Tags livres: "code", "vision", "fast", etc.
  features?: ModelFeatures;      // Recursos binários (tools/vision/JSON/stream)
}

// ── Classificação de tarefa ─────────────────────────────────────────────

export interface TaskRequirements {
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  streaming?: boolean;
  /** O prompt precisa caber inteiro na janela de contexto. */
  minContextTokens?: number;
}

export interface TaskClassification {
  categories: Partial<ModelCapabilities>;  // Capacidades necessárias (valores > 0)
  complexity: number;                       // 0-1 (0 = trivial, 1 = extremamente complexo)
  description: string;                      // Descrição legível da tarefa
  requirements?: TaskRequirements;          // Requisitos binários obrigatórios
}

// ── Política de custo ───────────────────────────────────────────────────

export type CostPolicy =
  | 'economy'       // Prioriza gratuitos / mais baratos
  | 'balanced'      // Melhor custo-benefício
  | 'quality'       // Prioriza qualidade
  | 'free-only'     // Apenas modelos gratuitos
  | 'paid-only';    // Apenas modelos pagos

// ── Configuração do Auto Router ─────────────────────────────────────────

export interface AutoRouterConfig {
  costPolicy: CostPolicy;
  showDecision: boolean;        // Mostrar qual modelo foi selecionado na resposta
  minCapabilityThreshold: number; // Capacidade mínima aceita (default: 5)
  /** Tarefas com complexidade >= gate exigem capacidade PRO: modelos rápidos/
   *  baratos com coding < 8 ou reasoning < 7 são descartados (ex.: refatoração
   *  em lote, múltiplas tools). 0 = sempre ligado; >1 = desligado. Default 0.6. */
  complexityGate?: number;
}

// ── Resultado do roteamento ─────────────────────────────────────────────

export interface ModelExclusion {
  modelId: string;
  reason: string;
}

export interface RoutingDecision {
  selectedModelId: string;
  selectedModelName: string;
  providerId: string;
  taskClassification: TaskClassification;
  score: number;
  reason: string;
  alternatives: string[];       // Outros modelos considerados
  fallbackChain: string[];      // Chain de fallback se falhar
  consideredModels?: number;    // Candidatos após filtros de catálogo/saúde
  exclusions?: ModelExclusion[]; // Modelos descartados e o motivo
}

// ── Entrada do score ────────────────────────────────────────────────────

export interface ModelScore {
  modelId: string;
  score: number;
  capabilityScore: number;
  costPenalty: number;
  speedBonus: number;
  reliabilityScore: number;  // 0-1 (0.5 = neutro/não medido)
  quotaHeadroom: number;     // 0-1 (1 = folga total; 1 quando desconhecido)
  reason: string;
}

// ── Contexto opcional de scoring ────────────────────────────────────────
// Alimenta o seletor com sinais aprendidos/observados (histórico, latência,
// cota, tamanho do prompt) SEM tornar o scoring dependente de estado global:
// quando ausente, o seletor mantém o comportamento determinístico original.

export interface ScoringContext {
  /** Métricas de um modelo (taxa de sucesso, requests, latência média). */
  reliability?: (modelId: string) =>
    | { successRate: number; requests: number; avgLatencyMs: number }
    | undefined;
  /** Headroom de cota 0-1 (1 = folga total). undefined = desconhecido. */
  quotaHeadroom?: (modelId: string) => number | undefined;
  /** Tokens estimados do prompt atual (para headroom de contexto). */
  estimatedTokens?: number;
  /** Provedor principal do registro (preferência leve, nunca obrigatória). */
  preferredProviderId?: string;
}
