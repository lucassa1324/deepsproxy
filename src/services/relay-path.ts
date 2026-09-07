/*
 * File: relay-path.ts
 * Project: deepsproxy
 * Camada de saída (Relay de Tool Calls) — sanitização de caminhos SEM I/O local.
 *
 * O Gateway HTTP Puro NÃO lê/edita/deleta arquivos (sem fs.promises). Este
 * módulo apenas transforma os argumentos de caminho das Tool Calls antes de
 * entregá-las à IDE no payload HTTP/SSE:
 *
 *   1. extrai a raiz do workspace por ordem de preferência:
 *        a) aviso padrão da IDE "current working directory is <PATH>" (prioridade
 *           MÁXIMA — capture até o fim da linha, suportando nomes com espaços
 *           como "Lucas sá");
 *        b) marcação <workspace>PATH</workspace> no System Prompt;
 *        c) chave 'workspacePath: PATH' (ou workspacePath = "PATH");
 *        d) caminho absoluto (C:\..., UNC, /home/..., /Users/...) em system
 *           prompts/reminders — com suporte a espaços no nome de usuário;
 *        e) cache da última raiz resolvida.
 *      O candidato automático que NÃO representa um diretório completo de
 *      projeto (ex.: somente "C:\Users\Lucas") é REJEITADO em favor do próximo
 *      fallback válido.
 *   2. purga prefixos relativos SEMPRE ANTES de qualquer regex/resolução — o
 *      valor bruto ainda carrega as barras cruas ('./', '.\', '.\Src', '/','\');
 *      em seguida converte TODAS as '\' em '/' e remove tags XML/HTML acidentais
 *      ('<\toolcall_error_message>') — '\tests_stress' NUNCA vira 'ests_stress';
 *   3. caminho JÁ absoluto (C:\..., c:\..., \\server\...) NÃO é re-concatenado
 *      com o workspaceRoot: só é limpo (tags/ruído) e normalizado via win32;
 *   4. se a raiz for Windows (letra de unidade ou UNC), converte TODOS os
 *      caminhos relativos em absolutos completos via path.win32.resolve()
 *      (ex.: 'teste_final.txt' → 'C:\Users\Lucas\projeto\teste_final.txt');
 *   5. argumentos com múltiplos arquivos separados por vírgula (ex.:
 *      "file1.ts,file2.ts" em DeleteFile/Read) são divididos, sanitizados
 *      individualmente e reconstruídos (cada item absoluto; strings absolutas
 *      Windows não contêm vírgula, então a lista continua inequívoca).
 *
 * Tudo é manipulação de string pura (módulo 'path'), sem tocar no disco.
 */

import { posix as pathPosix, win32 as pathWin32 } from 'path';
import type { Context } from 'hono';
import type { OpenAIRequest } from '../utils/types.ts';
import { protectPathEscapesInJson } from '../utils/robust-json.ts';

/** Chaves de argumento de Tool Call que representam um arquivo único (podem
 *  vir também como lista separada por vírgulas). 'directory' é só diretório. */
const FILE_PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'target_file', 'absolute_path']);

/** Auxiliares (LINUX/Windows) presente no set de path keys com semântica de lista. */
const PATH_ARG_KEYS = new Set([...FILE_PATH_KEYS, 'directory']);

/**
 * Ferramentas de TERMINAL: TODAS as barras invertidas dos argumentos viram '/',
 * principalmente 'src\tests_stress' → 'src/tests_stress' dentro de comandos
 * rmdir/mkdir/del enviados ao CMD/PowerShell. Um '\' literal no payload NÃO
 * pode ser reinterpretado depois como Tabulação ('\t' comeria a letra 't'); o
 * CMD/PowerShell aceita '/' normalmente em caminhos, então a conversão é segura
 * e impede permanentemente o caminho corrompido 'ests_stress'.
 */
const TERMINAL_TOOL_NAMES = new Set([
  'runcommand',
  'checkcommandstatus',
  'run_terminal_command',
  'runcommandstatus',
  'terminal_command',
  'exec_command',
  'shell_command',
]);

function isTerminalTool(name: string | undefined): boolean {
  return !!name && TERMINAL_TOOL_NAMES.has(String(name).trim().toLowerCase());
}

