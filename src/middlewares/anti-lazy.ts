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

/**
 * Padrões de texto genérico/preguiçoso OU de DESISTÊNCIA emitidos SEM chamar
 * nenhuma tool. Cobre desde "Aqui está o resumo..." até refugos longos e
 * reescritos ("Aguardando a instrução/tarefa", "qual alteração você deseja",
 * "o usuário esqueceu de incluir a tarefa", "vou perguntar ao usuário qual é
 * a tarefa desejada"). Como o modelo sempre REPARAFRASEIA, há também a regra
 * estrutural abaixo (TASK_SIGNAL + DODGE_SIGNAL) para pegar variações novas.
 */
const TASK_REFUSAL_PATTERNS: RegExp[] = [
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
  /aguardando\s+(a\s+)?(instru[cç][aã]o|tarefa|orienta[cç][aã]o)/i,
  /aguardando\s+novas?\s+(instru[cç][oõ]es|tarefas|orienta[cç][oõ]es)/i,
  /aguardando\s+suas?\s+instru[cç][oõ]es/i,
  /n[ãa]o\s+continha\s+(uma\s+)?(solicita[cç][aã]o|tarefa|instru[cç][aã]o)/i,
  /sem\s+(uma\s+)?(solicita[cç][aã]o|tarefa|instru[cç][aã]o|altera[cç][aã]o)\s+espec[ií]fica/i,
  /informe\s+(qual|o\s+que\s+alterar|o\s+que\s+voc[êe]\s+deseja)/i,
  /qual\s+(altera[cç][aã]o|corre[cç][aã]o|funcionalidade|mudan[cç]a|nov[aã]\s+funcionalidade)\s+(voc[êe]|o\s+usu[aá]rio)\s+(deseja|quer|gostaria)/i,
  /o\s+que\s+(voc[êe]|o\s+usu[aá]rio)\s+(deseja|quer|gostaria)\s+que\s+(eu\s+|se\s+)?(fa[çc]a|implemente|altere|corrija|adicione)/i,
  /what\s+(changes?|features?|tasks?)\s+would\s+you\s+like/i,
  /no\s+specific\s+(request|task|instruction|change|feature)/i,
  /please\s+inform\s+(me\s+)?(what|which)/i,
  // Refugos longos observados ("esqueceu de incluir a tarefa", "vou perguntar...")
  /(o\s+usu[aá]rio\s+|voc[êe]\s+)?esqueceu\s+de\s+incluir\s+(a\s+|uma\s+)?(tarefa|instru[cç][aã]o|solicita[cç][aã]o)/i,
  /esqueceu[^\n]{0,40}tarefa/i,
  /a\s+(última\s+)?mensagem\s+(est[áa]|esta)\s+vazia/i,
  /(preciso|precisamos|vou|devo|tenho)\s+saber\s+o\s+que\s+(o\s+usu[aá]rio|voc[êe])\s+(quer|deseja|gostaria)/i,
  /vou\s+perguntar/i,
  /perguntar\s+(diretamente\s+)?(ao\s+usu[aá]rio|a\s+voc[êe])/i,
  /qual\s+(é\s+|ser[áa]\s+)?a\s+(tarefa|altera[cç][aã]o|funcionalidade|mudan[cç]a)\s+(desejada|solicitada|pedida)/i,
  /tarefa\s+(desejada|solicitada|pedida|requerida)/i,
  /ex:\s*(adicionar|corrigir|melhorar|remover|implementar|nov[aã]\s+funcionalidade)/i,
  /preciso\s+que\s+voc[êe]\s+me\s+(diga|informe|d[êe])/i,
  /me\s+diga\s+(qual|o\s+que|a\s+tarefa|o\s+objetivo)/i,
  /(sem\s+instru[cç][oõ]es|sem\s+tarefa|sem\s+uma\s+tarefa)\s+(clara|definida|espec[ií]fica|v[aã]lida)/i,
  /(n[ãa]o|sem)\s+recebi\s+(a\s+|nenhuma\s+)?(tarefa|instru[cç][aã]o|solicita[cç][aã]o|pedido)/i,
];

