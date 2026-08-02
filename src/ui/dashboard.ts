/*
 * File: dashboard.ts
 * Project: deepsproxy
 * Purpose: Serve a interface gráfica (dashboard) e as rotas de
 * status/logs usadas por ela.
 */

import { Hono } from 'hono';
import { stream, streamSSE } from 'hono/streaming';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { getLogs, subscribe, clearLogs, type LogEntry } from './logger.ts';
import {
  getLoginStatus,
  getPlaywrightState,
  isLoginFlowActive,
  startLoginFlow,
  finishLoginFlow,
} from '../services/playwright.ts';
import { fetchModels, testProviderConnection, clearModelsCache } from '../services/local.ts';
import { vncEnabled, vncUrl } from './vnc.ts';
import {
  resolveRegistry,
  resolveActiveProvider,
  enabledProviders,
  sanitizeRegistry,
  saveRegistryToMemory,
  serializeProvidersCookie,
  isDeepseekProvider,
  PROVIDERS_COOKIE,
} from '../services/config.ts';

export const dashboard = new Hono();

// Incrementado quando o registro de provedores muda. As páginas (chat e
// dashboard) usam /api/models/stream para atualizar a lista de modelos na hora.
let modelsVersion = 0;

const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf-8');
const chatHtml = readFileSync(fileURLToPath(new URL('./chat.html', import.meta.url)), 'utf-8');
const chatComponentJs = readFileSync(
  fileURLToPath(new URL('./components/chat-component.js', import.meta.url)),
  'utf-8'
);
const chatExampleHtml = readFileSync(
  fileURLToPath(new URL('./components/example.html', import.meta.url)),
  'utf-8'
);

dashboard.get('/', (c) => c.html(html));

dashboard.get('/chat', (c) => c.html(chatHtml));

dashboard.get('/chat-example', (c) => c.html(chatExampleHtml));

dashboard.get('/components/chat-component.js', (c) =>
  c.body(chatComponentJs, 200, { 'Content-Type': 'application/javascript; charset=utf-8' })
);

dashboard.get('/api/status', async (c) => {
  const login = await getLoginStatus();
  const registry = resolveRegistry(c.req.header('Cookie'));
  const enabled = enabledProviders(registry);
  const primary = resolveActiveProvider(c.req.header('Cookie'));

  let modelsList: string[] = [];
  const seenModels = new Set<string>();
  let backend: { ok: boolean; baseUrl: string; model: string } | null = null;

  for (const p of enabled) {
    if (isDeepseekProvider(p)) {
      for (const m of ['deepseek-thinking', 'deepseek-no-thinking']) {
        if (!seenModels.has(m)) {
          modelsList.push(m);
          seenModels.add(m);
        }
      }
    } else {
      const models = await fetchModels(p);
      if (models) {
        for (const m of models.map((m: any) => m.id)) {
          if (!seenModels.has(m)) {
            modelsList.push(m);
            seenModels.add(m);
          }
        }
      }
      // Inclui o modelo de override do provedor, se configurado e não duplicado.
      if (p.model && !seenModels.has(p.model)) {
        modelsList.push(p.model);
        seenModels.add(p.model);
      }
    }
  }

  if (!isDeepseekProvider(primary)) {
    const models = await fetchModels(primary);
    backend = { ok: !!models, baseUrl: primary.baseUrl, model: primary.model };
  }

  return c.json({
    server: 'online',
    port: process.env.PORT ? parseInt(process.env.PORT) : 3005,
    uptime: Math.floor(process.uptime()),
    apiKeyConfigured: !!process.env.API_KEY,
    provider: {
      id: primary.id,
      name: primary.name,
      type: primary.type,
      baseUrl: primary.baseUrl,
      model: primary.model,
      hasApiKey: !!primary.apiKey,
    },
    enabledCount: enabled.length,
    models: modelsList,
    backend,
    providers: registry.providers.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      model: p.model,
      hasApiKey: !!p.apiKey,
      enabled: p.enabled,
    })),
    playwright: getPlaywrightState(),
    login: { ...login, inProgress: isLoginFlowActive() },
    vnc: vncEnabled() ? { enabled: true, url: vncUrl() } : { enabled: false },
  });
});

/* ------------------------- Provedores (cookie) ------------------------- */

dashboard.get('/api/providers', (c) => {
  const registry = resolveRegistry(c.req.header('Cookie'));
  return c.json({ ok: true, active: registry.active, providers: registry.providers });
});

dashboard.post('/api/providers', async (c) => {
  try {
    const body: any = await c.req.json().catch(() => ({}));
    const { registry, error } = sanitizeRegistry(body);
    if (!registry) {
      return c.json({ ok: false, error }, 400);
    }
    saveRegistryToMemory(registry);
    clearModelsCache();
    modelsVersion++;
    c.header('Set-Cookie', serializeProvidersCookie(registry));
    const enabledCount = registry.providers.filter((p) => p.enabled !== false).length;
    console.log(
      `[providers] ${registry.providers.length} provedor(es) (${enabledCount} ativo(s)); principal: ${registry.active}`
    );
    return c.json({ ok: true, active: registry.active, providers: registry.providers });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// SSE: avisa as páginas quando o registro de provedores mudar (novo modelo
// salvo, provedor ligado/desligado etc.), para atualizarem os seletores sem
// depender só do polling. A conexão fica aberta e envia quantos eventos forem
// necessários (a cada mudança de modelsVersion), sem encerrar após o primeiro.
dashboard.get('/api/models/stream', (c) => {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ version: modelsVersion }),
    });
    let lastSent = modelsVersion;
    while (true) {
      await stream.sleep(3000);
      if (modelsVersion !== lastSent) {
        lastSent = modelsVersion;
        await stream.writeSSE({
          event: 'models',
          data: JSON.stringify({ version: modelsVersion }),
        });
      }
    }
  });
});