/**
 * Converte recursivamente TODAS as barras invertidas de valores STRING em '/',
 * preservando a estrutura (objetos/arrays passam intactos na forma).
 */
function forwardSlashLeaves(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\\/g, '/');
  if (Array.isArray(value)) return value.map(forwardSlashLeaves);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = forwardSlashLeaves(v);
    return out;
  }
  return value;
}

/**
 * Prepara um texto JSON de TERMINAL para o parse: dobra a barra final de runs
 * ÍMPARES de '\' ('\t'→'\\t', '\s'→'\\s') exceto antes de '"' ou '\' (escapes
 * JSON válidos e intencionais). Assim o JSON.parse devolve barras LITERAIS em
 * vez de Tabulação ('src\tests_stress' NUNCA 'src<TAB>ests_stress') e nunca
 * quebra com "Bad escaped character".
 */
function protectTerminalJsonEscapes(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    let run = 1;
    while (i + run < text.length && text[i + run] === '\\') run++;
    const next = text[i + run] ?? '';
    if (run % 2 === 1 && next !== '' && !/["\\]/.test(next)) {
      out += '\\'.repeat(run + 1);
    } else {
      out += '\\'.repeat(run);
    }
    i += run;
  }
  return out;
}

/**
 * Sanitizador de TERMINAL: converte TODAS as '\' em '/' nos valores dos
 * argumentos. Strings JSON são protegidas ANTES do parse (nunca Tabulação),
 * transformadas e re-serializadas; textos crus não-JSON ganham '/' direto.
 */
function sanitizeTerminalArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(protectTerminalJsonEscapes(args));
      if (typeof parsed === 'string') return parsed.replace(/\\/g, '/');
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(forwardSlashLeaves(parsed));
      }
      return args.replace(/\\/g, '/');
    } catch {
      // Não é JSON estruturado: comando cru — barras invertidas direto para '/'.
      return args.replace(/\\/g, '/');
    }
  }
  return forwardSlashLeaves(args);
}

/* ---------------------------------------------------------------------------
 * Relay de Tool MCP (run_mcp)
 * ---------------------------------------------------------------------------
 * O modelo às vezes emite `run_mcp` SEM o campo `server_name`, e o cliente MCP
 * da IDE rejeita a chamada com "missing field server_name". O relay injeta um
 * nome válido:
 *   1. prioriza o nome anunciado no schema das tools da requisição
 *      (enum/const/default de `server_name` — ex.: "filesystem");
 *   2. senão, usa o padrão (configurável via MCP_DEFAULT_SERVER_NAME).
 * O payload MCP é pass-through: nenhum outro argumento é tocado (o servidor MCP
 * faz a própria resolução de caminhos dentro dos diretórios permitidos).
 */

/** Nome padrão do servidor MCP injetado quando o modelo omite `server_name`. */
export const DEFAULT_MCP_SERVER_NAME = (process.env.MCP_DEFAULT_SERVER_NAME || 'filesystem').trim();

/** Tool que encaminha chamadas para um servidor MCP externo. */
function isMcpToolCall(name: string | undefined): boolean {
  return !!name && String(name).trim().toLowerCase() === 'run_mcp';
}

/** Escolhe o servidor a injetar: o padrão se anunciado, senão o 1º do schema. */
function pickMcpServerName(mcpServers?: string[]): string {
  const servers = (mcpServers || []).map((s) => String(s).trim()).filter((s) => s.length > 0);
  if (servers.length === 0) return DEFAULT_MCP_SERVER_NAME;
  return servers.includes(DEFAULT_MCP_SERVER_NAME) ? DEFAULT_MCP_SERVER_NAME : servers[0];
}

/** Injeta `server_name` quando ausente/vazio em uma chamada `run_mcp`. */
function sanitizeMcpToolArguments(args: unknown, mcpServers?: string[]): unknown {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(protectPathEscapesInJson(args));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify(sanitizeMcpToolArguments(parsed, mcpServers));
      }
    } catch {
      // Não é JSON estruturado: repassa intacto.
    }
    return args;
  }

  if (typeof args === 'object' && !Array.isArray(args)) {
    const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    const server = out.server_name;
    if (server === undefined || server === null || String(server).trim() === '') {
      out.server_name = pickMcpServerName(mcpServers);
    }
    return out;
  }

  return args;
}

