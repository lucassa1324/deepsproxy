import type { Provider } from './config.ts';
import type { OpenAIRequest } from '../utils/types.ts';

export function applyPromptCaching(body: OpenAIRequest, provider: Provider): OpenAIRequest {
  if (!body.messages?.length) return body;

  // Respeita flag de opt-out
  if ((body as any).enablePromptCache === false) return body;

  const sysIdx = body.messages.findIndex(m => m.role === 'system');
  if (sysIdx === -1) return body;

  // Anthropic: cache_control explícito + header beta
  // Requer que o adapter Anthropic suporte system como array com cache_control
  // TODO: Modificar adapter Anthropic para aceitar system[] com cache_control
  if (provider.type === 'anthropic') {
    return {
      ...body,
      extraHeaders: { ...(body as any).extraHeaders, 'anthropic-beta': 'prompt-caching-2024-07-25' }
    };
  }

  // OpenAI / OpenAI-compatible: cache automático server-side (>1024 tokens, bloco 128)
  // Não precisa modificação no payload, só garantir system prompt estável
  if (provider.type === 'openai-compatible') {
    return body;
  }

  // DeepSeek / Qwen / Gemini Web / outros: sem cache explícito
  return body;
}