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
import type { OpenAIRequest, MessageContent } from '../utils/types.ts';
import { protectPathEscapesInJson } from '../utils/robust-json.ts';

/** Chaves de argumento de Tool Call que representam um arquivo único (podem
 *  vir também como lista separada por vírgulas). 'directory' é só diretório. */
const FILE_PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'target_file', 'absolute_path']);

/** Auxiliares (LINUX/Windows) presente no set de path keys com semântica de lista. */
const PATH_ARG_KEYS = new Set([...FILE_PATH_KEYS, 'directory']);

/** Ferramentas de LEITURA — única exceção à resolução por nome simples: quando o
 *  modelo passa só o basename ('anti-lazy.ts') sem pasta, o relay procura entre
 *  os caminhos JÁ CONHECIDOS do contexto (messages/tool_calls prévios) e resolve
 *  no subdiretório correto, evitando o múltiplo "Failed to read" da IDE. */
const READ_LIKE_TOOLS = new Set([
  'read',
  'readfile',
  'read_file',
  'read_text_file',
  'get_file_content',
  'read_relevant',
]);

/** Campos de STRING obrigatórios nos argumentos de tool call: quando o modelo
 *  envia NULL/undefined no JSON, caem para '' — NUNCA serializam 'undefined'
 *  (o payload enviado à IDE/API pode perder a chave, mas nunca carregar o
 *  literal inválido em nenhum campo). */
const STRICT_STRING_FIELDS = new Set(['content', 'path', 'file_path', 'filePath', 'command', 'command_line', 'target_file', 'absolute_path']);

/** Ferramentas de CRIAÇÃO/ESCRITA de arquivo: EXIGEM a chave 'content'. Se o
 *  modelo omitir o campo, o relay injeta '' explícito — sem isso o texto some
 *  do JSON serializado ('content' ausente → IDE falha a escrita). */
const WRITE_LIKE_TOOLS = new Set(['write', 'writefile', 'createfile', 'create_file', 'createnewfile']);

/** Chaves de ferramentas de Terminal que carregam um COMANDO (recebem aspas
 *  duplas defensivas para nomes com espaços/acentos/parenteses no CMD/PowerShell)
 *  e chaves que são apenas um caminho (aspas envolventes quando necessário). */
const TERMINAL_COMMAND_KEYS = new Set(['command', 'command_line', 'cmd', 'script', 'line']);
const TERMINAL_PATH_KEYS = new Set(['cwd', 'working_directory', 'directory', 'path', 'file_path']);

/** Chaves de ferramentas de BUSCA (Glob/Grep/Search): recebem apenas o colapso
 *  de barras múltiplas ('/src//*.ts' → '/src/*.ts') — NENHUMA outra transformação
 *  (não são resolvidas contra o root, pois podem ser globs/regex). */
const PATTERN_PATH_KEYS = new Set(['pattern', 'glob', 'paths', 'query', 'search']);

/** Extrai SÓ o valor string de chaves de caminho num texto JSON CRU, preservando
 *  byte a byte todo o resto do payload ('old_string'/'new_string'/'content'/
 *  'code' NUNCA são re-escritos — apenas caminhos são substituídos no lugar). */
const REWRITE_PATH_KEY_RE = /"(path|file_path|filePath|target_file|absolute_path|directory)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** Primeiro segmento plausível de caminhos RELATIVOS conhecidos do projeto —
 *  usados para filtrar ruído (URLs, drives) na varredura de conhecidos. */
const KNOWN_FILESYSTEM_ROOTS = new Set([
  'src', 'test', 'tests', 'lib', 'app', 'client', 'server', 'node', 'config',
  'scripts', 'public', 'dist', 'build', 'docs', 'assets', 'utils', 'helpers',
  'services', 'components', 'middlewares', 'routes', 'pages', 'api', 'core',
]);

/**
 * Varre as mensagens do corpo da requisição e coleciona caminhos RELATIVOS
 * multi-segmento já citados (texto dos usuários + arguments de tool_calls
 * prévios). Alimenta a resolução por NOME SIMPLES (Read-like): dado
 * 'anti-lazy.ts', o relay descobre 'src/middlewares/anti-lazy.ts'.
 */
