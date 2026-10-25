/*
 * File: model-health.test.ts
 * Project: deepsproxy
 * Testes da persistência do estado de saúde dos modelos (model-health.ts):
 * gravação em JSON, restauração no boot e descarte do estado transiente
 * "testing". Arquivo de estado apontado para um temporário isolado.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MODEL_HEALTH_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'model-health-test-')), 'model-health.json');

import {
  clearModelHealth,
  flushModelHealth,
  getAllModelHealth,
  getModelHealth,
  restoreModelHealthFromDisk,
  setModelHealth,
} from './services/model-health.ts';

function stateOnDisk(): any {
  return JSON.parse(fs.readFileSync(process.env.MODEL_HEALTH_FILE!, 'utf-8'));
}

test('setModelHealth grava em disco com debounce/flush explícito', () => {
  clearModelHealth();
  setModelHealth('mock-model-a', { status: 'working', latencyMs: 42, providerId: 'p1' });
  flushModelHealth();
  setModelHealth('mock-model-b', { status: 'broken', error: 'HTTP 429 limit' });
  flushModelHealth();
  const raw = stateOnDisk();
  assert.equal(raw.version, 1);
  assert.equal(raw.models['mock-model-a'].status, 'working');
  assert.equal(raw.models['mock-model-b'].status, 'broken');
});

test('limpar + restaurar do disco recupera o estado ("Funcionando" sobrevive ao reboot)', () => {
  assert.ok(getAllModelHealth()['mock-model-a']?.status === 'working');
  clearModelHealth();
  assert.equal(Object.keys(getAllModelHealth()).length, 0); // limpo em memória... e no disco
  // Se o estado foi limpo e gravado, restaurar do disco devolve zero — então
  // regrava um cenário de boot: escreve o JSON diretamente e força reload.
  fs.writeFileSync(
    process.env.MODEL_HEALTH_FILE!,
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      models: {
        'mock-model-a': { status: 'working', lastTested: 123, latencyMs: 42 },
        'mock-model-x': { status: 'testing' }, // transiente: NÃO pode ser restaurado
      },
    }),
    'utf-8'
  );
  restoreModelHealthFromDisk(true);
  const all = getAllModelHealth();
  assert.equal(all['mock-model-a'].status, 'working');
  assert.equal(all['mock-model-a'].latencyMs, 42);
  assert.ok(!all['mock-model-x'], 'estado transiente "testing" não deve ser restaurado');
  assert.equal(getModelHealth('mock-model-a').status, 'working');
});

test('modelo virtual (auto/auto-free) restaurado também funciona', () => {
  setModelHealth('auto', { status: 'working' });
  flushModelHealth();
  clearModelHealth();
  restoreModelHealthFromDisk(true);
  assert.equal(getModelHealth('auto').status, 'working');
});
