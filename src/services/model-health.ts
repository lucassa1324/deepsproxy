/*
 * File: model-health.ts
 * Project: deepsproxy
 * Purpose: Testa modelos individualmente e rastreia se estão funcionando.
 */

import { findProviderForModel, fetchModels } from './local.ts';
import { isAdapterProvider, fetchProviderModels } from './adapters/index.ts';
import {
  isDeepseekProvider,
  isQwenProvider,
  isGeminiWebProvider,
  normalizeModelId,
  primaryApiKey,
  type Provider,
} from './config.ts';
import { fetchQwenModels, QWEN_KNOWN_MODELS } from './qwen.ts';
import { GEMINI_KNOWN_MODELS } from './gemini-web.ts';
import { optimizedFetch } from './optimizations.ts';

export type ModelHealthStatus = 'untested' | 'testing' | 'working' | 'broken';

export interface ModelHealthEntry {
  status: ModelHealthStatus;
  lastTested?: number;
  error?: string;
  latencyMs?: number;
  providerId?: string;
  providerType?: string;
  testedBy?: string;
}

const DEFAULT_TEST_TIMEOUT = 8000;
const modelHealth = new Map<string, ModelHealthEntry>();

function getKey(modelId: string): string {
  return normalizeModelId(modelId);
}

export function getModelHealth(modelId: string): ModelHealthEntry {
  const key = getKey(modelId);
  const existing = modelHealth.get(key);
  if (existing) return existing;
  return { status: 'untested' };
}

export function setModelHealth(modelId: string, entry: Partial<ModelHealthEntry>): void {
  const key = getKey(modelId);
  const current = modelHealth.get(key) || { status: 'untested' };
  modelHealth.set(key, { ...current, ...entry });
}

export function getAllModelHealth(): Record<string, ModelHealthEntry> {
  const out: Record<string, ModelHealthEntry> = {};
  for (const [k, v] of modelHealth) {
    out[k] = v;
  }
  return out;
}

export function clearModelHealth(modelId?: string): void {
  if (modelId) {
    modelHealth.delete(getKey(modelId));
    return;
  }
  modelHealth.clear();
}

function isVirtualModel(modelId: string): boolean {
  const id = getKey(modelId);
  return id === 'auto' || id === 'auto-free';
}

async function resolveProviderForModel(providers: Provider[], modelId: string): Promise<Provider | null> {
  const normalized = normalizeModelId(modelId);

  for (const p of providers) {
    if (isDeepseekProvider(p) && (normalized === 'deepseek-thinking' || normalized === 'deepseek-no-thinking')) {
      return p;
    }
    if (isQwenProvider(p) && QWEN_KNOWN_MODELS.some((m) => normalizeModelId(m.id) === normalized)) {
      return p;
    }
    if (isGeminiWebProvider(p) && GEMINI_KNOWN_MODELS.some((m) => normalizeModelId(m.id) === normalized)) {
      return p;
    }
  }

  const owner = await findProviderForModel(providers, modelId);
  if (owner) return owner;

  return null;
}