export function extractKnownRelativePaths(messages: any): string[] {
  const out = new Set<string>();
  const pushRelative = (v: unknown) => {
    if (typeof v !== 'string' || v.trim() === '') return;
    const p = v.trim().replace(/^["'`]|["'`]$/g, '');
    if (!p) return;
    if (/^[A-Za-z]:/.test(p) || p.startsWith('//') || p.startsWith('/')) return;
    const clean = p.replace(/^\.\/|^\.\\/, '');
    if (clean.startsWith('..')) return;
    const first = clean.split(/[\\/]/)[0];
    if (!KNOWN_FILESYSTEM_ROOTS.has(first)) return;
    if (!clean.split('.').pop()) return;
    out.add(clean.replace(/\\/g, '/'));
  };

  for (const msg of Array.isArray(messages) ? messages : []) {
    const content = msg?.content;
    if (typeof content === 'string') {
      for (const m of content.matchAll(KNOWN_TEXT_PATH_RE)) {
        const p = m[0].trim().replace(/^["'`]|["'`]$/g, '');
        if (!p || p.includes('://')) continue;
        const first = p.split('/')[0];
        if (KNOWN_FILESYSTEM_ROOTS.has(first)) out.add(p.replace(/\\/g, '/'));
      }
    }
    for (const tc of Array.isArray(msg?.tool_calls) ? msg.tool_calls : []) {
      const declaredArgs = tc?.function?.arguments;
      if (typeof declaredArgs === 'string' && declaredArgs.trim()) {
        try {
          const parsed = JSON.parse(declaredArgs);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const key of PATH_ARG_KEYS) pushRelative((parsed as Record<string, unknown>)[key]);
          }
        } catch { /* arguments malformados são ignorados */ }
      } else if (declaredArgs && typeof declaredArgs === 'object') {
        for (const key of PATH_ARG_KEYS) pushRelative((declaredArgs as Record<string, unknown>)[key]);
      }
    }
  }
  return [...out];
}

/** Prefixos de raiz POSIX reconhecíveis (sys roots) — usados para NÃO tratar
 *  '/home/...' como caminho relativo acidental quando a raiz do workspace é
 *  Windows. */
const POSIX_SYSTEM_ROOT_RE = /^\/(?:users|home|root|var|opt|tmp|mnt|usr|etc|bin|dev|srv|workspace|project|data)\//i;

/** Padrão textual de caminho relativo tipo 'src/middlewares/anti-lazy.ts' usado
 *  para indexar os "subdiretórios conhecidos" varridos na conversa. Segmentos
 *  SEM espaços (evita casar a frase inteira '.../anti-lazy.ts e o src/...ts'). */
const KNOWN_TEXT_PATH_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}/g;

/**
 * Remove NUL bytes (\0) e caracteres de controle NÃO-imprimíveis que quebrariam
 *  o JSON.parse ou seriam injetados no processador. Preserva \t\n\r (\u0009,
 *  \u000A, \u000D — controle legítimo dentro de texto/comandos).
 */
export function stripControlChars(value: string): string {
  return (value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * Colapsa duplicações de barra ('/src//*.ts' → '/src/*.ts', 'C://Users' →
 *  'C:/Users') preservando o prefixo duplo '//' de caminho UNC ('\\server\share').
 */
function collapseDuplicateSlashes(p: string): string {
  const isUnc = p.startsWith('//');
  const collapsed = p.replace(/\/{2,}/g, '/');
  if (isUnc && !collapsed.startsWith('//')) return '/' + collapsed;
  return collapsed;
}

/**
 * Normaliza valores de chaves de BUSCA e glob (pattern, glob, paths, query,
 * search): colapsa dobras de barra como antes e, quando o valor é um CAMINHO
 * concreto ancorado na raiz ('/package.json' — POSIX-absoluto que a IDE lê na
 * raiz do DRIVE, 'C:\package.json' → 'sem resultados'), resolve contra o
 * workspaceRoot. Globs com '*'/'?', raízes de sistema POSIX ('/Users', '/home')
 * e caminhos relativos (sem '/' inicial) ficam como estão: só o colapso.
 * Suporta arrays de caminhos (chave 'paths').
 */
function sanitizePatternPathValue(value: unknown, root: string | null): unknown {
  if (typeof value === 'string') {
    const collapsed = collapseDuplicateSlashes(value);
    if (!root) return collapsed;
    const t = collapsed.trim();
    if (t.length === 0 || t.startsWith('//')) return collapsed;
    if (t.startsWith('/') && !POSIX_SYSTEM_ROOT_RE.test(t)) {
      if (t.includes('*') || t.includes('?') || t.includes('[') || t.includes(']')) return collapsed;
      return sanitizeSinglePath(t, root);
    }
    // Padrão ABSOLUTO (C:\...\file) DENTRO do workspace: vira RELATIVO à raiz —
    // a IDE resolve globs a partir do workspace, não da raiz do drive (senão
    // devolve "No results found" mesmo para arquivo existente).
    const rel = toRelativeUnderRoot(t, root);
    if (rel !== null) return rel;
    return collapsed;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizePatternPathValue(v, root));
  }
  return value;
}

/**
 * Converte um caminho ABSOLUTO (que esteja dentro do workspaceRoot) em
 * RELATIVO à raiz, para chaves de busca (pattern/glob/paths/query/search) que
 * a IDE resolve a partir do workspace. Ex.: root='C:/proj' e pattern
 * 'C:/proj/package.json' → 'package.json'. Null se o caminho estiver FORA da
 * raiz (o absoluto é preservado) ou não for absoluto Windows/path.
 */
function toRelativeUnderRoot(pattern: string, root: string): string | null {
  const normPat = pattern.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normRoot) return null;
  if (!/^[A-Za-z]:\//.test(normPat)) return null;
  const patLower = normPat.toLowerCase();
  const rootLower = normRoot.toLowerCase();
  if (patLower === rootLower) return '/';
  if (patLower.startsWith(rootLower + '/')) {
    const rel = normPat.slice(normRoot.length + 1);
    return rel || '/';
  }
  return null;
}

/**
 * Decodifica o fragmento CRU de um valor string JSON (sem as aspas externas):
 *  lida com \" \\ \/ \b \f \n \r \t e \uXXXX; escapes INVALIDOS (barra solta de
 *  modelo, já duplicada pelo protectPathEscapesInJson) viram a letra junto da
 *  barra — o pipeline seguinte converte essa barra em separador de caminho.
 */
function decodeJsonStringFragment(fragment: string): string {
  let out = '';
  let i = 0;
  while (i < fragment.length) {
    const ch = fragment[i];
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    const next = fragment[i + 1];
    switch (next) {
      case '"': out += '"'; i += 2; break;
      case '\\': out += '\\'; i += 2; break;
      case '/': out += '/'; i += 2; break;
      case 'b': out += '\b'; i += 2; break;
      case 'f': out += '\f'; i += 2; break;
      case 'n': out += '\n'; i += 2; break;
      case 'r': out += '\r'; i += 2; break;
      case 't': out += '\t'; i += 2; break;
      case 'u': {
        const hex = fragment.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          out += next ?? '';
          i += 2;
        }
        break;
      }
      default:
        out += next ?? '';
        i += 2;
        break;
    }
  }
  return out;
}

/** Re-escapa um valor como fragmento string JSON (sem as aspas externas). */
function encodeJsonStringFragment(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
}

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

/** True quando o token de comando é um caminho (separador/drive). */
function isPathyToken(t: string): boolean {
  if (/^\/[A-Za-z0-9]?$/.test(t)) return false; // switch do CMD: '/s', '/q', '/c'
  if (t.startsWith('-') || t.includes('=')) return false; // flag / --flag=value
  return t.includes('\\') || /^[A-Za-z]:/.test(t) || t.includes('/');
}

/** True quando o token tem caracteres especiais que exigem aspas: não-ASCII
 *  (acentos), parenteses, vírgula ou ponto-e-vírgula. */
function hasPathSpecials(t: string): boolean {
  return /[^\x00-\x7F]/.test(t) || /[(),;]/.test(t);
}

/** Builtins de filesystem do CMD (lote Windows) que o relay traduz para um
 *  ÚNICO `node -e "..."` — imune a concurrency, a 'mkdir -p' inexistente no
 *  CMD e a sintaxe PowerShell multilinha que quebra o parse da IDE. */
const BATCH_FS_BUILTINS: Record<string, 'mkdir' | 'move' | 'rmdir' | 'del'> = {
  mkdir: 'mkdir',
  md: 'mkdir',
  move: 'move',
  rmdir: 'rmdir',
  rd: 'rmdir',
  del: 'del',
  erase: 'del',
};

/** Divide um statement em tokens respeitando aspas duplas/simples. */
function splitQuotedTokens(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Caminho como literal JS com aspas SIMPLES (o argumento externo do `node -e`
 *  usa aspas duplas no CMD/PowerShell e nunca pode embutir um `"`). */
function jsPathLiteral(p: string): string {
  return `'${String(p).replace(/\\/g, '/').replace(/'/g, "\\'")}'`;
}

/**
 * Tenta traduzir um script composto SÓ de builtins de filesystem do CMD
 * (mkdir/md, move, rmdir/rd, del/erase) encadeados por '&&'/'&'/';'/quebra de
 * linha num ÚNICO `node -e "..."` (fs.mkdirSync/renameSync/rmSync). Torna o
 * lote seguro para concorrência e elimina o 'InvalidEndOfLine'/'missing field
 * command' da IDE. Retorna null quando NÃO é um lote puro (repassa intacto).
 */
function translateBatchToNodeE(cmd: string): string | null {
  const statements = cmd
    .split(/\s*&&\s*|\s*;\s*|\r?\n\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) return null;

  const js: string[] = [];
  for (const st of statements) {
    const tokens = splitQuotedTokens(st);
    if (tokens.length === 0) continue;
    const verb = BATCH_FS_BUILTINS[String(tokens[0]).toLowerCase()];
    if (!verb) return null;

    let recursive = false;
    const paths: string[] = [];
    for (const tok of tokens.slice(1)) {
      const low = String(tok).toLowerCase();
      if (low === '-p' || low === '/p' || low === '-s' || low === '/s' || low === '-r' || low === '/r') { recursive = true; continue; }
      if (low === '/q' || low === '-q' || low === '/f' || low === '-f') continue; // force/quiet
      if (low.startsWith('/') || (low.startsWith('-') && low.length > 1)) return null; // flag desconhecida
      paths.push(String(tok).replace(/^["']|["']$/g, ''));
    }
    if (paths.length === 0) return null;

    if (verb === 'mkdir') {
      for (const p of paths) js.push(`fs.mkdirSync(${jsPathLiteral(p)},${recursive ? '{recursive:true}' : '{recursive:false}'})`);
    } else if (verb === 'move') {
      if (paths.length < 2 || paths.length % 2 !== 0) return null;
      for (let i = 0; i + 1 < paths.length; i += 2) {
        js.push(`fs.renameSync(${jsPathLiteral(paths[i])},${jsPathLiteral(paths[i + 1])})`);
      }
    } else if (verb === 'rmdir') {
      for (const p of paths) {
        js.push(recursive ? `fs.rmSync(${jsPathLiteral(p)},{recursive:true,force:true})` : `fs.rmdirSync(${jsPathLiteral(p)})`);
      }
    } else {
      for (const p of paths) js.push(`fs.rmSync(${jsPathLiteral(p)},{force:true})`);
    }
  }

  if (js.length === 0) return null;
  return `node -e "const fs=require('fs');${js.join(';')}"`;
}

/**
 * Pré-processa o comando de terminal ANTES da cotação defensiva:
 *   1. lote Windows puro (mkdir/move/rmdir/del) → `node -e "..."` (UMA execução,
 *      sem corrida entre processos nem bloco PowerShell multilinha);
 *   2. remove/neutraliza sintaxes que QUEBRAM o parse do CMD/PowerShell da IDE:
 *      '|| true' (no-op Unix), '2>nul' e 'mkdir -p <dir>' (flag inexistente).
 * Preserva o restante byte a byte.
 */
function preprocessTerminalCommand(cmd: string): string {
  if (typeof cmd !== 'string' || cmd.trim() === '') return cmd;
  const translated = translateBatchToNodeE(cmd);
  if (translated !== null) return translated;
  let out = cmd;
  out = out.replace(/\s*\|\|\s*true\b/gi, ' ');
  out = out.replace(/\s*2>nul\b/gi, ' ');
  out = out.replace(/(^|[\s;&])mkdir\s+(-p|-parents)(?=\s|$)/gi, '$1mkdir');
  return out.replace(/[ \t][ \t]+/g, ' ').trim();
}

/**
 * ASPAS DUPLAS DEFENSIVAS em comandos de terminal: agrupa tokens de caminho
 * adjacentes (partes de UM caminho com espaços) e envolve o grupo em aspas
 * duplas quando contém espaços/acentos/parenteses (ex.: 'cd C:/Users/Lucas sá/Projeto'
 * → 'cd "C:/Users/Lucas sá/Projeto"'). Flags ('--','-x'), operadores (&&, |, ;)
 * e tokens JÁ entre aspas são preservados; tokens sem especiais ficam intactos
 * (semântica de argumentos preservada — 'src/x dest/y' nunca vira um argumento só).
 * O comando passa primeiro por `preprocessTerminalCommand` (lote → node -e;
 * Unix-isms removidos).
 */
function quoteCommandPathTokens(s: string): string {
  if (typeof s !== 'string' || s === '') return s;
  const pre = preprocessTerminalCommand(s);
  const tokens: string[] = [];
  let cur = '';
  for (let j = 0; j < pre.length; j++) {
    const ch = pre[j];
    if (ch === '"') {
      if (cur) { tokens.push(cur); cur = ''; }
      let q = '';
      j += 1;
      while (j < pre.length && pre[j] !== '"') { q += pre[j]; j += 1; }
      tokens.push('"' + q + '"');
      continue;
    }
    if (/[\s\u00A0]/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);

  const out: string[] = [];
  let pending: string[] | null = null;
  const flushGroup = () => {
    if (pending && pending.length > 0) {
      if (pending.some(hasPathSpecials)) {
        out.push('"' + pending.join(' ').replace(/"/g, '\\"') + '"');
      } else {
        for (const p of pending) out.push(p);
      }
      pending = null;
    }
  };
  const emitToken = (t: string) => {
    if (/^(?:&&|\|\||>>|>|<|\||;|&)$/.test(t)) { flushGroup(); out.push(t); return; }
    if (t.startsWith('-') || t.includes('=')) { flushGroup(); out.push(t); return; }
    if (pending === null) {
      if (isPathyToken(t) || hasPathSpecials(t)) pending = [t];
      else out.push(t);
      return;
    }
    if (isPathyToken(t) || hasPathSpecials(t)) { pending.push(t); return; }
    flushGroup();
    out.push(t);
  };

  for (const t of tokens) {
    if (/^".*"$/.test(t)) { flushGroup(); out.push(t); continue; }
    emitToken(t);
  }
  flushGroup();
  return out.join(' ');
}

/** Envolve um caminho INTEIRO (cwd/working_directory) em aspas quando contém
 *  espaços, acentos ou parenteses — já quotado, repassa intacto. */
function quoteWholePath(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const t = value.trim();
  if (/^".*"$/.test(t)) return value;
  if (/[\s\u00A0]|[^\x00-\x7F]|[(),;]/.test(t)) return '"' + t.replace(/"/g, '\\"') + '"';
  return value;
}

/**
 * Troca de barras invertidas + ASPAS DEFENSIVAS por chave: command→
 * quoteCommandPathTokens; cwd/directory→quoteWholePath; demais strings só
 * '\'→'/'. Estrutura (objetos/arrays) é preservada.
 */
function forwardSlashAndQuoteLeaves(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\\/g, '/');
  if (Array.isArray(value)) return value.map(forwardSlashAndQuoteLeaves);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TERMINAL_COMMAND_KEYS.has(k)) out[k] = quoteCommandPathTokens(String(forwardSlashLeaves(v) ?? ''));
      else if (TERMINAL_PATH_KEYS.has(k)) out[k] = quoteWholePath(forwardSlashLeaves(v));
      else out[k] = forwardSlashLeaves(v);
    }
    return out;
  }
  return value;
}

/**
 * Sanitizador de TERMINAL: converte TODAS as '\' em '/' nos valores dos
 * argumentos, remove NUL/control antes do parse, e aplica aspas duplas
 * defensivas em nomes com espaços/acentos/parenteses (CMD/PowerShell). Strings
 * JSON são protegidas ANTES do parse (nunca Tabulação), transformadas e
 * re-serializadas; textos crus não-JSON ganham '/' direto + aspas.
 */
function sanitizeTerminalArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    const safe = stripControlChars(args);
    try {
      const parsed = JSON.parse(protectTerminalJsonEscapes(safe));
      if (typeof parsed === 'string') return quoteCommandPathTokens(parsed.replace(/\\/g, '/'));
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(forwardSlashAndQuoteLeaves(parsed));
      }
      return quoteCommandPathTokens(safe.replace(/\\/g, '/'));
    } catch {
      // Não é JSON estruturado: comando cru — barras invertidas para '/' + aspas.
      return quoteCommandPathTokens(safe.replace(/\\/g, '/'));
    }
  }
  return forwardSlashAndQuoteLeaves(args);
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

/**
 * Limpeza de ERROS/STATUS DE TOOL devolvidos pela IDE (role `tool`/`user`):
 * converte/remove rigorosamente marcação interna tipo '<toolcall_error_message>',
 * '</toolcall_error_message>', '<toolcall_status>' e variantes malformadas
 * (sem fechamento, somente fechamento, barra de escape) para TEXTO LIMPO antes
 * de o conteúdo voltar ao contexto do modelo.
 *
 * Regras (idempotentes — rodar 2x não degrada):
 *   - bloco FECHADO <toolcall_error_message>...</toolcall_error_message> →
 *     'Error: <texto>' (o erro NÃO é perdido, só desembrulhado);
 *   - bloco fechado <toolcall_result> / <toolcall_status> → só o texto interno;
 *   - tags SOLTAS (abertura sem fechamento, só '</...>', '<toolcall_status/>')
 *     viram '' (abertura de error → 'Error: ' para não perder a mensagem);
 *   - NUNCA altera o conteúdo fora do escopo dessas tags (byte a byte).
 */
export function sanitizeToolOutput(content: unknown): unknown {
  if (typeof content === 'string') {
    const clean = cleanToolcallTags(content);
    return clean === content ? content : clean;
  }
  if (Array.isArray(content)) {
    let changed = false;
    const parts = content.map((p: any) => {
      if (p && typeof p === 'object' && typeof p.text === 'string') {
        const clean = cleanToolcallTags(p.text);
        if (clean !== p.text) {
          changed = true;
          return { ...p, text: clean };
        }
      }
      return p;
    });
    return changed ? parts : content;
  }
  return content;
}

/** Confirmação limpa para resultados VAZIOS de ferramentas de escrita ('Write'):
 *  uma IDE que devolve vazio faz o modelo suspeitar que o arquivo não foi
 *  gravado e re-escrever o MESMO arquivo em loop. O gateway injeta esta
 *  confirmação nesse caso — a chamada de Write está concluída, encerra o ciclo. */
export const WRITE_CONFIRMATION = 'The file was written successfully.';

/** True quando o content de uma mensagem é VAZIO (string em branco, array de
 *  partes sem texto, null ou array vazio) — alvo da injeção acima. */
function messageContentEmpty(content: unknown): boolean {
  if (content === undefined || content === null) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    return content.every((p: any) => {
      if (typeof p === 'string') return p.trim() === '';
      return !(p && typeof p === 'object' && typeof p.text === 'string' && p.text.trim() !== '');
    });
  }
  return true;
}

/**
 * Aplica `sanitizeToolOutput` a TODAS as mensagens do corpo (string ou partes
 * OpenAI). Idempotente e NUNCA toca em fields estruturais (role/name/tool_call_id).
 * Chamado no GATEWAY antes do roteamento — nem o Gemini nem o Qwen recebem
 * tags de erro malformadas no prompt da próxima volta do chat.
 *
 * Além da limpeza de tags, garante ESTABILIDADE do resultado das ferramentas de
 * escrita: resultado VAZIO de um 'Write' (correlacionado pelo tool_call_id com o
 * assistant que o emitiu) recebe a confirmação `WRITE_CONFIRMATION`, impedindo o
 * loop de re-escrita do mesmo arquivo.
 */
export function applyToolOutputSanitization(body: OpenAIRequest): OpenAIRequest {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;
  const toolNames = new Map<string, string>();
  let changed = false;
  const next = messages.map((msg) => {
    if (!msg) return msg;
    // Correlação tool_call_id → nome da ferramenta (o assistant com tool_calls
    // precede cronologicamente o result da tool na matriz de mensagens OpenAI).
    if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls as any[]) {
        if (tc && tc.id) toolNames.set(String(tc.id), String(tc?.function?.name ?? ''));
      }
    }
    // Confirmação de escrita: 'Write' com resultado VAZIO → confirmação limpa.
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      const name = toolNames.get(msg.tool_call_id);
      if (isWriteLikeTool(name) && messageContentEmpty(msg.content)) {
        changed = true;
        return { ...msg, content: WRITE_CONFIRMATION };
      }
    }
    const clean = sanitizeToolOutput(msg.content);
    if (clean !== msg.content) {
      changed = true;
      return { ...msg, content: clean as MessageContent };
    }
    return msg;
  });
  if (!changed) return body;
  return { ...body, messages: next };
}

