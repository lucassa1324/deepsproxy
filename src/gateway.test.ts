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
    assert.equal(before.settings.enabled, true, 'economy is default enabled');

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

test('gateway e2e: agent:true é recusado (Gateway HTTP Puro, sem execução local)', async () => {
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
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Busque notícias.' }],
        stream: false,
        agent: true,
      }),
    });
    assert.equal(res.status, 400);
    const data: any = await res.json();
    assert.ok(String(data.error?.message || '').includes('Gateway HTTP Puro'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gateway e2e: ai-config usa provedor de API mesmo com principal browser e envia a descrição', async () => {
  resetModelCatalogCache();
  const { app } = await import('./index.ts');
  const { resetEconomyCache } = await import('./services/token-economy.ts');
  const tmpFile = join(tmpdir(), 'deepsproxy-economy-aiconfig1.json');
  const prevFile = process.env.ECONOMY_FILE;
  process.env.ECONOMY_FILE = tmpFile;
  resetEconomyCache();

  const registry = {
    active: 'ds',
    providers: [
      { id: 'ds', name: 'DeepSeek', type: 'deepseek', baseUrl: '', apiKey: '', model: '', enabled: true },
      { id: 'api', name: 'Mock', type: 'openai-compatible', baseUrl: 'http://localhost:9123/v1', apiKey: 'sk-test', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  let llmHit = false;
  let llmBody: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/chat/completions')) {
      llmHit = true;
      llmBody = JSON.parse(String(init?.body));
      const descSeen = (llmBody.messages.find((m: any) => m.role === 'user')?.content || '').includes('marketing');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({
            llmParams: { temperature: descSeen ? 0.42 : 0.01, top_p: 0.9, systemPromptOverride: descSeen ? 'visto' : 'nao visto', maxTokens: 1000 },
            tokenEconomy: { enabled: true },
            booster: { enabled: false },
            recommendedModel: '',
            reasoning: 'mock',
          }) } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  };

  try {
    const createRes = await app.request('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'AI config 1', model: 'gpt-test' }),
    });
    assert.equal(createRes.status, 201);
    const created: any = await createRes.json();

    const res = await app.request(`/api/apps/${created.app.id}/ai-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ description: 'geração de ideias e cópias de marketing — respostas criativas e variadas' }),
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();

    assert.equal(llmHit, true, 'LLM deve ser chamado mesmo com o ativo sendo browser (deepseek)');
    assert.equal(data.config.llmParams.temperature, 0.42, 'config deve vir da IA e refletir a descrição');
    assert.equal(data.config.llmParams.systemPromptOverride, 'visto');
    // Modelo real resolvido do catálogo (nunca literal "default"), senão o Gemini 404.
    assert.ok(llmBody, 'payload do LLM deve ter sido capturado');
    assert.notEqual(llmBody.model, 'default');
    assert.equal(llmBody.model, 'gpt-test');
  } finally {
    globalThis.fetch = originalFetch;
    resetEconomyCache();
    process.env.ECONOMY_FILE = prevFile;
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
});

test('gateway e2e: ai-config com LLM inválido cai no heurístico e varia por descrição', async () => {
  resetModelCatalogCache();
  const { app } = await import('./index.ts');
  const { resetEconomyCache } = await import('./services/token-economy.ts');
  const tmpFile = join(tmpdir(), 'deepsproxy-economy-aiconfig2.json');
  const prevFile = process.env.ECONOMY_FILE;
  process.env.ECONOMY_FILE = tmpFile;
  resetEconomyCache();

  const registry = {
    active: 'api',
    providers: [
      { id: 'api', name: 'Mock', type: 'openai-compatible', baseUrl: 'http://localhost:9123/v1', apiKey: 'sk-test', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/chat/completions')) {
      // Resposta sem JSON válido força o fallback heurístico.
      return new Response('resposta sem json', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };

  try {
    const createRes = await app.request('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'AI config 2', model: 'gpt-test' }),
    });
    const created: any = await createRes.json();
    const call = async (d: string) => {
      const r = await app.request(`/api/apps/${created.app.id}/ai-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ description: d }),
      });
      assert.equal(r.status, 200);
      return (await r.json()).config;
    };

    const code = await call('refatoração de código e arquitetura — respostas determinísticas');
    const marketing = await call('geração de ideias e cópias de marketing — respostas criativas e variadas');
    const designer = await call('usar a IA como designer, pouca programação, gerar a parte criativa — artes com código html e css');
    assert.equal(code.llmParams.temperature, 0.1);
    assert.equal(marketing.llmParams.temperature, 0.9);
    // "código" + "html/css" num contexto de DESIGN NÃO deve virar coding (0.1).
    assert.equal(designer.llmParams.temperature, 0.9, 'design com html/css é criativo, não programação');
    assert.ok(String(code.reasoning).includes('heurística'));
    assert.notEqual(code.llmParams.temperature, marketing.llmParams.temperature);
  } finally {
    globalThis.fetch = originalFetch;
    resetEconomyCache();
    process.env.ECONOMY_FILE = prevFile;
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
});