async function testViaHttpChat(
  provider: Provider,
  modelId: string,
  timeoutMs = DEFAULT_TEST_TIMEOUT
): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const key = primaryApiKey(provider);
    const baseUrl = (provider.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) {
      return { ok: false, error: 'Provedor sem baseUrl' };
    }

    const url = provider.type === 'ollama' ? `${baseUrl}/v1/chat/completions` : `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers['authorization'] = `Bearer ${key}`;

    const body = {
      model: modelId,
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1,
      temperature: 0,
      stream: false,
    };

    const resp = await optimizedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;

    if (resp.ok) {
      try {
        const text = await resp.text();
        if (text.length === 0) {
          return { ok: false, error: 'Resposta vazia', latencyMs };
        }
        JSON.parse(text);
      } catch (e: any) {
        return { ok: false, error: `Resposta inválida: ${e?.message}`, latencyMs };
      }
      return { ok: true, latencyMs };
    }

    const errText = await resp.text().catch(() => '');
    return { ok: false, error: `HTTP ${resp.status} ${errText.slice(0, 120)}`, latencyMs };
  } catch (e: any) {
    const latencyMs = Date.now() - start;
    const msg = e?.name === 'AbortError' ? 'Timeout no teste' : e?.message || String(e);
    return { ok: false, error: msg, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

async function testModelWithProvider(
  provider: Provider,
  modelId: string,
  timeoutMs = DEFAULT_TEST_TIMEOUT
): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  if (isDeepseekProvider(provider) || isQwenProvider(provider) || isGeminiWebProvider(provider)) {
    return { ok: true };
  }

  if (isAdapterProvider(provider)) {
    // Fallback para teste HTTP genérico
    return await testViaHttpChat(provider, modelId, timeoutMs);
  }

  return await testViaHttpChat(provider, modelId, timeoutMs);
}

export async function testModel(
  modelId: string,
  providers: Provider[],
  opts: { timeoutMs?: number; force?: boolean } = {}
): Promise<boolean> {
  const id = getKey(modelId);

  if (isVirtualModel(id)) {
    setModelHealth(id, { status: 'working', lastTested: Date.now() });
    return true;
  }

  const current = getModelHealth(id);
  if (!opts.force && current.status === 'working' && current.lastTested && Date.now() - current.lastTested < 5 * 60 * 1000) {
    return true;
  }

  setModelHealth(id, { status: 'testing' });

  const provider = await resolveProviderForModel(providers, id);
  if (!provider) {
    setModelHealth(id, {
      status: 'broken',
      lastTested: Date.now(),
      error: 'Nenhum provedor encontrado para este modelo',
    });
    return false;
  }

  const res = await testModelWithProvider(provider, id, opts.timeoutMs || DEFAULT_TEST_TIMEOUT);

  if (res.ok) {
    setModelHealth(id, {
      status: 'working',
      lastTested: Date.now(),
      latencyMs: res.latencyMs,
      providerId: provider.id,
      providerType: provider.type,
    });
    return true;
  }

  setModelHealth(id, {
    status: 'broken',
    lastTested: Date.now(),
    error: res.error,
    latencyMs: res.latencyMs,
    providerId: provider.id,
    providerType: provider.type,
  });
  return false;
}

export async function listAllModels(providers: Provider[]): Promise<Array<{ id: string; owned_by?: string }>> {
  const seen = new Set<string>();
  const out: Array<{ id: string; owned_by?: string }> = [];

  out.push({ id: 'auto', owned_by: 'deepsproxy' });
  out.push({ id: 'auto-free', owned_by: 'deepsproxy' });

  const hasGeminiWeb = providers.some(isGeminiWebProvider);
  const geminiWebIds = new Set(GEMINI_KNOWN_MODELS.map((m) => normalizeModelId(m.id)));

  for (const p of providers) {
    if (isDeepseekProvider(p)) {
      for (const id of ['deepseek-thinking', 'deepseek-no-thinking']) {
        const nid = normalizeModelId(id);
        if (!seen.has(nid)) {
          seen.add(nid);
          out.push({ id: nid, owned_by: 'deepseek' });
        }
      }
    } else if (isQwenProvider(p)) {
      let qwen: any[] = [];
      try {
        qwen = await fetchQwenModels();
      } catch {
        qwen = QWEN_KNOWN_MODELS;
      }
      for (const m of qwen) {
        const nid = normalizeModelId(m.id);
        if (!seen.has(nid)) {
          seen.add(nid);
          out.push({ id: nid, owned_by: m.owned_by || 'qwen' });
        }
      }
    } else if (isGeminiWebProvider(p)) {
      for (const m of GEMINI_KNOWN_MODELS) {
        const nid = normalizeModelId(m.id);
        if (!seen.has(nid)) {
          seen.add(nid);
          out.push({ id: nid, owned_by: 'gemini-web' });
        }
      }
    } else {
      const models = isAdapterProvider(p) ? await fetchProviderModels(p, primaryApiKey(p)) : await fetchModels(p);
      if (models) {
        for (const m of models) {
          const nid = normalizeModelId(m.id);
          if (hasGeminiWeb && geminiWebIds.has(nid)) continue;
          if (!seen.has(nid)) {
            seen.add(nid);
            out.push({ id: nid, owned_by: m.owned_by });
          }
        }
      }
      if (p.model) {
        const nid = normalizeModelId(p.model);
        if (!seen.has(nid)) {
          seen.add(nid);
          out.push({ id: nid, owned_by: p.name });
        }
      }
    }
  }

  return out;
}

export async function testAllModels(
  providers: Provider[],
  opts: { timeoutMs?: number; concurrency?: number; force?: boolean } = {}
): Promise<{ total: number; working: number; broken: number }> {
  const models = await listAllModels(providers);
  const concurrency = Math.max(1, Math.min(opts.concurrency || 2, 5));

  let i = 0;
  let working = 0;
  let broken = 0;

  const workers = Array(concurrency)
    .fill(0)
    .map(async () => {
      while (i < models.length) {
        const idx = i++;
        const m = models[idx];
        try {
          const ok = await testModel(m.id, providers, { timeoutMs: opts.timeoutMs, force: opts.force });
          if (ok) working++;
          else broken++;
        } catch {
          broken++;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    });

  await Promise.all(workers);
  return { total: models.length, working, broken };
}

export function isModelUsable(modelId: string): boolean {
  const id = getKey(modelId);
  if (isVirtualModel(id)) return true;
  const h = getModelHealth(id);
  // Não testado ainda: assume utilizável (compatibilidade com testes existentes)
  if (h.status === 'untested' || h.status === 'testing') return true;
  return h.status === 'working';
}
