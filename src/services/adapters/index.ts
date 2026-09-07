/*
 * File: index.ts
 * Project: deepsproxy
 * Registry dos Adapters e dispatch por tipo. A rota de entrada e o roteador
 * usam estas funções para escolher o adaptador do provedor; o formato trocado
 * com o cliente é sempre OpenAI.
 */

import type { OpenAIRequest } from '../../utils/types.ts';
import type { Provider, ProviderType } from '../config.ts';
import type { ProviderAdapter } from './base.ts';
import { GeminiAdapter } from './gemini.ts';
import { AnthropicAdapter } from './anthropic.ts';
import { OllamaAdapter } from './ollama.ts';

const instances = new Map<string, ProviderAdapter>();

function getAdapter(type: ProviderType): ProviderAdapter | null {
  if (instances.has(type)) return instances.get(type)!;
  let adapter: ProviderAdapter | null = null;
  switch (type) {
    case 'gemini':
      adapter = new GeminiAdapter();
      break;
    case 'anthropic':
      adapter = new AnthropicAdapter();
      break;
    case 'ollama':
      adapter = new OllamaAdapter();
      break;
    default:
      return null;
  }
  instances.set(type, adapter);
  return adapter;
}

/** True para tipos que são atendidos pela camada de Adapters. */
export function isAdapterProvider(p: Provider): boolean {
  return p.type === 'gemini' || p.type === 'anthropic' || p.type === 'ollama';
}

/**
 * Dispatch final: executa o adapter do provedor e devolve a resposta OpenAI.
 * Retorna null quando o tipo não tem adapter (deepseek/qwen/openai-compatible).
 * `apiKey` opcional força uma chave específica (rotação de chaves).
 */
export async function dispatchAdapterChat(
  payload: OpenAIRequest,
  provider: Provider,
  apiKey?: string
): Promise<Response | null> {
  const adapter = getAdapter(provider.type);
  if (!adapter) return null;
  return adapter.chatCompletion(payload, provider, apiKey);
}

/**
 * Busca a lista de modelos de um provedor atendido por adapter (usado pelo
 * roteamento por modelo e pelo dashboard). Retorna null quando o provedor não
 * expõe listagem (Anthropic) ou quando o tipo não tem adapter.
 */
export async function fetchProviderModels(provider: Provider, apiKey?: string): Promise<any[] | null> {
  const adapter = getAdapter(provider.type);
  if (!adapter?.fetchModels) return null;
  return adapter.fetchModels(provider, apiKey);
}

/** Estado das filas de throttle dos adapters (para o dashboard). */
export function getAdapterQueueStates(): Record<string, { waiting: number }> {
  const gemini = instances.get('gemini');
  return {
    gemini: { waiting: gemini instanceof GeminiAdapter ? gemini.queueWaiting : 0 },
    anthropic: { waiting: 0 },
    ollama: { waiting: 0 },
  };
}
