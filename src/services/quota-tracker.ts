/*
 * File: quota-tracker.ts
 * Project: deepsproxy
 * Orçamento/cota por modelo (janela deslizante) com DETECÇÃO AUTOMÁTICA de
 * limites — sem configuração manual.
 *
 * Ideia (inspirada no budget/key-lease do freellmapi, adaptada sem SQLite):
 *   • Conta requests (e, quando disponível, tokens) por modelo numa janela
 *     deslizante (padrão 24h).
 *   • NÃO exige que o usuário informe o limite. Quando o provedor devolve um
 *     erro de cota (429 / quota exceeded), o tracker registra esse ponto como
 *     o "limite real observado" (uso no momento do erro) e coloca o modelo em
 *     cooldown até o fim da janela / retry-after.
 *   • Expõe um headroom 0-1 usado pelo roteador: modelos perto do limite ou
 *     esgotados são preteridos, e o failover segue para o próximo modelo —
 *     realizando o "vai acabando os tokens de um, passa pro outro".
 *
 * Config (env):
 *   QUOTA_TRACKING      'false' desliga (padrão: ligado)
 *   QUOTA_WINDOW_HOURS  janela deslizante em horas (padrão: 24)
 *   QUOTA_HEADROOM      fração de folga mínima p/ penalizar (padrão: 0.15)
 */

const HOUR_MS = 60 * 60 * 1000;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isQuotaTrackingEnabled(): boolean {
  return (process.env.QUOTA_TRACKING ?? 'on').trim().toLowerCase() !== 'false';
}

export function quotaWindowMs(): number {
  return numEnv('QUOTA_WINDOW_HOURS', 24) * HOUR_MS;
}

export function quotaHeadroomThreshold(): number {
  return numEnv('QUOTA_HEADROOM', 0.15);
}

interface Sample {
  ts: number;
  tokens: number;
}

interface QuotaEntry {
  samples: Sample[];          // janela deslizante de uso (requests = length)
  learnedLimitTokens: number; // maior uso observado no momento de um erro de cota
  learnedLimitRequests: number;
  exhaustedUntil: number;     // cooldown após erro de cota (0 = ok)
  lastErrorAt: number;
}

const entries = new Map<string, QuotaEntry>();

function blankEntry(): QuotaEntry {
  return { samples: [], learnedLimitTokens: 0, learnedLimitRequests: 0, exhaustedUntil: 0, lastErrorAt: 0 };
}

function prune(e: QuotaEntry): void {
  const cutoff = Date.now() - quotaWindowMs();
  if (e.samples.length === 0) return;
  const kept = e.samples.filter((s) => s.ts > cutoff);
  if (kept.length !== e.samples.length) e.samples = kept;
}

function usageOf(modelId: string): { requests: number; tokens: number } {
  const e = entries.get(modelId);
  if (!e) return { requests: 0, tokens: 0 };
  prune(e);
  let tokens = 0;
  for (const s of e.samples) tokens += s.tokens;
  return { requests: e.samples.length, tokens };
}

/** Registra o uso de um modelo (1 request; tokens best-effort quando conhecidos). */
export function recordQuotaUsage(modelId: string, tokens = 0): void {
  if (!modelId || !isQuotaTrackingEnabled()) return;
  let e = entries.get(modelId);
  if (!e) {
    e = blankEntry();
    entries.set(modelId, e);
  }
  e.samples.push({ ts: Date.now(), tokens: tokens > 0 ? tokens : 0 });
}

/** Soma tokens ao último request registrado (usage vem depois do desfecho). */
export function recordQuotaTokens(modelId: string, tokens: number): void {
  if (!modelId || !isQuotaTrackingEnabled() || !(tokens > 0)) return;
  const e = entries.get(modelId);
  if (!e || e.samples.length === 0) return;
  e.samples[e.samples.length - 1].tokens += tokens;
}

/**
 * Registra que o modelo estourou a cota. Aprende o limite a partir do uso
 * observado no momento do erro (auto-detecção) e coloca o modelo em cooldown.
 */
