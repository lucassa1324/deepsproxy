# Notas: Prompt Caching no DeepsProxy

## Resumo do que foi discutido

### O que é Prompt Caching
- **Anthropic**: Cache explícito via `cache_control: {type: 'ephemeral'}` no system prompt + header `anthropic-beta: prompt-caching-2024-07-25`. Economia ~90% no input, ~80% latência.
- **OpenAI**: Cache automático server-side para system prompts >1024 tokens (blocos de 128 tokens). Não precisa de configuração, só garantir system prompt **idêntico** entre requests.
- **DeepSeek/Qwen/Gemini Web**: Não têm cache nativo.

### Regra de Ouro: System Prompt DEVE ser ESTÁTICO
```javascript
// ❌ QUEBRA CACHE - dados dinâmicos no system prompt
system: `Você é um assistente. Hoje: ${new Date()}. Sessão: ${uuid()}. User: ${userId}.`

// ✅ MANTÉM CACHE - system prompt fixo byte-a-byte
system: `Você é um gerador de prompts criativo para editor de imagens. Seja técnico e preciso.`
```

### O que PODE variar (não afeta cache)
- **User prompts** — cada request com prompt diferente é processado fresco
- **Temperature, top-p, seed** — aleatoriedade preservada
- **Images, tools, histórico de conversa** — tudo no user message

### Seu caso de uso (editor de fotos) = IDEAL para cache
```
Request 1: System (fixo) + User: "gato cyberpunk"
Request 2: System (fixo) + User: "carro voador steampunk"  
Request 3: System (fixo) + User: "cidade neon futurista"
```
- 1ª request: paga cheio
- 2ª em diante: **~90% desconto no system prompt** (Anthropic) ou cache automático (OpenAI)
- Cada arte sai **diferente e criativa** — cache só guarda as instruções fixas

---

## Como implementar no DeepsProxy (próximos passos)

### 1. Criar `src/services/prompt-cache.ts`
```typescript
import type { Provider } from './config.ts';
import type { OpenAIRequest } from '../utils/types.ts';

export function applyPromptCaching(body: OpenAIRequest, provider: Provider): OpenAIRequest {
  if (!body.messages?.length) return body;

  const sysIdx = body.messages.findIndex(m => m.role === 'system');
  if (sysIdx === -1) return body;

  const sysMsg = body.messages[sysIdx];
  const sysText = typeof sysMsg.content === 'string' ? sysMsg.content : 
    Array.isArray(sysMsg.content) ? sysMsg.content.map(c => c.text || '').join('') : '';

  // Anthropic: cache_control + header
  if (provider.type === 'anthropic') {
    const cachedSystem = [
      { type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }
    ];
    return {
      ...body,
      system: cachedSystem,
      messages: body.messages.filter((_, i) => i !== sysIdx),
      extraHeaders: { ...(body as any).extraHeaders, 'anthropic-beta': 'prompt-caching-2024-07-25' }
    };
  }

  // OpenAI: já funciona automático se system prompt >1024 tokens e estável
  if (provider.type === 'openai-compatible' || provider.type === 'openai') {
    return body;
  }

  // DeepSeek / outros: sem cache explícito
  return body;
}
```

### 2. Integrar no `chatCompletions` (`src/routes/chat.ts`)
```typescript
// Antes do dispatchAdapterChat (linha ~136) e fetch openai-compatible (linha ~152)
import { applyPromptCaching } from '../services/prompt-cache';

// ...
const cachedBody = applyPromptCaching(payload, provider);
// usar cachedBody no dispatch/fetch
```

### 3. Adicionar flag opcional no `OpenAIRequest` (`src/utils/types.ts`)
```typescript
interface OpenAIRequest {
  // ... campos existentes
  enablePromptCache?: boolean; // default true
}
```

### 4. Verificar se `buildAgentPrompt` / `token-economy` / `optimizations` não mutam system prompt
- Rodar 2 requests idênticos e comparar logs
- System prompt deve ser **byte-a-byte igual**

---

## Checklist de validação

- [ ] System prompt não tem timestamps, UUIDs, session IDs, contadores
- [ ] System prompt >1024 tokens (OpenAI) ou qualquer tamanho (Anthropic com cache_control)
- [ ] Flag `enablePromptCache` respeitada (default true)
- [ ] Header `anthropic-beta` enviado só para Anthropic
- [ ] Teste: 2 requests iguais → 2ª mais rápida/barata (verificar logs de tokens/latência)
- [ ] Criatividade mantida: user prompts variados geram outputs variados

---

## Arquivos relacionados no proxy

| Arquivo | Papel |
|---------|-------|
| `src/services/adapters/` | Dispatch por provedor (anthropic, openai, gemini, etc) |
| `src/services/modelCatalog.ts` | Resolve modelo → provedor |
| `src/services/optimizations.ts` | Phase 1: strip metadata, compress tools |
| `src/services/token-economy.ts` | Truncamento, resumo, cache de resposta |
| `src/routes/chat.ts` | Handler principal `/v1/chat/completions` |
| `src/utils/prompt.ts` | `buildAgentPrompt` — **verificar se não injeta dinâmicos no system** |

---

## Referências rápidas

- **Anthropic Prompt Caching**: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- **OpenAI Prompt Caching**: https://platform.openai.com/docs/guides/prompt-caching (automático >1024 tokens)
- **TTL Anthropic**: 5 min (renovado a cada hit)
- **Blocos OpenAI**: 128 tokens a partir do token 1024

---

*Criado em: 27/08/2026*
*Continuar a partir daqui: implementar `prompt-cache.ts` e integrar no `chatCompletions`*