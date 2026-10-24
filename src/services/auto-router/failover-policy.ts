export const DEFAULT_MAX_AUTO_ATTEMPTS = 3;

export function maxAutoAttempts(value = process.env.AUTO_MAX_ATTEMPTS): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_AUTO_ATTEMPTS;
  return Math.min(parsed, 10);
}

export function capFailoverChain<T>(chain: T[], max = maxAutoAttempts()): T[] {
  return chain.slice(0, max);
}

export function isPermanentFailure(status: number, bodyText = ''): boolean {
  if (status === 400 || status === 401 || status === 403 || status === 422) return true;
  return /invalid\s+(api[\s_-]?key|token)|unauthori[sz]ed|authentication\s+(failed|required)|incorrect\s+api\s+key/i.test(
    bodyText
  );
}

export function shouldFailover(status: number, bodyText = ''): boolean {
  if (status < 400) return false;
  if (isPermanentFailure(status, bodyText)) return false;
  return true;
}

export function timeoutMs(value = process.env.AUTO_ATTEMPT_TIMEOUT_MS): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 120_000;
  return Math.min(Math.max(parsed, 5_000), 600_000);
}
