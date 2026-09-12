import test from 'node:test';
import assert from 'node:assert';

process.env.PROVIDER = 'local';
process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

// Isola os testes do registro de provedores persistido no disco. Arquivo
// próprio: outros arquivos de teste usam arquivos diferentes, pois os
// processos rodam em paralelo e compartilhar o mesmo arquivo causa corrida.
process.env.PROVIDERS_FILE = join(process.cwd(), '.test-providers-tools.json');
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
if (existsSync(process.env.PROVIDERS_FILE!)) rmSync(process.env.PROVIDERS_FILE!);

import { app } from './index.ts';

function setupLocalFetchMock(handler: (url: string, init?: RequestInit) => Response) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (/^http:\/\/localhost:\d+/.test(urlStr)) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('config: POST /api/providers updates the registry and persists via cookie', async () => {
  const restore = setupLocalFetchMock((url) => {
    assert.ok(url.endsWith('/models'), 'upstream /models must be hit after config change');
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'qwen2', object: 'model', owned_by: 'local' }] }),
      { status: 200 }
    );
  });

  try {
    const postReq = new Request('http://localhost/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active: 'p1',
        providers: [
          {
            id: 'p1',
            name: 'Ollama',
            type: 'openai-compatible',
            baseUrl: 'http://localhost:1234/v1',
            model: 'qwen2',
            apiKey: 'sekret',
          },
        ],
      }),
    });
    const postRes = await app.fetch(postReq);
    assert.strictEqual(postRes.status, 200);
    const setCookie = postRes.headers.get('Set-Cookie') || '';
    assert.ok(setCookie.includes('deepsproxy_providers='), 'must set the providers cookie');
    const cfg = await postRes.json();
    assert.strictEqual(cfg.ok, true);
    assert.strictEqual(cfg.active, 'p1');
    assert.strictEqual(cfg.providers[0].baseUrl, 'http://localhost:1234/v1');
    assert.strictEqual(cfg.providers[0].model, 'qwen2');

    // Sem cookie (cliente CLI): o registro em memória cobre a última config salva.
    const modelsRes = await app.fetch(new Request('http://localhost/v1/models'));
    const modelsData = await modelsRes.json();
    assert.ok(modelsData.data.some((m: any) => m.id === 'qwen2'));
  } finally {
    restore();
  }
});
