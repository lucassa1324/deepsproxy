/*
 * File: web-search.ts
 * Project: deepsproxy
 * Tool de busca na web (`web_search`) com orquestração de provedores:
 * tenta cada provedor em ordem, valida o formato dos resultados e só devolve
 * quando encontra itens utilizáveis. Hoje o único provedor é o DuckDuckGo HTML
 * (gratuito, sem API key); novos provedores podem ser registrados sem alterar
 * a rota/tool.
 */

import { registry } from './registry.ts';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  id: string;
  name: string;
  search(query: string, maxResults: number): Promise<WebSearchResult[]>;
}

export interface WebSearchAttempt {
  providerId: string;
  providerName: string;
  ok: boolean;
  resultCount: number;
  error?: string;
}

export interface WebSearchOutcome {
  results: WebSearchResult[];
  providerId: string | null;
  attempts: WebSearchAttempt[];
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

function normalizeResults(raw: unknown, maxResults: number): WebSearchResult[] {
  if (!Array.isArray(raw)) return [];
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const title = String((item as any).title || '').trim();
    const url = String((item as any).url || '').trim();
    const snippet = String((item as any).snippet || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (!title && !snippet) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title || url, url, snippet });
    if (out.length >= maxResults) break;
  }
  return out;
}

const duckDuckGoProvider: WebSearchProvider = {
  id: 'duckduckgo',
  name: 'DuckDuckGo HTML',
  async search(query, maxResults) {
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
  },
};

let providers: WebSearchProvider[] = [duckDuckGoProvider];

export function getWebSearchProviders(): WebSearchProvider[] {
  return [...providers];
}

export function setWebSearchProviders(list: WebSearchProvider[]): void {
  providers = Array.isArray(list) ? [...list] : [];
}

export function resetWebSearchProviders(): void {
  providers = [duckDuckGoProvider];
}

function maxProviders(): number {
  const parsed = parseInt(process.env.WEB_SEARCH_MAX_PROVIDERS || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 3;
  return Math.min(parsed, 10);
}

export async function searchWebDetailed(
  query: string,
  maxResults = 5
): Promise<WebSearchOutcome> {
  const attempts: WebSearchAttempt[] = [];
  let lastError: Error | null = null;
  let lastHardError: Error | null = null;

  for (const provider of providers.slice(0, maxProviders())) {
    try {
      const results = normalizeResults(await provider.search(query, maxResults), maxResults);
      attempts.push({
        providerId: provider.id,
        providerName: provider.name,
        ok: results.length > 0,
        resultCount: results.length,
      });
      if (results.length > 0) {
        return { results, providerId: provider.id, attempts };
      }
      lastError = new Error(`provedor ${provider.id} não retornou resultados válidos`);
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      lastHardError = lastError;
      attempts.push({
        providerId: provider.id,
        providerName: provider.name,
        ok: false,
        resultCount: 0,
        error: lastError.message,
      });
      console.warn(`[web-search] provedor ${provider.id} falhou: ${lastError.message}`);
    }
  }

  if (attempts.length === 0) {
    throw new Error('Busca web: nenhum provedor configurado.');
  }
  if (lastHardError) {
    throw new Error(`Busca web falhou em todos os provedores: ${lastHardError.message}`);
  }
  return { results: [], providerId: null, attempts };
}

export async function webSearch(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const outcome = await searchWebDetailed(query, maxResults);
  return outcome.results;
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
