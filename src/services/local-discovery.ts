/*
 * File: local-discovery.ts
 * Project: deepsproxy
 * FASE 4: Auto-discovery, health check e performance monitor para modelos
 * locais (Ollama, LM Studio).
 *
 * 4.1 Auto-discovery: detecta instâncias rodando em localhost
 * 4.2 Monitor de performance: tokens/segundo, latência
 * 4.3 Health check: indicador visual (verde/amarelo/vermelho)
 * 4.4 Fallback automático: se local falhar, usa cloud
 */

import { optimizedFetch } from './optimizations.ts';

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────

export interface LocalInstance {
  id: string;
  name: string;
  type: 'ollama' | 'lmstudio';
  baseUrl: string;
  port: number;
  status: 'online' | 'slow' | 'offline';
  models: LocalModel[];
  lastCheck: number;
  latencyMs: number;
}

export interface LocalModel {
  id: string;
  name: string;
  size?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
}

export interface PerformanceMetrics {
  modelId: string;
  instanceId: string;
  requests: number;
  totalTokens: number;
  totalMs: number;
  avgTokensPerSec: number;
  avgLatencyMs: number;
  lastRequestAt: number;
}

export interface HealthStatus {
  instanceId: string;
  status: 'online' | 'slow' | 'offline';
  latencyMs: number;
  lastCheck: number;
  error?: string;
}

