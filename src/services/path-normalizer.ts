/*
 * File: path-normalizer.ts
 * Project: deepsproxy
 * Normaliza caminhos de arquivos em tool_calls usando o [WORKSPACE MAP].
 * Corrige automaticamente caminhos truncados (ex: src/... -> front_end/src/...)
 */

import { getWorkspaceMap } from './workspace.ts';

/** Nomes de ferramentas que manipulam caminhos de arquivo */
const PATH_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'str_replace_editor',
  'edit',
  'write',
  'glob',
  'grep',
  'list_dir',
  'ls',
]);

/** Parâmetros comuns que contêm caminhos de arquivo */
const PATH_ARG_KEYS = [
  'path',
  'file_path',
  'file',
  'path_pattern',
  'pattern',
  'dir',
  'directory',
];

/** Cache do mapa de arquivos por raiz */
const pathIndexCache = new Map<string, Map<string, string>>();

/**
 * Extrai todos os caminhos do [WORKSPACE MAP] e cria índice: basename -> caminho completo
 */
function buildPathIndex(workspaceRoot?: string): Map<string, string> {
  const map = getWorkspaceMap(workspaceRoot);
  const index = new Map<string, string>();
  
  const lines = map.split('\n').slice(1); // Pula o header
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Extrai o caminho (remove indentação)
    const path = trimmed.replace(/^\s+/, '');
    if (!path) continue;
    
    // Índice por basename (ex: use-resize.ts -> front_end/src/hooks/use-resize.ts)
    const basename = path.split('/').pop() || path;
    if (basename && !index.has(basename)) {
      index.set(basename, path);
    }
    
    // Índice por sufixo comum (ex: hooks/use-resize.ts)
    const parts = path.split('/');
    if (parts.length > 1) {
      const suffix = parts.slice(-2).join('/'); // ex: hooks/use-resize.ts
      if (!index.has(suffix)) {
        index.set(suffix, path);
      }
      if (parts.length > 2) {
        const suffix3 = parts.slice(-3).join('/'); // ex: src/hooks/use-resize.ts
        if (!index.has(suffix3)) {
          index.set(suffix3, path);
        }
      }
    }
    
    // Índice pelo caminho completo
    index.set(path, path);
  }
  
  return index;
}

/**
 * Obtém o índice de caminhos para uma raiz (com cache)
 */
export function getPathIndex(workspaceRoot?: string): Map<string, string> {
  const root = workspaceRoot || '';
  if (pathIndexCache.has(root)) {
    return pathIndexCache.get(root)!;
  }
  const index = buildPathIndex(workspaceRoot);
  pathIndexCache.set(root, index);
  return index;
}

/**
 * Limpa o cache de índice de caminhos
 */
export function clearPathIndexCache(): void {
  pathIndexCache.clear();
}

/**
 * Normaliza um caminho usando o índice do workspace
 * Retorna o caminho normalizado ou o original se não encontrar correspondência
 */
export function normalizePath(rawPath: string, workspaceRoot?: string): string {
  if (!rawPath || typeof rawPath !== 'string') return rawPath;
  
  // Caminho absoluto ou já normalizado (começa com / ou é caminho completo no workspace)
  if (rawPath.startsWith('/') || rawPath.startsWith('.')) {
    return rawPath;
  }
  
  const index = getPathIndex(workspaceRoot);
  
  // 1. Match exato pelo basename (ex: interaction-math.ts -> github-edit-view/src/lib/interaction-math.ts)
  const basename = rawPath.split('/').pop() || rawPath;
  if (index.has(basename)) {
    const normalized = index.get(basename)!;
    console.log(`[PATH NORMALIZER] ${rawPath} -> ${normalized} (basename match)`);
    return normalized;
  }
  
  // 2. Match por sufixo comum (ex: lib/interaction-math.ts, src/lib/interaction-math.ts)
  const rawParts = rawPath.split('/');
  for (let i = 1; i <= rawParts.length; i++) {
    const suffix = rawParts.slice(-i).join('/');
    if (index.has(suffix)) {
      const normalized = index.get(suffix)!;
      console.log(`[PATH NORMALIZER] ${rawPath} -> ${normalized} (suffix match: ${suffix})`);
      return normalized;
    }
  }
  
  // 3. Match por substring (último recurso) - procura chave que contenha o rawPath
  for (const [key, value] of index.entries()) {
    if (key !== rawPath && key.includes(rawPath)) {
      console.log(`[PATH NORMALIZER] ${rawPath} -> ${value} (substring match)`);
      return value;
    }
  }
  
  // 4. Fallback: busca fuzzy - verifica se o rawPath é prefixo de alguma chave
  for (const [key, value] of index.entries()) {
    if (key.endsWith(rawPath)) {
      console.log(`[PATH NORMALIZER] ${rawPath} -> ${value} (endsWith match)`);
      return value;
    }
  }
  
  // Sem match: retorna original
  console.log(`[PATH NORMALIZER] ${rawPath} -> (sem match, mantendo original)`);
  return rawPath;
}

/**
 * Normaliza argumentos de tool_call que contenham caminhos
 */
export function normalizeToolCallArgs(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot?: string
): Record<string, unknown> {
  if (!PATH_TOOL_NAMES.has(toolName.toLowerCase())) {
    return args;
  }
  
  const normalized = { ...args };
  
  for (const key of PATH_ARG_KEYS) {
    if (normalized[key] && typeof normalized[key] === 'string') {
      const original = normalized[key];
      const normalizedPath = normalizePath(original, workspaceRoot);
      if (normalizedPath !== original) {
        normalized[key] = normalizedPath;
        console.log(`[PATH NORMALIZER] ${toolName}.${key}: ${original} -> ${normalizedPath}`);
      }
    }
  }
  
  // Também normaliza em arrays de caminhos
  for (const [key, value] of Object.entries(normalized)) {
    if (Array.isArray(value)) {
      normalized[key] = value.map(v => 
        typeof v === 'string' ? normalizePath(v, workspaceRoot) : v
      );
    }
  }
  
  return normalized;
}

/**
 * Normaliza tool_calls em lote (usado no executor)
 */
export function normalizeToolCalls(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
  workspaceRoot?: string
): Array<{ name: string; arguments: Record<string, unknown> }> {
  return toolCalls.map(tc => ({
    ...tc,
    arguments: normalizeToolCallArgs(tc.name, tc.arguments, workspaceRoot),
  }));
}