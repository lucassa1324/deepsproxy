import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'deepsproxy-gateway-'));
process.env.GATEWAY_FILE = join(tmp, 'apps.json');

import {
  createApp,
  updateApp,
  deleteApp,
  regenerateAppKey,
  getAppByKey,
  getAppById,
  listApps,
  generateVirtualKey,
  hashVirtualKey,
  isVirtualKeyFormat,
  extractBearerToken,
  resolveAppForRequest,
  resetAppsCache,
} from './services/gateway.ts';
import { resetModelCatalogCache } from './services/modelCatalog.ts';

test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('gateway: chave virtual tem formato e hash estável', () => {
  const key = generateVirtualKey('Trae Work');
  assert.ok(key.startsWith('app_trae-work_'));
  assert.ok(isVirtualKeyFormat(key));
  assert.ok(!isVirtualKeyFormat('sk-teste'));
  assert.equal(hashVirtualKey(key), hashVirtualKey(key));
  assert.equal(extractBearerToken('Bearer ' + key), key);
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Basic abc'), null);
});

test('gateway: cria app, persiste e resolve pela chave', () => {
  resetAppsCache();
  const { app, apiKey } = createApp({ name: 'Trae', model: 'gpt-test' });
  assert.ok(app.id);
  assert.ok(apiKey.startsWith('app_trae_'));
  assert.equal(getAppByKey(apiKey)?.id, app.id);
  // A chave não pode ser recuperada em texto plano depois.
  assert.ok(!listApps().some((a) => 'apiKey' in a));
  assert.ok(existsSync(process.env.GATEWAY_FILE!));

  const ctx = resolveAppForRequest('Bearer ' + apiKey);
  assert.ok(ctx && 'app' in ctx);
  if (ctx && 'app' in ctx) {
    assert.equal(ctx.app.name, 'Trae');
    assert.equal(ctx.app.providerId, undefined);
    assert.equal(ctx.model, 'gpt-test');
  }
});

test('gateway: resolveAppForRequest ignora requisições sem chave virtual', () => {
  assert.equal(resolveAppForRequest('Bearer sk-admin'), null);
  assert.equal(resolveAppForRequest(undefined), null);
  assert.equal(resolveAppForRequest('Basic abc'), null);
});

test('gateway: chave inválida e app desativada', () => {
  resetAppsCache();
  const { apiKey } = createApp({ name: 'Cursor', model: 'gpt-test' });

  const invalid = resolveAppForRequest('Bearer app_fake_xxxxxxxxxxxx');
  assert.ok(invalid && 'error' in invalid);
  if (invalid && 'error' in invalid) assert.equal(invalid.status, 401);

  // App desabilitada -> 403.
  updateApp(getAppByKey(apiKey)!.id, { enabled: false });
  const disabled = resolveAppForRequest('Bearer ' + apiKey);
  assert.ok(disabled && 'error' in disabled);
  if (disabled && 'error' in disabled) assert.equal(disabled.status, 403);
});

test('gateway: update/delete/regenerate', () => {
  resetAppsCache();
  const { app, apiKey } = createApp({ name: 'N8N', model: 'gpt-test' });
  const id = app.id;

  assert.ok(updateApp(id, { name: 'N8N Pro', model: 'deepseek-thinking' }));
  const updated = getAppById(id);
  assert.ok(updated);
  assert.equal(updated!.name, 'N8N Pro');
  assert.equal(updated!.model, 'deepseek-thinking');

  // Regeneração revoga a chave antiga e gera uma nova válida.
  const regen = regenerateAppKey(id);
  assert.ok(regen);
  assert.notEqual(regen!.apiKey, apiKey);
  assert.equal(getAppByKey(apiKey), null);
  assert.equal(getAppByKey(regen!.apiKey)?.id, id);

  assert.ok(deleteApp(id));
  assert.equal(getAppById(id), null);
  assert.ok(!deleteApp(id)); // já foi removida
});