// POST /api/models/refresh — limpa o cache de modelos e retorna a lista atualizada.
// Usado pelo botão "Buscar Modelos" no chat e no teste de API.
// A resposta inclui `providers`: o que o servidor usou (nome, Base URL, modelo,
// modelos encontrados ou erro) para facilitar o diagnóstico na interface.
dashboard.post('/api/models/refresh', async (c) => {
  clearModelsCache();
  const registry = resolveRegistry(c.req.header('Cookie'));
  const enabled = enabledProviders(registry);

  const seen = new Set<string>();
  const data: any[] = [];
  const providersInfo: any[] = [];
  for (const p of enabled) {
    const info: any = {
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl || null,
      model: p.model || null,
      enabled: p.enabled !== false,
    };
    if (isDeepseekProvider(p)) {
      info.models = ['deepseek-thinking', 'deepseek-no-thinking'];
      data.push(
        { id: 'deepseek-thinking', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-no-thinking', object: 'model', owned_by: 'deepseek' }
      );
    } else {
      try {
        const models = await fetchModels(p, true); // force refresh
        info.models = models ? models.map((m: any) => m.id) : [];
        if (models) data.push(...models);
      } catch (e: any) {
        info.error = e?.message || String(e);
        info.models = [];
      }
      if (p.model && !seen.has(p.model)) {
        data.push({ id: p.model, object: 'model', owned_by: p.name });
      }
    }
    providersInfo.push(info);
  }
  const deduped = data.filter((m: any) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  modelsVersion++;
  console.log(
    `[models] refresh: ${providersInfo
      .map((p) => `${p.name}(${p.models ? p.models.length : 0})`)
      .join(', ')} -> ${deduped.length} modelo(s)`
  );
  return c.json({ object: 'list', data: deduped, providers: providersInfo });
});

dashboard.get('/api/models', async (c) => {
  // Base URL/API Key opcionais: permitem carregar modelos de um provedor
  // que está sendo editado, mesmo que ele não esteja habilitado.
  const queryBaseUrl = c.req.query('baseUrl');
  const queryApiKey = c.req.query('apiKey');
  const registry = resolveRegistry(c.req.header('Cookie'));
  const enabled = enabledProviders(registry);

  if (queryBaseUrl) {
    const primary = resolveActiveProvider(c.req.header('Cookie'));
    const models = await fetchModels({
      ...primary,
      baseUrl: queryBaseUrl,
      apiKey: queryApiKey ?? primary.apiKey,
    });
    if (models) {
      console.log(
        `[models] ${models.length} modelo(s) carregado(s) de ${queryBaseUrl}: ${models
          .slice(0, 10)
          .map((m: any) => m.id)
          .join(', ')}${models.length > 10 ? ', ...' : ''}`
      );
      return c.json({ object: 'list', data: models });
    }
    return c.json(
      { object: 'list', data: [], error: `Não foi possível listar modelos de ${queryBaseUrl}` },
      502
    );
  }

  const seen = new Set<string>();
  const data: any[] = [];
  for (const p of enabled) {
    if (isDeepseekProvider(p)) {
      data.push(
        { id: 'deepseek-thinking', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-no-thinking', object: 'model', owned_by: 'deepseek' }
      );
    } else {
      const models = await fetchModels(p);
      if (models) data.push(...models);
      // Inclui o modelo de override do provedor, se configurado e não duplicado.
      if (p.model && !seen.has(p.model)) {
        data.push({ id: p.model, object: 'model', owned_by: p.name });
      }
    }
  }
  const deduped = data.filter((m: any) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  // O fallback para os modelos DeepSeek só faz sentido quando NÃO há
  // provedores configurados. Se há provedores habilitados mas o upstream
  // falhou / não retornou modelos, mostra a lista real (possivelmente vazia)
  // em vez de modelos DeepSeek que roteariam para o provedor errado.
  const result =
    enabled.length === 0 && !deduped.length
      ? [
          { id: 'deepseek-thinking', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-no-thinking', object: 'model', owned_by: 'deepseek' },
        ]
      : deduped;
  return c.json({ object: 'list', data: result });
});

dashboard.post('/api/provider/test', async (c) => {
  try {
    const body: any = await c.req.json().catch(() => ({}));
    const result = await testProviderConnection(body?.baseUrl, body?.apiKey);
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

dashboard.post('/api/login/start', async (c) => {
  try {
    await startLoginFlow();
    console.log('[login] Navegador aberto para login. Conclua no navegador e clique em "Concluir login".');
    return c.json({ ok: true, inProgress: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

dashboard.post('/api/login/finish', async (c) => {
  try {
    await finishLoginFlow();
    const login = await getLoginStatus();
    console.log(`[login] Fluxo concluído. Logado: ${login.loggedIn}`);
    return c.json({ ok: true, login });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

dashboard.get('/api/logs', (c) => c.json({ logs: getLogs() }));

dashboard.delete('/api/logs', (c) => {
  clearLogs();
  return c.json({ ok: true });
});

dashboard.get('/api/logs/stream', (c) => {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return stream(c, async (streamWriter) => {
    const send = (entry: LogEntry) => {
      streamWriter.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    for (const entry of getLogs()) send(entry);

    const unsubscribe = subscribe(send);
    streamWriter.onAbort(() => unsubscribe());

    try {
      while (true) {
        await streamWriter.sleep(5000);
      }
    } catch {
      // client disconnected
    }
  });
});

export { PROVIDERS_COOKIE };