/** Marcação do bloqueio do filesystem MCP (resposta de tool real da IDE). */
export const MCP_ACCESS_DENIED_RE = /Access denied[^\r\n]*path outside allowed directories/i;

/** Marcador idempotência do fallback (evita direcionar o modelo 2x). */
export const MCP_FALLBACK_MARKER = '[PROXY MCP FALLBACK]';

/**
 * Diretiva anexada à resposta da tool MCP bloqueada: orienta o modelo a usar as
 * ferramentas NATIVAS de arquivo da IDE (Write/Read/Edit/SearchReplace/DeleteFile)
 * em vez de persistir no servidor MCP filesystem bloqueado.
 */
export const MCP_NATIVE_FS_FALLBACK_DIRECTIVE = `${MCP_FALLBACK_MARKER} O servidor MCP de arquivos (filesystem) foi bloqueado pela IDE: "Access denied - path outside allowed directories". ` +
  'PARE de chamar run_mcp/filesystem para este arquivo. ' +
  'Use as ferramentas NATIVAS da IDE — Write, Read, Edit, SearchReplace ou DeleteFile — sempre com caminhos relativos ao workspace.';

/**
 * Extrai os nomes de servidores MCP anunciados no schema da tool `run_mcp`
 * (enum/const/default de `server_name`). Usado para injetar um nome VÁLIDO e
 * conhecido quando o modelo omite o campo na chamada.
 */
export function extractMcpServerNamesFromTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const servers = new Set<string>();
  for (const t of tools) {
    const fn: any = t?.function ?? t;
    const toolName = fn?.name ?? t?.name ?? '';
    if (String(toolName).trim().toLowerCase() !== 'run_mcp') continue;
    const params = fn?.parameters ?? t?.parameters;
    const prop = params?.properties?.server_name ?? params?.properties?.serverName;
    if (prop && typeof prop === 'object') {
      for (const key of ['enum', 'const', 'default'] as const) {
        const value = prop[key];
        if (typeof value === 'string' && value.trim()) servers.add(value.trim());
        if (Array.isArray(value)) {
          for (const v of value) {
            if (typeof v === 'string' && v.trim()) servers.add(v.trim());
          }
        }
      }
    }
  }
  return [...servers];
}

/** Texto de uma mensagem (string ou array de partes OpenAI). */
function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p && typeof p === 'object' ? p.text ?? '' : String(p)))
      .filter(Boolean)
      .join('\n');
  }
  return content ? String(content) : '';
}

/**
 * Fallback TRANSPARENTE do filesystem MCP para as ferramentas nativas da IDE.
 * Quando uma resposta de tool (role `tool`/`function`) contém o bloqueio
 * "Access denied - path outside allowed directories", anexa à mensagem uma
 * diretiva orientando o modelo a usar Write/Read/Edit/SearchReplace/DeleteFile
 * em vez de continuar no MCP bloqueado. O erro original é preservado (a
 * diretiva é anexada, não substitui) e a operação é idempotente (marcador).
 */
export function applyMcpNativeFilesystemFallback(body: OpenAIRequest): OpenAIRequest {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;

  let changed = false;
  const next = messages.map((msg) => {
    if (!msg || (msg.role !== 'tool' && msg.role !== 'function')) return msg;
    const text = messageContentText(msg.content);
    if (!MCP_ACCESS_DENIED_RE.test(text) || text.includes(MCP_FALLBACK_MARKER)) return msg;
    changed = true;
    if (typeof msg.content === 'string') {
      return { ...msg, content: `${msg.content}\n\n${MCP_NATIVE_FS_FALLBACK_DIRECTIVE.trim()}` };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: [...msg.content, { type: 'text' as const, text: `\n\n${MCP_NATIVE_FS_FALLBACK_DIRECTIVE.trim()}` }],
      };
    }
    return msg;
  });

  if (!changed) return body;
  return { ...body, messages: next };
}

