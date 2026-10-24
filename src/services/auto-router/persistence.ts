/*
 * File: persistence.ts
 * Project: deepsproxy
 * Persistência em JSON do estado aprendido pelo Auto Router (L3.7).
 *
 * Salva/carrega saúde de modelos e provedores, métricas, orçamento de cota,
 * rate tracking e a memória de conversas. SEM SQLite: um único arquivo JSON
 * (por padrão `router-state.json` no cwd, ou env ROUTER_STATE_FILE).
 *
 * IMPORTANTE: NÃO é executado ao importar o módulo (evita poluir os testes).
 * O bootstrap do servidor (index.ts) chama `initRouterPersistence()`
 * explicitamente quando roda como processo principal.
 *
 * Config (env):
 *   ROUTER_PERSISTENCE  'false' desliga (padrão: ligado)
 *   ROUTER_STATE_FILE   caminho do arquivo (padrão: ./router-state.json)
 *   ROUTER_SAVE_MS      intervalo de salvamento em ms (padrão: 60000)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  snapshotModelHealth,
  restoreModelHealth,
  snapshotProviderHealth,
  restoreProviderHealth,
  snapshotModelMetrics,
  restoreModelMetrics,
} from './model-metadata.ts';
import { snapshotQuota, restoreQuota } from '../quota-tracker.ts';
import { snapshotRateTracker, restoreRateTracker } from '../rate-tracker.ts';
import { snapshotConversationMemory, restoreConversationMemory } from './router.ts';

let timer: ReturnType<typeof setInterval> | null = null;
let currentFile = '';

export function isRouterPersistenceEnabled(): boolean {
  return (process.env.ROUTER_PERSISTENCE ?? 'on').trim().toLowerCase() !== 'false';
}

function defaultStateFile(): string {
  return process.env.ROUTER_STATE_FILE || join(process.cwd(), 'router-state.json');
}

function saveIntervalMs(): number {
  const raw = parseInt(process.env.ROUTER_SAVE_MS || '', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
}

/**
 * Carrega o estado do disco e agenda salvamentos periódicos. Idempotente:
 * chamadas repetidas apenas trocam o arquivo/intervalo.
 */
export function initRouterPersistence(file: string = defaultStateFile()): void {
  if (!isRouterPersistenceEnabled()) {
    console.log('[auto-router] persistência desligada (ROUTER_PERSISTENCE=false).');
    return;
  }
  currentFile = file;
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.modelHealth)) restoreModelHealth(raw.modelHealth);
      if (Array.isArray(raw?.providerHealth)) restoreProviderHealth(raw.providerHealth);
      if (Array.isArray(raw?.modelMetrics)) restoreModelMetrics(raw.modelMetrics);
      if (Array.isArray(raw?.quota)) restoreQuota(raw.quota);
      if (Array.isArray(raw?.rate)) restoreRateTracker(raw.rate);
      if (Array.isArray(raw?.conversations)) restoreConversationMemory(raw.conversations);
      console.log(`[auto-router] estado aprendido restaurado de ${file}`);
    }
  } catch (err: any) {
    console.warn(`[auto-router] falha ao carregar estado (${file}): ${err?.message}`);
  }

  if (timer) clearInterval(timer);
  timer = setInterval(() => flushRouterState(), saveIntervalMs());
  // Não mantém o processo vivo só por causa do timer.
  (timer as any)?.unref?.();
}

/** Grava o estado atual em disco. */
export function flushRouterState(): void {
  if (!currentFile) return;
  try {
    const data = {
      version: 1,
      savedAt: Date.now(),
      modelHealth: snapshotModelHealth(),
      providerHealth: snapshotProviderHealth(),
      modelMetrics: snapshotModelMetrics(),
      quota: snapshotQuota(),
      rate: snapshotRateTracker(),
      conversations: snapshotConversationMemory(),
    };
    mkdirSync(dirname(currentFile), { recursive: true });
    writeFileSync(currentFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err: any) {
    console.warn(`[auto-router] falha ao salvar estado: ${err?.message}`);
  }
}

/** Para o salvamento periódico (gravando uma última vez). */
export function stopRouterPersistence(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  flushRouterState();
}
