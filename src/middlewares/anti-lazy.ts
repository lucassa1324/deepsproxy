/*
 * File: anti-lazy.ts
 * Project: deepsproxy
 * Middleware de sanitização de prompt (Anti-Preguiça) e interceptação de
 * finalização precoce do Gateway HTTP Puro.
 *
 *  - Injeta a diretiva ANTI-LAZY no início do System Message de TODAS as
 *    requisições que atravessam o proxy (sanitização de prompt);
 *  - Detecta respostas "preguiçosas" (toolCalls=0 + texto curto ou genérico)
 *    e agenda 1 retry automático com a mensagem oculta.
 *
 * O proxy é pass-through: as Tool Calls do modelo são repassadas direto no
 * payload HTTP/SSE para a IDE resolver no workspace do usuário. Nenhum I/O
 * local é executado no servidor.
 */

import type { OpenAIRequest, Message } from '../utils/types.ts';

/** Diretiva anti-preguiça injetada no início do system prompt (verbatim). */
export const ANTI_LAZY_AGENTIC_DIRECTIVE = `[SYSTEM DIRECTIVE - ANTI-LAZY & AGENTIC EXECUTION]
Você é um agente de desenvolvimento autônomo e de alta precisão.
- NUNCA dê respostas parciais, resumos ou peça para o usuário implementar o código manualmente.
- Escreva SEMPRE o código completo e funcional nas chamadas de ferramentas (Write/Edit/SearchReplace).
- NUNCA encerre a tarefa até que todos os requisitos do prompt do usuário tenham sido cobertos por chamadas de ferramentas válidas.
- Se encontrar um erro de arquivo ou ferramenta, corrija o argumento e tente novamente imediatamente.`;

/** Marcador idempotência da diretiva (evita injeção duplicada). */
export const ANTI_LAZY_MARKER = 'SYSTEM DIRECTIVE - ANTI-LAZY';

/** Mensagem oculta enviada no retry (reagendamento) de finalização precoce. */
export const ANTI_LAZY_RETRY_MESSAGE =
  'Você ainda não concluiu a alteração solicitada no código. ' +
  'Execute as chamadas de ferramentas necessárias agora sem enrolar.';

/** True quando o texto já contém a diretiva (evita duplicação). */
export function hasAntiLazyDirective(text: string): boolean {
  return (text || '').includes(ANTI_LAZY_MARKER);
}

/**
 * Injeta a diretiva anti-preguiça no INÍCIO de um system prompt textual.
 * Idempotente: se o marcador já estiver presente, devolve o texto inalterado.
 */
export function injectAntiLazyDirectiveIntoText(systemPrompt: string): string {
  if (!systemPrompt || systemPrompt.trim() === '') {
    return ANTI_LAZY_AGENTIC_DIRECTIVE.trim();
  }
  if (hasAntiLazyDirective(systemPrompt)) return systemPrompt;
  return `${ANTI_LAZY_AGENTIC_DIRECTIVE.trim()}\n\n${systemPrompt.trim()}`;
}

/**
 * Middleware de sanitização de prompt: injeta a diretiva anti-preguiça no
 * INÍCIO do primeiro System Message de `messages[].content`. Sem system
 * message, cria uma no começo da lista. Idempotente por requisição.
 */
export function injectAntiLazyDirectiveIntoMessages(messages: Message[]): Message[] {
  const result = [...messages];
  const systemIndex = result.findIndex((m) => m.role === 'system');

  if (systemIndex === -1) {
    result.unshift({ role: 'system', content: ANTI_LAZY_AGENTIC_DIRECTIVE.trim() });
    return result;
  }

  const sysMsg = result[systemIndex];
  const content = sysMsg.content;

  if (typeof content === 'string') {
    if (hasAntiLazyDirective(content)) return result;
    result[systemIndex] = {
      ...sysMsg,
      content: `${ANTI_LAZY_AGENTIC_DIRECTIVE.trim()}\n\n${content.trim()}`,
    };
    return result;
  }

  if (Array.isArray(content)) {
    const existingText = content
      .map((p: any) => (p && p.type === 'text' ? p.text : ''))
      .join('\n');
    if (hasAntiLazyDirective(existingText)) return result;
    result[systemIndex] = {
      ...sysMsg,
      content: [{ type: 'text', text: ANTI_LAZY_AGENTIC_DIRECTIVE.trim() }, ...content],
    };
    return result;
  }

  result[systemIndex] = { ...sysMsg, content: ANTI_LAZY_AGENTIC_DIRECTIVE.trim() };
  return result;
}

/**
 * Sanitiza um request OpenAI-completo: aplica a diretiva anti-preguiça nas
 * mensagens e devolve uma cópia. Usado no entry-point do /v1/chat/completions
 * para TODAS as requisições que atravessam o gateway.
 */
export function injectAntiLazyDirective(body: OpenAIRequest): OpenAIRequest {
  const messages = injectAntiLazyDirectiveIntoMessages(body.messages || []);
  if (messages === (body.messages || [])) return body;
  return { ...body, messages };
}

/** Padrões de texto genérico/preguiçoso emitidos SEM chamar nenhuma tool. */
const LAZY_TEXT_PATTERNS: RegExp[] = [
  /aqui (est[áa]|est[aã]o) o (meu )?resumo/i,
  /aqui vai o (meu )?resumo/i,
  /resumo (do|da|dos|das) turno/i,
  /n[ãa]o (posso|consigo|consegui|consegue) (realizar|implementar|criar|executar|acessar|editar|modificar)/i,
  /n[ãa]o tenho acesso (a|ao|aos|[àa]s|nem)/i,
  /voc[êe] (pode|precisa|deve) (implementar|criar|fazer|editar|corrigir|escrever)/i,
  /me (diga|informe|passe|d[êe]|forne[çc]a) (o caminho|o path|onde|o arquivo)/i,
  /qual (['e]eo )?caminho/i,
  /onde (est[áa]|fica) (o |a )?(arquivo|pasta)/i,
  /por favor, (implemente|fa[çc]a|realize|execute)/i,
  /(eu |)(vou|posso) (te )?(ajudar|explicar|dizer) (com |sobre |como |)a?/i,
  /(como|onde) (posso|devo|preciso) (ajudar|prosseguir|continuar|saber)/i,
  /posso ajudar (com |em )?(algo|mais|outra)/i,
  /devo (eu )?implementar/i,
  /voc[êe] quem (implementa|faz|cria|edita)/i,
  /n[ãa]o posso executar/i,
];

/**
 * Detecta finalização precoce: toolCalls == 0 E texto ausente, curto ou
 * genérico (ex.: "Aqui está o resumo..." sem executar as alterações).
 */
export function isLazyCompletion(
  content: string | null | undefined,
  toolCalls: Array<{ name?: string }> | undefined
): boolean {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return false;
  const text = (content ?? '').trim();
  if (!text) return true;
  if (text.length < 30) return true;
  return LAZY_TEXT_PATTERNS.some((p) => p.test(text));
}