/** Headers HTTP candidatos a carregar a raiz do workspace. */
const WORKSPACE_ROOT_HEADERS = ['x-workspace-root', 'x-project-root', 'x-code-workspace-root'];

/** Aviso padrão da IDE (prioridade máxima): "current working directory is <PATH>". */
const CWD_NOTICE_RE = /current working directory is\s*[:=]?\s*([^\r\n]+)/gi;

/** Marcação explícita <workspace>...</workspace> no System Prompt da IDE. */
const WORKSPACE_TAG_RE = /<workspace>([\s\S]*?)<\/workspace>/g;

/** Chave 'workspacePath: PATH' (ou workspacePath = "PATH") no contexto. */
const WORKSPACE_PATH_KEY_RE = /workspacePath\s*[:=]\s*["'`]?\s*([^"'`\r\n<>]+)/g;

/** Caminho absoluto Windows 'C:\...' ou UNC '\\server\share\...' em reminders.
 *  Permite espaços (nomes de usuário como "Lucas sá"); para no início de
 *  aspas/colchetes/nova linha. */
const WINDOWS_ABS_PATH_RE =
  /(?:[A-Za-z]:[\\/][^"'`\r\n<>]+|\\\\[^\\\s"'`\r\n<>]+\\[^\s"'`\r\n<>]*)/g;

/** Caminho absoluto POSIX '/home/...', '/Users/...', '/var/...' (com espaços). */
const POSIX_ABS_PATH_RE = /\/(?:Users|home|root|var|opt|workspace|project|data|tmp|mnt)\/[^"'`\r\n<>]+/g;

let cachedWorkspaceRoot: string | null = null;

/**
 * PURGA DE PREFIXOS RELATIVOS — SEMPRE a PRIMEIRA ação de sanitização, quando o
 * valor ainda carrega as barras CRUAS (antes de qualquer regex/resolução).
 *   - remove '.\', './' e repetições ('././', '.\Src\...');
 *   - remove um '\' RAIZ único e acidental ('\src\file' → 'src\file') — o
 *     modelo às vezes prefixa o caminho com barra; '\\server\share' (UNC)
 *     e 'C:\...' permanecem intocados;
 *   - NUNCA remove o '/' inicial de caminho POSIX absoluto ('/Users/...').
 */
function stripRelativePrefix(p: string): string {
  let out = p.replace(/^(?:\.(?:[\\/]))+/, '');
  if (/^\\(?!\\)/.test(out) && !/^\\[A-Za-z]:/.test(out)) {
    // '\src\file' → 'src\file' (barra raiz única; '\\server' não entra aqui).
    out = out.slice(1);
  }
  return out;
}

/** Remove tags XML/HTML acidentais injetadas num caminho pelo modelo
 *  (ex.: '<\toolcall_error_message>' ou '<error>...</error>'). */
function stripXmlTags(p: string): string {
  return p.replace(/<[^>\r\n]*>/g, '');
}

/** Remove pontuação/ruído que pode acompanhar um caminho capturado numa linha. */
function trimTrailingPathNoise(p: string): string {
  return p.replace(/[\s.,;:)\]})]+$/, '');
}

/**
 * NORMALIZAÇÃO TOTAL DE BARRAS — roda DEPOIS da purga relativa e ANTES de
 * qualquer verificação de caminho absoluto / resolução:
 *   - converte TODAS as '\' em '/' (uma barra invertida real 'src\tests_stress'
 *     vira 'src/tests_stress' — nunca uma Tabulação que comeria a letra);
 *   - restaura control-chars residuais (Tab/CR/LF que um parseador decodificou
 *     de escapes misfired) como '/' separador;
 *   - remove tags XML/HTML acidentais;
 *   - remove aspas envelopantes e colapsa dobras de barra.
 */
function normalizePathValue(p: string): string {
  return p
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/\\/g, '/')
    .replace(/<[^>\r\n]*>/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '/')
    .replace(/\/{3,}/g, '//');
}

/** True para caminho já absoluto (POSIX, drive Windows ou UNC) — já com '/'. */
function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.startsWith('//')) return true;
  return false;
}