/** Tags de resultado/erro/status de tool: TAG_OPEN '<' [barra] '\\' nome '>'. */
const TOOLCALL_BLOCK_RE = /<\\?toolcall_(error_message|result|status)[^>]*>([\s\S]*?)<\/toolcall_(?:error_message|result|status)[^>]*>/gi;

/** Tags SOLTAS restantes (abertura sem fechamento, só fechamento, self-closed). */
const TOOLCALL_LEFT_OVER_RE = /<\/?\\?toolcall_(?:error_message|result|status)[^>]*>/gi;

/** Erros CRUS de PARÂMETROS/SINTAXE de terminal devolvidos pela IDE (o JSON de
 *  argumentos chega quebrado — 'command' ausente ou linha inválida). São
 *  normalizados para mensagem amigável ANTES de voltar ao contexto do modelo:
 *  sem isso o Gemini/Qwen repete a mesma tool malformada no próximo turno. */
const TERMINAL_RAW_ERROR_PATTERNS = [
  /invalid\s+params?:?\s+deserialize\s+params?\s+error:\s+missing\s+field\s+command/gi,
  /invalid\s+params?:?\s+deserialize\s+params?\s+error/gi,
  /deserialize\s+params?\s+error[^\r\n]*(?:missing\s+field\s+\w+)?/gi,
  /invalid\s+end\s+of\s+line/gi,
  /invalidendofline/gi,
];

