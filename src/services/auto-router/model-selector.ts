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
  ScoringContext,
  ModelExclusion,
  ModelFeatures,
} from './types.ts';
import { inferModelFeatures } from './model-metadata.ts';

const PREFERRED_PROVIDER_BONUS = 0.03;

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
  quality:   { capability: 0.65, cost: 0.05, speed: 0.10, availability: 0.20 },
  'free-only': { capability: 0.45, cost: 0.00, speed: 0.25, availability: 0.30 },
  'paid-only': { capability: 0.50, cost: 0.20, speed: 0.15, availability: 0.15 },
};

// ── Ajustes aprendidos (L1.1/L1.2/L2.4) ─────────────────────────────────
// Só entram quando há amostra suficiente; sem métricas o sinal é NEUTRO e o
// scoring permanece idêntico ao determinístico (preserva ordem e testes).

const RELIABILITY_WEIGHT = 0.15; // deslocamento máximo ±0.075
const MIN_SAMPLES = 3;           // requests mínimos p/ confiar numa métrica
const EXPLORE_BONUS = 0.02;      // chance (determinística) p/ modelos pouco testados
const LAPLACE_ALPHA = 2;         // suavização de Laplace (prior = 0.5)

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
  previousModelId?: string,
  ctx?: ScoringContext
): RoutingDecision {
  const weights = POLICY_WEIGHTS[config.costPolicy];

  // 1. Filtros rígidos: disponibilidade, política de custo e requisitos
  // binários da tarefa (visão/tools/JSON/streaming/contexto). Um modelo que não
  // atende a um requisito obrigatório NÃO pode ser escolhido nem como fallback:
  // o erro precisa ser explícito em vez de encaminhar para um modelo incompatível.
  const { eligible, exclusions } = filterCandidates(candidates, config, classification);

  if (eligible.length === 0) {
    return {
      selectedModelId: '',
      selectedModelName: 'Nenhum modelo compatível',
      providerId: '',
      taskClassification: classification,
      score: 0,
      reason: buildNoModelReason(exclusions),
      alternatives: [],
      fallbackChain: [],
      consideredModels: candidates.length,
      exclusions,
    };
  }

  // 2. Calcular score para cada modelo
  const gate = config.complexityGate ?? 0.6;
  const scored: ModelScore[] = eligible.map((model) => {
    const score = scoreModel(model, classification, weights, config.minCapabilityThreshold, gate, ctx);
    if (ctx?.preferredProviderId && model.providerId === ctx.preferredProviderId) {
      score.score = Math.round((score.score + PREFERRED_PROVIDER_BONUS) * 1000) / 1000;
    }
    return score;
  });

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
    consideredModels: candidates.length,
    exclusions,
  };
}

// ── Scoring de um modelo individual ─────────────────────────────────────

