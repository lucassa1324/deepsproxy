/*
 * File: validation-guard.ts
 * Project: deepsproxy
 * Validações de guarda para prevenir loops de edição nula, diagnóstico cego
 * e re-prompts infinitos sem evolução.
 */

import type { OpenAIRequest, MessageToolCall } from '../utils/types.ts';

/** Tipos de ferramentas de edição/escrita que podem causar loops nulos */
const EDIT_TOOL_NAMES = new Set([
  'edit_file',
  'write_file',
  'apply_patch',
  'str_replace_editor',
  'edit',
  'write',
]);

/** Tipos de ferramentas de leitura/busca que devem ser incentivadas */
const READ_TOOL_NAMES = new Set([
  'read_file',
  'glob',
  'grep',
  'list_dir',
  'run_command',
  'bash',
  'terminal',
]);

/** Tipos de ferramentas de diagnóstico */
const DIAGNOSTIC_TOOL_NAMES = new Set([
  'run_command',
  'bash',
  'terminal',
  'exec',
]);

/** Contador de tentativas por request (armazenado no contexto) */
const ANTI_LAZY_ATTEMPTS_KEY = '__anti_lazy_attempts__';
const ANTI_LAZY_LAST_HASH_KEY = '__anti_lazy_last_hash__';

/**
 * Verifica se uma tool_call é de edição/escrita
 */
export function isEditTool(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name.toLowerCase());
}

/**
 * Verifica se uma tool_call é de leitura/busca
 */
export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.has(name.toLowerCase());
}

/**
 * Verifica se uma tool_call é de diagnóstico/terminal
 */
export function isDiagnosticTool(name: string): boolean {
  return DIAGNOSTIC_TOOL_NAMES.has(name.toLowerCase());
}

/**
 * Extrai o conteúdo original e novo de uma tool_call de edição
 * Retorna { original: string, newContent: string } ou null se não aplicável
 */
export function extractEditDiff(args: Record<string, unknown>): 
  { original: string; newContent: string } | null {
  // Padrões comuns de argumentos para ferramentas de edição
  const oldStr = typeof args.old_str === 'string' ? args.old_str :
    typeof args.oldStr === 'string' ? args.oldStr :
    typeof args.original === 'string' ? args.original : null;
  
  const newStr = typeof args.new_str === 'string' ? args.new_str :
    typeof args.newStr === 'string' ? args.newStr :
    typeof args.content === 'string' ? args.content :
    typeof args.replacement === 'string' ? args.replacement : null;

  if (oldStr !== null && newStr !== null) {
    return { original: oldStr, newContent: newStr };
  }
  return null;
}

/**
 * Verifica se um diff é nulo (+0 -0): conteúdo idêntico ou apenas whitespace/comentários
 */
