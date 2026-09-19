/*
 * File: deepseek.ts
 * Project: deepsproxy
 * Author: Lucas Sá
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Lucas Sá
 */

import { getDeepSeekHeaders, invalidateDeepSeekHeaders } from './playwright.ts';

// In-memory state to track the last message ID per session to avoid overwriting
// Use globalThis to ensure it survives module reloads in some test environments
const sessionStates: Record<string, number | null> = (globalThis as any)._sessionStates || {};
(globalThis as any)._sessionStates = sessionStates;

export function updateSessionParent(sessionId: string, parentId: number | null) {
  if (sessionId) {
    sessionStates[sessionId] = parentId;
  }
}

export interface DeepSeekPayload {
  chat_session_id?: string;
  parent_message_id?: number | null;
  model_type: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

export interface DeepSeekStreamOptions {
  /** Sessão pré-criada (ex.: sessão de visão criada via chat_session/create). */
  chatSessionId?: string;
  /** model_type a enviar (ex.: "vision" quando há imagens). */
  modelType?: string | null;
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  forcedParentId?: number | null,
  refFileIds: string[] = [],
  opts: DeepSeekStreamOptions = {}
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  const buildPayload = (sessionId: string, parentId: number | null) => {
    // Determine the actual parent ID:
    // 1. If forcedParentId is provided (even if null), use it.
    // 2. If tracked parent ID is available for this session, use it.
    // 3. Fallback to Playwright's state.
    let actualParentId: number | null = parentId;
    if (forcedParentId !== undefined) {
      actualParentId = forcedParentId;
    } else if (sessionId && sessionStates[sessionId] !== undefined) {
      actualParentId = sessionStates[sessionId];
    }
    const effectiveSessionId = opts.chatSessionId || sessionId;
    const payload: DeepSeekPayload = {
      chat_session_id: effectiveSessionId || undefined,
      parent_message_id: actualParentId,
      model_type: opts.modelType !== undefined ? opts.modelType : null,
      prompt: prompt,
      ref_file_ids: refFileIds,
      thinking_enabled: enableThinking,
      search_enabled: true,
      preempt: false
    };
    return { payload, effectiveSessionId };
  };

  const doFetch = (hdrs: Record<string, string>, payload: DeepSeekPayload) =>
    fetch('https://chat.deepseek.com/api/v0/chat/completion', {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'authorization': hdrs['authorization'],
        'content-type': 'application/json',
        'origin': 'https://chat.deepseek.com',
        'x-ds-pow-response': hdrs['x-ds-pow-response'],
        'x-hif-dliq': hdrs['x-hif-dliq'],
        'x-hif-leim': hdrs['x-hif-leim'],
        'cookie': hdrs['cookie'],
        'x-client-bundle-id': hdrs['x-client-bundle-id'] || 'com.deepseek.chat',
        'x-client-locale': hdrs['x-client-locale'] || 'pt_BR',
        'x-client-platform': hdrs['x-client-platform'] || 'web',
        'x-client-version': hdrs['x-client-version'] || '2.3.0',
        'x-client-timezone-offset': hdrs['x-client-timezone-offset'] || '-10800'
      },
      body: JSON.stringify(payload)
    });

  // Obtain fresh headers/PoW from Playwright (ou do cache de continuação).
  // If forcedParentId is null, it means we are explicitly starting a new session
  let { headers, chatSessionId, parentMessageId } = await getDeepSeekHeaders(forcedParentId === null);
  let { payload, effectiveSessionId } = buildPayload(chatSessionId, parentMessageId);
  let response = await doFetch(headers, payload);

  // Headers/PoW expiraram ou foram rejeitados: invalida o cache e reextrai
  // headers frescos (fallback único; o chamador já tem retry próprio).
  if (response.status === 401 || response.status === 403) {
    console.warn('[deepseek] headers/PoW rejeitados pelo servidor; reextraindo headers frescos...');
    invalidateDeepSeekHeaders();
    const fresh = await getDeepSeekHeaders(true);
    headers = fresh.headers;
    chatSessionId = fresh.chatSessionId;
    parentMessageId = fresh.parentMessageId;
    ({ payload, effectiveSessionId } = buildPayload(chatSessionId, parentMessageId));
    response = await doFetch(headers, payload);
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from DeepSeek: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers, uiSessionId: effectiveSessionId };
}