const TERMINAL_ERROR_FRIENDLY =
  'Error: Parâmetros do comando de terminal inválidos — a IDE rejeitou o comando (campo "command" ausente ou sintaxe de linha inválida). Use um único comando de terminal simples.';

/** Substitui padrões de erro cru de terminal por uma mensagem amigável. */
function cleanTerminalParamError(text: string): string {
  let out = text;
  for (const re of TERMINAL_RAW_ERROR_PATTERNS) {
    out = out.replace(re, TERMINAL_ERROR_FRIENDLY);
  }
  return out;
}

/** Erro de BINÁRIO de BUSCA AUSENTE no SO (fd.exe/ripgrep) em Glob/LS/
 *  SearchCodebase: a linha menciona o binário E que há ENOENT/'no such file'/
 *  'not found'/'not recognized'. É um FALSO-negativo de infraestrutura — a IDE
 *  tenta 'spawn' um binário externo que não existe, e o modelo ficaria repetindo
 *  a mesma busca. Detecta e substitui a linha INTEIRA por instrução de fallback
 *  (listagem simples por caminhos relativos / resolução direta, sem 'fd.exe'). */
const SEARCH_BIN_MISSING_LINE_RE =
  /[^\r\n]*(?:\b(?:enoent|no such file|not found|not recognized)\b[^\r\n]*\b(?:fd\.exe|rg\.exe|ripgrep)\b|\b(?:fd\.exe|rg\.exe|ripgrep)\b[^\r\n]*\b(?:enoent|no such file|not found|not recognized)\b)[^\r\n]*/gi;