export function isNullDiff(original: string, newContent: string): boolean {
  if (original === newContent) return true;
  
  // Normaliza: remove whitespace, comentários single-line, multi-line
  const normalize = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')  // comentários /* */
    .replace(/\/\/.*$/gm, '')           // comentários //
    .replace(/#.*$/gm, '')              // comentários #
    .replace(/\s+/g, '')                // whitespace
    .trim();
  
  return normalize(original) === normalize(newContent);
}

/**
 * Verifica se o prompt do usuário indica erro técnico (build, sintaxe, compilação)
 */
export function needsDiagnosticDirective(userPrompt: string): boolean {
  const diagnosticKeywords = [
    'erro de sintaxe', 'syntax error', 'build', 'compilação', 'compilation',
    'quebrou', 'broken', 'linter', 'tsc', 'npm run build', 'typescript',
    'type error', 'erro de tipo', 'não compila', 'does not compile',
    'falha no build', 'build failed', 'erro de compilação',
  ];
  
  const lower = userPrompt.toLowerCase();
  return diagnosticKeywords.some(k => lower.includes(k));
}

/**
 * Padrões de respostas passivas/desistência que a IA emite quando não sabe o caminho
 * Só são considerados passivos se a IA NÃO chamou nenhuma ferramenta (tool_calls === 0)
 */
const PASSIVE_PATTERNS = [
  /qual\s+o\s+caminho/i,
  /onde\s+(est[aá]|fica)\s+o\s+arquivo/i,
  /n[ãa]o\s+encontrei\s+o\s+arquivo/i,
  /me\s+d[êe]\s+o\s+(caminho|path)/i,
  /onde\s+fica/i,
  /como\s+(prossigo|faço|prosseguir)/i,
  /n[ãa]o\s+sei\s+onde/i,
  /caminho\s+n[ãa]o\s+encontrado/i,
  /arquivo\s+n[ãa]o\s+encontrado/i,
  /path\s+not\s+found/i,
  /file\s+not\s+found/i,
  /informe\s+o\s+caminho/i,
  /fornecer\s+o\s+caminho/i,
  /caminho\s+exato/i,
  /poderia\s+me\s+informar/i,
  /caminho\s+(exato|correto)/i,
  /trecho\s+do\s+c[oó]digo/i,
  /qual\s+['eé]\s+o\s+(caminho|path)/i,
  /n[ãa]o\s+encontrei/i,
  /poderia\s+(por\s+favor\s+)?(informar|fornecer|enviar)/i,
  /protocolo\s+de\s+parada/i,
  /loop.?breaker/i,
  /n[ãa]o\s+foi\s+poss[ií]vel\s+(localizar|encontrar|ler)/i,
  /me\s+passe\s+o\s+(caminho|arquivo|c[oó]digo)/i,
];

/**
 * Verifica se a resposta da IA é passiva (desistência sem tentar ferramentas)
 * Regra de segurança: só bloqueia se tool_calls.length === 0
 */
export function isPassiveResponse(content: string, toolCalls: MessageToolCall[] | undefined): boolean {
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (hasToolCalls) return false; // Se usou ferramenta, não é passivo
  
  const lower = content.toLowerCase().trim();
  if (lower.length === 0) return false;
  
  return PASSIVE_PATTERNS.some(p => p.test(lower));
}

/**
 * Obtém o último prompt do usuário da requisição
 */
export function getLastUserPrompt(body: OpenAIRequest): string {
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user') {
      return typeof msg.content === 'string' ? msg.content :
        Array.isArray(msg.content) 
          ? msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('')
          : '';
    }
  }
  return '';
}

/**
 * Conta tentativas de anti-lazy no contexto do request
 */
export function getAntiLazyAttempts(body: OpenAIRequest): number {
  return (body as any)[ANTI_LAZY_ATTEMPTS_KEY] || 0;
}

/**
 * Obtém o hash do último payload de tool_calls para detecção de repetição exata
 */
export function getLastToolCallHash(body: OpenAIRequest): string | null {
  return (body as any)[ANTI_LAZY_LAST_HASH_KEY] || null;
}

/**
 * Define o hash do último payload de tool_calls
 */
export function setLastToolCallHash(body: OpenAIRequest, hash: string): void {
  (body as any)[ANTI_LAZY_LAST_HASH_KEY] = hash;
}

/**
 * Gera hash simples do payload de tool_calls (nome + args)
 */