/** Sinal de que o texto menciona a TAREFA/decisão (para a regra estrutural). */
const TASK_SIGNAL_RE =
  /(tarefa|instru[cç][aã]o|solicita[cç][aã]o|altera[cç][aã]o|funcionalidade|mudan[cç]a|pedido|requisi[cç][aã]o|o\s+que\s+(eu|voc[êe])\s+devo)/i;

/** Sinal de que o texto pergunta/PASSA A RESPONSABILIDADE ao usuário. */
const DODGE_SIGNAL_RE =
  /(pergunt|me\s+diga|informe-?me|qual|o\s+que\s+(voc[êe]|o\s+usu[aá]rio)\s+(quer|deseja|gostaria)|quer\s+que\s+(eu|lhe|eu\s+lhe)|preciso\s+saber|vou\s+perguntar|ag[uú]ardando|aguardo\s+(a|suas|novas))/i;

/**
 * Detecta respostas que DEVOLVEM a tarefa ao usuário em vez de executar
 * ("aguardando instrução", "qual alteração você deseja", "o usuário esqueceu
 * de incluir a tarefa... vou perguntar qual é a tarefa desejada"). Retorna
 * true também para texto vazio. O modelo sempre reparafraseia, por isso a
 * regra estrutural (menciona tarefa E pergunta/passa a bola) complementa os
 * padrões literais.
 */
export function isTaskRefusal(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length === 0) return true;
  if (TASK_REFUSAL_PATTERNS.some((re) => re.test(text))) return true;
  const sample = t.slice(0, 1200);
  return TASK_SIGNAL_RE.test(sample) && DODGE_SIGNAL_RE.test(sample);
}

/**
 * Detecta finalização precoce: toolCalls == 0 E texto ausente, curto ou
 * genérico (ex.: "Aqui está o resumo...", "Aguardando instrução/tarefa",
 * "qual alteração você deseja", "esqueceu de incluir a tarefa" — sem executar).
 */
export function isLazyCompletion(
  content: string | null | undefined,
  toolCalls: Array<{ name?: string }> | undefined
): boolean {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return false;
  const text = (content ?? '').trim();
  if (!text) return true;
  if (text.length < 30) return true;
  return isTaskRefusal(text);
}

/* ---------------------------------------------------------------------------
 * CIRCUIT BREAKER ANTI-LOOP DE TOOL CALLS
 * ---------------------------------------------------------------------------
 * Se a MESMA tool call se repete por turnos seguidos no mesmo ciclo (erro
 * retornado pela IDE sendo realimentado e o modelo insistindo na chamada), o
 * retry oculto ANTI-LAZY apenas amplifica o loop. Este breaker conta
 * ocorrências CONSECUTIVAS de uma determinada assinatura de tool call e, ao
 * atingir o limite, suprime o retry oculto — a resposta é entregue ao usuário
 * para interromper o ciclo.
 */

/** Limite de repetições consecutivas antes de abrir o circuito. */
export const TOOL_LOOP_BREAKER_LIMIT = 3;

let lastToolSig: string | null = null;
const toolLoopCounts = new Map<string, number>();

/**
 * Registra a emissão de uma assinatura de tool call. Repetições consecutivas
 * da MESMA assinatura incrementam; mudar de ferramenta reinicia o contador
 * (requisito: "3 turnos seguidos no mesmo ciclo").
 */
export function noteToolLoopEvent(signature: string): number {
  if (lastToolSig !== signature) toolLoopCounts.clear();
  lastToolSig = signature;
  const count = (toolLoopCounts.get(signature) ?? 0) + 1;
  toolLoopCounts.set(signature, count);
  return count;
}

/** True quando uma assinatura alcançou o limite do breaker. */
export function isToolLoopTripped(signature: string): boolean {
  return (toolLoopCounts.get(signature) ?? 0) >= TOOL_LOOP_BREAKER_LIMIT;
}

/** Zera o estado do breaker (usado em testes para isolar estado global). */
export function resetToolLoopBreaker(): void {
  toolLoopCounts.clear();
  lastToolSig = null;
}