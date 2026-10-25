/*
 * File: usage.ts
 * Project: deepsproxy
 * Telemetria de uso do proxy: registra cada requisição concluída em
 * /v1/chat/completions (modelo pedido, modelo final roteado, provedor, modo,
 * tokens, latência e status) e expõe agregações para o painel de Uso &
 * Métricas e para a exportação de relatórios.
 *
 * Persistência: ring buffer em memória + gravação debounced em disco
 * (`usage-logs.json`, ou USAGE_FILE) — mesmo padrão do providers.json.
 * A gravação é assíncrona/debounced para não afetar a latência do roteamento.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { normalizeAccountKeys, type ProviderRegistry } from './config.ts';
import { getCachedModelCatalog, providerFromCatalogEntry } from './modelCatalog.ts';
import { getQuotaTrackerStats, type QuotaTrackerStats } from './quota-tracker.ts';
import { getRateTrackerStats, type RateTrackerStats } from './rate-tracker.ts';

export type UsageRoutingMode = 'auto' | 'manual';

export interface UsageRecord {
  /** Timestamp (epoch ms) do término da requisição. */
  ts: number;
  /** HTTP status final devolvido ao cliente (200 = sucesso). */
  status: number;
  /** Modelo solicitado no payload original (ex.: "auto", "gpt-4o"). */
  requestedModel: string;
  /** Modelo real que atendeu (resolvido pelo orquestrador/failover). */
  finalModel: string;
  /** Provedor utilizado (nome exibido no registro). */
  provider: string;
  /** Modo de roteamento: "auto" (Smart Router) ou "manual". */
  routingMode: UsageRoutingMode;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  /** Tempo total do request no proxy (ms). */
  latencyMs: number;
  /** Id da conta/chave de API usada (AccountKey.id), quando identificada. */
  accountId?: string;
  /** Rótulo/apelido da conta (ex.: "atrossilva", "lucassa"). */
  accountName?: string;
  /** true quando os tokens vieram de estimativa (upstream não reportou usage). */
  tokensEstimated?: boolean;
}

export interface UsageSummary {
  period: string;
  since: number | null;
  totalRequests: number;
  totalErrors: number;
  totalTokens: number;
  autoRequests: number;
  manualRequests: number;
  topModel: { model: string; provider: string; requests: number } | null;
  avgLatencyMs: number;
  /** Quantidade de modelos finais distintos observados no período. */
  uniqueModels: number;
}

export interface UsageModelStat {
  model: string;
  provider: string;
  requests: number;
  errors: number;
  tokens: number;
  /** Tokens de entrada (prompt) somados no período. */
  tokensPrompt: number;
  /** Tokens de saída (completion) somados no período. */
  tokensCompletion: number;
  /** Média de tokens por requisição (total / requests). */
  avgTokensPerRequest: number;
  /** Percentual de requisições com status < 400 (0-100). */
  successRate: number;
  /** Latência p95 do bucket (ms). */
  p95LatencyMs: number;
  /** Timestamp do último uso observado. */
  lastUsedAt: number;
  autoRequests: number;
  manualRequests: number;
  /** Modo predominante neste modelo. */
  predominantMode: UsageRoutingMode | '—';
  /** requestModel predominante no bucket (ex.: "auto", nome do modelo). */
  predominantRequest: string;
  avgLatencyMs: number;
}

/** Cota observada para um modelo na janela deslizante do quota-tracker. */
export interface UsageModelQuotaInfo {
  /** Janela deslizante usada pelo tracker (horas). */
  windowHours: number;
  usedTokens: number;
  usedRequests: number;
  /** Limite aprendido a partir de erros 429/quota (0 = ainda desconhecido). */
  learnedLimitTokens: number;
  learnedLimitRequests: number;
  /** Tokens/requests restantes até o limite aprendido (null = desconhecido). */
  remainingTokens: number | null;
  remainingRequests: number | null;
  /** Folga 0-1 usada pelo roteador (null = sem informação suficiente). */
  headroom: number | null;
  exhausted: boolean;
  exhaustedUntil: number;
  /** Cooldown restante até o modelo voltar (ms). */
  resetsInMs: number;
  lastErrorAt: number;
}

export interface UsageModelAdvancedStat extends UsageModelStat {
  quota: UsageModelQuotaInfo | null;
}

export interface UsageAdvancedSummary {
  totalRequests: number;
  totalErrors: number;
  successRate: number;
  totalTokens: number;
  tokensPrompt: number;
  tokensCompletion: number;
  avgTokensPerRequest: number;
  /** Requisições sem tokens reportados (ex.: streaming não contabilizado). */
  requestsWithoutTokens: number;
  autoRequests: number;
  manualRequests: number;
  autoRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  /** Requisições auto cujo modelo final diferiu do pedido (failover). */
  failovers: number;
  uniqueModels: number;
  uniqueProviders: number;
}

export interface UsageProviderStat {
  provider: string;
  requests: number;
  errors: number;
  successRate: number;
  tokens: number;
  tokensPrompt: number;
  tokensCompletion: number;
  models: number;
  avgLatencyMs: number;
}

export interface UsageTimelinePoint {
  ts: number;
  label: string;
  requests: number;
  tokens: number;
  errors: number;
}