const SEARCH_BIN_MISSING_FRIENDLY =
  '[PROXY SEARCH FALLBACK] A ferramenta de busca falhou porque o binário externo (fd.exe / ripgrep) não está instalado no sistema operacional. Resolva os caminhos diretamente com ferramentas de arquivo por caminhos relativos ao workspace (Read/SearchReplace/Edit) ou use listagem simples baseada no protocolo — NÃO repita buscas que dependam de "fd.exe" nem solicite sua instalação ao usuário.';

/** Normaliza erros de binário de busca ausente (idempotente: o fallback não
 *  re-dispara o padrão na próxima passada). */
function cleanMissingSearchBinaryError(text: string): string {
  if (!SEARCH_BIN_MISSING_LINE_RE.test(text)) return text;
  SEARCH_BIN_MISSING_LINE_RE.lastIndex = 0;
  return text.replace(SEARCH_BIN_MISSING_LINE_RE, SEARCH_BIN_MISSING_FRIENDLY);
}

function cleanToolcallTags(text: string): string {
  let out = text.replace(TOOLCALL_BLOCK_RE, (_whole, kind: string, inner: string) => {
    const t = String(inner ?? '').trim();
    if (!t) return '';
    return String(kind).toLowerCase() === 'error_message' ? `Error: ${t}` : t;
  });
  // Restos: abertura solta de error_message → 'Error: ' (não perder o texto de
  // bloco SEM fechamento); fechamento/self-closed → ''; result/status → ''.
  out = out.replace(TOOLCALL_LEFT_OVER_RE, (tag) => {
    const closing = tag.startsWith('</') || tag.endsWith('/>');
    const isError = /error_message/i.test(tag);
    return !closing && isError ? 'Error: ' : '';
  });
  // Erros crus de parâmetros de terminal → mensagem amigável (idempotente).
  out = cleanTerminalParamError(out);
  // Binário de busca ausente (ENOENT: fd.exe/ripgrep) → fallback protocolo.
  out = cleanMissingSearchBinaryError(out);
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
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

/**
 * Cache de raiz por conversa/sessão: só é usado quando o request traz um id
 * estável (header x-conversation-id/x-session-id ou body conversation_id/...).
 * Cada conversa guarda a PRÓPRIA raiz — trocar de projeto nunca contamina a
 * conversa de outro projeto.
 */
const workspaceRootCache = new Map<string, string>();

/** Fallback global da ÚLTIMA raiz vista — usado apenas por requests SEM id. */
let cachedWorkspaceRoot: string | null = null;

/** Fontes de id estável de conversa/sessão no request (para o cache por conversa). */
const WORKSPACE_ROOT_KEY_SOURCES: Array<{ header: string } | { body: string[] }> = [
  { header: 'x-conversation-id' },
  { header: 'x-session-id' },
  {
    body: ['conversation_id', 'conversationId', 'session_id', 'sessionId', 'chat_session_id'],
  },
];

/**
 * PURGA RE-ENTRANTE DE PREFIXOS RELATIVOS — SEMPRE a PRIMEIRA ação de
 * sanitização, quando o valor ainda carrega as barras CRUAS (antes de qualquer
 * regex/resolução). Roda em LOOP até purificar (escudo defensivo):
 *   - remove './', '.\', '../', '..\' e repetições ('././', '.\.\', '././../',
 *     '.\..\src\...') recursivamente até não sobrar prefixo relativo;
 *   - remove um '\' RAIZ único e acidental ('\src\file' → 'src\file') — o
 *     modelo às vezes prefixa o caminho com barra; '\\server\share' (UNC)
 *     e 'C:\...' permanecem intocados;
 *   - NUNCA remove o '/' inicial de caminho POSIX absoluto ('/Users/...').
 * Nota de segurança: prefixos '../' (path traversal fora do workspaceRoot) são
 * PURGADOS, não preservados — um caminho relativo nunca sobe acima da raiz.
 */
function stripRelativePrefix(p: string): string {
  let out = p;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/^(?:\.{1,2}[\\/])+/, '');
    if (next === out) break;
    out = next;
  }
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
  return collapseDuplicateSlashes(
    p
      .trim()
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/\\/g, '/')
      .replace(/<[^>\r\n]*>/g, '')
      .replace(/[\u0000-\u001F\u007F]/g, '/')
  );
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
      // '/src/x.ts' (ou glob '/src//*.ts' já colapsado) com raiz Windows: uma
      // barra inicial NÃO é sys-root POSIX — é acidente do modelo. Trata como
      // relativo à raiz do projeto (senão 'src' viraria raiz da unidade 'C:' e
      // a busca quebraria). /home|/Users|... continuam absolutos acima.
      if (!POSIX_SYSTEM_ROOT_RE.test(p)) {
        return pathWin32.resolve(root, p.replace(/^\/+/, ''));
      }
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
 * Corta "cauda narrativa" de um candidato a raiz detectado em TEXTO LIVRE.
 * Caso real: o modelo usa 'C:\Users\Lucas sá\Documents\trae_projects\Teste_pratico_proxy. A
 * tarefa abaixo é OBRIGATÓRIA...' (caminho seguido de frase NA MESMA LINHA) —
 * o regex guloso come o folder + a frase inteira. A fronteira mais comum é um
 * '. ' (ponto+espaço) DEPOIS do último separador: a porção real termina aí.
 *   '...\Teste_pratico_proxy. A tarefa...' → '...\Teste_pratico_proxy'
 */
