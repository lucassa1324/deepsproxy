import test from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';

process.env.PROVIDERS_FILE = join(process.cwd(), '.test-providers-routing.json');
if (existsSync(process.env.PROVIDERS_FILE)) rmSync(process.env.PROVIDERS_FILE);

import { app } from './index.ts';
import { sanitizeRegistry, getRoutingSettings } from './services/config.ts';
import { localApiUrls } from './services/local-url.ts';
import { resetModelCatalogCache } from './services/modelCatalog.ts';
import { clearModelsCache } from './services/local.ts';
import { clearDecisionCache, clearConversationMemory } from './services/auto-router/router.ts';

function cookieFor(registry: any): string {
  return 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));
}

function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (/^http:\/\/localhost:\d+/.test(urlStr)) return handler(urlStr, init);
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

const API_REGISTRY = {
  active: 'api',
  providers: [
    {
      id: 'api',
      name: 'Mock API',
      type: 'openai-compatible',
      baseUrl: 'http://localhost:9231/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      enabled: true,
    },
  ],
};

test('routing: sanitizeRegistry preserva modo/política explícitos', () => {
  const { registry } = sanitizeRegistry({
    active: 'api',
    routing: { mode: 'auto', costPolicy: 'free-only' },
    providers: API_REGISTRY.providers,
  });
  assert.ok(registry);
  assert.deepStrictEqual(getRoutingSettings(registry), {
    mode: 'auto',
    costPolicy: 'free-only',
    source: 'explicit',
  });
});

test('routing: registro legado sem routing continua manual (comportamento clássico)', () => {
  const { registry } = sanitizeRegistry(API_REGISTRY);
  assert.ok(registry);
  assert.strictEqual(getRoutingSettings(registry).mode, 'manual');
});

test('routing: POST /api/routing persiste no cookie e GET devolve o modo', async () => {
  const res = await app.fetch(
    new Request('http://localhost/api/routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieFor(API_REGISTRY) },
      body: JSON.stringify({ mode: 'auto', costPolicy: 'economy' }),
    })
  );
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.routing.mode, 'auto');
  assert.strictEqual(data.routing.costPolicy, 'economy');

  const setCookie = res.headers.get('Set-Cookie') || '';
  assert.ok(setCookie.includes('deepsproxy_providers='));

  const getRes = await app.fetch(
    new Request('http://localhost/api/routing', { headers: { Cookie: setCookie.split(';')[0] } })
  );
  const getData = await getRes.json();
  assert.strictEqual(getData.routing.mode, 'auto');
  assert.strictEqual(getData.routing.costPolicy, 'economy');
  assert.ok(String(getData.endpoints.proxyUrl).includes('127.0.0.1'));
});

test('routing: modo auto roteia modelo desconhecido em request real (HTTP)', async () => {
  let capturedChat: any = null;
  const restore = setupFetchMock((url, init) => {
    if (url.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gpt-4o-mini', object: 'model', owned_by: 'mock' },
            { id: 'gpt-4o', object: 'model', owned_by: 'mock' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith('/chat/completions')) {
      capturedChat = JSON.parse(init?.body as string || '{}');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-auto',
          object: 'chat.completion',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'roteado' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404 });
  });

  try {
    const registry = {
      ...API_REGISTRY,
      routing: { mode: 'auto', costPolicy: 'balanced' },
    };
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieFor(registry) },
        body: JSON.stringify({
          model: 'modelo-inexistente',
          messages: [{ role: 'user', content: 'implemente uma função em TypeScript' }],
          stream: false,
        }),
      })
    );
    assert.strictEqual(res.status, 200);
    assert.ok(capturedChat, 'deve encaminhar ao upstream');
    assert.notStrictEqual(capturedChat.model, 'modelo-inexistente', 'modelo deve ser roteado');
    assert.ok(['gpt-4o-mini', 'gpt-4o'].includes(capturedChat.model));
    assert.strictEqual(res.headers.get('X-Routing-Mode'), 'auto');
    assert.ok(res.headers.get('X-AutoRouter-Model'));
    assert.ok(res.headers.get('X-Request-Id'));
  } finally {
    restore();
  }
});