export interface UsageTransition {
  requested: string;
  final: string;
  provider: string;
  mode: UsageRoutingMode;
  count: number;
}

export interface UsageAdvancedReport {
  period: string;
  since: number | null;
  generatedAt: number;
  summary: UsageAdvancedSummary;
  models: UsageModelAdvancedStat[];
  providers: UsageProviderStat[];
  timeline: UsageTimelinePoint[];
  transitions: UsageTransition[];
  quota: QuotaTrackerStats;
  rate: RateTrackerStats;
}

const MAX_RECORDS = 10_000;

const DEFAULT_PERIODS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'all': 0, // sem filtro
};

let records: UsageRecord[] = [];
let loaded = false;

/** Caminho do arquivo de persistência (conf. providers.json/token-economy). */
function usageFile(): string {
  return process.env.USAGE_FILE || join(process.cwd(), 'usage-logs.json');
}

function sanitizeRecord(raw: any): UsageRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const status = Number.isFinite(Number(raw.status)) ? Number(raw.status) : 0;
  const mode: UsageRoutingMode = raw.routingMode === 'auto' ? 'auto' : 'manual';
  const rec: UsageRecord = {
    ts,
    status,
    requestedModel: String(raw.requestedModel || ''),
    finalModel: String(raw.finalModel || raw.requestedModel || ''),
    provider: String(raw.provider || ''),
    routingMode: mode,
    tokensPrompt: Number(raw.tokensPrompt) || 0,
    tokensCompletion: Number(raw.tokensCompletion) || 0,
    tokensTotal: Number(raw.tokensTotal) || 0,
    latencyMs: Number(raw.latencyMs) || 0,
  };
  if (raw.accountId) rec.accountId = String(raw.accountId).slice(0, 128);
  if (raw.accountName) rec.accountName = String(raw.accountName).slice(0, 128);
  if (raw.tokensEstimated) rec.tokensEstimated = true;
  return rec;
}

function loadFromDisk(): void {
  if (loaded) return;
  loaded = true;
  try {
    const file = usageFile();
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : [];
    records = list
      .map((x: any): UsageRecord | null => sanitizeRecord(x))
      .filter((r: UsageRecord | null): r is UsageRecord => !!r)
      .slice(-MAX_RECORDS);
  } catch {
    // arquivo corrompido/inexistente: começa vazio
  }
}

let usageSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (usageSaveTimer) return;
  usageSaveTimer = setTimeout(() => {
    usageSaveTimer = null;
    saveToDisk();
  }, 2000);
  if (typeof (usageSaveTimer as any).unref === 'function') (usageSaveTimer as any).unref();
}