test('gateway e2e: ai-config sem provedor de API usa heurístico sem chamar LLM', async () => {
  resetModelCatalogCache();
  const { app } = await import('./index.ts');
  const { resetEconomyCache } = await import('./services/token-economy.ts');
  const tmpFile = join(tmpdir(), 'deepsproxy-economy-aiconfig3.json');
  const prevFile = process.env.ECONOMY_FILE;
  process.env.ECONOMY_FILE = tmpFile;
  resetEconomyCache();

  const registry = {
    active: 'ds',
    providers: [
      { id: 'ds', name: 'DeepSeek', type: 'deepseek', baseUrl: '', apiKey: '', model: '', enabled: true },
      { id: 'qw', name: 'Qwen', type: 'qwen', baseUrl: '', apiKey: '', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  let llmHit = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/chat/completions') && !url.includes('localhost:9123')) {
      llmHit = true;
    }
    return originalFetch(input, init);
  };

  try {
    // Sem modelo no catálogo, cria a app direto no registry (sem validação do painel).
    const { app: createdApp } = createApp({ name: 'AI config 3', model: 'gpt-test' });
    const res = await app.request(`/api/apps/${createdApp.id}/ai-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ description: 'análise de dados e logs — estruturado' }),
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.equal(llmHit, false, 'sem provedor de API, nenhum LLM deve ser chamado');
    assert.ok(String(data.config.reasoning).includes('heurística'));
    assert.equal(data.config.llmParams.temperature, 0.2);
  } finally {
    globalThis.fetch = originalFetch;
    resetEconomyCache();
    process.env.ECONOMY_FILE = prevFile;
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
});

test('gateway e2e: ai-config com Gemini extrai JSON de fence markdown e usa modelo real', async () => {
  resetModelCatalogCache();
  const { app } = await import('./index.ts');
  const { resetEconomyCache } = await import('./services/token-economy.ts');
  const tmpFile = join(tmpdir(), 'deepsproxy-economy-aiconfig4.json');
  const prevFile = process.env.ECONOMY_FILE;
  process.env.ECONOMY_FILE = tmpFile;
  resetEconomyCache();

  const registry = {
    active: 'gem',
    providers: [
      { id: 'gem', name: 'Google AI', type: 'gemini', baseUrl: '', apiKey: 'gemkey', model: '', enabled: true },
    ],
  };
  const cookie = 'deepsproxy_providers=' + encodeURIComponent(JSON.stringify(registry));

  let llmUrl = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('/models?key=')) {
      return new Response(
        JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes(':generateContent')) {
      llmUrl = url;
      const config = {
        llmParams: { temperature: 0.55, top_p: 0.95, systemPromptOverride: 'gerado', maxTokens: 5000 },
        tokenEconomy: { enabled: true },
        booster: { enabled: false },
        recommendedModel: '',
        reasoning: 'customização por perfil',
      };
      const text = 'Aqui está a config ideal:\n\n```json\n' + JSON.stringify(config) + '\n```\nEspero ter ajudado.';
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  };

  try {
    const createRes = await app.request('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'AI config 4', model: 'gemini-2.5-flash' }),
    });
    assert.equal(createRes.status, 201);
    const created: any = await createRes.json();

    const res = await app.request(`/api/apps/${created.app.id}/ai-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ description: 'uso criativo: design e artes para a web' }),
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.equal(data.config.llmParams.temperature, 0.55, 'JSON extraído do fence markdown deve virar a config da IA');
    assert.equal(data.config.llmParams.systemPromptOverride, 'gerado');
    assert.ok(!String(data.config.reasoning).includes('heurística'), 'LLM válido não deve cair no heurístico');
    // Modelo real no URL (nunca o literal "default", que daria 404 no Gemini).
    assert.ok(llmUrl.includes('gemini-2.5-flash'), 'URL do Gemini deve conter modelo real, got: ' + llmUrl);
    assert.ok(!llmUrl.includes(':default:'), 'nunca pode chamar o modelo default');
  } finally {
    globalThis.fetch = originalFetch;
    resetEconomyCache();
    process.env.ECONOMY_FILE = prevFile;
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
});
