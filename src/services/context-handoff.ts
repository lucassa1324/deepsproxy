/*
 * File: context-handoff.ts
 * Project: deepsproxy
 * Context Handoff: quando uma conversa troca de modelo (ex.: failover
 * automático no Auto Router, ou sticky session mudando de provedor), injeta
 * um resumo do contexto recente como mensagem de system para o novo modelo
 * continuar a tarefa sem "reiniciar" a conversa.
 *
 * Portado do freellmapi (server/src/services/context-handoff.ts), sem
 * dependências externas. Usa a estrutura de mensagens OpenAI do deepsproxy.
 *
 * Modo de operação (env):
 *   DEEPSPROXY_CONTEXT_HANDOFF=on_model_switch  (padrão) — injeta ao trocar de modelo
 *   DEEPSPROXY_CONTEXT_HANDOFF=off               — desliga o recurso
 *   (FREELLMAPI_CONTEXT_HANDOFF é aceito como alias para quem já configurou)
 */

import { createHash } from 'crypto';

export type ContextHandoffMode = 'off' | 'on_model_switch';

type TrimmedMessage = { role: string; content: string };

type SessionContext = {
  lastModelKey?: string;
  recentMessages: TrimmedMessage[];
  updatedAt: number;
};

const MAX_RECENT_MESSAGES = 12;
const MAX_HANDOFF_CHARS = 6000;
const MAX_CONTENT_PER_MSG = 500;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_STORE_SIZE = 500;

// (MAX_HANDOFF_CHARS chars + ~400 overhead chars) / 4 chars-per-token.
export const HANDOFF_MAX_TOKENS = Math.ceil((MAX_HANDOFF_CHARS + 400) / 4);

const HANDOFF_MARKER = 'DeepsProxy context handoff:';

const store = new Map<string, SessionContext>();

export function getContextHandoffMode(): ContextHandoffMode {
  const raw = (
    process.env.DEEPSPROXY_CONTEXT_HANDOFF ??
    process.env.FREELLMAPI_CONTEXT_HANDOFF ??
    ''
  )
    .trim()
    .toLowerCase();
  // Padrão: ligado na troca de modelo (recurso desejado). Desliga só com
  // valor explícito de "off"/"0"/"false"/"no".
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'off';
  return 'on_model_switch';
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        const block = b as { type?: string; text?: unknown };
        if (typeof block?.text === 'string' && (block.type === 'text' || block.type === undefined)) {
          return block.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Deriva uma chave de sessão estável: header X-Session-ID se presente; caso
 *  contrário, hash dos primeiros turnos (system + primeiro user) — mesma
 *  conversa no mesmo cliente mapeia para a mesma sessão. */
export function deriveSessionKey(sessionHeader: string | null | undefined, messages: any[]): string {
  if (sessionHeader && sessionHeader.trim()) return `header:${sessionHeader.trim()}`.slice(0, 256);
  const turns = (messages || [])
    .filter((m) => m && (m.role === 'system' || m.role === 'user'))
    .slice(0, 6)
    .map((m) => `${m.role}:${contentToString(m.content)}`)
    .join('\u0000');
  return `hash:${createHash('sha256').update(turns || 'empty').digest('hex')}`;
}

// Slice sem cortar um par de surrogates (emoji). Um String.slice puro pode
// deixar um high surrogate solto; alguns provedores rejeitam (400).
function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastCode = text.charCodeAt(max - 1);
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

function trimContent(content: unknown): string {
  const text = contentToString(content);
  return text.length > MAX_CONTENT_PER_MSG ? safeSlice(text, MAX_CONTENT_PER_MSG) + '…' : text;
}

function pruneExpired(): void {
  if (store.size === 0) return;
  const now = Date.now();
  for (const [key, ctx] of store) {
    if (now - ctx.updatedAt > SESSION_TTL_MS) store.delete(key);
  }
}

function evictIfNeeded(): void {
  if (store.size <= MAX_STORE_SIZE) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.updatedAt > SESSION_TTL_MS) store.delete(k);
  }
  if (store.size > MAX_STORE_SIZE) {
    const sorted = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [k] of sorted.slice(0, store.size - MAX_STORE_SIZE)) store.delete(k);
  }
}