function saveToDisk(): void {
  try {
    const file = usageFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[usage] falha ao persistir uso em ${usageFile()}:`, err.message);
  }
}

/**
 * Registra uma requisição concluída no /v1/chat/completions. Chamado a cada
 * request finalizado; gravação em disco é debounced (zero impacto na latência).
 */
export function recordUsage(entry: UsageRecord): void {
  loadFromDisk();
  const rec = sanitizeRecord(entry);
  if (!rec) return;
  records.push(rec);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  scheduleSave();
}

/**
 * Complementa tokens de um registro (best-effort: a leitura do corpo JSON é
 * feita depois do retorno ao cliente, via clone; ids aqui são ts+finalModel).
 */
export function patchUsageTokens(
  ts: number,
  finalModel: string,
  tokens: { tokensPrompt?: number; tokensCompletion?: number; tokensTotal?: number; estimated?: boolean }
): void {
  const rec = [...records].reverse().find((r) => r.ts === ts && r.finalModel === finalModel);
  if (!rec) return;
  if (tokens.tokensPrompt !== undefined) rec.tokensPrompt = tokens.tokensPrompt;
  if (tokens.tokensCompletion !== undefined) rec.tokensCompletion = tokens.tokensCompletion;
  if (tokens.tokensTotal !== undefined) rec.tokensTotal = tokens.tokensTotal;
  if (tokens.estimated) rec.tokensEstimated = true;
  scheduleSave();
}

/** Converte um `period` (24h|7d|30d|all) em timestamp "desde" (ou null p/ all). */
export function periodToSince(period: string | undefined): { since: number | null; period: string } {
  const key = String(period || 'all').toLowerCase();
  if (key === 'all' || !DEFAULT_PERIODS[key]) return { since: null, period: 'all' };
  return { since: Date.now() - DEFAULT_PERIODS[key], period: key };
}

/** Registros filtrados pelo período (+ busca opcional por texto). */
export function getUsageRecords(period?: string): UsageRecord[] {
  loadFromDisk();
  const { since } = periodToSince(period);
  if (since === null) return records.slice();
  return records.filter((r) => r.ts >= since);
}

/** Agregação consolidada para GET /api/usage/summary. */
export function computeSummary(period?: string): UsageSummary {
  const list = getUsageRecords(period);
  const { since, period: p } = periodToSince(period);
  const topCounts = new Map<string, { requests: number; provider: string }>();
  let totalTokens = 0;
  let autoRequests = 0;
  let manualRequests = 0;
  let errors = 0;
  let latencySum = 0;
  const uniqueModels = new Set<string>();
  for (const r of list) {
    const key = `${r.finalModel}::${r.provider}`;
    const cur = topCounts.get(key) || { requests: 0, provider: r.provider };
    cur.requests++;
    topCounts.set(key, cur);
    totalTokens += r.tokensTotal || (r.tokensPrompt + r.tokensCompletion);
    if (r.finalModel) uniqueModels.add(r.finalModel);
    if (r.routingMode === 'auto') autoRequests++;
    else manualRequests++;
    if (r.status >= 400 || r.status === 0) errors++;
    latencySum += r.latencyMs;
  }
  let topModel: UsageSummary['topModel'] = null;
  let bestCount = -1;
  for (const [key, v] of topCounts) {
    if (v.requests > bestCount) {
      bestCount = v.requests;
      const model = key.split('::')[0];
      topModel = { model, provider: v.provider, requests: v.requests };
    }
  }
  return {
    period: p,
    since,
    totalRequests: list.length,
    totalErrors: errors,
    totalTokens,
    autoRequests,
    manualRequests,
    topModel,
    avgLatencyMs: list.length ? Math.round(latencySum / list.length) : 0,
    uniqueModels: uniqueModels.size,
  };
}

/** Percentil (0-100) de uma lista de números; 0 quando vazia. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

function aggregateModels(list: UsageRecord[]): UsageModelStat[] {
  type Agg = Omit<UsageModelStat, 'predominantMode' | 'predominantRequest' | 'avgLatencyMs' | 'avgTokensPerRequest' | 'successRate' | 'p95LatencyMs'> & {
    latSum: number;
    latencies: number[];
    reqCounts: Map<string, number>;
  };
  const map = new Map<string, Agg>();
  for (const r of list) {
    const key = `${r.finalModel}::${r.provider}`;
    const existing = map.get(key);
    const agg: Agg = existing ?? {
      model: r.finalModel,
      provider: r.provider,
      requests: 0,
      errors: 0,
      tokens: 0,
      tokensPrompt: 0,
      tokensCompletion: 0,
      lastUsedAt: 0,
      autoRequests: 0,
      manualRequests: 0,
      latSum: 0,
      latencies: [],
      reqCounts: new Map(),
    };
    map.set(key, agg);
    const prompt = Number(r.tokensPrompt) || 0;
    const completion = Number(r.tokensCompletion) || 0;
    agg.reqCounts.set(r.requestedModel, (agg.reqCounts.get(r.requestedModel) || 0) + 1);
    agg.requests++;
    if (r.status >= 400 || r.status === 0) agg.errors++;
    agg.tokens += r.tokensTotal || (prompt + completion);
    agg.tokensPrompt += prompt;
    agg.tokensCompletion += completion;
    agg.lastUsedAt = Math.max(agg.lastUsedAt, r.ts);
    if (r.routingMode === 'auto') agg.autoRequests++;
    else agg.manualRequests++;
    agg.latSum += r.latencyMs;
    agg.latencies.push(r.latencyMs);
  }
  const out: UsageModelStat[] = [];
  for (const agg of map.values()) {
    const { latSum, latencies, reqCounts, ...rest } = agg;
    let predominantRequest = '';
    let bestReq = -1;
    for (const [req, n] of reqCounts) {
      if (n > bestReq) {
        bestReq = n;
        predominantRequest = req;
      }
    }
    out.push({
      ...rest,
      avgLatencyMs: agg.requests ? Math.round(latSum / agg.requests) : 0,
      avgTokensPerRequest: agg.requests ? Math.round(rest.tokens / agg.requests) : 0,
      successRate: agg.requests ? Math.round(((agg.requests - agg.errors) / agg.requests) * 1000) / 10 : 0,
      p95LatencyMs: percentile(latencies, 95),
      predominantMode: agg.autoRequests === agg.manualRequests ? '—' : agg.autoRequests > agg.manualRequests ? 'auto' : 'manual',
      predominantRequest,
    });
  }
  return out;
}

/** Ranking por modelo para GET /api/usage/models. */
export function computeModelRanking(period?: string, limit = 15): UsageModelStat[] {
  const out = aggregateModels(getUsageRecords(period));
  out.sort((a, b) => b.requests - a.requests || b.tokens - a.tokens);
  return out.slice(0, Math.max(1, Math.min(50, limit)));
}

/* ------------------------- Consumo por conta/chave ----------------========= */

export interface UsageAccountStat {
  /** Id da conta (AccountKey.id) ou chave de agrupamento dos sem-id. */
  accountId: string;
  /** Rótulo/apelido da conta (ex.: "atrossilva") ou "(sem identificação)". */
  accountName: string;
  provider: string;
  providerId: string;
  totalRequests: number;
  errorRequests: number;
  /** 0-100. */
  successRate: number;
  totalTokens: number;
  tokensPrompt: number;
  tokensCompletion: number;
  avgTokensPerRequest: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastUsedAt: number;
  /** Modelos distintos atendidos pela conta no período. */
  models: number;
  /** Saúde da conta no runtime: active/rate_limited/disabled (+ desconhecido). */
  status: 'active' | 'rate_limited' | 'disabled' | 'desconhecido';
  /** Cooldown de cota restante (ms) quando rate_limited; 0 caso contrário. */
  resetsInMs: number;
  /** Resultado da última tentativa com esta chave (registro do AccountKey). */
  lastResult: 'success' | 'quota' | 'error' | null;
  /** Limite de tokens configurado no AccountKey (null = sem limite). */
  limitTokens: number | null;
  /** Limite de requisições configurado no AccountKey (null = sem limite). */
  limitRequests: number | null;
  /** Janela do limite. null quando nenhum limite configurado. */
  limitPeriod: 'day' | 'month' | null | undefined;
  /** Consumo de tokens/requisições DENTRO da janela do limite (independe do
   * seletor de período da UI — quota sempre reflete hoje/este mês). */
  windowTokens: number;
  windowRequests: number;
  /** Saldo restante da cota (null = sem limite configurado). */
  remainingTokens: number | null;
  remainingRequests: number | null;
  /** % da cota consumida (0-100, clampado; null = sem limite). */
  usagePctTokens: number | null;
  usagePctRequests: number | null;
  /** true quando a conta já estourou pelo menos um dos limites configurados. */
  quotaExhausted: boolean;
}

type AccountAgg = Omit<
  UsageAccountStat,
  | 'successRate'
  | 'avgTokensPerRequest'
  | 'p95LatencyMs'
  | 'windowTokens'
  | 'windowRequests'
  | 'remainingTokens'
  | 'remainingRequests'
  | 'usagePctTokens'
  | 'usagePctRequests'
  | 'quotaExhausted'
> & {
  latSum: number;
  latencies: number[];
};

/**
 * Agrega o uso por conta (chave de API) para GET /api/usage/accounts.
 * Junta dois repositórios:
 *  1. telemetria de requisições (accountId gravado nos headers X-Account-*);
 *  2. inventário de contas do registry (inclui contas sem uso no período, com
 *     o status runtime de cota — active/rate_limited/disabled — e o cooldown).
 */
export function getUsageByAccount(
  period?: string,
  registry?: ProviderRegistry | null
): UsageAccountStat[] {
  const { since } = periodToSince(period);
  loadFromDisk();
  const list = since ? records.filter((r) => r.ts >= since) : records;
  const now = Date.now();

  const map = new Map<string, AccountAgg>();
  const touch = (key: string, init: Partial<AccountAgg>): AccountAgg => {
    let acc: AccountAgg | undefined = map.get(key);
    if (!acc) {
      acc = {
        accountId: init.accountId || key,
        accountName: init.accountName || '(sem identificação)',
        provider: init.provider || '—',
        providerId: init.providerId || '',
        totalRequests: 0,
        errorRequests: 0,
        totalTokens: 0,
        tokensPrompt: 0,
        tokensCompletion: 0,
        avgLatencyMs: 0,
        lastUsedAt: 0,
        models: 0,
        status: 'desconhecido',
        resetsInMs: 0,
        lastResult: null,
        limitTokens: null,
        limitRequests: null,
        limitPeriod: undefined,
        latSum: 0,
        latencies: [],
      };
      map.set(key, acc);
    }
    return acc;
  };

  // 1) Inventário de contas configuradas (inclusive as sem uso no período).
  const providers = registry?.providers || [];
  for (const p of providers) {
    const keys = normalizeAccountKeys(p);
    for (const k of keys) {
      const acc = touch(k.id, {
        accountId: k.id,
        accountName: k.label || k.id,
        provider: p.name || p.id,
        providerId: p.id,
      });
      acc.status = k.status || 'active';
      acc.lastResult = k.lastResult ?? null;
      const resetAt = k.resetAt ? Date.parse(k.resetAt) : NaN;
      acc.resetsInMs = Number.isFinite(resetAt) ? Math.max(0, resetAt - now) : 0;
      // Limites de cota definidos na configuração da conta.
      acc.limitTokens = Number(k.limitTokens) > 0 ? Math.floor(Number(k.limitTokens)) : null;
      acc.limitRequests = Number(k.limitRequests) > 0 ? Math.floor(Number(k.limitRequests)) : null;
      acc.limitPeriod = acc.limitTokens || acc.limitRequests ? k.limitPeriod || 'day' : undefined;
    }
  }

  // 2) Consumo DENTRO da janela de cota (independente do período da UI):
  //    dia = desde a meia-noite local; mês = desde o dia 1º 00:00 local.
  //    Feito sobre TODOS os registros (não só o recorte do seletor),
  //    numa passada própria — lim (recorte) é só para as métricas gerais.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const winDay = new Map<string, { tokens: number; requests: number }>();
  const winMonth = new Map<string, { tokens: number; requests: number }>();
  for (const r of records) {
    if (!r.accountId) continue;
    const tok = Number(r.tokensTotal) || Number(r.tokensPrompt) + Number(r.tokensCompletion);
    const d0 = new Date(r.ts);
    if (d0 >= monthStart) {
      const w = winMonth.get(r.accountId) || { tokens: 0, requests: 0 };
      w.tokens += tok;
      w.requests++;
      winMonth.set(r.accountId, w);
    }
    if (d0 >= dayStart) {
      const w = winDay.get(r.accountId) || { tokens: 0, requests: 0 };
      w.tokens += tok;
      w.requests++;
      winDay.set(r.accountId, w);
    }
  }

  // 3) Telemetria: contas com id conhecido + bucket "(sem identificação)".
  const modelsByAcc = new Map<string, Set<string>>();
  for (const r of list) {
    const key = r.accountId ? r.accountId : `anon::${r.provider}`;
    const providerId = providers.find((p) => p.name === r.provider)?.id || '';
    const invEntry = r.accountId ? providers.find((p) => (p.apiKeys || []).some((k2) => k2.id === r.accountId)) : undefined;
    const invKey = invEntry ? (invEntry.apiKeys || []).find((k2) => k2.id === r.accountId) : undefined;
    const acc = touch(key, {
      accountId: invKey?.id || '',
      accountName: invKey?.label || r.accountName || '',
      provider: invEntry?.name || r.provider,
      providerId: providerId,
    });
    acc.totalRequests++;
    if (r.status >= 400) acc.errorRequests++;
    acc.totalTokens += Number(r.tokensTotal) || Number(r.tokensPrompt) + Number(r.tokensCompletion);
    acc.tokensPrompt += Number(r.tokensPrompt) || 0;
    acc.tokensCompletion += Number(r.tokensCompletion) || 0;
    acc.latSum += r.latencyMs || 0;
    acc.latencies.push(r.latencyMs || 0);
    acc.lastUsedAt = Math.max(acc.lastUsedAt, r.ts);
    if (!modelsByAcc.has(key)) modelsByAcc.set(key, new Set());
    if (r.finalModel) modelsByAcc.get(key)!.add(r.finalModel);
  }

  const out: UsageAccountStat[] = [];
  for (const [key, acc] of map) {
    // Cota: janela conforme a configuração da conta (padrão: dia) e consumo
    // registrado dentro dela. Excedido → quotaExhausted.
    const win = acc.limitPeriod === 'month' ? winMonth : winDay;
    const w = win.get(key) || { tokens: 0, requests: 0 };
    const remainingTokens = acc.limitTokens != null ? Math.max(0, acc.limitTokens - w.tokens) : null;
    const remainingRequests = acc.limitRequests != null ? Math.max(0, acc.limitRequests - w.requests) : null;
    const usagePctTokens = acc.limitTokens ? Math.min(100, Math.round((w.tokens / acc.limitTokens) * 1000) / 10) : null;
    const usagePctRequests = acc.limitRequests
      ? Math.min(100, Math.round((w.requests / acc.limitRequests) * 1000) / 10)
      : null;
    const exhaustedTokens = acc.limitTokens != null ? w.tokens >= acc.limitTokens : false;
    const exhaustedRequests = acc.limitRequests != null ? w.requests >= acc.limitRequests : false;
    const { latSum, latencies, ...rest } = acc;
    out.push({
      ...rest,
      providerId: rest.providerId || '',
      successRate: acc.totalRequests
        ? Math.round(((acc.totalRequests - acc.errorRequests) / acc.totalRequests) * 1000) / 10
        : 0,
      avgTokensPerRequest: acc.totalRequests ? Math.round(acc.totalTokens / acc.totalRequests) : 0,
      avgLatencyMs: acc.totalRequests ? Math.round(latSum / acc.totalRequests) : 0,
      p95LatencyMs: percentile(latencies, 95),
      limitTokens: acc.limitTokens ?? null,
      limitRequests: acc.limitRequests ?? null,
      limitPeriod: acc.limitPeriod ?? null,
      windowTokens: w.tokens,
      windowRequests: w.requests,
      remainingTokens,
      remainingRequests,
      usagePctTokens,
      usagePctRequests,
      quotaExhausted: exhaustedTokens || exhaustedRequests,
      models: modelsByAcc.get(key)?.size || 0,
      resetsInMs: Math.max(0, acc.resetsInMs || 0),
    });
  }
  out.sort(
    (a, b) =>
      b.totalRequests - a.totalRequests ||
      (b.totalTokens || 0) - (a.totalTokens || 0) ||
      String(a.accountName).localeCompare(String(b.accountName))
  );
  return out;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TIMELINE_BUCKETS = 60;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildTimeline(
  list: UsageRecord[],
  period: string,
  since: number | null
): UsageTimelinePoint[] {
  if (!list.length) return [];
  const bucketMs = period === '24h' ? HOUR_MS : DAY_MS;
  const now = Date.now();
  const lastTs = list.reduce((max, r) => Math.max(max, r.ts), 0);
  const end = Math.max(now, lastTs);
  const firstTs = list.reduce((min, r) => Math.min(min, r.ts), Number.POSITIVE_INFINITY);
  let start = since ?? firstTs;
  const minStart = end - (MAX_TIMELINE_BUCKETS - 1) * bucketMs;
  if (start < minStart) start = minStart;
  if (start > end) start = end;
  const startBucket = Math.floor(start / bucketMs) * bucketMs;
  const endBucket = Math.floor(end / bucketMs) * bucketMs;

  const buckets = new Map<number, { requests: number; tokens: number; errors: number }>();
  for (const r of list) {
    const key = Math.floor(r.ts / bucketMs) * bucketMs;
    const cur = buckets.get(key) || { requests: 0, tokens: 0, errors: 0 };
    cur.requests++;
    cur.tokens += r.tokensTotal || r.tokensPrompt + r.tokensCompletion;
    if (r.status >= 400 || r.status === 0) cur.errors++;
    buckets.set(key, cur);
  }

  const out: UsageTimelinePoint[] = [];
  for (let ts = startBucket; ts <= endBucket; ts += bucketMs) {
    const cur = buckets.get(ts) || { requests: 0, tokens: 0, errors: 0 };
    const d = new Date(ts);
    out.push({
      ts,
      label: period === '24h' ? `${pad2(d.getHours())}:00` : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`,
      ...cur,
    });
  }
  return out;
}

