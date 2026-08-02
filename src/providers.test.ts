import test from 'node:test';
import assert from 'node:assert';

// Sem PROVIDER=local no env: o fallback padrão é DeepSeek. Os testes abaixo
// usam o cookie de provedores para apontar para um upstream OpenAI-compatível.
import { app } from './index.ts';

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response) {
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

function cookieFor(registry: any): string {
  return 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));
}

const OPENAI_REGISTRY = {
  active: 'openai',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:9123/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
    },
  ],
};

test('registry: cookie-switched provider receives /v1/chat/completions (client model respected)', async () => {
  let capturedBody: any = null;
  const restore = setupFetchMock((url, init) => {
    assert.ok(url.includes('/chat/completions'));
    capturedBody = JSON.parse(init?.body as string || '{}');
    return new Response(
      JSON.stringify({
        id: 'x',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'do openai-compatible', finish_reason: 'stop' } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieFor(OPENAI_REGISTRY) },
      body: JSON.stringify({
        model: 'qualquer',
        messages: [{ role: 'user', content: 'oi' }],
        stream: false,
      }),
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, 'do openai-compatible');
    assert.ok(capturedBody, 'must forward to the upstream provider');
    assert.strictEqual(capturedBody.model, 'qualquer', 'requested model must be respected');
  } finally {
    restore();
  }
});

test('registry: /v1/models with cookie lists the active provider models', async () => {
  const restore = setupFetchMock((url) => {
    assert.ok(url.endsWith('/models'));
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model', owned_by: 'openai' }] }),
      { status: 200 }
    );
  });

  try {
    const res = await app.fetch(
      new Request('http://localhost/v1/models', { headers: { Cookie: cookieFor(OPENAI_REGISTRY) } })
    );
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.data.some((m: any) => m.id === 'gpt-test'));
  } finally {
    restore();
  }
});

test('registry: /api/status reports the active provider without leaking the apiKey', async () => {
  const restore = setupFetchMock(() => {
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'llama', object: 'model' }] }),
      { status: 200 }
    );
  });

  try {
    const res = await app.fetch(
      new Request('http://localhost/api/status', { headers: { Cookie: cookieFor(OPENAI_REGISTRY) } })
    );
    const st = await res.json();
    assert.strictEqual(st.provider.name, 'OpenAI');
    assert.strictEqual(st.provider.type, 'openai-compatible');
    assert.strictEqual(st.provider.hasApiKey, true);
    assert.ok(!('apiKey' in st.provider), 'apiKey must not be in /api/status');
  } finally {
    restore();
  }
});

test('registry: /api/models?baseUrl= lists models of an edited (non-active) provider', async () => {
  const restore = setupFetchMock((url) => {
    assert.ok(url.includes('/models'), 'must fetch upstream models');
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'editable-model', object: 'model' }] }),
      { status: 200 }
    );
  });

  try {
    const res = await app.fetch(
      new Request('http://localhost/api/models?baseUrl=' + encodeURIComponent('http://localhost:9123/v1'))
    );
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.data.some((m: any) => m.id === 'editable-model'));
  } finally {
    restore();
  }
});

test('registry: POST /api/providers rejects an empty registry', async () => {
  const res = await app.fetch(
    new Request('http://localhost/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: '', providers: [] }),
    })
  );
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

test('registry: default (no cookie, no env override) routes to DeepSeek backend', async () => {
  // Sem cookie e sem env local: o fallback é deepseek -> o caminho Playwright
  // é tentado (Playwright não inicializado em testes) e a resposta é um 500
  // com erro de Playwright, não um forward para upstream OpenAI.
  const restore = setupFetchMock(() => {
    throw new Error('upstream OpenAI-compatível não deve ser chamado no fallback deepseek');
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'oi' }] }),
    });
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 500);
  } finally {
    restore();
  }
});

test('registry: POST /api/models/refresh clears cache and force-fetches models', async () => {
  const restore = setupFetchMock((url) => {
    assert.ok(url.endsWith('/models'), 'must force-fetch upstream /models');
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'qween', object: 'model' }] }),
      { status: 200 }
    );
  });

  try {
    const res = await app.fetch(
      new Request('http://localhost/api/models/refresh', {
        method: 'POST',
        headers: { Cookie: cookieFor(OPENAI_REGISTRY) },
      })
    );
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.data.some((m: any) => m.id === 'qween'));
    assert.ok(data.data.some((m: any) => m.id === 'gpt-test'), 'includes provider.model override');
  } finally {
    restore();
  }
});

test('registry: /api/models with configured provider does NOT fall back to deepseek', async () => {
  // Provedor habilitado, upstream fora do ar e SEM model definido:
  // não deve aparecer "deepseek-thinking/no-thinking" (que roteariam errado),
  // e sim a lista real (vazia).
  const registry = {
    active: 'off',
    providers: [{ id: 'off', name: 'Fora', type: 'openai-compatible', baseUrl: 'http://localhost:9123/v1', apiKey: '', model: '', enabled: true }],
  };
  const restore = setupFetchMock(() => {
    throw new Error('upstream fora do ar');
  });

  try {
    const res = await app.fetch(
      new Request('http://localhost/api/models', { headers: { Cookie: cookieFor(registry) } })
    );
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data.data, [], 'must not show deepseek models when a provider is configured');
  } finally {
    restore();
  }
});
