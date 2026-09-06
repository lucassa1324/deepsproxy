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
 *   2. limpa prefixos relativos repetidos ('././arquivo.txt' → 'arquivo.txt')
 *      — NUNCA gera saída com prefixo relativo residual;
 *   3. manipula internamente com '/' e só emite '\' no final via path.win32 —
 *      escapes misfired como '\t' (Tab) ou '\n' (quebra de linha) NÃO viram
 *      espaços: são restaurados como separador '/' sem quebrar o caminho;
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

/** Chaves de argumento de Tool Call que representam um arquivo único (podem
 *  vir também como lista separada por vírgulas). 'directory' é só diretório. */
const FILE_PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'target_file', 'absolute_path']);

/** Auxiliares (LINUX/Windows) presente no set de path keys com semântica de lista. */
const PATH_ARG_KEYS = new Set([...FILE_PATH_KEYS, 'directory']);

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
 * Limpa prefixos relativos repetidos no início de um caminho (ex.: '.\' ou
 * './'). '.\' já foi normalizado para './'. NUNCA deixa resquícios como
 * '././arquivo.txt'. Respeita '../' (traversal legítimo).
 */
function stripRedundantRelativePrefix(p: string): string {
  return p.replace(/^(?:\.\/)+/, '');
}

/** Remove pontuação/ruído que pode acompanhar um caminho capturado numa linha. */
function trimTrailingPathNoise(p: string): string {
  return p.replace(/[\s.,;:)\]})]+$/, '');
}

/**
 * Normaliza o valor de um caminho para uso INTERNO (sempre '/', sem escapes):
 *   - remove aspas envelopantes;
 *   - caracteres de controle (Tab/CR/LF e demais \u0000-\u001F, \u007F) —
 *     resíduos de escapes misfired (ex.: '\t' de uma barra invertida real que
 *     a IDE/modelo decodificou) — são restaurados como '/' separador, para que
 *     um caminho como '\src\tests_stress' NUNCA vire ' ests_stress';
 *   - '\' → '/'; dobras de barra colapsadas.
 */
function normalizePathValue(p: string): string {
  return p
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '/')
    .replace(/\\/g, '/')
    .replace(/\/{3,}/g, '//');
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

/** True para caminho já absoluto (POSIX, drive Windows ou UNC) — já com '/'. */
function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.startsWith('//')) return true;
  return false;
}

/** True quando a raiz (normalizada) é de workspace Windows (letra de unidade). */
function isWindowsRoot(root: string): boolean {
  return /^[A-Za-z]:\//.test(root) || root.startsWith('//');
}

/**
 * Sanitiza UM argumento de caminho.
 *  - Sem raiz: ao menos limpa o prefixo relativo repetido e ' \ '→' / '.
 *  - Raiz Windows: win32.resolve(root, rel) → absoluto completo com '\'.
 *  - Raiz POSIX: posix.join + normalize → absoluto com '/'.
 */
export function sanitizePathValue(value: unknown, root: string | null): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;

  const p = stripRedundantRelativePrefix(normalizePathValue(value));
  if (!p) return value;

  if (!root) return p;

  if (isAbsolutePath(p)) {
    if (isWindowsRoot(root)) {
      // Só reescreve no estilo Windows se for drive/UNC Windows; caminho
      // POSIX absoluto dentro de workspace Windows é repassado como está.
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
 * Sanitiza um argumento de caminho que pode conter VÁRIOS arquivos separados
 * por vírgula (ex.: DeleteFile/Read: "file1.ts,file2.ts"). Divide, aplica
 * sanitizePathValue em cada item e reconstitui a lista. Caminhos absolutos
 * Windows não contêm vírgula, então a estrutura reconstruída permanece
 * inequívoca para a ferramenta da IDE.
 */
function sanitizeMultiFilePath(value: unknown, root: string | null): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length <= 1) return sanitizePathValue(value, root);
  return parts.map((part) => sanitizePathValue(part, root)).join(',');
}

/**
 * Sanitiza os argumentos de uma Tool Call (objeto OU string JSON), reescrevendo
 * apenas as chaves de caminho. Nenhum outro argumento (content, query, etc.) é
 * tocado.
 */
export function sanitizeToolCallArguments(
  name: string | undefined,
  args: unknown,
  root: string | null
): unknown {
  if (args === null || args === undefined) return args;

  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
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