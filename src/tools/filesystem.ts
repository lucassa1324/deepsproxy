/*
 * File: filesystem.ts
 * Project: deepsproxy
 * Gateway HTTP Puro (Pass-through com Sanitização e Anti-Preguiça).
 *
 * Este módulo NÃO registra nem executa nenhuma ferramenta de filesystem no
 * disco do servidor. O proxy apenas repassa as Tool Calls do modelo no payload
 * HTTP/SSE para a IDE (ex.: Trae) resolver no workspace do usuário. A execução
 * local de ferramentas (ls/glob/grep/read/write/edit/delete/bash) foi removida
 * por design — o servidor jamais lê, edita ou deleta arquivos.
 */

/** Registra as tools de filesystem do agente nativo (desativado no gateway puro). */
export function registerFilesystemTools(): void {
  // No-op: execução de I/O local foi removida. As Tool Calls do modelo
  // atravessam o proxy sem execução — a IDE resolve no workspace do usuário.
  console.log('[gateway] filesystem tools desativadas (gateway puro, sem I/O local).');
}