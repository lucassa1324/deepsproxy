/*
 * File: model-selector.ts
 * Project: deepsproxy
 * Seletor de modelos — recebe uma classificação de tarefa e retorna o
 * melhor modelo disponível com base em capacidade, custo, velocidade
 * e política de custo configurada.
 */

import type {
  ModelMetadata,
  ModelScore,
  TaskClassification,
  CostPolicy,
  RoutingDecision,
  AutoRouterConfig,
} from './types.ts';

// ── Pesos da fórmula de scoring ─────────────────────────────────────────

interface ScoreWeights {
  capability: number;   // Peso da capacidade (quanto o modelo atende à tarefa)
  cost: number;         // Peso do custo (penalidade por custo alto)
  speed: number;        // Peso da velocidade
  availability: number; // Bonus por estar disponível
}

const POLICY_WEIGHTS: Record<CostPolicy, ScoreWeights> = {
  economy:   { capability: 0.35, cost: 0.40, speed: 0.15, availability: 0.10 },
  balanced:  { capability: 0.40, cost: 0.25, speed: 0.20, availability: 0.15 },
  quality:   { capability: 0.55, cost: 0.10, speed: 0.15, availability: 0.20 },
  'free-only': { capability: 0.45, cost: 0.00, speed: 0.25, availability: 0.30 },
  'paid-only': { capability: 0.50, cost: 0.20, speed: 0.15, availability: 0.15 },
};

// ── Função principal de seleção ─────────────────────────────────────────

/**
 * Seleciona o melhor modelo para a tarefa classificada.
 *
 * @param candidates - Modelos disponíveis para considerar
 * @param classification - Classificação da tarefa
 * @param config - Configuração do Auto Router
 * @param previousModelId - ID do modelo usado anteriormente (para estabilidade)
 */
export function selectBestModel(
  candidates: ModelMetadata[],
  classification: TaskClassification,
  config: AutoRouterConfig,
  previousModelId?: string
): RoutingDecision {
  const weights = POLICY_WEIGHTS[config.costPolicy];

  // 1. Filtrar por disponibilidade e política de custo
  const eligible = filterByPolicy(candidates, config.costPolicy);

  if (eligible.length === 0) {
    // Fallback: se nenhum modelo passou no filtro, tentar com todos os disponíveis
    const available = candidates.filter((m) => m.isAvailable);
    if (available.length === 0) {
      return {
        selectedModelId: '',
        selectedModelName: 'Nenhum modelo disponível',
        providerId: '',
        taskClassification: classification,
        score: 0,
        reason: 'Nenhum modelo disponível no momento',
        alternatives: [],
        fallbackChain: [],
      };
    }
    // Usar o primeiro disponível como fallback
    const fallback = available[0];
    return {
      selectedModelId: fallback.id,
      selectedModelName: fallback.name,
      providerId: fallback.providerId,
      taskClassification: classification,
      score: 0,
      reason: 'Fallback: nenhum modelo atendeu à política de custo',
      alternatives: available.slice(1).map((m) => m.id),
      fallbackChain: available.slice(1).map((m) => m.id),
    };
  }

  // 2. Calcular score para cada modelo
  const gate = config.complexityGate ?? 0.6;
  const scored: ModelScore[] = eligible.map((model) =>
    scoreModel(model, classification, weights, config.minCapabilityThreshold, gate)
  );

  // 3. Ordenar por score (maior = melhor)
  scored.sort((a, b) => b.score - a.score);

  // 4. Bonus de estabilidade: se o modelo anterior está entre os top 3, dar preferência
  if (previousModelId) {
    const prevIndex = scored.findIndex((s) => s.modelId === previousModelId);
    if (prevIndex >= 0 && prevIndex <= 2) {
      const prevScore = scored[prevIndex];
      prevScore.score += 0.05; // Bonus pequeno para estabilidade
      scored.sort((a, b) => b.score - a.score);
    }
  }

  // 5. Selecionar o melhor
  const best = scored[0];
  const bestModel = eligible.find((m) => m.id === best.modelId)!;

  // 6. Montar cadeia de fallback (top 5 alternativas)
  const fallbackChain = scored.slice(1, 6).map((s) => s.modelId);

  // 7. Gerar justificativa
  const reason = generateReason(best, classification, config.costPolicy);

  return {
    selectedModelId: best.modelId,
    selectedModelName: bestModel.name,
    providerId: bestModel.providerId,
    taskClassification: classification,
    score: best.score,
    reason,
    alternatives: scored.slice(1, 4).map((s) => s.modelId),
    fallbackChain,
  };
}

// ── Scoring de um modelo individual ─────────────────────────────────────

