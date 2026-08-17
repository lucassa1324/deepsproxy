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
}

// ── Classificação de tarefa ─────────────────────────────────────────────

export interface TaskClassification {
  categories: Partial<ModelCapabilities>;  // Capacidades necessárias (valores > 0)
  complexity: number;                       // 0-1 (0 = trivial, 1 = extremamente complexo)
  description: string;                      // Descrição legível da tarefa
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
  minCapabilityThreshold: number; // Capacidade mínima aceita (default: 3)
}

// ── Resultado do roteamento ─────────────────────────────────────────────

export interface RoutingDecision {
  selectedModelId: string;
  selectedModelName: string;
  providerId: string;
  taskClassification: TaskClassification;
  score: number;
  reason: string;
  alternatives: string[];       // Outros modelos considerados
  fallbackChain: string[];      // Chain de fallback se falhar
}

// ── Entrada do score ────────────────────────────────────────────────────

export interface ModelScore {
  modelId: string;
  score: number;
  capabilityScore: number;
  costPenalty: number;
  speedBonus: number;
  reason: string;
}
