/*
 * File: sse.ts
 * Project: deepsproxy
 * Keep-alive para streams SSE longos: enquanto o modelo "pensa", nenhum byte
 * é escrito no socket e proxies/clientes com timeout encerram a conexão. Este
 * helper escreve um comentário SSE (`: ping`) periodicamente, mantendo a
 * conexão viva sem que o cliente enxergue nada (comentários são ignorados).
 */

export const SSE_KEEPALIVE_MS = 15_000;

/**
 * Inicia um intervalo que escreve `: ping` a cada `SSE_KEEPALIVE_MS`.
 * Retorna uma função que interrompe o intervalo.
 */
export function startKeepAlive(write: (chunk: string) => Promise<void>): () => void {
  const timer = setInterval(() => {
    write(': ping\n\n').catch(() => {});
  }, SSE_KEEPALIVE_MS);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  return () => clearInterval(timer);
}
