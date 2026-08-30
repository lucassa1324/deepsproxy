/*
 * File: workspace.ts
 * Project: deepsproxy
 * Workspace scanner: varre o sistema de arquivos do projeto para gerar
 * um mapa compacto de arquivos relevantes (.ts, .tsx, .js, .jsx) e
 * injeta como [WORKSPACE MAP] no system prompt.
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, relative, resolve, sep, dirname } from 'path';

/** Diretórios que NUNCA devem ser varridos */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.vercel',
  '.netlify',
  'out',
  '.cache',
  'tmp',
  'temp',
  '.DS_Store',
]);

/** Extensões de arquivo que interessam */
const TARGET_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/** Profundidade máxima de diretórios a varrer */
const MAX_DEPTH = 3;

/** Limite máximo de arquivos no mapa */
const MAX_FILES = 150;

/** Marcadores de raiz de projeto para busca ascendente */
const PROJECT_ROOT_MARKERS = [
  'package.json',
  'front_end',
  'src',
  'tsconfig.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
];

/**
 * Verifica se um caminho deve ser ignorado
 */
function shouldIgnore(path: string): boolean {
  const parts = path.split(sep);
  return parts.some(p => IGNORED_DIRS.has(p));
}

/**
 * Busca ascendente pela raiz do projeto a partir de um diretório inicial.
 * Procura por marcadores de projeto (package.json, front_end/, src/, etc.)
 * Retorna o caminho absoluto da raiz MAIS PROFUNDA (mais interna) encontrada,
 * ou o diretório original como fallback.
 */
export function resolveProjectRoot(startDir: string): string {
  let currentDir = resolve(startDir);
  const rootDir = dirname(currentDir);
  let deepestMatch: string | null = null;

  while (currentDir !== rootDir) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      const markerPath = join(currentDir, marker);
      if (existsSync(markerPath)) {
        deepestMatch = currentDir;
        break;
      }
    }
    
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  if (deepestMatch) {
    console.log(`[PROXY WORKSPACE]: Raiz resolvida em: ${deepestMatch} (mais profunda)`);
    return deepestMatch;
  }

  console.log(`[PROXY WORKSPACE]: Nenhum marcador encontrado. Usando diretório original: ${startDir}`);
  return resolve(startDir);
}

/**
 * Resolve a raiz do workspace considerando prioridades:
 * 1. Variável de ambiente TARGET_WORKSPACE_PATH (compatibilidade)
 * 2. Variável de ambiente USER_WORKSPACE_PATH (caminho do projeto do usuário)
 * 3. Caminho passado explicitamente (projectRoot via request body)
 * 4. Busca ascendente a partir de process.cwd() (fallback - proxy directory)
 */
export function getResolvedWorkspaceRoot(explicitPath?: string): string {
  // 1. TARGET_WORKSPACE_PATH (compatibilidade)
  const targetEnvPath = process.env.TARGET_WORKSPACE_PATH;
  if (targetEnvPath && existsSync(targetEnvPath)) {
    console.log(`[PROXY WORKSPACE]: Usando TARGET_WORKSPACE_PATH: ${targetEnvPath}`);
    return resolve(targetEnvPath);
  }

  // 2. USER_WORKSPACE_PATH - caminho do projeto do usuário (configurável)
  const userEnvPath = process.env.USER_WORKSPACE_PATH;
  if (userEnvPath && existsSync(userEnvPath)) {
    console.log(`[PROXY WORKSPACE]: Usando USER_WORKSPACE_PATH: ${userEnvPath}`);
    return resolve(userEnvPath);
  }

  // 3. Caminho explícito passado (ex: via body da requisição)
  if (explicitPath && existsSync(explicitPath)) {
    console.log(`[PROXY WORKSPACE]: Usando caminho explícito: ${explicitPath}`);
    return resolve(explicitPath);
  }

  // 4. Busca ascendente a partir do cwd (fallback - diretório do proxy)
  console.log(`[PROXY WORKSPACE]: Fallback para busca ascendente a partir de ${process.cwd()}`);
  return resolveProjectRoot(process.cwd());
}

/**
 * Varre recursivamente o workspace a partir da raiz
 */
function scanDir(
  root: string,
  currentDir: string,
  depth: number,
  files: string[]
): void {
  if (depth > MAX_DEPTH) return;
  if (files.length >= MAX_FILES) return;

  try {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;

      const fullPath = join(currentDir, entry.name);
      
      if (shouldIgnore(fullPath)) continue;

      if (entry.isDirectory()) {
        scanDir(root, fullPath, depth + 1, files);
      } else if (entry.isFile()) {
        const ext = fullPath.substring(fullPath.lastIndexOf('.'));
        if (TARGET_EXTS.has(ext)) {
          const relPath = relative(root, fullPath);
          files.push(relPath);
        }
      }
    }
  } catch {
    // Ignora erros de permissão, links quebrados, etc.
  }
}

/**
 * Gera o mapa do workspace como string formatada
 */
export function generateWorkspaceMap(projectRoot?: string): string {
  const root = resolveProjectRoot(projectRoot || process.cwd());
  
  if (!existsSync(root)) {
    return '[WORKSPACE MAP] Diretório raiz não encontrado.';
  }

  const files: string[] = [];
  scanDir(root, root, 0, files);

  if (files.length === 0) {
    return '[WORKSPACE MAP] Nenhum arquivo .ts/.tsx/.js/.jsx encontrado (até 3 níveis, max 150).';
  }

  // Ordena: primeiro por profundidade, depois alfabeticamente
  files.sort((a, b) => {
    const depthA = a.split(sep).length;
    const depthB = b.split(sep).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  const lines = files.map(f => `  ${f}`);
  const header = `[WORKSPACE MAP] ${files.length} arquivo(s) encontrado(s) (max ${MAX_FILES}, profundidade ${MAX_DEPTH}):\n`;
  
  return header + lines.join('\n');
}

/**
 * Cache simples para evitar varreduras repetidas na mesma requisição
 */
let workspaceMapCache: string | null = null;
let workspaceCacheRoot: string | null = null;

/**
 * Obtém o mapa do workspace com cache por requisição
 * O cache é limpo a cada nova requisição HTTP via clearWorkspaceCache()
 * Aceita caminho explícito (ex: body.workspacePath) para override
 */
export function getWorkspaceMap(explicitRoot?: string): string {
  const root = getResolvedWorkspaceRoot(explicitRoot);
  
  if (workspaceMapCache && workspaceCacheRoot === root) {
    return workspaceMapCache;
  }
  
  workspaceMapCache = generateWorkspaceMap(root);
  workspaceCacheRoot = root;
  return workspaceMapCache;
}

/**
 * Limpa o cache do workspace (chamar no início de cada requisição HTTP)
 */
export function clearWorkspaceCache(): void {
  workspaceMapCache = null;
  workspaceCacheRoot = null;
}