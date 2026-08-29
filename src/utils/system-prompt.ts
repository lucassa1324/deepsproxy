/*
 * File: system-prompt.ts
 * Project: deepsproxy
 * HIGH-PRECISION AGENT PROTOCOL - System Prompt Injection
 *
 * This module injects the strict ReAct protocol to prevent infinite tool loops,
 * context pollution, and mechanical execution without strategic replanning.
 */

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
   - Se uma ferramenta retornar vazia, falhar ('Failed to list') ou não trouxer o código relevante após 3 tentativas, PARALISE a execução de ferramentas imediatamente.
   - Em vez de continuar buscando, responda diretamente ao usuário explicando o que você tentou e solicite o caminho exato do arquivo ou o trecho do código onde o bug ocorre.

4. FOCO EM SOLUÇÃO CIRÚRGICA:
   - Assim que o arquivo relevante for localizado, analise a lógica matemática/estrutural do problema antes de propor alterações.
   - Não reescreva arquivos inteiros. Forneça modificações pontuais e explicadas.
`;

/**
 * Injeta o HIGH-PRECISION AGENT PROTOCOL no system prompt.
 * Se já houver system prompt, adiciona no início (maior prioridade).
 */
export function injectHighPrecisionProtocol(systemPrompt: string): string {
  if (!systemPrompt || systemPrompt.trim() === '') {
    return HIGH_PRECISION_AGENT_PROTOCOL.trim();
  }
  // Evita duplicação se já injetado
  if (systemPrompt.includes('HIGH-PRECISION AGENT PROTOCOL')) {
    return systemPrompt;
  }
  return `${HIGH_PRECISION_AGENT_PROTOCOL.trim()}\n\n${systemPrompt.trim()}`;
}

/**
 * Injeta o protocolo nas mensagens do formato OpenAI.
 * Encontra o(s) system message(s) e injeta no primeiro.
 */
export function injectProtocolIntoMessages(messages: any[]): any[] {
  const result = [...messages];
  let systemIndex = result.findIndex(m => m.role === 'system');
  
  if (systemIndex === -1) {
    // Não há system message: cria um no início
    result.unshift({
      role: 'system',
      content: HIGH_PRECISION_AGENT_PROTOCOL.trim()
    });
  } else {
    // Injeta no system message existente
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
 * Verifica se o protocolo já foi injetado no prompt/mensagens.
 */
export function hasProtocol(systemPrompt: string): boolean {
  return systemPrompt.includes('HIGH-PRECISION AGENT PROTOCOL');
}