/**
 * Resolve um caminho JÁ LIMPO (normalizado '/' e SEM prefixo relativo) contra
 * a raiz do workspace. Caminhos JÁ absolutos nunca recebem o workspaceRoot:
 *   - Windows (drive/UNC) → win32.normalize (formato nativo com '\');
 *   - POSIX absoluto → repassado como está (ou posix.normalize).
 * Rotas relativas: win32.resolve ou posix.join conforme a raiz.
 */
function resolveAgainstRoot(p: string, root: string | null): string {
  if (!root) return p;

  if (isAbsolutePath(p)) {
    if (isWindowsRoot(root)) {
      // Não concatena root de novo: só reescreve no estilo Windows quando for
      // drive/UNC; caminho POSIX absoluto dentro de workspace Windows é
      // repassado como está.
      if (/^[A-Za-z]:/.test(p) || p.startsWith('//')) return pathWin32.normalize(p);
      return p;
    }
    return pathPosix.normalize(p);
  }

  if (isWindowsRoot(root)) {
    return pathWin32.resolve(root, p);
  }
  return pathPosix.normalize(pathPosix.join(root, p));
}

/**
 * Limpa e valida um candidato a RAÍZ do workspace, devolvendo-o em formato
 * POSIX ('/'). Retorna null se vazio/inválido.
 */
function cleanRootValue(raw: string): string | null {
  const p = raw.trim().replace(/^["'`]|["'`]$/g, '').replace(/[\u0000-\u001F\u007F]/g, '');
  const cleaned = trimTrailingPathNoise(p).trim();
  if (!cleaned) return null;
  const root = cleaned.replace(/\\/g, '/').replace(/\/+$/, '');
  return root || null;
}

/**
 * True quando o candidato NÃO é um diretório de projeto completo (rejeição):
 * raiz do filesystem, unidade sem diretório ou apenas o home do usuário
 * (ex.: 'C:\Users\Lucas', '/home/lucas', '/Users/lucas').
 */
function isIncompleteRoot(root: string | null): boolean {
  if (!root) return true;
  const r = String(root).replace(/\/+$/, '');
  if (!r || r === '/') return true;
  if (/^[A-Za-z]:$/.test(r)) return true; // unidade solta: 'C:'
  if (/^[A-Za-z]:\/[^/]+$/.test(r)) return true; // só um diretório na unidade
  if (/^[A-Za-z]:\/Users\/[^/]+$/i.test(r)) return true; // home win: C:\Users\<nome>
  if (/^\/Users\/[^/]+$/i.test(r)) return true; // home mac
  if (/^\/home\/[^/]+$/i.test(r)) return true; // home linux
  return false;
}

/** True quando a raiz (normalizada) é de workspace Windows (letra de unidade). */
function isWindowsRoot(root: string): boolean {
  return /^[A-Za-z]:\//.test(root) || root.startsWith('//');
}

/**
 * Pipeline RÍGIDO de sanitização de UM caminho — usado tanto por
 * `sanitizePathValue` (chave única 'directory'/'path') quanto por itens de
 * listas multi-arquivo (Read/DeleteFile/Write/SearchReplace):
 *   1. PURGA do prefixo relativo ('./', '.\', repetidos, '\' raiz) ANTES de
 *      qualquer regex/resolução — barras ainda cruas;
 *   2. NORMALIZAÇÃO TOTAL de barras: TODAS as '\' → '/' (nunca Tabulação que
 *      comeria a letra de '\tests_stress'), remoção de tags XML/HTML
 *      acidentais e restauração de control-chars residuais como '/';
 *   3. re-purga relativa (barra de segurança — cobre '.\' surgido no passo 2);
 *   4. resolução contra o workspaceRoot — caminho JÁ absoluto (C:\..., c:\...,
 *      \\server\...) nunca recebe o root de novo, só win32.normalize.
 */
function sanitizeSinglePath(raw: string, root: string | null): string {
  if (typeof raw !== 'string' || raw.trim() === '') return raw;
  const purged = stripRelativePrefix(raw);
  const normalized = normalizePathValue(purged);
  if (!normalized) return raw;
  return resolveAgainstRoot(stripRelativePrefix(normalized), root);
}

/**
 * Sanitiza UM argumento de caminho.
 *  - Sem raiz: ao menos limpa o prefixo relativo e ' \ '→' / ' e tags XML.
 *  - Raiz Windows: win32.resolve(root, rel) → absoluto completo com '\'.
 *  - Caminhos JÁ absolutos: nunca duplica o root; só win32.normalize.
 *  - Raiz POSIX: posix.join + normalize → absoluto com '/'.
 */
export function sanitizePathValue(value: unknown, root: string | null): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  return sanitizeSinglePath(value, root);
}

/**
 * Sanitiza um argumento de caminho que pode conter VÁRIOS arquivos separados
 * por vírgula (ex.: DeleteFile/Read: "file1.ts,file2.ts"). Divide, aplica o
 * MESMO pipeline rigoroso (sanitizeSinglePath) em cada item e reconstitui a
 * lista. Cada item é resolvido ABSOLUTO ANTES do join — a string passada ao
 * resolve nunca contém './'. Caminhos absolutos Windows não contêm vírgula,
 * então a estrutura reconstruída permanece inequívoca.
 */
function sanitizeMultiFilePath(value: unknown, root: string | null): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length <= 1) return sanitizeSinglePath(value, root);
  return parts
    .map((part) => sanitizeSinglePath(part, root))
    .join(',');
}

