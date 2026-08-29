/*
 * File: gateway.ts
 * Project: deepsproxy
 * AI Gateway multi-tenant: API Keys virtuais vinculadas a aplicações.
 *
 * Cada aplicação (Trae, Cursor, N8N, scripts...) recebe uma chave virtual
 * (ex.: app_trae_x7K2...). Os clientes apontam para a mesma Base URL do proxy
 * e usam a chave virtual como "Authorization: Bearer <chave>". O gateway
 * identifica a aplicação, resolve o provedor ativo e o modelo real
 * configurados no painel e reescreve a requisição em direção ao provedor.
 *
 * A chave real é guardada apenas como hash SHA-256 (keyHash); o valor em texto
 * plano só é exibido uma única vez, na criação ou na regeneração.
 */

import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export interface GatewayApp {
  id: string;
  name: string;
  /** Hash SHA-256 da chave virtual (nunca guarda a chave em texto plano). */
  keyHash: string;
  /** Prefixo legível da chave (ex.: "app_trae_…") para exibição na lista. */
  keyHint: string;
  /**
   * Id do provedor (opcional, compat. com apps antigas). Desde a eliminação do
   * dropdown de provedor, o provedor é resolvido automaticamente pelo catálogo
   * de modelos a partir do campo `model`.
   */
  providerId?: string;
  /** Modelo real a usar; vazio = respeitar o modelo da requisição. */
  model: string;
  enabled: boolean;
  createdAt: number;
  /** Parâmetros LLM por aplicação (opcionais; se ausentes, usa valores do cliente/padrão). */
  temperature?: number;
  top_p?: number;
  /** System prompt override para esta aplicação (anexado ao system prompt da requisição). */
  systemPromptOverride?: string;
  /** Limite de tokens de resposta para esta aplicação. */
  maxTokens?: number;
}

export interface AppCreationResult {
  app: GatewayApp;
  /** Chave em texto plano — exibida UMA única vez ao criar/regenerar. */
  apiKey: string;
}

export interface AppUpdatePatch {
  name?: string;
  providerId?: string;
  model?: string;
  enabled?: boolean;
  temperature?: number | null;
  top_p?: number | null;
  systemPromptOverride?: string | null;
  maxTokens?: number | null;
}

const VIRTUAL_KEY_PREFIX = 'app_';

function appsFile(): string {
  return process.env.GATEWAY_FILE || join(process.cwd(), 'gateway-apps.json');
}

let appsCache: GatewayApp[] | null = null;