export function hashToolCallPayload(toolCalls: MessageToolCall[] | undefined): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return 'no-tools';
  
  // Ordena para normalizar
  const normalized = toolCalls
    .map(tc => ({
      name: tc.function?.name || '',
      args: tc.function?.arguments || {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  
  return JSON.stringify(normalized);
}

/**
 * Verifica se o payload atual é repetição exata do anterior
 * Retorna true se for repetição (deve contar como tentativa), false se for novo (reset)
 */
export function checkAndUpdatePayloadHash(body: OpenAIRequest, toolCalls: MessageToolCall[] | undefined): boolean {
  const currentHash = hashToolCallPayload(toolCalls);
  const lastHash = getLastToolCallHash(body);
  
  const isExactRepeat = lastHash === currentHash && currentHash !== 'no-tools';
  
  // Atualiza o hash atual
  setLastToolCallHash(body, currentHash);
  
  return isExactRepeat;
}

/**
 * Incrementa tentativas de anti-lazy (ou reseta se payload mudou)
 * @param toolCalls - tool_calls atuais para detectar repetição exata
 * @returns novo número de tentativas
 */
export function incrementAntiLazyAttempts(body: OpenAIRequest, toolCalls?: MessageToolCall[]): number {
  const current = getAntiLazyAttempts(body);
  
  // Se toolCalls fornecidos, verifica repetição exata
  if (toolCalls && toolCalls.length > 0) {
    const isExactRepeat = checkAndUpdatePayloadHash(body, toolCalls);
    
    if (isExactRepeat) {
      // Repetição exata: incrementa
      (body as any)[ANTI_LAZY_ATTEMPTS_KEY] = current + 1;
      return current + 1;
    } else {
      // Payload novo (exploratório): reseta contador
      (body as any)[ANTI_LAZY_ATTEMPTS_KEY] = 1;
      return 1;
    }
  }
  
  // Sem toolCalls (resposta sem ferramentas): incrementa normal
  (body as any)[ANTI_LAZY_ATTEMPTS_KEY] = current + 1;
  return current + 1;
}

/**
 * Verifica se atingiu o limite máximo de tentativas (2)
 */
export function hasExceededMaxAttempts(body: OpenAIRequest): boolean {
  return getAntiLazyAttempts(body) >= 2;
}

/**
 * Gera mensagem de rejeição para edição nula
 */
export function buildNullEditRejection(editDetails: string): string {
  return `[REJEIÇÃO AUTOMÁTICA DO PROXY — EDIÇÃO NULA]: ${editDetails}

INSTRUÇÃO OBRIGATÓRIA:
1. NÃO faça edições de comentários, espaços em branco, formatação ou JSDoc.
2. Se não souber a alteração EXATA no código, USE uma ferramenta de busca (Grep/Read) ou execute o compilador no terminal.
3. A próxima tentativa DEVE conter uma alteração de lógica real (+N -M linhas onde N+M > 0).`;
}

/**
 * Gera mensagem de rejeição genérica (anti-lazy padrão)
 */
export function buildGenericRejection(attempt: number): string {
  const isSecondAttempt = attempt >= 2;
  
  if (isSecondAttempt) {
    return `[REJEIÇÃO AUTOMÁTICA DO PROXY — LIMITE ATINGIDO]: Duas tentativas consecutivas falharam em produzir alteração efetiva.

O loop automático será ENCERRADO. A resposta será devolvida ao usuário com aviso.

RECOMENDAÇÃO AO USUÁRIO:
- Rode 'npm run build' ou 'tsc' manualmente no terminal para ver o erro real.
- Forneça o log do compilador/linter no próximo prompt.
- Especifique o arquivo e a linha exata do problema.`;
  }
  
  return `[REJEIÇÃO AUTOMÁTICA DO PROXY — RESPOSTA SUPERFICIAL]: Sua resposta não contém alteração de lógica real (sem tool_calls, sem reasoning, conteúdo curto ou apenas cosmética).

RE-INSTRUÇÃO OBRIGATÓRIA (Tentativa ${attempt}/2):
1. Reanalise o problema geométrico/lógico original no histórico.
2. Escreva um bloco <thinking> explicando: (a) bug exato e fórmula, (b) arquivos afetados, (c) por que resolve a causa raiz.
3. Forneça a alteração REAL — use tool_calls para editar arquivos.
4. Trate casos de borda: zerados, negativos, nulos, arrays vazios.`;
}

/**
 * Gera diretiva de diagnóstico obrigatória
 */
export function buildDiagnosticDirective(): string {
  return `[DIRETIVA DE DIAGNÓSTICO OBRIGATÓRIA]: É terminantemente proibido tentar adivinhar a linha do erro de sintaxe. Você DEVE rodar a ferramenta de terminal (run_command) com 'npm run build' ou 'tsc' para ler o log oficial do compilador ANTES de propor qualquer modificação em arquivos.`;
}

/**
 * Valida tool_calls de edição em busca de diffs nulos
 * Retorna array de detalhes de edições nulas encontradas
 */
export function validateEditToolCalls(toolCalls: MessageToolCall[] | undefined): string[] {
  if (!Array.isArray(toolCalls)) return [];
  
  const nullEdits: string[] = [];
  
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (!name || !isEditTool(name)) continue;
    
    let args: Record<string, unknown> = {};
    try {
      args = typeof tc.function.arguments === 'string' 
        ? JSON.parse(tc.function.arguments) 
        : (tc.function.arguments as Record<string, unknown> || {});
    } catch {
      continue;
    }
    
    const diff = extractEditDiff(args);
    if (diff && isNullDiff(diff.original, diff.newContent)) {
      const path = typeof args.path === 'string' ? args.path : 
        typeof args.file === 'string' ? args.file : 'arquivo desconhecido';
      nullEdits.push(`${name} em "${path}": diff nulo (+0 -0)`);
    }
  }
  
  return nullEdits;
}

/**
 * Verifica se a resposta tem tool_calls de leitura/diagnóstico (bom sinal)
 */
export function hasReadOrDiagnosticToolCalls(toolCalls: MessageToolCall[] | undefined): boolean {
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.some(tc => 
    isReadTool(tc.function?.name || '') || isDiagnosticTool(tc.function?.name || '')
  );
}

/**
 * Pipeline completo de validação pós-resposta
 * Apenas executa validações se flags explícitas estiverem presentes:
 * - enableNullDiffValidation: valida edições nulas (+0 -0)
 * - enableAntiLazyLoop: valida respostas preguiçosas
 * Retorna { isValid: boolean, rejectionMessage?: string, shouldAbort: boolean }
 */
export function validateResponse(
  c: any, // Context do Hono (evita import circular)
  res: Response,
  body: OpenAIRequest,
  _target: any
): Promise<{ isValid: boolean; rejectionMessage?: string; shouldAbort: boolean; modifiedBody?: OpenAIRequest }> {
  return (async () => {
    // Opt-in only: só executa validações se flags explícitas estiverem presentes
    const enableNullDiff = (body as any).enableNullDiffValidation === true;
    const enableAntiLazy = (body as any).enableAntiLazyLoop === true;
    
    if (!enableNullDiff && !enableAntiLazy) {
      return { isValid: true, shouldAbort: false };
    }
    
    if (res.status !== 200) return { isValid: true, shouldAbort: false };
    
    let json: any;
    try {
      json = await res.clone().json();
    } catch {
      return { isValid: true, shouldAbort: false };
    }
    
    const choice = json.choices?.[0];
    const message = choice?.message;
    if (!message) return { isValid: true, shouldAbort: false };
    
    const toolCalls = message.tool_calls;
    const reasoning = message.reasoning_content;
    const content = typeof message.content === 'string' ? message.content : '';
    
    // 1. Validação de edição nula (+0 -0) — apenas se flag habilitada
    if (enableNullDiff) {
      const nullEdits = validateEditToolCalls(toolCalls);
      if (nullEdits.length > 0) {
        const rejection = buildNullEditRejection(nullEdits.join('; '));
        const modifiedBody = {
          ...body,
          messages: [...body.messages, { role: 'system' as const, content: rejection }],
        };
        return { 
          isValid: false, 
          rejectionMessage: rejection,
          shouldAbort: false,
          modifiedBody,
        };
      }
    }
    
    // 1.5. Anti-Resposta Passiva: detecta "qual o caminho?", "não encontrei", etc.
    // Só bloqueia se tool_calls === 0 (regra de segurança: se usou ferramenta, não bloqueia)
    if (enableAntiLazy) {
      if (isPassiveResponse(content, toolCalls)) {
        const rejection = `[REJEIÇÃO AUTOMÁTICA DO PROXY — RESPOSTA PASSIVA]: A IA desistiu sem tentar ferramentas.

RE-INSTRUÇÃO OBRIGATÓRIA:
1. NÃO responda "qual o caminho", "onde está o arquivo", "não encontrei".
2. Use IMEDIATAMENTE glob/grep/read_file/list_dir para LOCALIZAR o arquivo.
3. Se o usuário pedir "altere X", use glob/grep para ACHAR "X" e LEIA antes de alterar.`;
        const modifiedBody = {
          ...body,
          messages: [...body.messages, { role: 'system' as const, content: rejection }],
        };
        return { 
          isValid: false, 
          rejectionMessage: rejection,
          shouldAbort: false,
          modifiedBody,
        };
      }
    }
    
    // 2. Anti-lazy: resposta superficial sem tool_calls — apenas se flag habilitada
    if (enableAntiLazy) {
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
      const hasReasoning = typeof reasoning === 'string' && reasoning.length > 100;
      const isShort = content.trim().length < 200;
      const onlyCommentsOrFormatting = /^(\s*\/\/.*|\s*\/\*.*\*\/|\s*#.*|\s*)+$/.test(content.trim());
      const isLazy = !hasToolCalls && !hasReasoning && (isShort || onlyCommentsOrFormatting);
      
      if (isLazy) {
        const attempts = getAntiLazyAttempts(body);
        incrementAntiLazyAttempts(body, toolCalls);
        
        if (attempts >= 1) { // Já tentou uma vez, agora é a segunda
          // Segunda tentativa falhou: aborta
          const finalRejection = buildGenericRejection(attempts + 1);
          const modifiedBody = {
            ...body,
            messages: [...body.messages, { role: 'system' as const, content: finalRejection }],
          };
          return {
            isValid: false,
            rejectionMessage: finalRejection,
            shouldAbort: true, // Para o loop
            modifiedBody,
          };
        }
        
        // Primeira tentativa: re-prompt normal
        const rejection = buildGenericRejection(attempts + 1);
        const modifiedBody = {
          ...body,
          messages: [...body.messages, { role: 'system' as const, content: rejection }],
        };
        return {
          isValid: false,
          rejectionMessage: rejection,
          shouldAbort: false,
          modifiedBody,
        };
      }
    }
    
    // 3. Resposta válida: reseta contador e hash de payload
    (body as any)[ANTI_LAZY_ATTEMPTS_KEY] = 0;
    (body as any)[ANTI_LAZY_LAST_HASH_KEY] = null;
    return { isValid: true, shouldAbort: false };
  })();
}

/**
 * Injeta diretiva de diagnóstico no system prompt se necessário
 * Apenas executa se body.enableDiagnosticDirective === true
 */
export function maybeInjectDiagnosticDirective(body: OpenAIRequest): OpenAIRequest {
  // Opt-in only: só executa se flag explícita estiver presente
  if ((body as any).enableDiagnosticDirective !== true) return body;
  
  const userPrompt = getLastUserPrompt(body);
  if (!needsDiagnosticDirective(userPrompt)) return body;
  
  // Verifica se já tem a diretiva
  const hasDirective = body.messages.some(m => 
    m.role === 'system' && 
    typeof m.content === 'string' && 
    m.content.includes('DIRETIVA DE DIAGNÓSTICO OBRIGATÓRIA')
  );
  
  if (hasDirective) return body;
  
  const directive = buildDiagnosticDirective();
  const systemIdx = body.messages.findIndex(m => m.role === 'system');
  
  if (systemIdx >= 0) {
    // Pré-pende à system message existente
    const sysMsg = body.messages[systemIdx];
    const prefix = typeof sysMsg.content === 'string' ? sysMsg.content : '';
    return {
      ...body,
      messages: body.messages.map((m, i) => i === systemIdx 
        ? { ...m, content: directive + '\n\n' + prefix }
        : m
      ),
    };
  } else {
    // Insere nova system message no início
    return {
      ...body,
      messages: [{ role: 'system' as const, content: directive }, ...body.messages],
    };
  }
}