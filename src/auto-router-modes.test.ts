import test from 'node:test';
import assert from 'node:assert';
import { selectBestModel } from './services/auto-router/model-selector.ts';
import { routeRequest, getRecentRoutingDiagnostics, recordRoutingDiagnostic, clearRoutingDiagnostics, clearDecisionCache, clearConversationMemory } from './services/auto-router/router.ts';
import { registerModel } from './services/auto-router/model-metadata.ts';
import type { ModelMetadata, AutoRouterConfig, TaskClassification, ModelFeatures } from './services/auto-router/types.ts';

const CONFIG: AutoRouterConfig = {
  costPolicy: 'balanced',
  showDecision: true,
  minCapabilityThreshold: 5,
  complexityGate: 0.6,
};

function model(id: string, features: Partial<ModelFeatures> | undefined, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id,
    name: id,
    providerId: 'p',
    capabilities: { reasoning: 7, coding: 7, math: 7, writing: 7, vision: 0, general: 7 },
    cost: { input: 1, output: 2 },
    speed: 7,
    contextLength: 128000,
    isFree: false,
    isAvailable: true,
    tags: [],
    ...(features
      ? {
          features: {
            tools: false,
            vision: false,
            structuredOutput: false,
            streaming: true,
            ...features,
          },
        }
      : {}),
    ...overrides,
  };
}

function classification(requirements: TaskClassification['requirements']): TaskClassification {
  return {
    categories: { coding: 7 },
    complexity: 0.5,
    description: 'teste',
    requirements,
  };
}

test('filtro rígido: tools elimina modelo sem suporte e escolhe o compatível', () => {
  const models = [
    model('no-tools', { tools: false }),
    model('with-tools', { tools: true }),
  ];
  const result = selectBestModel(models, classification({ tools: true }), CONFIG);
  assert.strictEqual(result.selectedModelId, 'with-tools');
  assert.ok(result.exclusions?.some((e) => e.modelId === 'no-tools'));
});

test('filtro rígido: quando nenhum modelo suporta tools, falha explícita (sem fallback incompatível)', () => {
  const models = [model('a', { tools: false }), model('b', { tools: false })];
  const result = selectBestModel(models, classification({ tools: true }), CONFIG);
  assert.strictEqual(result.selectedModelId, '');
  assert.match(result.reason, /Nenhum modelo compatível/);
  assert.match(result.reason, /tools/);
  assert.strictEqual(result.exclusions?.length, 2);
});

test('filtro rígido: visão e streaming obrigatórios', () => {
  const models = [
    model('text-only', { vision: false, streaming: true }),
    model('vision-no-stream', { vision: true, streaming: false }),
    model('vision-stream', { vision: true, streaming: true }),
  ];
  const vision = selectBestModel(models, classification({ vision: true, streaming: true }), CONFIG);
  assert.strictEqual(vision.selectedModelId, 'vision-stream');

  const stream = selectBestModel(models, classification({ streaming: true }), CONFIG);
  assert.notStrictEqual(stream.selectedModelId, 'vision-no-stream');
});

test('filtro rígido: structured output obrigatório', () => {
  const models = [
    model('json-off', { structuredOutput: false }),
    model('json-on', { structuredOutput: true }),
  ];
  const result = selectBestModel(models, classification({ structuredOutput: true }), CONFIG);
  assert.strictEqual(result.selectedModelId, 'json-on');

  const none = selectBestModel([model('only-off', { structuredOutput: false })], classification({ structuredOutput: true }), CONFIG);
  assert.strictEqual(none.selectedModelId, '');
  assert.match(none.reason, /structured/i);
});

test('filtro rígido: contexto insuficiente é excluído', () => {
  const models = [
    model('small-ctx', undefined, { contextLength: 1000 }),
    model('big-ctx', undefined, { contextLength: 200000 }),
  ];
  const result = selectBestModel(models, classification({ minContextTokens: 50000 }), CONFIG);
  assert.strictEqual(result.selectedModelId, 'big-ctx');
  assert.ok(result.exclusions?.some((e) => e.modelId === 'small-ctx' && /contexto/.test(e.reason)));
});

test('routeRequest: costPolicy do registro sobrepõe a config global', () => {
  registerModel('mode-free', {
    providerId: 'p-free',
    capabilities: { reasoning: 7, coding: 7, math: 7, writing: 7, vision: 0, general: 7 },
    cost: { input: 0, output: 0 },
    isFree: true,
    tags: ['general'],
  });
  registerModel('mode-paid', {
    providerId: 'p-paid',
    capabilities: { reasoning: 10, coding: 10, math: 10, writing: 10, vision: 0, general: 10 },
    cost: { input: 10, output: 30 },
    isFree: false,
    tags: ['premium'],
  });
  clearDecisionCache();
  clearConversationMemory();
  const available = [
    { id: 'mode-free', providerId: 'p-free' },
    { id: 'mode-paid', providerId: 'p-paid' },
  ];
  const result = routeRequest([], 'tarefa simples', available, undefined, false, false, {
    costPolicy: 'free-only',
  });
  assert.strictEqual(result.selectedModelId, 'mode-free');
});

test('diagnósticos: ring buffer expõe a decisão mais recente', () => {
  clearRoutingDiagnostics();
  recordRoutingDiagnostic({
    at: Date.now(),
    requestId: 'req-test',
    mode: 'auto',
    selectedModelId: 'm1',
    selectedModelName: 'M1',
    task: 'teste',
    reason: 'ok',
    considered: 3,
    excluded: 1,
    exclusions: [{ modelId: 'm2', reason: 'sem tools' }],
  });
  const list = getRecentRoutingDiagnostics();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].requestId, 'req-test');
  assert.strictEqual(list[0].exclusions[0].modelId, 'm2');
  clearRoutingDiagnostics();
});