function truncateRootCandidateTail(candidate: string): string {
  const lastSep = Math.max(candidate.lastIndexOf('\\'), candidate.lastIndexOf('/'));
  const bodyStart = lastSep + 1;
  const tail = lastSep >= 0 ? candidate.slice(bodyStart) : candidate;
  const dotSpace = tail.search(/\.\s+\S/);
  if (dotSpace >= 0) return candidate.slice(0, bodyStart + dotSpace);
  return candidate;
}

/** cleanRootValue + corte da cauda narrativa (usado na varredura das mensagens). */
function cleanRootCandidate(raw: string): string | null {
  return cleanRootValue(truncateRootCandidateTail(raw));
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

/** True para ferramentas de LEITURA (resolução por nome simples habilitada). */
function isReadLikeTool(name: string | undefined): boolean {
  return !!name && READ_LIKE_TOOLS.has(String(name).trim().toLowerCase());
}

/** True para ferramentas de CRIAÇÃO/ESCRITA de arquivo (exigem 'content'). */
function isWriteLikeTool(name: string | undefined): boolean {
  return !!name && WRITE_LIKE_TOOLS.has(String(name).trim().toLowerCase());
}

/** Arquivos de CONFIGURAÇÃO/RAIZ do workspace: quando o modelo pede só o nome
 *  (ex.: 'package.json'), resolvem SEMPRE direto na raiz do workspace — mesmo
 *  que haja um caminho conhecido mais profundo na conversa. Elimina retries e
 *  'Failed to read' repetidos (gateway PURO: resolução de string, sem I/O). */
const ROOT_CONFIG_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'bun.lock', 'tsconfig.json', 'jsconfig.json', 'tsconfig.tsbuildinfo', 'diag-output.log',
  '.env', '.env.local', '.env.example', '.gitignore', '.npmrc', '.babelrc', '.editorconfig',
  '.prettierrc', '.prettierrc.json', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts',
  'prettier.config.js', 'prettier.config.cjs', 'vitest.config.ts', 'vitest.config.js',
  'jest.config.ts', 'jest.config.js', 'vite.config.ts', 'vite.config.js', 'next.config.js',
  'next.config.mjs', 'README.md', 'readme.md', 'LICENSE', 'Dockerfile', 'Makefile',
]);

/**
 * Resolução por NOME SIMPLES (apenas Read-like): se 'anti-lazy.ts' (basename
 * puro, sem pasta) foi referenciado como 'src/middlewares/anti-lazy.ts' em algum
 * caminho CONHECIDO da conversa (messages/tool_calls prévios), resolve no diretório
 * conhecido em vez de assumir a raiz direta do workspace — evita o "Failed to
 * read" repetido da IDE. Retorna null quando não há pista (mantém o
 * comportamento padrão root/basename).
 */
