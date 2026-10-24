import test from 'node:test';
import assert from 'node:assert';
import {
  webSearch,
  searchWebDetailed,
  setWebSearchProviders,
  resetWebSearchProviders,
} from './web-search.ts';
import { app } from '../index.ts';

function setupFetchMock(handler: (url: string) => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('html.duckduckgo.com')) {
      return handler(urlStr);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

const SAMPLE_HTML = `
<div class="result results_links">
  <a class="result__a" href="https://example.com/1">Título &amp; exemplo</a>
  <div class="result__snippet">
    <a class="result__snippet" href="https://example.com/1">Trecho <b>destacado</b> da página</a>
  </div>
</div>
<div class="result results_links">
  <a class="result__a" href="//example.com/2">Segundo resultado</a>
  <div class="result__snippet">
    <a class="result__snippet" href="https://example.com/2">Outro trecho</a>
  </div>
</div>
`;

test('webSearch: parseia títulos, URLs e trechos do HTML do DuckDuckGo', async () => {
  const state: { calledWith: string | null } = { calledWith: null };
  const restore = setupFetchMock((url) => {
    state.calledWith = url;
    return new Response(SAMPLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  });
  try {
    const results = await webSearch('teste', 5);
    assert.ok(state.calledWith && state.calledWith.includes('q=teste'), 'deve enviar a query codificada');
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].title, 'Título & exemplo');
    assert.strictEqual(results[0].url, 'https://example.com/1');
    assert.ok(results[0].snippet.includes('destacado'));
    assert.strictEqual(results[1].title, 'Segundo resultado');
    assert.strictEqual(results[1].url, 'https://example.com/2');
    assert.ok(results[1].snippet.includes('Outro trecho'));
  } finally {
    restore();
  }
});

test('webSearch: respeita o limite maxResults', async () => {
  const restore = setupFetchMock(() => new Response(SAMPLE_HTML, { status: 200 }));
  try {
    const results = await webSearch('teste', 1);
    assert.strictEqual(results.length, 1);
  } finally {
    restore();
  }
});

test('webSearch: erro HTTP é propagado como exceção', async () => {
  const restore = setupFetchMock(() => new Response('erro', { status: 503 }));
  try {
    await assert.rejects(() => webSearch('teste', 5), /503/);
  } finally {
    restore();
  }
});

test('POST /v1/web/search: rota devolve resultados em JSON', async () => {
  const restore = setupFetchMock(() => new Response(SAMPLE_HTML, { status: 200 }));
  try {
    const req = new Request('http://localhost/v1/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'deepseek' }),
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.query, 'deepseek');
    assert.strictEqual(data.results.length, 2);
  } finally {
    restore();
  }
});

test('POST /v1/web/search: valida query vazia', async () => {
  const restore = setupFetchMock(() => new Response('{}', { status: 200 }));
  try {
    const req = new Request('http://localhost/v1/web/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '   ' }),
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 400);
  } finally {
    restore();
  }
});

test('orquestrador de busca: provedor com erro cai para o próximo e valida resultados', async () => {
  setWebSearchProviders([
    {
      id: 'broken',
      name: 'Broken',
      async search() { throw new Error('HTTP 503'); },
    },
    {
      id: 'good',
      name: 'Good',
      async search() {
        return [
          { title: 'Válido', url: 'https://example.com/a', snippet: 'ok' },
          { title: 'Inválido', url: 'javascript:alert(1)', snippet: 'x' },
          { title: 'Duplicado', url: 'https://example.com/a', snippet: 'dup' },
          { title: '', url: '', snippet: '' },
        ];
      },
    },
  ]);
  try {
    const outcome = await searchWebDetailed('teste', 5);
    assert.strictEqual(outcome.providerId, 'good');
    assert.strictEqual(outcome.results.length, 1);
    assert.strictEqual(outcome.results[0].url, 'https://example.com/a');
    assert.strictEqual(outcome.attempts.length, 2);
    assert.strictEqual(outcome.attempts[0].ok, false);
    assert.match(outcome.attempts[0].error || '', /503/);
    assert.strictEqual(outcome.attempts[1].ok, true);
  } finally {
    resetWebSearchProviders();
  }
});

test('orquestrador de busca: resultados vazios tentam próximo provedor', async () => {
  setWebSearchProviders([
    { id: 'empty', name: 'Empty', async search() { return []; } },
    {
      id: 'filled',
      name: 'Filled',
      async search() { return [{ title: 'T', url: 'https://example.com/b', snippet: 'S' }]; },
    },
  ]);
  try {
    const outcome = await searchWebDetailed('teste', 5);
    assert.strictEqual(outcome.providerId, 'filled');
    assert.strictEqual(outcome.results.length, 1);
  } finally {
    resetWebSearchProviders();
  }
});

test('orquestrador de busca: nenhum provedor elegível falha com erro claro', async () => {
  setWebSearchProviders([]);
  try {
    await assert.rejects(
      () => searchWebDetailed('teste', 5),
      /nenhum provedor configurado/i
    );
  } finally {
    resetWebSearchProviders();
  }
});

test('orquestrador de busca: timeout de um provedor cai para o próximo', async () => {
  setWebSearchProviders([
    {
      id: 'slow',
      name: 'Slow',
      async search() { throw new Error('The operation was aborted due to timeout'); },
    },
    {
      id: 'fast',
      name: 'Fast',
      async search() { return [{ title: 'T', url: 'https://example.com/c', snippet: 'S' }]; },
    },
  ]);
  try {
    const outcome = await searchWebDetailed('teste', 5);
    assert.strictEqual(outcome.providerId, 'fast');
    assert.strictEqual(outcome.results[0].url, 'https://example.com/c');
    assert.match(outcome.attempts[0].error || '', /timeout/i);
  } finally {
    resetWebSearchProviders();
  }
});

test('orquestrador de busca: todos sem resultados devolve lista vazia (não erro)', async () => {
  setWebSearchProviders([
    { id: 'empty-a', name: 'A', async search() { return []; } },
    { id: 'empty-b', name: 'B', async search() { return []; } },
  ]);
  try {
    const outcome = await searchWebDetailed('teste', 5);
    assert.strictEqual(outcome.results.length, 0);
    assert.strictEqual(outcome.providerId, null);
    assert.strictEqual(outcome.attempts.length, 2);
  } finally {
    resetWebSearchProviders();
  }
});
