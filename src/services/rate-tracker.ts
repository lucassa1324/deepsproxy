/*
 * File: rate-tracker.ts
 * Project: deepsproxy
 * Rate tracking leve por chave de API (RPM/TPM em memória, sem SQLite).
 * Portado conceitualmente do freellmapi (server/src/services/ratelimit.ts),
 * sem persistência: janelas deslizantes de 60s por chave, usadas pela rotação
 * (rotation.ts) para PULAR de antemão uma chave que estourou o orçamento
 * local — em vez de esperar o 429 do provedor.
 *
 * Semântica de "lease": acquire() reserva uma requisição (+ estimativa de
 * tokens) na janela e devolve true se cabe; release() desfaz a reserva quando
 * a tentativa falha sem consumo real (erro de rede). Chamadas que de fato
 * chegaram ao provedor (sucesso ou 429) mantêm a reserva — o provedor contou.
 *
 * Config (env):
 *  RATE_LIMIT_TRACKING   'false' desliga (padrão: ligado)
 *  RATE_LIMIT_RPM        máx requisições/chave/minuto (padrão: 120)
 *  RATE_LIMIT_TPM        máx tokens estimados/chave/minuto (padrão: 300000)
 *  RATE_LIMIT_EST_TOKENS estimativa de tokens por request p/ TPM (padrão: 1000)
 */

const WINDOW_MS = 60_000;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isRateTrackingEnabled(): boolean {
  return (process.env.RATE_LIMIT_TRACKING ?? 'on').trim().toLowerCase() !== 'false';
}

export function rateLimitRpm(): number {
  return intEnv('RATE_LIMIT_RPM', 120);
}

export function rateLimitTpm(): number {
  return intEnv('RATE_LIMIT_TPM', 300_000);
}

export function rateLimitEstTokens(): number {
  return intEnv('RATE_LIMIT_EST_TOKENS', 1000);
}

interface BudgetEntry {
  ts: number;
  tokens: number;
}

const buckets = new Map<string, BudgetEntry[]>();

function keyFor(providerId: string, keyId: string): string {
  return `${providerId}::${keyId}`;
}

function prune(key: string): BudgetEntry[] {
  const cutoff = Date.now() - WINDOW_MS;
  const list = buckets.get(key) ?? [];
  const kept = list.filter((e) => e.ts > cutoff);
  if (kept.length !== list.length) {
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
  }
  return kept;
}

function usage(key: string): { requests: number; tokens: number } {
  const list = prune(key) ?? [];
  let tokens = 0;
  for (const e of list) tokens += e.tokens;
  return { requests: list.length, tokens };
}

/** Reserva uma requisição (+ estimativa de tokens) na janela da chave.
 *  Retorna false quando a chave já estourou RPM ou TPM. */
export function acquireKeyBudget(providerId: string, keyId: string, estTokens = rateLimitEstTokens()): boolean {
  if (!providerId || !keyId) return true;
  const key = keyFor(providerId, keyId);
  const { requests, tokens } = usage(key);
  if (requests >= rateLimitRpm()) return false;
  if (tokens + estTokens > rateLimitTpm()) return false;
  const list = buckets.get(key) ?? [];
  list.push({ ts: Date.now(), tokens: estTokens });
  buckets.set(key, list);
  return true;
}

/** Desfaz a reserva mais recente da janela (falha de rede sem consumo real). */
export function releaseKeyBudget(providerId: string, keyId: string, estTokens = rateLimitEstTokens()): void {
  if (!providerId || !keyId) return;
  const key = keyFor(providerId, keyId);
  const list = buckets.get(key);
  if (!list) return;
  const cutoff = Date.now() - WINDOW_MS;
  const idx = list.findIndex((e) => e.ts > cutoff && e.tokens === estTokens);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) buckets.delete(key);
  else buckets.set(key, list);
}

/** Cooldown sugerido (ms) até o fim da janela atual — ~60s no máximo. */
export function cooldownUntilWindowEnd(): number {
  return Math.max(1000, WINDOW_MS - (Date.now() % WINDOW_MS));
}

export interface RateTrackerStats {
  enabled: boolean;
  rpm: number;
  tpm: number;
  estTokens: number;
  keys: Array<{ key: string; requests: number; tokens: number }>;
}

/** Estado para o dashboard / debug. */
export function getRateTrackerStats(): RateTrackerStats {
  const out: RateTrackerStats = {
    enabled: isRateTrackingEnabled(),
    rpm: rateLimitRpm(),
    tpm: rateLimitTpm(),
    estTokens: rateLimitEstTokens(),
    keys: [],
  };
  for (const [key, list] of buckets) {
    const kept = list.filter((e) => e.ts > Date.now() - WINDOW_MS);
    if (kept.length === 0) continue;
    let tokens = 0;
    for (const e of kept) tokens += e.tokens;
    out.keys.push({ key, requests: kept.length, tokens });
  }
  out.keys.sort((a, b) => b.requests - a.requests);
  return out;
}

export function resetRateTracker(): void {
  buckets.clear();
}

// ── Snapshot/Restore (persistência — L3.7) ───────────────────────────────

export interface RateTrackerSnapshotEntry {
  key: string;
  entries: BudgetEntry[];
}

export function snapshotRateTracker(): RateTrackerSnapshotEntry[] {
  const out: RateTrackerSnapshotEntry[] = [];
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, list] of buckets) {
    const kept = list.filter((e) => e.ts > cutoff);
    if (kept.length > 0) out.push({ key, entries: kept });
  }
  return out;
}

export function restoreRateTracker(entriesIn: RateTrackerSnapshotEntry[]): void {
  buckets.clear();
  if (!Array.isArray(entriesIn)) return;
  const cutoff = Date.now() - WINDOW_MS;
  for (const e of entriesIn) {
    if (!e || typeof e.key !== 'string' || !Array.isArray(e.entries)) continue;
    const kept = e.entries.filter((x) => x && typeof x.ts === 'number' && x.ts > cutoff);
    if (kept.length > 0) buckets.set(e.key, kept);
  }
}