function resolveSimpleKnownPath(name: string, root: string | null, knownPaths?: string[]): string | null {
  if (!root || !Array.isArray(knownPaths) || knownPaths.length === 0) return null;
  if (name.includes('/') || name.includes('\\') || name.startsWith('.') || name.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(name)) return null;
  // Arquivos de CONFIGURAÇÃO/RAIZ SEMPRE resolvem na raiz do workspace
  // (package.json, tsconfig.json, .env...), independente de subdiretórios
  // conhecidos — evita 'package.json' apontando para 'src/package.json'.
  if (ROOT_CONFIG_FILES.has(String(name).toLowerCase())) {
    return resolveAgainstRoot(name, root);
  }
  const target = '/' + name.toLowerCase();
  let best: string | null = null;
  for (const rel of knownPaths) {
    const norm = String(rel).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm || norm.split('/').length < 2) continue;
    if (norm.toLowerCase().endsWith(target)) {
      const dir = norm.slice(0, norm.length - name.length); // '<dir>/'
      if (best === null || dir.length > best.length) best = dir;
    }
  }
  if (best === null) return null;
  return resolveAgainstRoot(best + name, root);
}

/**
 * Pipeline RÍGIDO de sanitização de UM caminho — usado tanto por
 * `sanitizePathValue` (chave única 'directory'/'path') quanto por itens de
 * listas multi-arquivo (Read/DeleteFile/Write/SearchReplace):
 *   1. PURGA re-entrante do prefixo relativo ('./', '.\', '../', repetidos,
 *      '\' raiz) ANTES de qualquer regex/resolução — barras ainda cruas;
 *   2. NORMALIZAÇÃO TOTAL de barras: TODAS as '\' → '/' (nunca Tabulação que
 *      comeria a letra de '\tests_stress'), remoção de tags XML/HTML
 *      acidentais, restauração de control-chars residuais como '/' e COLAPSO
 *      de barras duplicadas ('/src//*.ts' → '/src/*.ts');
 *   3. re-purga relativa (barra de segurança — cobre '.\' surgido no passo 2)
 *      e remoção de NUL bytes/control residual;
 *   4. Preservação do drive letter: 'C:'/'c:' sola vira raiz do drive 'C:\';
 *   5. resolução contra o workspaceRoot — caminho JÁ absoluto (C:\..., c:\...,
 *      \\server\...) nunca recebe o root de novo, só win32.normalize. Para
 *      Read-like com basename puro, resolução inteligente via subdiretórios
 *      conhecidos da conversa.
 */
function sanitizeSinglePath(
  raw: string,
  root: string | null,
  knownPaths?: string[],
  readLike = false
): string {
  if (typeof raw !== 'string' || raw.trim() === '') return raw;
  const purged = stripRelativePrefix(raw);
  const normalized = normalizePathValue(purged);
  if (!normalized) return raw;
  const candidate = stripRelativePrefix(stripControlChars(normalized));
  if (!candidate) return raw;
  const driveOnly = /^([A-Za-z]):$/.exec(candidate);
  if (driveOnly) return pathWin32.normalize(driveOnly[1] + ':\\');
  if (readLike) {
    const hinted = resolveSimpleKnownPath(candidate, root, knownPaths);
    if (hinted !== null) return hinted;
  }
  return resolveAgainstRoot(candidate, root);
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
function sanitizeMultiFilePath(
  value: unknown,
  root: string | null,
  readLike = false,
  knownPaths?: string[]
): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length <= 1) return sanitizeSinglePath(value, root, knownPaths, readLike);
  return parts
    .map((part) => sanitizeSinglePath(part, root, knownPaths, readLike))
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
 * Reescreve, no texto JSON CRU, SOMENTE os valores das chaves de caminho,
 * preservando BYTE A BYTE todos os demais campos do payload. `old_string`,
 * `new_string`, `content` e `code` jamais são re-escapados ou alterados — a
 * integridade do conteúdo pedido pelo modelo é garantida mesmo em JSON
 * malformado (barra solta, aspas não escapadas desses campos não quebram nada
 * aqui). Retorna null quando não há chave de caminho em string no payload.
 */
function rewritePathValuesInJsonRaw(
  raw: string,
  name: string | undefined,
  root: string | null,
  knownPaths?: string[]
): string | null {
  const readLike = isReadLikeTool(name);
  // Protege barras de caminho ANTES de extrair o fragmento, igual ao pipeline
  // de parse: '.\src\tests_stress' não pode decodificar '\t' para Tabulação
  // (o fragmento reescrito mantém a letra 't' real).
  const protectedRaw = protectPathEscapesInJson(raw);
  let out = '';
  let lastIndex = 0;
  let found = false;
  REWRITE_PATH_KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REWRITE_PATH_KEY_RE.exec(protectedRaw)) !== null) {
    const key = match[1];
    const decoded = stripControlChars(decodeJsonStringFragment(match[2]));
    let replaced: string;
    if (PATTERN_PATH_KEYS.has(key)) {
      replaced = String(sanitizePatternPathValue(decoded, root));
    } else {
      // Multi-arquivo ('x.ts, y.ts') divide cada item E re-resolve — string
      // JSON de Read/DeleteFile com listas continua funcionando.
      replaced = String(sanitizeMultiFilePath(decoded, root, readLike, knownPaths));
    }
    out += protectedRaw.slice(lastIndex, match.index);
    out += '"' + key + '":"' + encodeJsonStringFragment(replaced) + '"';
    lastIndex = match.index + match[0].length;
    found = true;
  }
  if (!found) return null;
  out += protectedRaw.slice(lastIndex);
  return out;
}

/**
 * Sanitiza os argumentos de uma Tool Call (objeto OU string JSON), reescrevendo
 * apenas as chaves de caminho. Nenhum outro argumento (content, query, etc.) é
 * tocado.
 *
 * ISOLAMENTO/TRATAMENTO: ferramentas de terminal (RunCommand, CheckCommandStatus
 * e afins) têm TODAS as barras invertidas convertidas em '/' nos valores
 * ('src\tests_stress' → 'src/tests_stress'; '\t' nunca vira Tabulação) —
 * o CMD/PowerShell aceita '/' em caminhos, e comandos com espaços/acentos/
 * parenteses ganham aspas duplas defensivas. Chamadas `run_mcp` (MCP) recebem
 * apenas a injeção de `server_name` quando ausente (`mcpServers` = nomes
 * anunciados no schema das tools da requisição). Read/Write/Edit/
 * SearchReplace/DeleteFile passam pelo pipeline rígido de sanitização; Read-like
 * recebe resolução por nome simples contra caminhos conhecidos (`knownPaths`
 * = extractKnownRelativePaths das messages) e keys de busca (pattern/glob/
 * paths/query) colapsam '/' e, quando o valor é um caminho concreto ancorado
 * na raiz ('/package.json'), resolvem contra o workspaceRoot — a IDE não busca
 * na raiz do drive.
 */
