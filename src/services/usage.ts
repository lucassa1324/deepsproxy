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
import { getCachedModelCatalog, providerFromCatalogEntry } from './modelCatalog.ts';

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
}

export interface UsageModelStat {
  model: string;
  provider: string;
  requests: number;
  errors: number;
  tokens: number;
  autoRequests: number;
  manualRequests: number;
  /** Modo predominante neste modelo. */
  predominantMode: UsageRoutingMode | '—';
  /** requestModel predominante no bucket (ex.: "auto", nome do modelo). */
  predominantRequest: string;
  avgLatencyMs: number;
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
  return {
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
  tokens: { tokensPrompt?: number; tokensCompletion?: number; tokensTotal?: number }
): void {
  const rec = [...records].reverse().find((r) => r.ts === ts && r.finalModel === finalModel);
  if (!rec) return;
  if (tokens.tokensPrompt !== undefined) rec.tokensPrompt = tokens.tokensPrompt;
  if (tokens.tokensCompletion !== undefined) rec.tokensCompletion = tokens.tokensCompletion;
  if (tokens.tokensTotal !== undefined) rec.tokensTotal = tokens.tokensTotal;
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
  for (const r of list) {
    const key = `${r.finalModel}::${r.provider}`;
    const cur = topCounts.get(key) || { requests: 0, provider: r.provider };
    cur.requests++;
    topCounts.set(key, cur);
    totalTokens += r.tokensTotal || (r.tokensPrompt + r.tokensCompletion);
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
  };
}

/** Ranking por modelo para GET /api/usage/models. */
export function computeModelRanking(period?: string, limit = 15): UsageModelStat[] {
  const list = getUsageRecords(period);
  type Agg = Omit<UsageModelStat, 'predominantMode' | 'predominantRequest'> & { latSum: number; reqCounts: Map<string, number> };
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
      autoRequests: 0,
      manualRequests: 0,
      avgLatencyMs: 0,
      latSum: 0,
      reqCounts: new Map(),
    };
    map.set(key, agg);
    agg.reqCounts.set(r.requestedModel, (agg.reqCounts.get(r.requestedModel) || 0) + 1);
    agg.requests++;
    if (r.status >= 400 || r.status === 0) agg.errors++;
    agg.tokens += r.tokensTotal || (r.tokensPrompt + r.tokensCompletion);
    if (r.routingMode === 'auto') agg.autoRequests++;
    else agg.manualRequests++;
    agg.latSum += r.latencyMs;
  }
  const out: UsageModelStat[] = [];
  for (const agg of map.values()) {
    const { latSum, reqCounts, ...rest } = agg;
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
      predominantMode: agg.autoRequests === agg.manualRequests ? '—' : agg.autoRequests > agg.manualRequests ? 'auto' : 'manual',
      predominantRequest,
    });
  }
  out.sort((a, b) => b.requests - a.requests || b.tokens - a.tokens);
  return out.slice(0, Math.max(1, Math.min(50, limit)));
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
): void {
  try {
    if (!c || typeof (c as any).req?.path !== 'string') return;
    if ((c as any).req.path !== '/v1/chat/completions') return;

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
    });

    // Tokens: best-effort (apenas respostas JSON; SSE é consumido pelo cliente).
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json') && (res.status === 200 || res.status === 201)) {
      const fm = finalModel;
      res
        .clone()
        .json()
        .then((j: any) => {
          const p = Number(j?.usage?.prompt_tokens) || 0;
          const comp = Number(j?.usage?.completion_tokens) || 0;
          const tot = Number(j?.usage?.total_tokens) || p + comp;
          if (p || comp || tot) patchUsageTokens(ts, fm, { tokensPrompt: p, tokensCompletion: comp, tokensTotal: tot });
        })
        .catch(() => {});
    }
  } catch {
    // nunca quebra o fluxo de resposta
  }
}

/** Snapshot dos registros (testes/persistência externa). */
export function getUsageSnapshot(): UsageRecord[] {
  loadFromDisk();
  return records.slice();
}
