/*
 * File: web-search.ts
 * Project: deepsproxy
 * Tool de busca na web (`web_search`): registra a tool no registry e expõe a
 * função de busca (DuckDuckGo HTML, sem API key) para a rota /v1/web/search.
 * O resultado são títulos, URLs e trechos — o modelo/agente resume a partir
 * disso.
 */

import { registry } from './registry.ts';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca na web via DuckDuckGo HTML (gratuito, sem API key). Retorna até
 * `maxResults` resultados. Lança erro se a busca falhar.
 */
export async function webSearch(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Busca falhou (HTTP ${resp.status})`);
    const html = await resp.text();

    const results: WebSearchResult[] = [];
    const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles: Array<[string, string]> = [];
    const snippets: string[] = [];
    let m: RegExpExecArray | null;

    while ((m = anchorRe.exec(html)) !== null && titles.length < maxResults) {
      const href = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
      titles.push([stripHtml(m[2]), href]);
    }
    while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
      snippets.push(stripHtml(m[1]));
    }

    for (let i = 0; i < titles.length; i++) {
      results.push({ title: titles[i][0], url: titles[i][1], snippet: snippets[i] || '' });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

/** Registra a tool `web_search` no registry compartilhado (agentes). */
export function registerWebSearchTool(): void {
  registry.register(
    'web_search',
    'Busca resultados na web (títulos, URLs e trechos) para uma consulta. Use para informações atuais que o modelo não conhece.',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Consulta de busca (ex.: "preço do dólar hoje")' },
        max_results: {
          type: 'number',
          description: 'Quantidade de resultados (padrão 5, máximo 10)',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
    },
    async (args) => {
      const query = String(args.query || '').trim();
      if (!query) return { error: 'Consulta vazia.' };
      const max = Math.min(Math.max(Number(args.max_results) || 5, 1), 10);
      const results = await webSearch(query, max);
      if (results.length === 0) {
        return { message: `Nenhum resultado encontrado para "${query}".` };
      }
      return results;
    }
  );
}