test('gateway e2e: porta 3005 respeita o model do cliente e roteia pelo catálogo', async () => {
  resetAppsCache();
  resetModelCatalogCache();
  const registry = {
    active: 'openai',
    providers: [
      { id: 'openai', name: 'OpenAI', type: 'openai-compatible', baseUrl: 'http://localhost:9123/v1', apiKey: 'sk-test', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  const { app } = await import('./index.ts');

  let capturedModel: string | null = null;
  let capturedAuth: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-test' }, { id: 'gpt-gateway' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body));
      capturedModel = body.model;
      capturedAuth = (init?.headers as Record<string, string>)?.authorization || null;
      return new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok', finish_reason: 'stop' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  };

  try {
    // Modelo conhecido no catálogo -> roteia para o dono (OpenAI), respeitando
    // o model enviado pelo cliente (porta direta).
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'oi' }],
        stream: false,
      }),
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.equal(capturedModel, 'gpt-test');
    assert.equal(capturedAuth, 'Bearer sk-test');
    assert.ok(data.choices?.[0]?.message?.content);

    // Modelo desconhecido -> fallback para o provedor principal.
    const fallback = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        model: 'qualquer-coisa',
        messages: [{ role: 'user', content: 'oi' }],
        stream: false,
      }),
    });
    assert.equal(fallback.status, 200);
    assert.equal(capturedModel, 'qualquer-coisa');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gateway e2e: porta 3006 exige chave virtual e roteia pelo painel', async () => {
  resetAppsCache();
  resetModelCatalogCache();
  const registry = {
    active: 'openai',
    providers: [
      { id: 'openai', name: 'OpenAI', type: 'openai-compatible', baseUrl: 'http://localhost:9123/v1', apiKey: 'sk-test', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  const { gatewayApp } = await import('./index.ts');

  // Sem chave virtual -> 401 (a IDE não pode ignorar o painel).
  const noKey = await gatewayApp.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'oi' }], stream: false }),
  });
  assert.equal(noKey.status, 401);

  // Chave inválida -> 401.
  const badKey = await gatewayApp.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Authorization: 'Bearer app_fake_xxxxxxxx' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'oi' }], stream: false }),
  });
  assert.equal(badKey.status, 401);

  let capturedModel: string | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-test' }, { id: 'gpt-gateway' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/chat/completions')) {
      capturedModel = JSON.parse(String(init?.body)).model;
      return new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok', finish_reason: 'stop' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  };

  try {
    // Cria app pelo dashboard do gateway (sem provedor — apenas o modelo).
    const createRes = await gatewayApp.request('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'IDE', model: 'gpt-gateway' }),
    });
    assert.equal(createRes.status, 201);
    const created: any = await createRes.json();
    const apiKey = created.apiKey;
    assert.ok(apiKey.startsWith('app_ide_'));
    assert.equal(created.app.providerId, undefined);

    // Com chave virtual válida: o model enviado pela IDE é IGNORADO e o do
    // painel ("gpt-gateway") é injetado no upstream.
    const res = await gatewayApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: 'qualquer-coisa', messages: [{ role: 'user', content: 'oi' }], stream: false }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedModel, 'gpt-gateway');

    // /v1/models no gateway aceita a chave virtual e devolve a lista de modelos.
    const modelsRes = await gatewayApp.request('/v1/models', {
      headers: { Cookie: cookie, Authorization: 'Bearer ' + apiKey },
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson: any = await modelsRes.json();
    assert.ok(Array.isArray(modelsJson.data));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gateway e2e: /api/models/catalog agrupa modelos por provedor', async () => {
  resetModelCatalogCache();
  const registry = {
    active: 'openai',
    providers: [
      { id: 'openai', name: 'OpenAI', type: 'openai-compatible', baseUrl: 'http://localhost:9123/v1', apiKey: 'sk-test', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  const { app } = await import('./index.ts');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-test' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.request('/api/models/catalog', {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.ok(Array.isArray(data.models));
    const entry = data.models.find((m: any) => m.id === 'gpt-test');
    assert.ok(entry);
    assert.equal(entry.provider, 'openai');
    assert.equal(entry.providerName, 'OpenAI');
    assert.equal(entry.baseUrl, 'http://localhost:9123/v1');
    assert.equal(entry.apiKey, 'sk-test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gateway e2e: /api/settings/token-economy GET/PATCH', async () => {
  const { app } = await import('./index.ts');
  const { resetEconomyCache } = await import('./services/token-economy.ts');
  const tmpFile = join(tmpdir(), 'deepsproxy-economy-e2e.json');

  const prevFile = process.env.ECONOMY_FILE;
  process.env.ECONOMY_FILE = tmpFile;
  resetEconomyCache();
  try {
    const getRes = await app.request('/api/settings/token-economy');
    assert.equal(getRes.status, 200);
    const before: any = await getRes.json();
    assert.equal(before.settings.enabled, false);

    const patchRes = await app.request('/api/settings/token-economy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        cachePrefix: true,
        truncateHistory: true,
        summarizeHistory: false,
        stripReasoning: true,
        truncateToolOutput: false,
        responseCache: true,
        tokenEstimation: false,
        maxContextTokens: 42000,
      }),
    });
    assert.equal(patchRes.status, 200);
    const after: any = await patchRes.json();
    assert.equal(after.settings.enabled, true);
    assert.equal(after.settings.truncateHistory, true);
    assert.equal(after.settings.responseCache, true);
    assert.equal(after.settings.maxContextTokens, 42000);

    const again = await app.request('/api/settings/token-economy');
    const reloaded: any = await again.json();
    assert.equal(reloaded.settings.enabled, true);
    assert.equal(reloaded.settings.maxContextTokens, 42000);
  } finally {
    resetEconomyCache();
    process.env.ECONOMY_FILE = prevFile;
    try {
      rmSync(tmpFile, { force: true });
    } catch {}
  }
});

test('gateway e2e: agent:true executa web_search server-side e responde final', async () => {
  resetModelCatalogCache();
  const registry = {
    active: 'openai',
    providers: [
      { id: 'openai', name: 'OpenAI', type: 'openai-compatible', baseUrl: 'http://localhost:9123/v1', apiKey: 'sk-test', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  const { app } = await import('./index.ts');

  let completionsCall = 0;
  let lastBody: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-test' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('html.duckduckgo.com')) {
      return new Response(
        '<a class="result__a" href="https://ex.com">Ex</a><a class="result__snippet">Trecho.</a>',
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    }
    if (url.includes('/chat/completions')) {
      completionsCall++;
      lastBody = JSON.parse(String(init?.body));
      const choices =
        completionsCall === 1
          ? [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'call_ws', type: 'function', function: { name: 'web_search', arguments: '{"query":"notícias"}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ]
          : [
              {
                index: 0,
                message: { role: 'assistant', content: 'Resposta com busca.', reasoning_content: 'procurei' },
                finish_reason: 'stop',
              },
            ];
      return new Response(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices,
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  };

  try {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Busque notícias e resuma.' }],
        stream: false,
        agent: true,
      }),
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.equal(data.choices[0].message.content, 'Resposta com busca.');
    assert.equal(data.choices[0].message.reasoning_content, 'procurei');
    assert.equal(data.agent.turns, 2);
    assert.ok(data.agent.tools.includes('web_search'));
    // A segunda chamada ao LLM recebeu o resultado da tool.
    assert.ok(Array.isArray(lastBody.messages));
    assert.ok(lastBody.messages.some((m: any) => m.role === 'tool' && m.content.includes('Trecho.')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
