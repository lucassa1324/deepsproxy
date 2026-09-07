/*
 * File: system-prompt.ts
 * Project: deepsproxy
 * HIGH-PRECISION AGENT PROTOCOL + ANTI-LAZY DIRECTIVE - System Prompt Injection
 *
 * Cada requisição que atravessa o gateway recebe, no INÍCIO do system prompt:
 *   1. [SYSTEM DIRECTIVE - ANTI-LAZY & AGENTIC EXECUTION] (anti-preguiça);
 *   2. [SYSTEM DIRECTIVE: HIGH-PRECISION AGENT PROTOCOL] (protocolo cirúrgico).
 * Ambos são idempotentes por marcador.
 */

import {
  ANTI_LAZY_AGENTIC_DIRECTIVE,
  hasAntiLazyDirective,
} from '../middlewares/anti-lazy.ts';

export const HIGH_PRECISION_AGENT_PROTOCOL = `
[SYSTEM DIRECTIVE: HIGH-PRECISION AGENT PROTOCOL]

Você é um agente de desenvolvimento de software focado em alta precisão, eficiência e resolução cirúrgica de bugs. Para evitar execuções desnecessárias e degradação de contexto, você DEVE seguir rigorosamente o protocolo abaixo:

1. FASE DE PENSAMENTO (OBLIGATORY REASONING):
   - Antes de executar QUALQUER ferramenta (Tool Call), você deve emitir uma breve mensagem de texto (1-2 frases) explicando a hipótese do problema e por que aquela ferramenta específica é necessária.
   - É PROIBIDO executar ferramentas sem justificativa prévia em texto.

2. REGRAS DE BUSCA E NAVEGAÇÃO NO WORKSPACE:
   - É estritamente PROIBIDO fazer buscas genéricas (ex: '*', 'src/*', listas globais de diretórios).
   - Suas buscas devem usar termos específicos de funções, componentes, erros de console ou nomes de arquivos altamente prováveis.
   - Limite de chamadas: Você tem no máximo 3 (três) tentativas de busca por arquivos no workspace.

3. PROTOCOLO DE DESISTÊNCIA E PARADA (LOOP-BREAKER):
   - Se uma ferramenta retornar vazia, falhar ou não trouxer o código relevante após 3 tentativas, PARALISE a execução de ferramentas imediatamente.
   - Em vez de continuar buscando, responda diretamente ao usuário explicando o que você tentou e solicite o caminho exato do arquivo ou o trecho do código onde o bug ocorre.

4. FOCO EM SOLUÇÃO CIRÚRGICA:
   - Assim que o arquivo relevante for localizado, analise a lógica matemática/estrutural do problema antes de propor alterações.
   - Não reescreva arquivos inteiros. Forneça modificações pontuais e explicadas.

5. ISOLAMENTO DE ESCOPO (PROIBIDO BUILD/RUNTIME NO TERMINAL):
   - Durante tarefas PURAS de manipulação de arquivos ou testes de integridade de código, é PROIBIDO executar comandos de build/runtime no terminal (ex.: 'bun run build', 'npm run build', 'tsc', 'vite build', 'dev server') a menos que o usuário tenha EXPLICITAMENTE solicitado essa execução.
   - Faça as alterações cirúrgicas com Write/Edit/SearchReplace e ENCERRE a tarefa. Não dispare processos de compilação/execução que possam poluir o workspace ou degradar o contexto sem necessidade.
`;

/**
 * Bloco completo de diretivas do gateway: anti-preguiça + protocolo de alta
 * precisão. A ordem garante que a diretiva ANTI-LAZY fique NO INÍCIO.
 */
export function buildSystemDirectives(): string {
  return `${ANTI_LAZY_AGENTIC_DIRECTIVE.trim()}\n\n${HIGH_PRECISION_AGENT_PROTOCOL.trim()}`;
}

/**
 * Injeta as diretivas no system prompt (anti-preguiça primeiro, protocolo de
 * alta precisão depois, ambos idempotentes).
 */
export function injectHighPrecisionProtocol(systemPrompt: string): string {
  if (!systemPrompt || systemPrompt.trim() === '') {
    return buildSystemDirectives().trim();
  }
  if (hasAntiLazyDirective(systemPrompt)) {
    return systemPrompt;
  }
  return `${buildSystemDirectives()}\n\n${systemPrompt.trim()}`;
}

/**
 * Injeta as diretivas nas mensagens do formato OpenAI.
 * Encontra o(s) system message(s) e injeta no primeiro.
 */
export function injectProtocolIntoMessages(messages: any[]): any[] {
  const result = [...messages];
  let systemIndex = result.findIndex(m => m.role === 'system');

  if (systemIndex === -1) {
    result.unshift({
      role: 'system',
      content: buildSystemDirectives().trim()
    });
  } else {
    const sysMsg = { ...result[systemIndex] };
    const currentContent = Array.isArray(sysMsg.content)
      ? sysMsg.content.map((c: any) => c.type === 'text' ? c.text : '').join('\n')
      : String(sysMsg.content || '');
    sysMsg.content = injectHighPrecisionProtocol(currentContent);
    result[systemIndex] = sysMsg;
  }

  return result;
}

/**
 * Verifica se as diretivas já foram injetadas no prompt/mensagens.
 */
export function hasProtocol(systemPrompt: string): boolean {
  return hasAntiLazyDirective(systemPrompt);
}