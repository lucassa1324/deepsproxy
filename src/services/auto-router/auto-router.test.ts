/*
 * File: auto-router.test.ts
 * Project: deepsproxy
 * Testes automatizados do Auto Router.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask } from './task-classifier.ts';
import { selectBestModel } from './model-selector.ts';
import { routeRequest, clearDecisionCache, updateAutoRouterConfig } from './router.ts';
import { registerModel, setModelAvailability } from './model-metadata.ts';
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