function scoreModel(
  model: ModelMetadata,
  classification: TaskClassification,
  weights: ScoreWeights,
  minThreshold: number,
  complexityGate: number,
  ctx?: ScoringContext
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

  // L2.5 — Headroom de contexto: se o prompt estimado não cabe na janela do
  // modelo, ele é praticamente descartado (evita 400/truncamento no meio da
  // conversa). Perto do limite, penalidade leve.
  if (ctx?.estimatedTokens && model.contextLength > 0) {
    const need = ctx.estimatedTokens;
    if (model.contextLength < need * 1.15) {
      capabilityScore *= 0.05;
    } else if (model.contextLength < need * 2) {
      capabilityScore *= 0.85;
    }
  }

  // Cost penalty: normalizado (0 = gratuito, 1 = muito caro)
  // Usar custo combinado (input + output) ponderado
  const totalCost = model.cost.input + model.cost.output * 2; // Output pesa mais
  const costPenalty = Math.min(1, totalCost / 50); // 50 USD = custo máximo normalizado

  // L2.4 — Speed: usa a latência REAL observada quando há amostra; sem
  // medição cai no `speed` estático (mantém saída determinística nos testes).
  let speedSignal = model.speed / 10;
  let sample = ctx?.reliability?.(model.id);
  if (sample && sample.requests >= MIN_SAMPLES && sample.avgLatencyMs > 0) {
    // 1s → ~1.0; 20s → ~0.4; 60s+ → ~0 (escala log).
    const measured = Math.max(
      0,
      Math.min(1, 1 - Math.log10(Math.max(1, sample.avgLatencyMs / 1000)) / Math.log10(60))
    );
    speedSignal = 0.5 * (model.speed / 10) + 0.5 * measured;
  }

  // Availability
  const availability = model.isAvailable ? 1 : 0;

  // L1.1 — Reliability: aprende com o histórico (taxa de sucesso com
  // suavização de Laplace). Neutro (0.5) quando não há amostra suficiente.
  let reliabilityScore = 0.5;
  if (sample && sample.requests >= MIN_SAMPLES) {
    const successes = sample.successRate * sample.requests;
    reliabilityScore = (successes + LAPLACE_ALPHA) / (sample.requests + LAPLACE_ALPHA * 2);
  }

  // L1.2 — Exploração determinística: modelos pouco testados ganham um empurrão
  // fixo (não-RNG, para manter a decisão reproduzível) até acumularem amostra.
  const exploreBonus = !sample || sample.requests < MIN_SAMPLES ? EXPLORE_BONUS : 0;

  // L1.3 — Headroom de cota: multiplicador 0.4-1.0. Sem informação, 1.0 (neutro).
  let quotaHeadroom = 1;
  const headroom = ctx?.quotaHeadroom?.(model.id);
  if (typeof headroom === 'number' && Number.isFinite(headroom)) {
    quotaHeadroom = Math.max(0, Math.min(1, headroom));
  }
  const quotaFactor = 0.4 + 0.6 * quotaHeadroom;

  // Score final (multiplicado pelo fator de cota)
  const score =
    (
      capabilityScore * weights.capability
      + (1 - costPenalty) * weights.cost
      + speedSignal * weights.speed
      + availability * weights.availability
      + (reliabilityScore - 0.5) * RELIABILITY_WEIGHT
      + exploreBonus
    ) * quotaFactor;

  return {
    modelId: model.id,
    score: Math.round(score * 1000) / 1000,
    capabilityScore: Math.round(capabilityScore * 1000) / 1000,
    costPenalty: Math.round(costPenalty * 1000) / 1000,
    speedBonus: Math.round(speedSignal * 1000) / 1000,
    reliabilityScore: Math.round(reliabilityScore * 1000) / 1000,
    quotaHeadroom: Math.round(quotaHeadroom * 1000) / 1000,
    reason: '',
  };
}

// ── Filtragem rígida (política de custo + requisitos) ───────────────────

function filterCandidates(
  models: ModelMetadata[],
  config: AutoRouterConfig,
  classification: TaskClassification
): { eligible: ModelMetadata[]; exclusions: ModelExclusion[] } {
  const eligible: ModelMetadata[] = [];
  const exclusions: ModelExclusion[] = [];
  const requirements = classification.requirements;

  for (const model of models) {
    const reasons: string[] = [];

    if (!model.isAvailable) reasons.push('indisponível');
    if (config.costPolicy === 'free-only' && !model.isFree) reasons.push('política free-only (modelo pago)');
    if (config.costPolicy === 'paid-only' && model.isFree) reasons.push('política paid-only (modelo gratuito)');

    if (requirements) {
      const features: ModelFeatures =
        model.features || inferModelFeatures(model.id, model.capabilities, model.tags);
      if (requirements.vision && !features.vision) reasons.push('não suporta visão');
      if (requirements.tools && !features.tools) reasons.push('não suporta tools/function calling');
      if (requirements.structuredOutput && !features.structuredOutput) {
        reasons.push('não suporta structured output/JSON');
      }
      if (requirements.streaming && !features.streaming) reasons.push('não suporta streaming');
      if (
        requirements.minContextTokens &&
        (!model.contextLength || model.contextLength < requirements.minContextTokens)
      ) {
        reasons.push(
          `contexto insuficiente (${model.contextLength || 'desconhecido'} < ${requirements.minContextTokens} tokens)`
        );
      }
    }

    if (reasons.length === 0) eligible.push(model);
    else exclusions.push({ modelId: model.id, reason: reasons.join('; ') });
  }

  return { eligible, exclusions };
}

function buildNoModelReason(exclusions: ModelExclusion[]): string {
  if (exclusions.length === 0) return 'Nenhum modelo disponível no momento';
  const sample = exclusions
    .slice(0, 3)
    .map((e) => `${e.modelId}: ${e.reason}`)
    .join('; ');
  return `Nenhum modelo compatível com a tarefa (${exclusions.length} excluído(s): ${sample})`;
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