/** Registra as mensagens atuais da sessão para montar o resumo do handoff. */
export function recordIncomingMessages(sessionKey: string, messages: any[]): void {
  if (!sessionKey) return;
  pruneExpired();

  const trimmed = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: trimContent(m.content) }))
    .slice(-MAX_RECENT_MESSAGES);

  // Mutação in-place preserva lastModelKey escrito por recordSuccessfulModel em
  // requests concorrentes. Sem turno assistant, trata como conversa nova e
  // limpa lastModelKey (evita handoff espúrio quando o sticky-session expirou).
  const hasAssistant = (messages || []).some((m) => m && m.role === 'assistant');
  const existing = store.get(sessionKey);
  if (existing) {
    if (!hasAssistant) existing.lastModelKey = undefined;
    existing.recentMessages = trimmed;
    existing.updatedAt = Date.now();
  } else {
    store.set(sessionKey, { recentMessages: trimmed, updatedAt: Date.now() });
  }

  evictIfNeeded();
}

function buildSummary(messages: TrimmedMessage[]): string {
  const lines = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  const joined = lines.join('\n');
  return joined.length > MAX_HANDOFF_CHARS
    ? safeSlice(joined, MAX_HANDOFF_CHARS) + '\n…[truncated]'
    : joined;
}

/** True quando há um modelo anterior bem-sucedido registrado para a sessão. */
export function hasPriorModel(sessionKey: string): boolean {
  if (!sessionKey) return false;
  return !!store.get(sessionKey)?.lastModelKey;
}

/** Injeta o resumo de contexto quando a sessão estava num modelo diferente. */
export function maybeInjectContextHandoff(params: {
  mode: ContextHandoffMode;
  sessionKey: string;
  messages: any[];
  selectedModelKey: string;
}): { messages: any[]; injected: boolean; injectedTokens: number } {
  const { mode, sessionKey, messages, selectedModelKey } = params;
  if (mode === 'off' || !sessionKey) return { messages, injected: false, injectedTokens: 0 };

  const ctx = store.get(sessionKey);
  if (!ctx?.lastModelKey || ctx.lastModelKey === selectedModelKey) {
    return { messages, injected: false, injectedTokens: 0 };
  }

  // Já existe um handoff (string ou array de bloco de conteúdo): não duplica.
  const alreadyPresent = (messages || []).some((m) => {
    if (!m || m.role !== 'system') return false;
    const text = typeof m.content === 'string' ? m.content : contentToString(m.content);
    return text.startsWith(HANDOFF_MARKER);
  });
  if (alreadyPresent) return { messages, injected: false, injectedTokens: 0 };

  const summary = buildSummary(ctx.recentMessages);
  const handoffContent = [
    HANDOFF_MARKER,
    `You are taking over an ongoing conversation from another model (${ctx.lastModelKey} → ${selectedModelKey}).`,
    "Continue the user's task using the conversation context already provided in this request.",
    'Do not restart the task, re-ask already answered setup questions, or discard prior tool results.',
    "Respect the user's latest message as the highest-priority instruction.",
    '',
    'Recent session summary:',
    summary,
  ].join('\n');

  const handoffMsg: any = { role: 'system', content: handoffContent };

  // Insere após as mensagens de system de abertura, preservando a ordem dos
  // system prompts do provedor.
  const insertAt = (messages || []).findIndex((m) => m && m.role !== 'system');
  const pos = insertAt === -1 ? (messages || []).length : insertAt;

  return {
    messages: [...(messages || []).slice(0, pos), handoffMsg, ...(messages || []).slice(pos)],
    injected: true,
    injectedTokens: Math.ceil(handoffContent.length / 4),
  };
}

/** Registra o modelo que respondeu com sucesso nesta sessão. */
export function recordSuccessfulModel(params: { sessionKey: string; modelKey: string }): void {
  const { sessionKey, modelKey } = params;
  if (!sessionKey) return;
  pruneExpired();
  const ctx = store.get(sessionKey);
  if (ctx) {
    ctx.lastModelKey = modelKey;
    ctx.updatedAt = Date.now();
  } else {
    store.set(sessionKey, { lastModelKey: modelKey, recentMessages: [], updatedAt: Date.now() });
  }
  evictIfNeeded();
}

/** Nº de sessões no store (para o dashboard). */
export function getHandoffStoreSize(): number {
  return store.size;
}

/** Para testes apenas. */
export function _clearStoreForTesting(): void {
  store.clear();
}