/**
 * Assinatura estável de uma Tool Call (nome + args normalizados) para rastrear
 * loops de repetição no circuit breaker anti-lazy.
 */
export function toolCallSignature(name: string | undefined, args: unknown): string {
  const toolName = String(name || '').trim().toLowerCase();
  return `${toolName}(${stableSerialize(args)})`;
}

/** Serializa args de forma determinística (chaves ordenadas) para a assinatura. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableSerialize(v)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return '{' + keys.map((k) => `${k}:${stableSerialize(record[k])}`).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Sanitiza os argumentos de uma Tool Call (objeto OU string JSON), reescrevendo
 * apenas as chaves de caminho. Nenhum outro argumento (content, query, etc.) é
 * tocado.
 *
 * ISOLAMENTO/TRATAMENTO: ferramentas de terminal (RunCommand, CheckCommandStatus
 * e afins) têm TODAS as barras invertidas convertidas em '/' nos valores
 * ('src\tests_stress' → 'src/tests_stress'; '\t' nunca vira Tabulação) —
 * o CMD/PowerShell aceita '/' em caminhos. Chamadas `run_mcp` (MCP) recebem
 * apenas a injeção de `server_name` quando ausente (`mcpServers` = nomes
 * anunciados no schema das tools da requisição). Read/Write/Edit/
 * SearchReplace/DeleteFile passam pelo pipeline rígido de sanitização.
 */
export function sanitizeToolCallArguments(
  name: string | undefined,
  args: unknown,
  root: string | null,
  mcpServers?: string[]
): unknown {
  if (args === null || args === undefined) return args;
  if (isMcpToolCall(name)) return sanitizeMcpToolArguments(args, mcpServers);
  if (isTerminalTool(name)) return sanitizeTerminalArgs(args);

  if (typeof args === 'string') {
    try {
      // Protege barras de caminho no JSON cru ANTES do parse: '\tests_stress'
      // não pode ser decodificado como Tab (o JSON.parse 'engoliria' o 't').
      const parsed = JSON.parse(protectPathEscapesInJson(args));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify(sanitizeToolCallArguments(name, parsed, root));
      }
    } catch {
      // Não é JSON estruturado: repassa intacto.
    }
    return args;
  }

  if (typeof args === 'object' && !Array.isArray(args)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(args as Record<string, unknown>)) {
      if (FILE_PATH_KEYS.has(key)) out[key] = sanitizeMultiFilePath(val, root);
      else if (key === 'directory') out[key] = sanitizePathValue(val, root);
      else out[key] = val;
    }
    return out;
  }

  return args;
}

/** Extrai os textos de body.messages (string ou array de partes OpenAI). */
function extractMessageTexts(messages: any): string[] {
  const texts: string[] = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const content = msg?.content;
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') texts.push(part);
        else if (part && typeof part === 'object' && typeof part.text === 'string') texts.push(part.text);
      }
    }
  }
  return texts;
}