function isAutoRequested(model: string): boolean {
  return model === 'auto' || model === 'auto-free';
}

/**
 * Relatório avançado de uso: consumo/cotas por modelo, split prompt×completion,
 * percentis de latência, timeline, failovers e estado dos trackers de cota/rate.
 */
export function computeAdvancedUsage(period?: string): UsageAdvancedReport {
  const list = getUsageRecords(period);
  const { since, period: p } = periodToSince(period);

  let tokensPrompt = 0;
  let tokensCompletion = 0;
  let totalTokens = 0;
  let totalErrors = 0;
  let requestsWithoutTokens = 0;
  let autoRequests = 0;
  let manualRequests = 0;
  let failovers = 0;
  let latencySum = 0;
  const latencies: number[] = [];
  const uniqueModels = new Set<string>();
  const uniqueProviders = new Set<string>();
  const providerMap = new Map<string, {
    provider: string;
    requests: number;
    errors: number;
    tokens: number;
    tokensPrompt: number;
    tokensCompletion: number;
    latSum: number;
    models: Set<string>;
  }>();
  const transitionMap = new Map<string, UsageTransition>();

  for (const r of list) {
    const prompt = Number(r.tokensPrompt) || 0;
    const completion = Number(r.tokensCompletion) || 0;
    const tokens = r.tokensTotal || prompt + completion;
    const failed = r.status >= 400 || r.status === 0;

    tokensPrompt += prompt;
    tokensCompletion += completion;
    totalTokens += tokens;
    if (!tokens) requestsWithoutTokens++;
    if (failed) totalErrors++;
    if (r.routingMode === 'auto') autoRequests++;
    else manualRequests++;
    if (r.routingMode === 'auto' && isAutoRequested(r.requestedModel) && r.finalModel !== r.requestedModel) {
      failovers++;
    }
    latencySum += r.latencyMs;
    latencies.push(r.latencyMs);
    if (r.finalModel) uniqueModels.add(r.finalModel);
    if (r.provider) uniqueProviders.add(r.provider);

    const providerKey = r.provider || '(desconhecido)';
    const prov = providerMap.get(providerKey) || {
      provider: providerKey,
      requests: 0,
      errors: 0,
      tokens: 0,
      tokensPrompt: 0,
      tokensCompletion: 0,
      latSum: 0,
      models: new Set<string>(),
    };
    providerMap.set(providerKey, prov);
    prov.requests++;
    if (failed) prov.errors++;
    prov.tokens += tokens;
    prov.tokensPrompt += prompt;
    prov.tokensCompletion += completion;
    prov.latSum += r.latencyMs;
    if (r.finalModel) prov.models.add(r.finalModel);

    if (r.routingMode === 'auto' && r.requestedModel !== r.finalModel) {
      const key = `${r.requestedModel}→${r.finalModel}::${r.provider}`;
      const tr = transitionMap.get(key) || {
        requested: r.requestedModel,
        final: r.finalModel,
        provider: r.provider,
        mode: r.routingMode,
        count: 0,
      };
      tr.count++;
      transitionMap.set(key, tr);
    }
  }

  const quotaStats = getQuotaTrackerStats();
  const quotaByModel = new Map(quotaStats.models.map((q) => [q.modelId, q]));
  const models: UsageModelAdvancedStat[] = aggregateModels(list)
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
    .map((m) => {
      const q = quotaByModel.get(m.model);
      return {
        ...m,
        quota: q
          ? {
              windowHours: quotaStats.windowHours,
              usedTokens: q.tokens,
              usedRequests: q.requests,
              learnedLimitTokens: q.learnedLimitTokens,
              learnedLimitRequests: q.learnedLimitRequests,
              remainingTokens: q.learnedLimitTokens > 0 ? Math.max(0, q.learnedLimitTokens - q.tokens) : null,
              remainingRequests: q.learnedLimitRequests > 0 ? Math.max(0, q.learnedLimitRequests - q.requests) : null,
              headroom: q.headroom ?? null,
              exhausted: q.exhausted,
              exhaustedUntil: q.exhaustedUntil,
              resetsInMs: q.exhausted ? Math.max(0, q.exhaustedUntil - Date.now()) : 0,
              lastErrorAt: q.lastErrorAt,
            }
          : null,
      };
    });

  const providers: UsageProviderStat[] = [...providerMap.values()]
    .map((p) => ({
      provider: p.provider,
      requests: p.requests,
      errors: p.errors,
      successRate: p.requests ? Math.round(((p.requests - p.errors) / p.requests) * 1000) / 10 : 0,
      tokens: p.tokens,
      tokensPrompt: p.tokensPrompt,
      tokensCompletion: p.tokensCompletion,
      models: p.models.size,
      avgLatencyMs: p.requests ? Math.round(p.latSum / p.requests) : 0,
    }))
    .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens);

  const transitions = [...transitionMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const totalRequests = list.length;
  const successRate = totalRequests
    ? Math.round(((totalRequests - totalErrors) / totalRequests) * 1000) / 10
    : 0;

  return {
    period: p,
    since,
    generatedAt: Date.now(),
    summary: {
      totalRequests,
      totalErrors,
      successRate,
      totalTokens,
      tokensPrompt,
      tokensCompletion,
      avgTokensPerRequest: totalRequests ? Math.round(totalTokens / totalRequests) : 0,
      requestsWithoutTokens,
      autoRequests,
      manualRequests,
      autoRate: totalRequests ? Math.round((autoRequests / totalRequests) * 1000) / 10 : 0,
      avgLatencyMs: totalRequests ? Math.round(latencySum / totalRequests) : 0,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      failovers,
      uniqueModels: uniqueModels.size,
      uniqueProviders: uniqueProviders.size,
    },
    models,
    providers,
    timeline: buildTimeline(list, p, since),
    transitions,
    quota: quotaStats,
    rate: getRateTrackerStats(),
  };
}