function scoreModel(
  model: ModelMetadata,
  classification: TaskClassification,
  weights: ScoreWeights,
  minThreshold: number,
  complexityGate: number
): ModelScore {
  const cap = classification.categories;
  const complexity = classification.complexity;

  // Capability score: média ponderada das capacidades necessárias
  let capabilityScore = 0;
  let capCount = 0;
  const requiredCaps = Object.entries(cap).filter(([, v]) => v && v > 0);

  if (requiredCaps.length > 0) {
    for (const [cat, required] of requiredCaps) {
      const modelValue = (model.capabilities as any)[cat] || 0;
      const normalizedRequired = (required as number) / 10;
      const normalizedModel = modelValue / 10;

      // Se o modelo não atende à capacidade mínima, penalizar
      if (modelValue < minThreshold && (required as number) >= 3) {
        capabilityScore -= 0.3;
      } else {
        // Quanto mais o modelo exige, mais valor ter capacidade alta
        const match = normalizedModel * normalizedRequired;
        capabilityScore += match;
      }
      capCount++;
    }
    capabilityScore = capCount > 0 ? capabilityScore / capCount : 0;
  } else {
    // Sem categorias específicas → usar general
    capabilityScore = (model.capabilities.general || 5) / 10;
  }

  // Bonus por capacidades extras (ter mais do que o necessário)
  const totalCapability = Object.values(model.capabilities).reduce((s, v) => s + v, 0) / 60;
  capabilityScore += totalCapability * 0.1;

  // Penalty: modelos muito fracos para tarefas complexas
  if (complexity > 0.7 && capabilityScore < 0.5) {
    capabilityScore *= 0.5;
  }

  // Gate de qualidade (complexityGate): tarefa COMPLEXA que exige coding/
  // reasoning forte (ex.: refatoração em lote, múltiplas tools, correções
  // profundas) descarta modelos rápidos/baratos de capacidade mediana — o
  // capabilityScore zera, e o modelo PRO/superior vence mesmo em 'balanced'
  // (evita repetir o ciclo em que o gemini-flash é escolhido e falha).
  if (complexity >= complexityGate) {
    const needsStrong = (cap.coding ?? 0) >= 6 || (cap.reasoning ?? 0) >= 6;
    if (needsStrong && (model.capabilities.coding < 8 || model.capabilities.reasoning < 7)) {
      capabilityScore = 0;
    }
  }

  // Cost penalty: normalizado (0 = gratuito, 1 = muito caro)
  // Usar custo combinado (input + output) ponderado
  const totalCost = model.cost.input + model.cost.output * 2; // Output pesa mais
  const costPenalty = Math.min(1, totalCost / 50); // 50 USD = custo máximo normalizado

  // Speed bonus: 0-1
  const speedBonus = model.speed / 10;

  // Availability
  const availability = model.isAvailable ? 1 : 0;

  // Score final
  const score =
    capabilityScore * weights.capability
    + (1 - costPenalty) * weights.cost
    + speedBonus * weights.speed
    + availability * weights.availability;

  return {
    modelId: model.id,
    score: Math.round(score * 1000) / 1000,
    capabilityScore: Math.round(capabilityScore * 1000) / 1000,
    costPenalty: Math.round(costPenalty * 1000) / 1000,
    speedBonus: Math.round(speedBonus * 1000) / 1000,
    reason: '',
  };
}

// ── Filtragem por política de custo ─────────────────────────────────────

function filterByPolicy(models: ModelMetadata[], policy: CostPolicy): ModelMetadata[] {
  return models.filter((m) => {
    if (!m.isAvailable) return false;
    switch (policy) {
      case 'free-only': return m.isFree;
      case 'paid-only': return !m.isFree;
      default: return true;
    }
  });
}

// ── Geração de justificativa ────────────────────────────────────────────

function generateReason(
  score: ModelScore,
  classification: TaskClassification,
  policy: CostPolicy
): string {
  const parts: string[] = [];

  // Capacidade
  if (score.capabilityScore > 0.8) {
    parts.push('excelente capacidade para a tarefa');
  } else if (score.capabilityScore > 0.6) {
    parts.push('boa capacidade para a tarefa');
  } else if (score.capabilityScore > 0.4) {
    parts.push('capacidade adequada');
  } else {
    parts.push('capacidade mínima aceitável');
  }

  // Custo
  if (score.costPenalty < 0.1) {
    parts.push('custo zero/gratuito');
  } else if (score.costPenalty < 0.3) {
    parts.push('custo baixo');
  } else if (score.costPenalty > 0.7) {
    parts.push('custo alto (justificado pela complexidade)');
  }

  // Velocidade
  if (score.speedBonus > 0.8) {
    parts.push('resposta rápida');
  }

  return parts.join('; ') || 'melhor opção disponível';
}