export function sanitizeToolCallArguments(
  name: string | undefined,
  args: unknown,
  root: string | null,
  mcpServers?: string[],
  knownPaths?: string[]
): unknown {
  if (args === null || args === undefined) return args;
  if (isMcpToolCall(name)) return sanitizeMcpToolArguments(args, mcpServers);
  if (isTerminalTool(name)) return sanitizeTerminalArgs(args);

  if (typeof args === 'string') {
    const raw = stripControlChars(args);
    if (!raw.trim()) return args;
    try {
      const rewritten = rewritePathValuesInJsonRaw(raw, name, root, knownPaths);
      if (rewritten !== null) {
        // Payload de caminho reescrito no lugar; campos não-path (old_string,
        // content, etc.) ficam byte a byte INTACTOS — mesmo que o JSON global
        // seja preguiçoso (o caminho sanitizado é entregue à IDE de qualquer
        // forma; o restante não é pior do que o original).
        return rewritten;
      }
    } catch { /* segue para o fallback */ }
    try {
      // Protege barras de caminho no JSON cru ANTES do parse: '\tests_stress'
      // não pode ser decodificado como Tab (o JSON.parse 'engoliria' o 't').
      const parsed = JSON.parse(protectPathEscapesInJson(raw));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify(sanitizeToolCallArguments(name, parsed, root, mcpServers, knownPaths));
      }
    } catch {
      // Não é JSON estruturado: repassa intacto.
    }
    return args;
  }

  if (typeof args === 'object' && !Array.isArray(args)) {
    const readLike = isReadLikeTool(name);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(args as Record<string, unknown>)) {
      if (STRICT_STRING_FIELDS.has(key) && (val === undefined || val === null)) {
        out[key] = '';
        continue;
      }
      if (FILE_PATH_KEYS.has(key)) out[key] = sanitizeMultiFilePath(val, root, readLike, knownPaths);
      else if (key === 'directory') out[key] = sanitizePathValue(val, root);
      else if (PATTERN_PATH_KEYS.has(key)) out[key] = sanitizePatternPathValue(val, root);
      else out[key] = val;
    }
    // Chamada de CRIAÇÃO de arquivo SEM o campo 'content' (ausente) → conteúdo
    // vazio EXPLÍCITO: a chave nunca some do JSON serializado para a IDE.
    if (isWriteLikeTool(name) && !Object.prototype.hasOwnProperty.call(out, 'content')) {
      out.content = '';
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
      const candidate = cleanRootCandidate(m[1]);
      if (candidate && !isIncompleteRoot(candidate)) cwdMatch = candidate;
    }
  }
  if (cwdMatch) return cwdMatch;

  // 2) Marcação explícita <workspace>PATH</workspace> (confiável).
  let tagMatch: string | null = null;
  for (const text of texts) {
    for (const m of text.matchAll(WORKSPACE_TAG_RE)) {
      const candidate = cleanRootCandidate(m[1]);
      if (candidate) tagMatch = candidate;
    }
  }
  if (tagMatch) return tagMatch;

  // 3) Chave explícita 'workspacePath: PATH'.
  let keyMatch: string | null = null;
  for (const text of texts) {
    for (const m of text.matchAll(WORKSPACE_PATH_KEY_RE)) {
      const candidate = cleanRootCandidate(m[1]);
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
        const candidate = cleanRootCandidate(m[0]);
        if (candidate && !isIncompleteRoot(candidate)) absMatch = candidate;
      }
    }
  }
  return absMatch;
}

/** Zera o cache de raiz (semântica de 'o próximo projeto é quem decide agora'). */
export function clearWorkspaceRootCache(): void {
  cachedWorkspaceRoot = null;
  workspaceRootCache.clear();
}

/**
 * Resolve a raiz do workspace a partir do contexto HTTP:
 *   header 'x-workspace-root' → demais headers → body.workspacePath/rootPath →
 *   varredura das mensagens (fallback Trae) → cache.
 * Se o request trouxer id de conversa/sessão, apenas o cache DAQUELA conversa
 * é consultado/gravado — a última raiz global NUNCA é emprestada para uma
 * conversa que já tem uma raiz própria. Requests sem id usam a última raiz
 * global vista como conveniência (compat. com clientes que não enviam contexto).
 */
export function getWorkspaceRootFromContext(
  c: Context,
  body?: { workspacePath?: string; rootPath?: string; messages?: any[] } | any
): string | null {
  const key = requestConversationKey(c, body);
  const remember = (root: string): string => {
    if (key) workspaceRootCache.set(key, root);
    cachedWorkspaceRoot = root;
    return root;
  };

  for (const header of WORKSPACE_ROOT_HEADERS) {
    const value = c?.req?.header(header);
    if (value && value.trim()) {
      const root = cleanRootValue(value);
      if (root) return remember(root);
    }
  }

  const bodyRoot = body?.workspacePath ?? body?.rootPath;
  if (bodyRoot && String(bodyRoot).trim()) {
    const root = cleanRootValue(String(bodyRoot));
    if (root) return remember(root);
  }

  const msgRoot = extractWorkspaceRootFromMessages(body?.messages);
  if (msgRoot) return remember(msgRoot);

  if (key) return workspaceRootCache.get(key) ?? null;
  return cachedWorkspaceRoot;
}

/** Extrai id estável de conversa/sessão do request, se o cliente enviar. */
function requestConversationKey(c: Context, body?: any): string | null {
  for (const src of WORKSPACE_ROOT_KEY_SOURCES) {
    if ('header' in src) {
      const value = c?.req?.header(src.header);
      if (value && value.trim()) return value.trim();
    } else {
      for (const field of src.body) {
        const value = body?.[field];
        if (value && String(value).trim()) return String(value).trim();
      }
    }
  }
  return null;
}