/** Formata os registros em CSV (para o export). */
export function recordsToCsv(list: UsageRecord[]): string {
  const header = [
    'timestamp', 'status', 'requestedModel', 'finalModel', 'provider', 'routingMode',
    'tokensPrompt', 'tokensCompletion', 'tokensTotal', 'latencyMs',
  ];
  const rows = list.map((r) =>
    [
      new Date(r.ts).toISOString(),
      r.status,
      r.requestedModel,
      r.finalModel,
      r.provider,
      r.routingMode,
      r.tokensPrompt,
      r.tokensCompletion,
      r.tokensTotal,
      r.latencyMs,
    ]
      .map((v) => {
        const s = String(v ?? '');
        return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      })
      .join(',')
  );
  return [header.join(','), ...rows].join('\n');
}

/** Limpa os dados de uso (útil em testes). */
export function resetUsage(): void {
  records = [];
}

/**
 * Captura o uso de uma requisição concluída em /v1/chat/completions, a partir
 * da Response final e do contexto Hono (usoRequestedModel/usageRoutingMode
 * gravados em chat.ts). Best-effort: qualquer falha aqui NÃO pode afetar a
 * resposta devolvida ao cliente.
 */
export function recordRequestUsageFromResponse(
  c: any,
  res: Response,
  startedAt: number
): Response {
  try {
    if (!c || typeof (c as any).req?.path !== 'string') return res;
    if ((c as any).req.path !== '/v1/chat/completions') return res;

    const requested = String((c as any).get?.('usageRequestedModel') || '');
    const routingMode: UsageRoutingMode = (c as any).get?.('usageRoutingMode') === 'auto' ? 'auto' : 'manual';

    // Fonte primária: variáveis de contexto (definidas nos pontos de decisão
    // de chat.ts/fusion.ts) — robustas mesmo quando a Response final é uma
    // Response crua que o Hono NÃO completa com os headers de contexto
    // (ex.: erros pós-failover em auto). Headers servem de fallback.
    let provider = String((c as any).get?.('usageProviderName') || '');
    let finalModel = String((c as any).get?.('usageFinalModel') || '');

    if (!finalModel) finalModel = res.headers.get('X-AutoRouter-FinalModel') || '';
    const via = res.headers.get('X-Routed-Via');
    if (via && (!finalModel || !provider)) {
      try {
        const dec = decodeURIComponent(via);
        const idx = dec.indexOf('/');
        if (!provider && idx > 0) provider = dec.slice(0, idx);
        if (!finalModel) finalModel = idx > 0 ? dec.slice(idx + 1) : dec;
      } catch {
        finalModel = finalModel || via;
      }
    }
    if (!finalModel) finalModel = requested || '';
    if (!finalModel) finalModel = res.headers.get('X-AutoRouter-FinalModel') || requested || '';
    if (!provider && finalModel && finalModel !== requested) {
      // Fallback de provedor: caminhos do orquestrador que não emitem
      // X-Routed-Via (ex.: resposta de erro pós-failover) podem ainda trazer o
      // FinalModel; resolve o provedor pelo catálogo em cache (só contém
      // provedores ativos). Best-effort e síncrono.
      const entry = getCachedModelCatalog().find((m) => m.id === finalModel);
      if (entry) provider = providerFromCatalogEntry(entry).name || entry.providerType || '';
    }
    if (finalModel === requested && (finalModel === 'auto' || finalModel === 'auto-free')) {
      // Modo auto não resolvido (erro antes da escolha): registrar "auto"
      // como final encobriria a lacuna — marca como desconhecido.
      finalModel = '(desconhecido)';
    }

    const ts = Date.now();
    // Conta/chave de API usada. Fonte primária: contexto Hono gravado no
    // handle da rotação (local.ts); headers X-Account-* ficam de reserva para
    // caminhos que só conseguem carimbar a Response (agent.ts).
    const accountId = String(
      c.get?.('usageAccountId') || res.headers.get('X-Account-Id') || ''
    ).slice(0, 128);
    const accountName = String(
      c.get?.('usageAccountName') || res.headers.get('X-Account-Label') || ''
    ).slice(0, 128);
    recordUsage({
      ts,
      status: res.status,
      requestedModel: requested || '(vazio)',
      finalModel,
      provider,
      routingMode,
      tokensPrompt: 0,
      tokensCompletion: 0,
      tokensTotal: 0,
      latencyMs: Date.now() - startedAt,
      ...(accountId ? { accountId: accountId } : {}),
      ...(accountName ? { accountName: accountName } : {}),
    });

    // Tokens: best-effort.
    //  - JSON: clone barato da response (não-streaming).
    //  - SSE: tee da stream — uma branch vai ao cliente, a outra é escaneada
    //    em background procurando o objeto `usage` (o chunk final do formato
    //    OpenAI interno o traz). IDEs sempre usam stream: true, então sem isto
    //    TODA telemetria de token ficava zerada.
    //  - Sem `usage` reportável: estimativa por caracteres (fallback garante
    //    que o consumo nunca fique zerado). prompt via usagePromptChars
    //    (contexto Hono do chat.ts), completion via tamanho dos payloads SSE.
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json') && (res.status === 200 || res.status === 201)) {
      const fm = finalModel;
      const tsUsed = ts;
      const promptChars = Number(c.get?.('usagePromptChars')) || 0;
      res
        .clone()
        .json()
        .then((j: any) => {
          let p = Number(j?.usage?.prompt_tokens) || 0;
          let comp = Number(j?.usage?.completion_tokens) || 0;
          const tot = Number(j?.usage?.total_tokens) || p + comp;
          if (!p && !comp) {
            // Upstream (OpenAI-compatível) sem bloco usage: estima.
            const contentLen = String(j?.choices?.[0]?.message?.content || '').length;
            comp = Math.ceil(contentLen / 3.5);
            p = promptChars ? Math.ceil(promptChars / 3.5) : 0;
          }
          const est = !!(p || comp) && !j?.usage?.total_tokens;
          if (p || comp || tot) {
            patchUsageTokens(tsUsed, fm, {
              tokensPrompt: p,
              tokensCompletion: comp,
              tokensTotal: tot || p + comp,
              ...(est ? { estimated: true } : {}),
            });
          }
        })
        .catch(() => {});
      return res;
    }
    if (
      res.status === 200 &&
      ct.includes('text/event-stream') &&
      res.body &&
      typeof res.body.tee === 'function' &&
      finalModel &&
      finalModel !== '(desconhecido)'
    ) {
      const [clientBranch, scanBranch] = res.body.tee();
      const returned = new Response(clientBranch, { status: res.status, headers: res.headers });
      scanSseForUsage(scanBranch, finalModel, ts, Number(c.get?.('usagePromptChars')) || 0).catch(() => {});
      return returned;
    }
    return res;
  } catch {
    // nunca quebra o fluxo de resposta
    return res;
  }
}

