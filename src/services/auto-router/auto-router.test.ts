/*
 * File: auto-router.test.ts
 * Project: deepsproxy
 * Testes automatizados do Auto Router.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from './task-classifier.ts';
import { selectBestModel } from './model-selector.ts';
import { routeRequest, clearDecisionCache, updateAutoRouterConfig, getAutoRouterStatus, getPreviousAutoModel, rememberAutoModel, clearConversationMemory, buildAutoFailoverChain } from './router.ts';
import { registerModel, setModelAvailability, isModelDown, recordModelFailure, recordModelSuccess, resetModelHealth, getModelHealthState, inferCapabilities, getModelMetadata, recordModelRequest, recordModelLatency, recordModelOutcome, getModelMetrics, getModelMetricsFor, resetModelMetrics } from './model-metadata.ts';
import type { ModelMetadata, AutoRouterConfig } from './types.ts';

// ── Modelos de teste (mesmos IDs do registry global para override) ──────

const TEST_MODELS: ModelMetadata[] = [
  {
    id: 'free-fast',
    name: 'Free Fast',
    providerId: 'test-ollama',
    capabilities: { reasoning: 5, coding: 5, math: 4, writing: 5, vision: 0, general: 6 },
    cost: { input: 0, output: 0 },
    speed: 9,
    contextLength: 128000,
    isFree: true,
    isAvailable: true,
    tags: ['local', 'fast'],
  },
  {
    id: 'paid-mid',
    name: 'Paid Mid',
    providerId: 'test-openai',
    capabilities: { reasoning: 7, coding: 7, math: 7, writing: 7, vision: 0, general: 7 },
    cost: { input: 1.0, output: 2.0 },
    speed: 7,
    contextLength: 128000,
    isFree: false,
    isAvailable: true,
    tags: ['balanced'],
  },
  {
    id: 'paid-high',
    name: 'Paid High',
    providerId: 'test-anthropic',
    capabilities: { reasoning: 10, coding: 10, math: 9, writing: 9, vision: 8, general: 9 },
    cost: { input: 15.0, output: 75.0 },
    speed: 5,
    contextLength: 200000,
    isFree: false,
    isAvailable: true,
    tags: ['premium', 'code', 'reasoning'],
  },
  {
    id: 'vision-model',
    name: 'Vision Model',
    providerId: 'test-gemini',
    capabilities: { reasoning: 6, coding: 5, math: 5, writing: 5, vision: 10, general: 6 },
    cost: { input: 0.5, output: 1.5 },
    speed: 8,
    contextLength: 1048576,
    isFree: false,
    isAvailable: true,
    tags: ['vision', 'fast'],
  },
  {
    id: 'code-specialist',
    name: 'Code Specialist',
    providerId: 'test-openai',
    capabilities: { reasoning: 7, coding: 10, math: 6, writing: 4, vision: 0, general: 5 },
    cost: { input: 0.5, output: 1.5 },
    speed: 8,
    contextLength: 64000,
    isFree: false,
    isAvailable: true,
    tags: ['code'],
  },
];

function setupTestModels(): void {
  for (const m of TEST_MODELS) {
    registerModel(m.id, m);
  }
}

function makeConfig(overrides: Partial<AutoRouterConfig> = {}): AutoRouterConfig {
  return {
    costPolicy: 'balanced',
    showDecision: true,
    minCapabilityThreshold: 3,
    ...overrides,
  };
}

function testCandidates(): ModelMetadata[] {
  // Return ONLY the test models (by ID filter)
  const testIds = new Set(TEST_MODELS.map((m) => m.id));
  return TEST_MODELS.filter((m) => m.isAvailable);
}

function testAvailableIds(): Array<{ id: string; providerId: string }> {
  return TEST_MODELS.map((m) => ({ id: m.id, providerId: m.providerId }));
}

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Classificação de Tarefas
// ══════════════════════════════════════════════════════════════════════════

describe('Task Classifier', () => {
  it('classifica programação simples', () => {
    const result = classifyTask([], 'Crie uma função em Python para validar CPF');
    assert.ok(result.categories.coding && result.categories.coding > 3, 'deve detectar coding');
    assert.ok(result.complexity < 0.7, 'complexidade deve ser moderada/baixa');
  });

  it('classifica programação complexa', () => {
    const result = classifyTask([], 'Analise esse projeto inteiro, encontre problemas arquiteturais e proponha uma refatoração completa do sistema de autenticação');
    assert.ok(result.categories.coding && result.categories.coding > 3, 'deve ter coding alto');
    assert.ok(result.categories.reasoning && result.categories.reasoning > 0, 'deve ter reasoning');
    assert.ok(result.complexity > 0.3, 'complexidade deve ser moderada/alta');
  });

  it('classifica matemática simples', () => {
    const result = classifyTask([], 'Quanto é 10 + 15?');
    assert.ok(result.categories.math && result.categories.math > 0, 'deve detectar math');
  });

  it('classifica matemática complexa', () => {
    const result = classifyTask([], 'Resolva essa equação diferencial complexa e demonstre o teorema com prova rigorosa');
    assert.ok(result.categories.math && result.categories.math > 3, 'deve ter math alto');
  });

  it('classifica escrita', () => {
    const result = classifyTask([], 'Escreva um texto publicitário para um app de delivery');
    assert.ok(result.categories.writing && result.categories.writing > 3, 'deve detectar writing');
  });

  it('classifica resumo', () => {
    const result = classifyTask([], 'Resuma esse artigo em 3 parágrafos');
    assert.ok(result.categories.writing && result.categories.writing > 0, 'deve detectar writing');
  });

  it('classifica análise de imagem', () => {
    const result = classifyTask([], 'Analise essa imagem e descreva o que vê');
    assert.ok(result.categories.vision && result.categories.vision > 3, 'deve detectar vision');
  });

  it('classifica tarefa geral', () => {
    const result = classifyTask([], 'O que é fotossíntese?');
    assert.ok(result.categories.general && result.categories.general > 0, 'deve detectar general');
  });

  it('classifica tarefa ambígua com contexto', () => {
    const messages = [
      { role: 'user', content: 'Vamos construir uma API em Node.js' },
      { role: 'assistant', content: 'Claro! Vamos começar...' },
      { role: 'user', content: 'Agora implemente a autenticação' },
    ];
    const result = classifyTask(messages, 'Agora implemente a autenticação');
    assert.ok(result.categories.coding && result.categories.coding > 3, 'deve ter coding no contexto');
  });

  it('classifica tarefa mista (múltiplas capacidades)', () => {
    const result = classifyTask([], 'Escreva uma função em Python que gere um relatório com gráficos');
    assert.ok(result.categories.coding && result.categories.coding > 0, 'deve ter coding');
    assert.ok(result.categories.writing && result.categories.writing > 0, 'deve ter writing');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Seleção de Modelos
// ══════════════════════════════════════════════════════════════════════════

describe('Model Selector', () => {
  beforeEach(() => {
    setupTestModels();
  });

  it('escolhe modelo de código para tarefa de coding', () => {
    const config = makeConfig({ costPolicy: 'balanced' });
    const classification = {
      categories: { coding: 8 } as any,
      complexity: 0.5,
      description: 'Tarefa intermediária — Programação',
    };
    const result = selectBestModel(testCandidates(), classification, config);
    assert.equal(result.selectedModelId, 'code-specialist', 'deve escolher o code-specialist');
  });

  it('escolhe modelo de visão para tarefa com imagem', () => {
    const config = makeConfig();
    const classification = {
      categories: { vision: 9 } as any,
      complexity: 0.3,
      description: 'Tarefa simples — Visão/Imagem',
    };
    const result = selectBestModel(testCandidates(), classification, config);
    assert.equal(result.selectedModelId, 'vision-model', 'deve escolher o vision-model');
  });

  it('respeita política free-only', () => {
    const config = makeConfig({ costPolicy: 'free-only' });
    const classification = {
      categories: { coding: 8, reasoning: 8 } as any,
      complexity: 0.7,
      description: 'Tarefa complexa — Programação + Raciocínio',
    };
    const result = selectBestModel(testCandidates(), classification, config);
    const selected = TEST_MODELS.find((m) => m.id === result.selectedModelId);
    assert.ok(selected?.isFree, 'deve escolher modelo gratuito');
  });

  it('respeita política paid-only', () => {
    const config = makeConfig({ costPolicy: 'paid-only' });
    const classification = {
      categories: { writing: 5 } as any,
      complexity: 0.3,
      description: 'Tarefa simples — Escrita',
    };
    const result = selectBestModel(testCandidates(), classification, config);
    const selected = TEST_MODELS.find((m) => m.id === result.selectedModelId);
    assert.ok(selected && !selected.isFree, 'deve escolher modelo pago');
  });

  it('escolhe modelo potente para tarefa complexa (quality policy)', () => {
    const config = makeConfig({ costPolicy: 'quality' });
    // Tarefa que exige MÚLTIPLAS capacidades altas (não só coding)
    const classification = {
      categories: { reasoning: 10, coding: 9, math: 9, writing: 8 } as any,
      complexity: 0.95,
      description: 'Tarefa muito complexa — Programação + Raciocínio + Matemática + Escrita',
    };
    const result = selectBestModel(testCandidates(), classification, config);
    assert.equal(result.selectedModelId, 'paid-high', 'deve escolher o modelo mais potente');
  });

  it('retorna fallback quando nenhum modelo disponível', () => {
    const config = makeConfig();
    const classification = {
      categories: { coding: 5 } as any,
      complexity: 0.3,
      description: 'Tarefa intermediária — Programação',
    };
    const candidates = TEST_MODELS.map((m) => ({ ...m, isAvailable: false }));
    const result = selectBestModel(candidates, classification, config);
    assert.ok(!result.selectedModelId, 'deve retornar modelo vazio');
  });

  it('retorna cadeia de fallback', () => {
    const config = makeConfig();
    const classification = {
      categories: { coding: 7 } as any,
      complexity: 0.5,
      description: 'Tarefa intermediária — Programação',
    };
    const result = selectBestModel(testCandidates(), classification, config);
    assert.ok(result.fallbackChain.length > 0, 'deve ter cadeia de fallback');
    assert.ok(result.alternatives.length > 0, 'deve ter alternativas');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Router Principal
// ══════════════════════════════════════════════════════════════════════════

describe('Auto Router', () => {
  beforeEach(() => {
    setupTestModels();
    clearDecisionCache();
    updateAutoRouterConfig(makeConfig());
  });

  it('roteia tarefa de programação para modelo de código', () => {
    const result = routeRequest([], 'Implemente uma API REST em Node.js com autenticação JWT', testAvailableIds());
    assert.ok(result.selectedModelId, 'deve selecionar um modelo');
    assert.ok(result.reason.length > 0, 'deve ter justificativa');
  });

  it('com tools presentes, roteia para modelo de programação mesmo sem palavras de código', () => {
    // Mensagem de agente/IDE (ex.: Trae) que traz tools mas cujo texto não cita
    // programação explicitamente ("rodar na vercel os modelos que usam playwright").
    const result = routeRequest(
      [],
      'voce esta por dentro de todo o projeto? como eu faco para rodar na vercel os modelos que usam o playwright?',
      testAvailableIds(),
      undefined,
      false,
      true // hasTools
    );
    const selected = TEST_MODELS.find((m) => m.id === result.selectedModelId);
    assert.ok(selected, 'deve selecionar um modelo');
    assert.ok(
      (selected?.capabilities.coding ?? 0) >= 7,
      `deve escolher modelo com boa capacidade de programação, veio: ${result.selectedModelId}`
    );
  });

  it('sem tools, tarefa genérica não força modelo de programação caro', () => {
    const result = routeRequest(
      [],
      'voce esta por dentro de todo o projeto? como eu faco para rodar na vercel os modelos que usam o playwright?',
      testAvailableIds()
    );
    const selected = TEST_MODELS.find((m) => m.id === result.selectedModelId);
    assert.ok(selected, 'deve selecionar um modelo');
    assert.ok(selected.id !== 'paid-high', 'não deve usar o modelo mais caro para pergunta genérica');
  });

  it('roteia tarefa de imagem para modelo de visão', () => {
    const result = routeRequest([], 'Analise essa imagem e descreva o que vê', testAvailableIds());
    assert.equal(result.selectedModelId, 'vision-model', 'deve escolher modelo de visão');
  });

  it('mantém estabilidade entre mensagens da mesma conversa', () => {
    const messages = [
      { role: 'user', content: 'Crie uma função em Python' },
      { role: 'assistant', content: 'Aqui está a função...' },
    ];
    const result1 = routeRequest(messages, 'Agora adicione tratamento de erros', testAvailableIds());
    const result2 = routeRequest(
      [...messages, { role: 'assistant', content: 'Feito!' }, { role: 'user', content: 'Adicione logs' }],
      'Adicione logs',
      testAvailableIds()
    );
    assert.equal(result1.selectedModelId, result2.selectedModelId, 'deve manter o mesmo modelo');
  });

  it('retorna erro quando nenhum modelo disponível', () => {
    const result = routeRequest([], 'Qualquer tarefa', []);
    assert.equal(result.selectedModelId, '', 'deve retornar modelo vazio');
    assert.ok(result.reason.includes('Nenhum'), 'deve indicar que não há modelos');
  });

  it('usa política economy para tarefas simples', () => {
    updateAutoRouterConfig(makeConfig({ costPolicy: 'economy' }));
    const result = routeRequest([], 'O que é uma variável em Python?', testAvailableIds());
    assert.ok(result.selectedModelId, 'deve selecionar um modelo');
    // Economy deve preferir gratuito
    const selected = TEST_MODELS.find((m) => m.id === result.selectedModelId);
    assert.ok(selected, 'deve selecionar modelo existente');
  });

  it('classifica tarefa e retorna descrição', () => {
    const result = routeRequest([], 'Faça uma API REST em Node.js', testAvailableIds());
    assert.ok(result.taskClassification.description.length > 0, 'deve ter descrição');
    assert.ok(typeof result.taskClassification.complexity === 'number', 'deve ter complexidade');
  });

  it('muda de modelo quando tarefa muda drasticamente', () => {
    // Primeira: programação
    const r1 = routeRequest([], 'Crie uma função em Python', testAvailableIds());
    // Limpar cache para forçar reclassificação
    clearDecisionCache();
    // Segunda: imagem (tarefa completamente diferente)
    const r2 = routeRequest(
      [{ role: 'user', content: 'Crie uma função em Python' }, { role: 'assistant', content: 'Feito!' }],
      'Analise essa imagem de satélite',
      testAvailableIds()
    );
    assert.equal(r2.selectedModelId, 'vision-model', 'deve trocar para modelo de visão');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Economia de Recursos
// ══════════════════════════════════════════════════════════════════════════

describe('Resource Economy', () => {
  beforeEach(() => {
    setupTestModels();
    clearDecisionCache();
  });

  it('não usa modelo caro para tarefa trivial', () => {
    updateAutoRouterConfig(makeConfig({ costPolicy: 'economy' }));
    const result = routeRequest([], 'Obrigado!', testAvailableIds());
    const selected = TEST_MODELS.find((m) => m.id === result.selectedModelId);
    assert.ok(selected, 'deve selecionar modelo');
    // Economy: não deve优选 o paid-high para "obrigado"
    if (selected) {
      assert.ok(selected.id !== 'paid-high', 'não deve usar premium para agradecimento');
    }
  });

  it('usa modelo potente quando complexidade justifica (quality)', () => {
    updateAutoRouterConfig(makeConfig({ costPolicy: 'quality' }));
    const result = routeRequest(
      [],
      'Analise a arquitetura de microserviços deste projeto, encontre gargalos de performance, proponha soluções de caching e implemente um sistema de fallback resilient com testes unitários completos',
      testAvailableIds()
    );
    assert.equal(result.selectedModelId, 'paid-high', 'deve usar premium para tarefa complexa');
  });

  it('não desperdiça tokens com classificação (sem chamadas externas)', () => {
    const available = testAvailableIds();
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      routeRequest([], 'Teste de performance ' + i, available);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `100 classificações devem levar < 5s (levou ${elapsed}ms)`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Circuit Breaker (saúde dos modelos)
// ══════════════════════════════════════════════════════════════════════════

describe('Circuit Breaker', () => {
  beforeEach(() => {
    setupTestModels();
    clearDecisionCache();
    resetModelHealth();
  });

  it('modelo começa saudável e sai do roteamento após falha', () => {
    assert.equal(isModelDown('paid-high'), false, 'inicialmente deve estar de pé');
    recordModelFailure('paid-high', 500, 'HTTP 500');
    assert.equal(isModelDown('paid-high'), true, 'deve ficar down após falha');
  });

  it('volta ao roteamento após o cooldown expirar', () => {
    const now = Date.now();
    recordModelFailure('paid-high');
    assert.equal(isModelDown('paid-high', now), true, 'down logo após a falha');
    // 31s depois o cooldown base (30s) já expirou
    assert.equal(isModelDown('paid-high', now + 31_000), false, 'deve voltar após o cooldown');
  });

  it('aplica backoff exponencial em falhas consecutivas', () => {
    recordModelFailure('paid-high');
    const first = getModelHealthState().find((h) => h.modelId === 'paid-high')!.downUntil;
    recordModelFailure('paid-high');
    recordModelFailure('paid-high');
    const third = getModelHealthState().find((h) => h.modelId === 'paid-high')!.downUntil;
    // 1ª falha: 30s; 3ª falha: 30s * 2^2 = 120s → cooldown cresce
    assert.ok(third - first >= 90_000, 'cooldown deve crescer a cada falha consecutiva');
    // 6ª falha em diante satura no máximo (10min)
    recordModelFailure('paid-high');
    recordModelFailure('paid-high');
    recordModelFailure('paid-high');
    const sixth = getModelHealthState().find((h) => h.modelId === 'paid-high')!.downUntil;
    const elapsed = sixth - Date.now();
    assert.ok(elapsed <= 600_000 && elapsed >= 599_000, `backoff deve saturar em ~10min (teve ${elapsed}ms)`);
  });

  it('sucesso fecha o circuito e zera as falhas', () => {
    recordModelFailure('paid-high');
    recordModelFailure('paid-high');
    assert.equal(isModelDown('paid-high'), true, 'down após falhas');
    recordModelSuccess('paid-high');
    assert.equal(isModelDown('paid-high'), false, 'sucesso reabilita na hora');
    assert.equal(getModelHealthState().length, 0, 'histórico de falhas limpo');
  });

  it('router não escolhe modelo down mesmo sendo o melhor', () => {
    updateAutoRouterConfig(makeConfig({ costPolicy: 'quality' }));
    const msg = 'Analise a arquitetura de microserviços deste projeto, encontre gargalos de performance, proponha soluções de caching e implemente um sistema de fallback resilient com testes unitários completos';
    // Quality normalmente escolheria paid-high (melhor).
    recordModelFailure('paid-high');
    const result = routeRequest([], msg, testAvailableIds());
    assert.notEqual(result.selectedModelId, 'paid-high', 'modelo down não pode ser escolhido');
    assert.ok(result.selectedModelId, 'deve escolher outro modelo disponível');
  });

  it('retorna "nenhum modelo disponível" quando todos estão down', () => {
    for (const m of TEST_MODELS) recordModelFailure(m.id);
    const result = routeRequest([], 'Qualquer tarefa', testAvailableIds());
    assert.equal(result.selectedModelId, '', 'nenhum modelo disponível');
    assert.ok(result.reason.toLowerCase().includes('nenhum'), 'deve indicar indisponibilidade');
  });

  it('expõe estado de saúde no status do roteador', () => {
    recordModelFailure('paid-high', 503, 'HTTP 503');
    const status = getAutoRouterStatus();
    assert.equal(status.downedCount, 1, 'deve contar 1 modelo down');
    assert.equal(status.downedModels[0].modelId, 'paid-high');
    assert.ok(status.downedModels[0].retryInMs > 0, 'deve informar quando o retry é possível');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Estabilidade entre turnos (previousModelId real por conversa)
// ══════════════════════════════════════════════════════════════════════════

describe('Conversation Memory', () => {
  beforeEach(() => {
    setupTestModels();
    clearDecisionCache();
    clearConversationMemory();
  });

  it('retorna undefined antes de qualquer roteamento', () => {
    assert.equal(getPreviousAutoModel([{ role: 'user', content: 'oi' }], 'app', 'auto'), undefined);
  });

  it('lembra o modelo e devolve no próximo turno da mesma conversa', () => {
    const msgs1 = [{ role: 'user', content: 'Primeira pergunta' }];
    rememberAutoModel(msgs1, 'app1', 'auto', 'code-specialist');
    // Turno 2: mesma conversa (mesma primeira mensagem), histórico cresceu
    const msgs2 = [
      ...msgs1,
      { role: 'assistant', content: 'resposta' },
      { role: 'user', content: 'segunda pergunta' },
    ];
    assert.equal(getPreviousAutoModel(msgs2, 'app1', 'auto'), 'code-specialist');
  });

  it('isola conversas diferentes (primeira mensagem diferente)', () => {
    rememberAutoModel([{ role: 'user', content: 'conversa A' }], 'app', 'auto', 'paid-high');
    assert.equal(getPreviousAutoModel([{ role: 'user', content: 'conversa B' }], 'app', 'auto'), undefined);
  });

  it('isola apps/clientes diferentes (namespace)', () => {
    rememberAutoModel([{ role: 'user', content: 'oi' }], 'app1', 'auto', 'paid-high');
    assert.equal(getPreviousAutoModel([{ role: 'user', content: 'oi' }], 'app2', 'auto'), undefined);
  });

  it('isola modos auto vs auto-free', () => {
    rememberAutoModel([{ role: 'user', content: 'oi' }], 'app', 'auto', 'paid-high');
    assert.equal(getPreviousAutoModel([{ role: 'user', content: 'oi' }], 'app', 'auto-free'), undefined);
  });

  it('não vaza modelo entre conversas com system diferente', () => {
    const msgsA = [{ role: 'system', content: 'Você é A' }, { role: 'user', content: 'oi' }];
    const msgsB = [{ role: 'system', content: 'Você é B' }, { role: 'user', content: 'oi' }];
    rememberAutoModel(msgsA, 'app', 'auto', 'paid-high');
    assert.equal(getPreviousAutoModel(msgsB, 'app', 'auto'), undefined);
  });

  it('fluxo completo: decisão → memória → próximo turno reusa o modelo', () => {
    updateAutoRouterConfig(makeConfig({ costPolicy: 'economy' }));
    const msgs1 = [{ role: 'user', content: 'escreva um poema' }];
    const d1 = routeRequest(msgs1, 'escreva um poema', testAvailableIds());
    assert.ok(d1.selectedModelId, '1º turno deve escolher modelo');
    rememberAutoModel(msgs1, 'app', 'auto', d1.selectedModelId);

    const msgs2 = [
      ...msgs1,
      { role: 'assistant', content: 'poema' },
      { role: 'user', content: 'agora mais longo' },
    ];
    const prev = getPreviousAutoModel(msgs2, 'app', 'auto');
    assert.equal(prev, d1.selectedModelId, 'deve lembrar o modelo do 1º turno');
    const d2 = routeRequest(msgs2, 'agora mais longo', testAvailableIds(), prev);
    assert.ok(d2.selectedModelId, '2º turno deve escolher modelo');
    // Com o bonus de estabilidade, o modelo anterior (se ainda elegível no top
    // 3) é mantido — nunca troca para piorar continuidade.
    assert.equal(d2.selectedModelId, d1.selectedModelId, 'deve manter o modelo entre turnos');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Inferência de capacidades de modelos dinâmicos
// ══════════════════════════════════════════════════════════════════════════

describe('Capabilities Inference', () => {
  it('modelo desconhecido mantém valores neutros (não extremos)', () => {
    const caps = inferCapabilities('random-model-xyz');
    assert.equal(caps.reasoning, 5);
    assert.equal(caps.coding, 5);
    assert.equal(caps.vision, 0);
    assert.equal(caps.general, 5);
  });

  it('gemini-flash tem visão, é capaz e rápido-por-natureza (visão ligeiramente menor que pro)', () => {
    const flash = inferCapabilities('gemini-2.5-flash');
    assert.ok(flash.vision >= 7, 'gemini tem visão');
    assert.ok(flash.general >= 7, 'gemini é capaz no geral');
    const pro = inferCapabilities('gemini-2.5-pro');
    assert.ok(pro.reasoning >= 9, 'pro tem raciocínio máximo');
    assert.ok(pro.coding >= 9, 'pro é excelente em código');
  });

  it('deepseek-r1 é modelo de raciocínio/matemática', () => {
    const caps = inferCapabilities('deepseek-r1');
    assert.equal(caps.reasoning, 9);
    assert.equal(caps.math, 9);
    assert.ok(caps.coding >= 8, 'deepseek é forte em código');
  });

  it('qwen-coder-plus prioriza código e raciocínio', () => {
    const caps = inferCapabilities('qwen-coder-plus');
    assert.ok(caps.coding >= 9, 'coder deve ter coding máximo');
    assert.ok(caps.reasoning >= 8, 'plus deve ter raciocínio forte');
  });

  it('claude-opus é top em escrita, código e visão', () => {
    const caps = inferCapabilities('claude-opus-4.5');
    assert.equal(caps.reasoning, 9);
    assert.equal(caps.coding, 9);
    assert.equal(caps.writing, 9);
    assert.ok(caps.vision >= 8, 'claude tem visão');
  });

  it('modelo local grande (70b) ganha capacidades, leve (7b) não', () => {
    const big = inferCapabilities('my-local-70b');
    assert.ok(big.reasoning >= 7);
    assert.ok(big.general >= 7);
    const small = inferCapabilities('my-local-7b');
    assert.equal(small.reasoning, 5);
  });

  it('registerModel aplica inferência a modelos dinâmicos', () => {
    registerModel('exotic-coder-v2', { providerId: 'p' });
    registerModel('plain-unknown', { providerId: 'p' });
    assert.ok(getModelMetadata('exotic-coder-v2')!.capabilities.coding >= 8, 'coder inferido');
    assert.equal(getModelMetadata('plain-unknown')!.capabilities.coding, 5, 'desconhecido neutro');
  });

  it('roteia tarefa de código para modelo dinâmico com coding no nome', () => {
    registerModel('x-coder-9', { providerId: 'p' });
    registerModel('y-generic-2', { providerId: 'p' });
    clearDecisionCache();
    const result = routeRequest(
      [],
      'Escreva uma função em Python para ordenar uma lista',
      [
        { id: 'x-coder-9', providerId: 'p' },
        { id: 'y-generic-2', providerId: 'p' },
      ]
    );
    assert.equal(result.selectedModelId, 'x-coder-9', 'deve escolher o modelo com coding no nome');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Métricas de saúde por modelo
// ══════════════════════════════════════════════════════════════════════════

describe('Model Metrics', () => {
  beforeEach(() => {
    resetModelMetrics();
    resetModelHealth();
  });

  it('começa sem métricas registradas', () => {
    assert.equal(getModelMetrics().length, 0);
    assert.equal(getModelMetricsFor('paid-high'), undefined);
  });

  it('acumula requests, sucessos e falhas', () => {
    recordModelRequest('paid-high');
    recordModelOutcome('paid-high', true);
    recordModelRequest('paid-high');
    recordModelOutcome('paid-high', false, 'HTTP 500');
    const m = getModelMetricsFor('paid-high')!;
    assert.equal(m.requests, 2);
    assert.equal(m.successes, 1);
    assert.equal(m.failures, 1);
    assert.equal(m.successRate, 0.5);
    assert.equal(m.lastError, 'HTTP 500');
  });

  it('calcula latência média e última', () => {
    recordModelRequest('free-fast');
    recordModelLatency('free-fast', 100);
    recordModelRequest('free-fast');
    recordModelLatency('free-fast', 300);
    const m = getModelMetricsFor('free-fast')!;
    assert.equal(m.lastLatencyMs, 300);
    assert.equal(m.avgLatencyMs, 200);
  });

  it('marca o último request e sucesso', () => {
    recordModelRequest('free-fast');
    recordModelOutcome('free-fast', true);
    const m = getModelMetricsFor('free-fast')!;
    assert.ok(m.lastRequestAt, 'deve ter lastRequestAt');
    assert.ok(m.lastSuccessAt, 'deve ter lastSuccessAt');
  });

  it('falha sem sucesso não define lastSuccessAt', () => {
    recordModelRequest('paid-mid');
    recordModelOutcome('paid-mid', false, 'timeout');
    const m = getModelMetricsFor('paid-mid')!;
    assert.equal(m.lastSuccessAt, undefined);
    assert.equal(m.lastError, 'timeout');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TESTES: Cadeia de failover (buildAutoFailoverChain)
// ══════════════════════════════════════════════════════════════════════════

describe('Failover Chain', () => {
  beforeEach(() => {
    setupTestModels();
    clearDecisionCache();
    resetModelHealth();
    resetModelMetrics();
  });

  it('começa pelo modelo selecionado e segue o fallbackChain sem duplicatas', () => {
    const decision = routeRequest([], 'Escreva um poema sobre o mar', testAvailableIds());
    assert.ok(decision.selectedModelId, 'deve escolher um modelo');
    const chain = buildAutoFailoverChain(decision.selectedModelId, decision, TEST_MODELS.map((m) => m.id));
    assert.equal(chain[0], decision.selectedModelId, 'selecionado vem primeiro');
    assert.equal(new Set(chain).size, chain.length, 'sem duplicatas');
    assert.ok(chain.length >= 2, 'deve ter pelo menos o selecionado + alternativas');
  });

  it('inclui apenas modelos que existem no catálogo informado', () => {
    const decision = {
      selectedModelId: 'paid-mid',
      fallbackChain: ['free-fast', 'paid-high'],
    } as any;
    const chain = buildAutoFailoverChain('paid-high', decision, ['paid-high']);
    assert.deepEqual(chain, ['paid-high']);
  });

  it('remove modelos que o circuit breaker marcou como down', () => {
    recordModelFailure('paid-high');
    // Escolhe manualmente com cadeia contendo paid-high (down) e free-fast (ok)
    const decision = {
      selectedModelId: 'paid-high',
      fallbackChain: ['free-fast', 'paid-mid'],
    } as any;
    const chain = buildAutoFailoverChain('paid-high', decision, ['paid-high', 'free-fast', 'paid-mid']);
    assert.ok(!chain.includes('paid-high'), 'down não entra na cadeia');
    assert.ok(chain.includes('free-fast'), 'saudável entra');
  });

  it('status expõe o resumo de tráfego das métricas', () => {
    recordModelRequest('free-fast');
    recordModelOutcome('free-fast', true);
    recordModelRequest('paid-mid');
    recordModelOutcome('paid-mid', false, 'HTTP 503');
    const status = getAutoRouterStatus();
    assert.equal(status.metrics.totalRequests, 2);
    assert.equal(status.metrics.totalSuccesses, 1);
    assert.equal(status.metrics.totalFailures, 1);
  });
});