test('cadeia curta expõe FinalModel/Attempts na resposta 200', async () => {
  const { res, models } = await runAutoRequest({
    port: 9240,
    modelIds: ['mock-single-a'],
    messages: 'tarefa com um único modelo elegível',
    nextResponse: () => okResponse('ok'),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(models.length, 1);
  assert.strictEqual(res.headers.get('X-AutoRouter-FinalModel'), models[0]);
  assert.strictEqual(res.headers.get('X-AutoRouter-Attempts'), '1');
});

test('base URL: localApiUrls expõe localhost, 127.0.0.1 e portas configuráveis', () => {
  const oldPort = process.env.PORT;
  const oldGateway = process.env.GATEWAY_PORT;
  try {
    process.env.PORT = '4123';
    process.env.GATEWAY_PORT = '4124';
    const urls = localApiUrls('http://localhost:4123');
    assert.strictEqual(urls.proxyUrl, 'http://127.0.0.1:4123');
    assert.strictEqual(urls.proxyLocalhostUrl, 'http://localhost:4123');
    assert.strictEqual(urls.gatewayUrl, 'http://127.0.0.1:4124/v1');
    assert.strictEqual(urls.gatewayLocalhostUrl, 'http://localhost:4124/v1');
    assert.strictEqual(urls.requestOrigin, 'http://localhost:4123');

    delete process.env.PORT;
    delete process.env.GATEWAY_PORT;
    const defaults = localApiUrls();
    assert.strictEqual(defaults.proxyUrl, 'http://127.0.0.1:3005');
    assert.strictEqual(defaults.gatewayUrl, 'http://127.0.0.1:3006/v1');
  } finally {
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
    if (oldGateway === undefined) delete process.env.GATEWAY_PORT; else process.env.GATEWAY_PORT = oldGateway;
  }
});

test('routing: alternância auto → manual persiste no cookie', async () => {
  const autoRes = await app.fetch(
    new Request('http://localhost/api/routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieFor(API_REGISTRY) },
      body: JSON.stringify({ mode: 'auto' }),
    })
  );
  const autoCookie = (autoRes.headers.get('Set-Cookie') || '').split(';')[0];
  const manualRes = await app.fetch(
    new Request('http://localhost/api/routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: autoCookie },
      body: JSON.stringify({ mode: 'manual' }),
    })
  );
  const manualData = await manualRes.json();
  assert.strictEqual(manualData.routing.mode, 'manual');
});

async function runAutoRequest(opts: {
  port: number;
  modelIds: string[];
  active?: string;
  messages: string;
  nextResponse: (call: number, model: string) => Response | Promise<Response>;
}): Promise<{ res: Response; models: string[] }> {
  resetModelCatalogCache();
  clearModelsCache();
  clearDecisionCache();
  clearConversationMemory();
  const models: string[] = [];
  const registry = {
    active: opts.active ?? 'api',
    providers: [
      {
        id: 'api',
        name: 'Mock API',
        type: 'openai-compatible',
        baseUrl: `http://localhost:${opts.port}/v1`,
        apiKey: 'sk-test',
        model: opts.modelIds[0],
        enabled: true,
      },
    ],
    routing: { mode: 'auto', costPolicy: 'balanced' },
  };
  const restore = setupFetchMock((url, init) => {
    if (url.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: opts.modelIds.map((id) => ({ id, object: 'model' })) }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(init?.body as string || '{}');
      models.push(body.model);
      return opts.nextResponse(models.length - 1, body.model);
    }
    return new Response('{}', { status: 404 });
  });
  try {
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieFor(registry) },
        body: JSON.stringify({
          model: 'modelo-fora-do-catalogo',
          messages: [{ role: 'user', content: opts.messages }],
          stream: false,
        }),
      })
    );
    return { res, models };
  } finally {
    restore();
  }
}