export interface FallbackConfig {
  enabled: boolean;
  latencyThresholdMs: number;
  fallbackProviderId: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 4.1 Auto-discovery
// ────────────────────────────────────────────────────────────────────────────

const DISCOVERY_PORTS = {
  ollama: [11434],
  lmstudio: [1234],
};

const DISCOVERY_TIMEOUT_MS = 3000;
const DISCOVERY_INTERVAL_MS = 30_000; // 30s

let discoveryInterval: ReturnType<typeof setInterval> | null = null;
const instances = new Map<string, LocalInstance>();

/** Detecta instâncias rodando em localhost. */
export async function discoverLocalInstances(): Promise<LocalInstance[]> {
  const found: LocalInstance[] = [];

  // Ollama
  for (const port of DISCOVERY_PORTS.ollama) {
    try {
      const instance = await probeOllama(port);
      if (instance) found.push(instance);
    } catch {
      // offline
    }
  }

  // LM Studio
  for (const port of DISCOVERY_PORTS.lmstudio) {
    try {
      const instance = await probeLMStudio(port);
      if (instance) found.push(instance);
    } catch {
      // offline
    }
  }

  // Update cache
  instances.clear();
  for (const inst of found) {
    instances.set(inst.id, inst);
  }

  return found;
}

async function probeOllama(port: number): Promise<LocalInstance | null> {
  const baseUrl = `http://localhost:${port}`;
  const start = Date.now();
  try {
    const resp = await optimizedFetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const latencyMs = Date.now() - start;

    const models: LocalModel[] = (data.models || []).map((m: any) => ({
      id: m.name,
      name: m.name,
      size: m.size,
      parameterSize: extractParameterSize(m.name),
      quantization: extractQuantization(m.name),
      family: m.details?.family,
    }));

    return {
      id: `ollama_${port}`,
      name: 'Ollama',
      type: 'ollama',
      baseUrl,
      port,
      status: latencyMs > 5000 ? 'slow' : 'online',
      models,
      lastCheck: Date.now(),
      latencyMs,
    };
  } catch {
    return null;
  }
}

async function probeLMStudio(port: number): Promise<LocalInstance | null> {
  const baseUrl = `http://localhost:${port}/v1`;
  const start = Date.now();
  try {
    const resp = await optimizedFetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const latencyMs = Date.now() - start;

    const models: LocalModel[] = (data.data || []).map((m: any) => ({
      id: m.id,
      name: m.id,
    }));

    return {
      id: `lmstudio_${port}`,
      name: 'LM Studio',
      type: 'lmstudio',
      baseUrl,
      port,
      status: latencyMs > 5000 ? 'slow' : 'online',
      models,
      lastCheck: Date.now(),
      latencyMs,
    };
  } catch {
    return null;
  }
}

function extractParameterSize(name: string): string | undefined {
  const match = name.match(/(\d+\.?\d*)[bB]/);
  return match ? match[1] + 'B' : undefined;
}

function extractQuantization(name: string): string | undefined {
  const quants = ['q4_0', 'q4_k_m', 'q4_k_s', 'q5_0', 'q5_k_m', 'q5_k_s', 'q6_k', 'q8_0', 'f16', 'f32'];
  for (const q of quants) {
    if (name.toLowerCase().includes(q)) return q.toUpperCase();
  }
  return undefined;
}

/** Retorna instâncias cached (ou descobre se vazio). */
export function getLocalInstances(): LocalInstance[] {
  return Array.from(instances.values());
}

/** Retorna uma instância por ID. */
export function getLocalInstance(id: string): LocalInstance | undefined {
  return instances.get(id);
}

/** Inicia discovery periódico. */
export function startDiscovery(): void {
  if (discoveryInterval) return;
  discoverLocalInstances().catch(() => {});
  discoveryInterval = setInterval(() => {
    discoverLocalInstances().catch(() => {});
  }, DISCOVERY_INTERVAL_MS);
}

/** Para discovery periódico. */
export function stopDiscovery(): void {
  if (discoveryInterval) {
    clearInterval(discoveryInterval);
    discoveryInterval = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4.2 Performance Monitor
// ────────────────────────────────────────────────────────────────────────────

const metrics = new Map<string, PerformanceMetrics>();

/** Registra uma requisição completada. */
export function recordRequest(
  modelId: string,
  instanceId: string,
  tokens: number,
  durationMs: number
): void {
  const key = `${instanceId}:${modelId}`;
  let m = metrics.get(key);
  if (!m) {
    m = {
      modelId,
      instanceId,
      requests: 0,
      totalTokens: 0,
      totalMs: 0,
      avgTokensPerSec: 0,
      avgLatencyMs: 0,
      lastRequestAt: 0,
    };
    metrics.set(key, m);
  }
  m.requests++;
  m.totalTokens += tokens;
  m.totalMs += durationMs;
  m.avgTokensPerSec = m.totalTokens / (m.totalMs / 1000);
  m.avgLatencyMs = m.totalMs / m.requests;
  m.lastRequestAt = Date.now();
}

/** Retorna métricas de performance para um modelo. */
export function getMetrics(modelId: string, instanceId: string): PerformanceMetrics | undefined {
  return metrics.get(`${instanceId}:${modelId}`);
}

/** Retorna todas as métricas. */
export function getAllMetrics(): PerformanceMetrics[] {
  return Array.from(metrics.values());
}

/** Limpa métricas antigas (>5min sem request). */
export function cleanupMetrics(): void {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, m] of metrics) {
    if (m.lastRequestAt < cutoff) {
      metrics.delete(key);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4.3 Health Check
// ────────────────────────────────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 60_000; // 1min
let healthInterval: ReturnType<typeof setInterval> | null = null;
const healthStatuses = new Map<string, HealthStatus>();

/** Verifica a saúde de uma instância local. */
export async function checkHealth(instanceId: string): Promise<HealthStatus> {
  const instance = instances.get(instanceId);
  if (!instance) {
    return {
      instanceId,
      status: 'offline',
      latencyMs: 0,
      lastCheck: Date.now(),
      error: 'Instância não encontrada',
    };
  }

  const start = Date.now();
  try {
    const url = instance.type === 'ollama'
      ? `${instance.baseUrl}/api/tags`
      : `${instance.baseUrl}/v1/models`;
    const resp = await optimizedFetch(url, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;

    const status: HealthStatus = {
      instanceId,
      status: latencyMs > 5000 ? 'slow' : 'online',
      latencyMs,
      lastCheck: Date.now(),
    };
    healthStatuses.set(instanceId, status);
    return status;
  } catch (err: any) {
    const status: HealthStatus = {
      instanceId,
      status: 'offline',
      latencyMs: Date.now() - start,
      lastCheck: Date.now(),
      error: err?.message || String(err),
    };
    healthStatuses.set(instanceId, status);
    return status;
  }
}

/** Verifica saúde de todas as instâncias. */
export async function checkAllHealth(): Promise<HealthStatus[]> {
  const results: HealthStatus[] = [];
  for (const id of instances.keys()) {
    results.push(await checkHealth(id));
  }
  return results;
}

/** Retorna status de saúde cached. */
export function getHealthStatus(instanceId: string): HealthStatus | undefined {
  return healthStatuses.get(instanceId);
}

/** Retorna todos os status de saúde. */
export function getAllHealthStatuses(): HealthStatus[] {
  return Array.from(healthStatuses.values());
}

/** Inicia health check periódico. */
export function startHealthCheck(): void {
  if (healthInterval) return;
  healthInterval = setInterval(() => {
    checkAllHealth().catch(() => {});
    cleanupMetrics();
  }, HEALTH_CHECK_INTERVAL_MS);
}

/** Para health check periódico. */
export function stopHealthCheck(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4.4 Fallback Automático
// ────────────────────────────────────────────────────────────────────────────

let fallbackConfig: FallbackConfig = {
  enabled: false,
  latencyThresholdMs: 10_000,
  fallbackProviderId: '',
};

/** Configura o fallback automático. */
export function configureFallback(config: Partial<FallbackConfig>): void {
  fallbackConfig = { ...fallbackConfig, ...config };
}

/** Retorna configuração atual do fallback. */
export function getFallbackConfig(): FallbackConfig {
  return { ...fallbackConfig };
}

/**
 * Decide se deve usar fallback para um modelo local.
 * Retorna o provider ID do fallback se deve usar, ou null se pode usar o local.
 */
export function shouldFallback(instanceId: string, modelId: string): string | null {
  if (!fallbackConfig.enabled) return null;
  if (!fallbackConfig.fallbackProviderId) return null;

  const health = healthStatuses.get(instanceId);
  if (!health) return null;

  // Offline → fallback
  if (health.status === 'offline') return fallbackConfig.fallbackProviderId;

  // Lento demais → fallback
  if (health.status === 'slow' && health.latencyMs > fallbackConfig.latencyThresholdMs) {
    return fallbackConfig.fallbackProviderId;
  }

  // Performance degradada → fallback
  const perf = metrics.get(`${instanceId}:${modelId}`);
  if (perf && perf.avgLatencyMs > fallbackConfig.latencyThresholdMs) {
    return fallbackConfig.fallbackProviderId;
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// API para Dashboard
// ────────────────────────────────────────────────────────────────────────────

/** Retorna dados completos para o dashboard. */
export function getLocalModelsDashboard() {
  return {
    instances: getLocalInstances(),
    health: getAllHealthStatuses(),
    metrics: getAllMetrics(),
    fallback: getFallbackConfig(),
  };
}
