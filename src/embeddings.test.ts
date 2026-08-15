import test from 'node:test';
import assert from 'node:assert';

process.env.PROVIDER = 'local';
process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
process.env.LLM_MODEL = 'llama3.2';

// Isola os testes do registro de provedores persistido no disco. Usa um
// arquivo próprio (outros arquivos de teste usam .test-providers.json; como
// os processos rodam em paralelo, compartilhar o mesmo arquivo causa corrida).
process.env.PROVIDERS_FILE = join(process.cwd(), '.test-providers-embeddings.json');
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
if (existsSync(process.env.PROVIDERS_FILE!)) rmSync(process.env.PROVIDERS_FILE!);

import { app } from './index.ts';

function setupLocalFetchMock(handler: (url: string, init?: RequestInit) => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.startsWith(process.env.LLM_BASE_URL!)) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('/v1/embeddings: roteia e repassa a resposta OpenAI-compatível', async () => {
  const state: { captured: { url: string; body: any } | null } = { captured: null };
  const restore = setupLocalFetchMock((url, init) => {
    state.captured = { url, body: JSON.parse((init?.body as string) || '{}') };
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: 'nomic-embed-text',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  try {
    const req = new Request('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: 'olá mundo' }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.object, 'list');
    assert.deepStrictEqual(data.data[0].embedding, [0.1, 0.2, 0.3]);

    assert.ok(state.captured, 'deve ter feito fetch no upstream');
    assert.ok(state.captured.url.endsWith('/embeddings'), `URL deve apontar para /embeddings: ${state.captured.url}`);
    assert.strictEqual(state.captured.body.model, 'nomic-embed-text');
    assert.strictEqual(state.captured.body.input, 'olá mundo');
  } finally {
    restore();
  }
});

test('/v1/embeddings: valida corpo sem model ou input', async () => {
  const restore = setupLocalFetchMock(() => new Response('{}', { status: 200 }));
  try {
    let res = await app.fetch(
      new Request('http://localhost/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'oi' }),
      })
    );
    assert.strictEqual(res.status, 400);

    res = await app.fetch(
      new Request('http://localhost/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'x' }),
      })
    );
    assert.strictEqual(res.status, 400);
  } finally {
    restore();
  }
});

test('/v1/embeddings: deepseek (browser) responde 501', async () => {
  process.env.PROVIDER = 'deepseek';
  const restore = setupLocalFetchMock(() => new Response('{}', { status: 200 }));
  try {
    const req = new Request('http://localhost/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-thinking', input: 'oi' }),
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 501);
    const body = await res.json();
    assert.ok(body.error?.message.includes('embeddings'));
  } finally {
    restore();
  }
});
