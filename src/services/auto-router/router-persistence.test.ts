/*
 * File: router-persistence.test.ts
 * Project: deepsproxy
 * Testes da persistência JSON do estado do Auto Router (L3.7).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initRouterPersistence, flushRouterState, stopRouterPersistence } from './persistence.ts';
import {
  recordModelFailure,
  isModelDown,
  resetModelHealth,
} from './model-metadata.ts';
import { recordQuotaExhaustion, isModelQuotaExhausted, resetQuotaTracker } from '../quota-tracker.ts';

let dir = '';
let file = '';

describe('Router Persistence', () => {
  beforeEach(() => {
    resetModelHealth();
    resetQuotaTracker();
    dir = mkdtempSync(join(tmpdir(), 'router-persist-'));
    file = join(dir, 'router-state.json');
  });

  afterEach(() => {
    stopRouterPersistence();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('salva e restaura saúde de modelo e cooldown de cota', () => {
    initRouterPersistence(file);
    recordModelFailure('persist-model', 500, 'HTTP 500');
    recordQuotaExhaustion('persist-model', 300_000);
    flushRouterState();

    // Simula reinício limpo.
    resetModelHealth();
    resetQuotaTracker();
    assert.equal(isModelDown('persist-model'), false, 'estado limpo antes de restaurar');

    initRouterPersistence(file);
    assert.equal(isModelDown('persist-model'), true, 'saúde restaurada do disco');
    assert.equal(isModelQuotaExhausted('persist-model'), true, 'cooldown de cota restaurado');
  });

  it('arquivo inexistente não quebra a inicialização', () => {
    initRouterPersistence(join(dir, 'nao-existe.json'));
    assert.equal(isModelDown('qualquer'), false);
  });
});