/**
 * Extrai a raiz absoluta do workspace inspecionando as mensagens do corpo
 * (fallback para a IDE Trae, que NÃO envia o header 'x-workspace-root').
 *
 * Prioridade:
 *   1. "current working directory is <PATH>" (aviso padrão da IDE) — MÁXIMA;
 *   2. <workspace>PATH</workspace>;
 *   3. "workspacePath: PATH" / "workspacePath = PATH";
 *   4. caminho absoluto genérico em system prompts/reminders.
 * Candidatos detectados automaticamente (1 e 4) que sejam apenas o home do
 * usuário / raiz de unidade são REJEITADOS, seguindo para o próximo fallback.
 * Entre mensagens, a ÚLTIMA ocorrência de cada categoria vence (workspace
 * ativo mais recente da IDE).
 */
export function extractWorkspaceRootFromMessages(messages: any): string | null {
  const texts = extractMessageTexts(messages);
  if (texts.length === 0) return null;

  // 1) Avido padrão da IDE — prioridade máxima. Captura até o fim da linha
  //    (suporta nomes com espaços); incompletos ('C:\Users\Lucas') são rejeitados.
  let cwdMatch: string | null = null;
  for (const text of texts) {
    for (const m of text.matchAll(CWD_NOTICE_RE)) {
      const candidate = cleanRootValue(m[1]);
      if (candidate && !isIncompleteRoot(candidate)) cwdMatch = candidate;
    }
  }
  if (cwdMatch) return cwdMatch;

  // 2) Marcação explícita <workspace>PATH</workspace> (confiável).
  let tagMatch: string | null = null;
  for (const text of texts) {
    for (const m of text.matchAll(WORKSPACE_TAG_RE)) {
      const candidate = cleanRootValue(m[1]);
      if (candidate) tagMatch = candidate;
    }
  }
  if (tagMatch) return tagMatch;

  // 3) Chave explícita 'workspacePath: PATH'.
  let keyMatch: string | null = null;
  for (const text of texts) {
    for (const m of text.matchAll(WORKSPACE_PATH_KEY_RE)) {
      const candidate = cleanRootValue(m[1]);
      if (candidate) keyMatch = candidate;
    }
  }
  if (keyMatch) return keyMatch;

  // 4) Caminho absoluto anunciado em system prompts/reminders (com espaços),
  //    rejeitando candidatos incompletos.
  let absMatch: string | null = null;
  for (const text of texts) {
    for (const re of [WINDOWS_ABS_PATH_RE, POSIX_ABS_PATH_RE]) {
      for (const m of text.matchAll(re)) {
        const candidate = cleanRootValue(m[0]);
        if (candidate && !isIncompleteRoot(candidate)) absMatch = candidate;
      }
    }
  }
  return absMatch;
}

/** Zera o cache de raiz (usado pelos testes para isolar o estado global). */
export function clearWorkspaceRootCache(): void {
  cachedWorkspaceRoot = null;
}

/**
 * Resolve a raiz do workspace a partir do contexto HTTP:
 *   header 'x-workspace-root' → demais headers → body.workspacePath/rootPath →
 *   varredura das mensagens (fallback Trae) → cache da última raiz.
 * A última raiz resolvida é guardada em memória para servir de fallback em
 * requisições seguintes sem header.
 */
export function getWorkspaceRootFromContext(
  c: Context,
  body?: { workspacePath?: string; rootPath?: string; messages?: any[] } | any
): string | null {
  for (const header of WORKSPACE_ROOT_HEADERS) {
    const value = c?.req?.header(header);
    if (value && value.trim()) {
      const root = cleanRootValue(value);
      if (root) {
        cachedWorkspaceRoot = root;
        return root;
      }
    }
  }

  const bodyRoot = body?.workspacePath ?? body?.rootPath;
  if (bodyRoot && String(bodyRoot).trim()) {
    const root = cleanRootValue(String(bodyRoot));
    if (root) {
      cachedWorkspaceRoot = root;
      return root;
    }
  }

  const msgRoot = extractWorkspaceRootFromMessages(body?.messages);
  if (msgRoot) {
    cachedWorkspaceRoot = msgRoot;
    return msgRoot;
  }

  return cachedWorkspaceRoot;
}