/**
 * Consome uma branch da stream SSE (descartável) e extrai o último objeto
 * `usage` visto nos chunks `data:` no formato OpenAI. NUNCA toca na branch do
 * cliente — qualquer erro aqui só significa tokens zerados na telemetria.
 *
 * `promptChars`: estimativa do tamanho do prompt (contexto Hono usagePromptChars,
 * grava no ciclo do request) — usado no fallback quando NENHUM chunk traz
 * `usage` (upstreams que só emitem usage com stream_options.include_usage).
 */
async function scanSseForUsage(
  stream: ReadableStream<Uint8Array>,
  finalModel: string,
  ts: number,
  promptChars = 0
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage: any = null;
  let sseChars = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j && j.usage) usage = j.usage;
        } catch {
          // linha parcial: ignora
        }
        sseChars += payload.length;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  if (!usage) {
    // Fallback: completion estimada pelo volume de payload SSE (÷4), prompt
    // pelo tamanho registrado do prompt (÷3.5). Nada no stream → patch vazio.
    const estCompletion = Math.ceil(sseChars / 4);
    const estPrompt = promptChars ? Math.ceil(promptChars / 3.5) : 0;
    if (estCompletion > 0 || estPrompt > 0) {
      patchUsageTokens(ts, finalModel, {
        tokensPrompt: estPrompt,
        tokensCompletion: estCompletion,
        tokensTotal: estPrompt + estCompletion,
        estimated: true,
      });
    }
    return;
  }
  const p = Number(usage?.prompt_tokens) || 0;
  const comp = Number(usage?.completion_tokens) || 0;
  const tot = Number(usage?.total_tokens) || p + comp;
  if (p || comp || tot) {
    patchUsageTokens(ts, finalModel, { tokensPrompt: p, tokensCompletion: comp, tokensTotal: tot });
  }
}

/** Snapshot dos registros (testes/persistência externa). */
export function getUsageSnapshot(): UsageRecord[] {
  loadFromDisk();
  return records.slice();
}