function loadApps(): GatewayApp[] {
  if (appsCache) return appsCache;
  try {
    const file = appsFile();
    if (!existsSync(file)) {
      appsCache = [];
      return appsCache;
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    appsCache = Array.isArray(raw.apps) ? raw.apps : [];
  } catch {
    appsCache = [];
  }
  return appsCache ?? [];
}

function persistApps(): void {
  try {
    const file = appsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ apps: appsCache ?? [] }, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[gateway] falha ao persistir apps em ${appsFile()}:`, err.message);
  }
}

/** Invalida o cache em memória (usado em testes). */
export function resetAppsCache(): void {
  appsCache = null;
}

export function newAppId(): string {
  return 'app_' + randomBytes(6).toString('hex');
}

function slugify(name: string): string {
  return (
    String(name || 'app')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'app'
  );
}

/** Gera uma chave virtual no formato app_<nome>_<aleatório>. */
export function generateVirtualKey(name: string): string {
  const random = randomBytes(9).toString('base64url');
  return `${VIRTUAL_KEY_PREFIX}${slugify(name)}_${random}`;
}

/** Hash SHA-256 de uma chave virtual. */
export function hashVirtualKey(key: string): string {
  return createHash('sha256').update(String(key)).digest('hex');
}

export function isVirtualKeyFormat(key: string | undefined | null): boolean {
  return typeof key === 'string' && key.startsWith(VIRTUAL_KEY_PREFIX);
}

/** Extrai o token de um header Authorization ("Bearer <token>"). */
export function extractBearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export function listApps(): GatewayApp[] {
  return loadApps().map((a) => ({ ...a }));
}

export function getAppByKey(key: string): GatewayApp | null {
  if (!isVirtualKeyFormat(key)) return null;
  const hash = hashVirtualKey(key);
  const app = loadApps().find((a) => a.keyHash === hash);
  return app ? { ...app } : null;
}

export function getAppById(id: string): GatewayApp | null {
  const app = loadApps().find((a) => a.id === id);
  return app ? { ...app } : null;
}

export function createApp(input: { name: string; providerId?: string; model?: string }): AppCreationResult {
  const apiKey = generateVirtualKey(input.name);
  const app: GatewayApp = {
    id: newAppId(),
    name: String(input.name || 'Aplicação').trim() || 'Aplicação',
    keyHash: hashVirtualKey(apiKey),
    keyHint: apiKey.slice(0, apiKey.indexOf('_', 4) + 1 + 8) + '…',
    providerId: input.providerId || undefined,
    model: String(input.model || '').trim(),
    enabled: true,
    createdAt: Date.now(),
  };
  const apps = loadApps();
  apps.push(app);
  appsCache = apps;
  persistApps();
  return { app: { ...app }, apiKey };
}

export function updateApp(id: string, patch: AppUpdatePatch): GatewayApp | null {
  const apps = loadApps();
  const idx = apps.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const next: GatewayApp = {
    ...apps[idx],
    name: patch.name !== undefined ? (String(patch.name).trim() || apps[idx].name) : apps[idx].name,
    providerId: patch.providerId !== undefined ? patch.providerId : apps[idx].providerId,
    model: patch.model !== undefined ? String(patch.model).trim() : apps[idx].model,
    enabled: patch.enabled !== undefined ? patch.enabled !== false : apps[idx].enabled,
    temperature: patch.temperature !== undefined ? (patch.temperature === null ? undefined : patch.temperature) : apps[idx].temperature,
    top_p: patch.top_p !== undefined ? (patch.top_p === null ? undefined : patch.top_p) : apps[idx].top_p,
    systemPromptOverride: patch.systemPromptOverride !== undefined ? (patch.systemPromptOverride === null ? undefined : patch.systemPromptOverride) : apps[idx].systemPromptOverride,
    maxTokens: patch.maxTokens !== undefined ? (patch.maxTokens === null ? undefined : patch.maxTokens) : apps[idx].maxTokens,
  };
  apps[idx] = next;
  appsCache = apps;
  persistApps();
  return { ...next };
}

export function deleteApp(id: string): boolean {
  const apps = loadApps();
  const idx = apps.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  apps.splice(idx, 1);
  appsCache = apps;
  persistApps();
  return true;
}

/** Gera uma nova chave para a aplicação (a anterior é revogada). */
export function regenerateAppKey(id: string): AppCreationResult | null {
  const apps = loadApps();
  const idx = apps.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const apiKey = generateVirtualKey(apps[idx].name);
  apps[idx] = {
    ...apps[idx],
    keyHash: hashVirtualKey(apiKey),
    keyHint: apiKey.slice(0, apiKey.indexOf('_', 4) + 1 + 8) + '…',
  };
  appsCache = apps;
  persistApps();
  return { app: { ...apps[idx] }, apiKey };
}

/**
 * Resolve o contexto de uma requisição autenticada por chave virtual.
 *
 * Retorna:
 *  - null -> sem chave virtual (roteamento normal continua);
 *  - { app, model } -> aplicação válida; o provedor é resolvido pelo catálogo
 *    de modelos a partir de `model` (eliminação da seleção manual);
 *  - { error, status } -> chave inválida (401) ou aplicação desativada (403).
 */
export function resolveAppForRequest(
  authHeader: string | undefined | null
): { app: GatewayApp; model: string } | { error: string; status: 401 | 403 } | null {
  const token = extractBearerToken(authHeader);
  if (!token || !isVirtualKeyFormat(token)) return null;

  const app = getAppByKey(token);
  if (!app) {
    return { error: 'Invalid API key for application.', status: 401 };
  }
  if (app.enabled === false) {
    return { error: `Application "${app.name}" is disabled.`, status: 403 };
  }

  return { app, model: app.model || '' };
}