export function recordQuotaExhaustion(modelId: string, cooldownMs: number): void {
  if (!modelId) return;
  let e = entries.get(modelId);
  if (!e) {
    e = blankEntry();
    entries.set(modelId, e);
  }
  prune(e);
  const requests = e.samples.length;
  let tokens = 0;
  for (const s of e.samples) tokens += s.tokens;
  // Limite observado: o uso que disparou o erro é, na prática, o teto atingido.
  if (requests > e.learnedLimitRequests) e.learnedLimitRequests = requests;
  if (tokens > e.learnedLimitTokens) e.learnedLimitTokens = tokens;
  const cooldown = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : quotaWindowMs();
  e.exhaustedUntil = Math.max(e.exhaustedUntil, Date.now() + cooldown);
  e.lastErrorAt = Date.now();
  console.warn(
    `[quota] modelo "${modelId}" atingiu a cota; cooldown de ${Math.round(cooldown / 1000)}s ` +
      `(limite aprendido: ${requests} req / ${tokens} tok na janela).`
  );
}

/** true quando o modelo está em cooldown por cota (esgotado). */
export function isModelQuotaExhausted(modelId: string, now: number = Date.now()): boolean {
  const e = entries.get(modelId);
  return !!e && now < e.exhaustedUntil;
}

/**
 * Headroom de cota 0-1 (1 = folga total). Retorna undefined quando não há
 * informação suficiente (nenhum limite aprendido e nenhum uso) — o roteador
 * trata undefined como neutro.
 */
export function getQuotaHeadroom(modelId: string, now: number = Date.now()): number | undefined {
  const e = entries.get(modelId);
  if (!e) return undefined;
  if (now < e.exhaustedUntil) return 0;
  prune(e);
  if (e.learnedLimitTokens > 0) {
    let tokens = 0;
    for (const s of e.samples) tokens += s.tokens;
    const h = 1 - tokens / e.learnedLimitTokens;
    return Math.max(0, Math.min(1, h));
  }
  if (e.learnedLimitRequests > 0) {
    const h = 1 - e.samples.length / e.learnedLimitRequests;
    return Math.max(0, Math.min(1, h));
  }
  return undefined;
}

export interface QuotaTrackerStats {
  enabled: boolean;
  windowHours: number;
  models: Array<{
    modelId: string;
    requests: number;
    tokens: number;
    headroom?: number;
    exhausted: boolean;
    exhaustedUntil: number;
    learnedLimitTokens: number;
    learnedLimitRequests: number;
    lastErrorAt: number;
  }>;
}

export function getQuotaTrackerStats(): QuotaTrackerStats {
  const now = Date.now();
  const models: QuotaTrackerStats['models'] = [];
  for (const [modelId, e] of entries) {
    prune(e);
    let tokens = 0;
    for (const s of e.samples) tokens += s.tokens;
    models.push({
      modelId,
      requests: e.samples.length,
      tokens,
      headroom: getQuotaHeadroom(modelId, now),
      exhausted: now < e.exhaustedUntil,
      exhaustedUntil: e.exhaustedUntil,
      learnedLimitTokens: e.learnedLimitTokens,
      learnedLimitRequests: e.learnedLimitRequests,
      lastErrorAt: e.lastErrorAt,
    });
  }
  models.sort((a, b) => b.requests - a.requests);
  return { enabled: isQuotaTrackingEnabled(), windowHours: quotaWindowMs() / HOUR_MS, models };
}

// ── Snapshot/Restore (persistência — L3.7) ───────────────────────────────

export interface QuotaSnapshotEntry {
  modelId: string;
  samples: Sample[];
  learnedLimitTokens: number;
  learnedLimitRequests: number;
  exhaustedUntil: number;
  lastErrorAt: number;
}

export function snapshotQuota(): QuotaSnapshotEntry[] {
  const out: QuotaSnapshotEntry[] = [];
  for (const [modelId, e] of entries) out.push({ modelId, ...e, samples: [...e.samples] });
  return out;
}

export function restoreQuota(entriesIn: QuotaSnapshotEntry[]): void {
  entries.clear();
  for (const e of entriesIn) {
    if (!e || !e.modelId) continue;
    entries.set(e.modelId, {
      samples: Array.isArray(e.samples) ? e.samples.filter((s) => s && typeof s.ts === 'number') : [],
      learnedLimitTokens: e.learnedLimitTokens || 0,
      learnedLimitRequests: e.learnedLimitRequests || 0,
      exhaustedUntil: e.exhaustedUntil || 0,
      lastErrorAt: e.lastErrorAt || 0,
    });
  }
}

export function resetQuotaTracker(): void {
  entries.clear();
}