function okResponse(label: string): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${label}`,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: label }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

test('roteamento sem provedor principal (active vazio) ainda seleciona candidato', async () => {
  const { res } = await runAutoRequest({
    port: 9241,
    modelIds: ['mock-empty-active-a', 'mock-empty-active-b'],
    active: '',
    messages: 'tarefa sem provedor principal',
    nextResponse: () => okResponse('ok'),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('X-Routing-Mode'), 'auto');
});

test('fallback real: erro 429 no primeiro modelo tenta o próximo e conclui', async () => {
  const { res, models } = await runAutoRequest({
    port: 9242,
    modelIds: ['mock-429-a', 'mock-429-b'],
    messages: 'tarefa que enfrenta quota',
    nextResponse: (call) => call === 0
      ? new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      : okResponse('sucesso-apos-429'),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(models.length, 2);
  assert.strictEqual(new Set(models).size, 2, 'não deve repetir o mesmo modelo');
  assert.strictEqual(res.headers.get('X-AutoRouter-Failover'), '1');
  assert.strictEqual(res.headers.get('X-AutoRouter-Attempts'), '2');
});

test('fallback real: erro 5xx no primeiro modelo tenta o próximo e conclui', async () => {
  const { res, models } = await runAutoRequest({
    port: 9243,
    modelIds: ['mock-5xx-a', 'mock-5xx-b'],
    messages: 'tarefa com erro interno',
    nextResponse: (call) => call === 0
      ? new Response('upstream explodiu', { status: 503 })
      : okResponse('sucesso-apos-5xx'),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(models.length, 2);
});

test('erro permanente (401) NÃO dispara fallback', async () => {
  const { res, models } = await runAutoRequest({
    port: 9244,
    modelIds: ['mock-401-a', 'mock-401-b'],
    messages: 'tarefa com chave inválida',
    nextResponse: () => new Response(
      JSON.stringify({ error: { message: 'invalid api key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    ),
  });
  // O passthrough preserva o contrato do proxy (erro upstream vira 502), mas o
  // corpo com "invalid api key" é classificado como permanente: sem novo fallback.
  assert.strictEqual(res.status, 502);
  assert.strictEqual(models.length, 1);
  assert.strictEqual(res.headers.get('X-AutoRouter-FinalModel'), models[0]);
});

test('limite de tentativas (AUTO_MAX_ATTEMPTS=1) impede segundo modelo', async () => {
  const old = process.env.AUTO_MAX_ATTEMPTS;
  process.env.AUTO_MAX_ATTEMPTS = '1';
  try {
    const { res, models } = await runAutoRequest({
      port: 9245,
      modelIds: ['mock-limit-a', 'mock-limit-b'],
      messages: 'tarefa com limite de tentativas',
      nextResponse: () => new Response('falha', { status: 500 }),
    });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(models.length, 1);
    assert.strictEqual(res.headers.get('X-AutoRouter-Attempts'), '1');
  } finally {
    if (old === undefined) delete process.env.AUTO_MAX_ATTEMPTS; else process.env.AUTO_MAX_ATTEMPTS = old;
  }
});

test('timeout da tentativa cai para o próximo modelo', async () => {
  const old = process.env.AUTO_ATTEMPT_TIMEOUT_MS;
  process.env.AUTO_ATTEMPT_TIMEOUT_MS = '5000';
  try {
    const { res, models } = await runAutoRequest({
      port: 9246,
      modelIds: ['mock-timeout-a', 'mock-timeout-b'],
      messages: 'tarefa que demora demais',
      nextResponse: (call) => call === 0 ? new Promise<Response>(() => {}) : okResponse('sucesso-apos-timeout'),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(models.length, 2);
  } finally {
    if (old === undefined) delete process.env.AUTO_ATTEMPT_TIMEOUT_MS; else process.env.AUTO_ATTEMPT_TIMEOUT_MS = old;
  }
});

test('routing: modo auto respeita modelo explícito conhecido', async () => {
  let capturedChat: any = null;
  const restore = setupFetchMock((url, init) => {
    if (url.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith('/chat/completions')) {
      capturedChat = JSON.parse(init?.body as string || '{}');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-fixed',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404 });
  });

  try {
    const registry = { ...API_REGISTRY, routing: { mode: 'auto', costPolicy: 'balanced' } };
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieFor(registry) },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'oi' }],
          stream: false,
        }),
      })
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedChat.model, 'gpt-4o-mini');
    assert.strictEqual(res.headers.get('X-AutoRouter-Model'), null);
  } finally {
    restore();
  }
});
