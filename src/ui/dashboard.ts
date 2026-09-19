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
  getProfileDir,
  isProfileWritable,
  getDeepSeekQueueState,
} from '../services/playwright.ts';
import { fetchModels, testProviderConnection, clearModelsCache } from '../services/local.ts';
import {
  isAdapterProvider,
  fetchProviderModels,
  getAdapterQueueStates,
} from '../services/adapters/index.ts';
import {
  getQwenLoginStatus,
  getQwenPlaywrightState,
  isQwenLoginFlowActive,
  startQwenLoginFlow,
  finishQwenLoginFlow,
  getQwenProfileDir,
  isQwenProfileWritable,
  getQwenPoolState,
} from '../services/qwen-playwright.ts';
import { fetchQwenModels, clearQwenModelsCache, QWEN_KNOWN_MODELS } from '../services/qwen.ts';
import { GEMINI_KNOWN_MODELS } from '../services/gemini-web.ts';
import {
  getGeminiLoginStatus,
  getGeminiPlaywrightState,
  isGeminiLoginFlowActive,
  startGeminiLoginFlow,
  finishGeminiLoginFlow,
  getGeminiProfileDir,
  isGeminiProfileWritable,
  getGeminiPoolState,
} from '../services/gemini-playwright.ts';
import { enrichModel } from '../services/qwen-utils.ts';
import { vncEnabled, vncUrl } from './vnc.ts';
import {
  resolveRegistry,
  resolveActiveProvider,
  enabledProviders,
  sanitizeRegistry,
  saveRegistryToMemory,
  serializeProvidersCookie,
  sanitizeType,
  isDeepseekProvider,
  isQwenProvider,
  isGeminiWebProvider,
  PROVIDERS_COOKIE,
  primaryApiKey,
  getActiveApiKey,
  normalizeAccountKeys,
} from '../services/config.ts';
import {
  listApps,
  createApp,
  updateApp,
  deleteApp,
  regenerateAppKey,
  getAppById,
} from '../services/gateway.ts';
import type { ProviderRegistry } from '../services/config.ts';
import { getModelCatalog, resolveModelEntry } from '../services/modelCatalog.ts';
import { getTokenEconomy, updateTokenEconomy } from '../services/token-economy.ts';
import { getBoosterSettings, updateBoosterSettings, toggleModelBooster, isModelBoosted } from '../services/booster.ts';
import { clearWorkspaceRootCache } from '../services/relay-path.ts';
import { APP_VERSION, APP_TAG } from '../version.ts';
import { buildAgentPrompt } from '../utils/prompt.ts';
export const dashboard = new Hono();

// Incrementado quando o registro de provedores muda. As páginas (chat e
// dashboard) usam /api/models/stream para atualizar a lista de modelos na hora.
let modelsVersion = 0;

// Lista de modelos do Qwen: busca na API (via Playwright) com fallback para a
// lista estática quando o backend não responde.
async function qwenModelsWithFallback(): Promise<any[]> {
  try {
    const models = await fetchQwenModels();
    if (models.length) return models;
  } catch (err: any) {
    console.warn('[models] falha ao buscar modelos do Qwen; usando lista conhecida:', err.message);
  }
  return QWEN_KNOWN_MODELS.map((m) => ({ ...m, object: 'model' }));
}

/** Modelos do Gemini Web: lista conhecida (sem API para listar dinamicamente). */
function geminiWebModels(): any[] {
  return GEMINI_KNOWN_MODELS.map((m) => ({ ...m, object: 'model' }));
}

/** True se o id pertence ao Gemini Web (navegador). */
function isGeminiWebModel(id: string): boolean {
  return GEMINI_KNOWN_MODELS.some((m) => m.id === id);
}

const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf-8');
const chatHtml = readFileSync(fileURLToPath(new URL('./chat.html', import.meta.url)), 'utf-8');
const faviconSvg = readFileSync(fileURLToPath(new URL('./proxy-logo.svg', import.meta.url)), 'utf-8');
const chatComponentJs = readFileSync(
  fileURLToPath(new URL('./components/chat-component.js', import.meta.url)),
  'utf-8'
);
const chatExampleHtml = readFileSync(
  fileURLToPath(new URL('./components/example.html', import.meta.url)),
  'utf-8'
);

const htmlWithVersion = html.replace('__APP_VERSION__', APP_VERSION).replace('__APP_TAG__', APP_TAG);

dashboard.get('/', (c) => c.html(htmlWithVersion));

dashboard.get('/favicon.svg', (c) =>
  c.body(faviconSvg, 200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
);

dashboard.get('/chat', (c) => c.html(chatHtml));

dashboard.get('/chat-example', (c) => c.html(chatExampleHtml));

dashboard.get('/components/chat-component.js', (c) =>
  c.body(chatComponentJs, 200, { 'Content-Type': 'application/javascript; charset=utf-8' })
);

dashboard.get('/api/status', async (c) => {
  try {
    const login = await getLoginStatus();
    const registry = resolveRegistry(c.req.header('Cookie'));
    const enabled = enabledProviders(registry);
    const primary = resolveActiveProvider(c.req.header('Cookie'));
    const hasGeminiWeb = enabled.some(isGeminiWebProvider);

    let modelsList: any[] = [];
    const seenModels = new Set<string>();
    let backend: { ok: boolean; baseUrl: string; model: string } | null = null;

    for (const p of enabled) {
      if (isDeepseekProvider(p)) {
        for (const m of ['deepseek-thinking', 'deepseek-no-thinking']) {
          if (!seenModels.has(m)) {
            modelsList.push(enrichModel({ id: m, object: 'model', owned_by: 'deepseek' }));
            seenModels.add(m);
          }
        }
      } else if (isQwenProvider(p)) {
        const models = await qwenModelsWithFallback();
        for (const m of models.map((m: any) => enrichModel(m))) {
          if (!seenModels.has(m.id)) {
            modelsList.push(m);
            seenModels.add(m.id);
          }
        }
      } else if (isGeminiWebProvider(p)) {
        for (const m of geminiWebModels().map((m: any) => enrichModel(m))) {
          if (!seenModels.has(m.id)) {
            modelsList.push(m);
            seenModels.add(m.id);
          }
        }
      } else {
        const models = isAdapterProvider(p) ? await fetchProviderModels(p, getActiveApiKey(p)) : await fetchModels(p);
        if (models) {
          for (const m of models
            .filter((m: any) => !(hasGeminiWeb && isGeminiWebModel(m.id)))
            .map((m: any) => enrichModel(m))) {
            if (!seenModels.has(m.id)) {
              modelsList.push(m);
              seenModels.add(m.id);
            }
          }
        }
        if (p.model && !seenModels.has(p.model)) {
          modelsList.push(enrichModel({ id: p.model, object: 'model', owned_by: p.name }));
          seenModels.add(p.model);
        }
      }
    }

    if (!isDeepseekProvider(primary) && !isQwenProvider(primary) && !isGeminiWebProvider(primary)) {
      const models = await fetchModels(primary);
      backend = { ok: !!models, baseUrl: primary.baseUrl, model: primary.model };
    }

    // Adicionar os modelos virtuais "auto" e "auto-free" como primeiros da lista
    if (!seenModels.has('auto')) {
      modelsList.unshift(enrichModel({
        id: 'auto',
        object: 'model',
        owned_by: 'deepsproxy',
        name: 'Auto (Smart Router)',
      }));
    }
    if (!seenModels.has('auto-free')) {
      modelsList.unshift(enrichModel({
        id: 'auto-free',
        object: 'model',
        owned_by: 'deepsproxy',
        name: 'Auto Free (Browser Only)',
      }));
    }

    return c.json({
      server: 'online',
      port: process.env.PORT ? parseInt(process.env.PORT) : 3005,
      uptime: Math.floor(process.uptime()),
      apiKeyConfigured: !!process.env.API_KEY,
      apiKey: process.env.API_KEY || '',
      provider: {
        id: primary.id,
        name: primary.name,
        type: primary.type,
        baseUrl: primary.baseUrl,
        model: primary.model,
        hasApiKey: !!primaryApiKey(primary),
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
        hasApiKey: !!primaryApiKey(p),
        enabled: p.enabled,
      })),
      playwright: {
        ...getPlaywrightState(),
        profileDir: getProfileDir(),
        profileWritable: isProfileWritable(),
      },
      deepseek: {
        queue: getDeepSeekQueueState(),
      },
      qwen: {
        playwright: {
          ...getQwenPlaywrightState(),
          profileDir: getQwenProfileDir(),
          profileWritable: isQwenProfileWritable(),
        },
        pool: getQwenPoolState(),
        login: { ...(await getQwenLoginStatus()), inProgress: isQwenLoginFlowActive() },
      },
      geminiWeb: {
        playwright: {
          ...getGeminiPlaywrightState(),
          profileDir: getGeminiProfileDir(),
          profileWritable: isGeminiProfileWritable(),
        },
        pool: getGeminiPoolState(),
        login: { ...(await getGeminiLoginStatus()), inProgress: isGeminiLoginFlowActive() },
      },
      adapters: getAdapterQueueStates(),
      login: { ...login, inProgress: isLoginFlowActive() },
      vnc: vncEnabled() ? { enabled: true, url: vncUrl() } : { enabled: false },
      gateway: {
        enabled: process.env.ENABLE_GATEWAY !== 'false',
        port: process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT) : 3006,
        baseUrl: `http://localhost:${process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT) : 3006}/v1`,
      },
    });
  } catch (err: any) {
    // Um erro isolado (ex.: página do navegador fechada) não pode derrubar o
    // status inteiro do dashboard — o login ficaria congelado no botão.
    console.warn('[status] Falha ao montar status completo:', err.message);
    return c.json({
      server: 'online',
      port: process.env.PORT ? parseInt(process.env.PORT) : 3005,
      uptime: Math.floor(process.uptime()),
      apiKeyConfigured: !!process.env.API_KEY,
      apiKey: process.env.API_KEY || '',
      provider: { id: '', name: '', type: 'unknown', baseUrl: '', model: '', hasApiKey: false },
      enabledCount: 0,
      models: [],
      backend: null,
      providers: [],
      playwright: {},
      deepseek: { queue: { active: 0, waiting: 0 } },
      qwen: {
        pool: { capacity: 0, active: 0, waiting: 0 },
        login: { loggedIn: false, cookieCount: 0, inProgress: isQwenLoginFlowActive() },
      },
      geminiWeb: {
        pool: { capacity: 0, active: 0, waiting: 0 },
        login: { loggedIn: false, cookieCount: 0, inProgress: isGeminiLoginFlowActive() },
      },
      adapters: { gemini: { waiting: 0 }, anthropic: { waiting: 0 }, ollama: { waiting: 0 } },
      login: { loggedIn: false, cookieCount: 0, inProgress: isLoginFlowActive() },
      vnc: { enabled: false },
      gateway: {
        enabled: process.env.ENABLE_GATEWAY !== 'false',
        port: process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT) : 3006,
        baseUrl: `http://localhost:${process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT) : 3006}/v1`,
      },
    });
  }
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
  const hasGeminiWeb = enabled.some(isGeminiWebProvider);

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
        enrichModel({ id: 'deepseek-thinking', object: 'model', owned_by: 'deepseek' }),
        enrichModel({ id: 'deepseek-no-thinking', object: 'model', owned_by: 'deepseek' })
      );
    } else if (isQwenProvider(p)) {
      clearQwenModelsCache();
      try {
        const models = await qwenModelsWithFallback();
        info.models = models.map((m: any) => m.id);
        data.push(...models.map((m: any) => enrichModel(m)));
      } catch (e: any) {
        info.error = e?.message || String(e);
        info.models = [];
      }
    } else if (isGeminiWebProvider(p)) {
      const models = geminiWebModels();
      info.models = models.map((m: any) => m.id);
      data.push(...models.map((m: any) => enrichModel(m)));
    } else {
      try {
        const models = isAdapterProvider(p) ? await fetchProviderModels(p, getActiveApiKey(p)) : await fetchModels(p, true); // force refresh
        const filtered = models ? models.filter((m: any) => !(hasGeminiWeb && isGeminiWebModel(m.id))) : [];
        info.models = filtered.map((m: any) => m.id);
        if (filtered.length) data.push(...filtered.map((m: any) => enrichModel(m)));
      } catch (e: any) {
        info.error = e?.message || String(e);
        info.models = [];
      }
      if (p.model && !seen.has(p.model)) {
        data.push(enrichModel({ id: p.model, object: 'model', owned_by: p.name }));
      }
    }
    providersInfo.push(info);
  }
  const deduped = data.map((m: any) => enrichModel(m)).filter((m: any) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Adicionar o modelo virtual "auto" como primeiro da lista
  if (!seen.has('auto')) {
    deduped.unshift(enrichModel({
      id: 'auto',
      object: 'model',
      owned_by: 'deepsproxy',
      name: 'Auto (Smart Router)',
    }));
  }

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
  const queryType = c.req.query('type');
  const registry = resolveRegistry(c.req.header('Cookie'));
  const enabled = enabledProviders(registry);

  if (queryBaseUrl) {
    const primary = resolveActiveProvider(c.req.header('Cookie'));
    const probe: any = {
      ...primary,
      type: queryType ? sanitizeType(queryType) : primary.type,
      baseUrl: queryBaseUrl,
      apiKey: queryApiKey ?? (primaryApiKey(primary) || ''),
    };
    const models = isAdapterProvider(probe) ? await fetchProviderModels(probe) : await fetchModels(probe);
    if (models) {
      console.log(
        `[models] ${models.length} modelo(s) carregado(s) de ${queryBaseUrl}: ${models
          .slice(0, 10)
          .map((m: any) => m.id)
          .join(', ')}${models.length > 10 ? ', ...' : ''}`
      );
      return c.json({ object: 'list', data: models.map((m: any) => enrichModel(m)) });
    }
    return c.json(
      { object: 'list', data: [], error: `Não foi possível listar modelos de ${queryBaseUrl}` },
      502
    );
  }

  const seen = new Set<string>();
  const data: any[] = [];
  const hasGeminiWeb = enabled.some(isGeminiWebProvider);
  for (const p of enabled) {
    if (isDeepseekProvider(p)) {
      data.push(
        enrichModel({ id: 'deepseek-thinking', object: 'model', owned_by: 'deepseek' }),
        enrichModel({ id: 'deepseek-no-thinking', object: 'model', owned_by: 'deepseek' })
      );
    } else if (isQwenProvider(p)) {
      const models = await qwenModelsWithFallback();
      if (models) data.push(...models.map((m: any) => enrichModel(m)));
    } else if (isGeminiWebProvider(p)) {
      data.push(...geminiWebModels().map((m: any) => enrichModel(m)));
    } else {
      const models = isAdapterProvider(p) ? await fetchProviderModels(p, getActiveApiKey(p)) : await fetchModels(p);
      if (models) data.push(...models.filter((m: any) => !(hasGeminiWeb && isGeminiWebModel(m.id))).map((m: any) => enrichModel(m)));
      // Inclui o modelo de override do provedor, se configurado e nǜo duplicado.
      if (p.model && !seen.has(p.model)) {
        data.push(enrichModel({ id: p.model, object: 'model', owned_by: p.name }));
      }
    }
  }
  const deduped = data.map((m: any) => enrichModel(m)).filter((m: any) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  // O fallback para os modelos DeepSeek s�� faz sentido quando NǟO hǭ
  // provedores configurados. Se hǭ provedores habilitados mas o upstream
  // falhou / nǜo retornou modelos, mostra a lista real (possivelmente vazia)
  // em vez de modelos DeepSeek que roteariam para o provedor errado.
  const result =
    enabled.length === 0 && !deduped.length
      ? [
          enrichModel({ id: 'auto', object: 'model', owned_by: 'deepsproxy', name: 'Auto (Smart Router)' }),
          enrichModel({ id: 'deepseek-thinking', object: 'model', owned_by: 'deepseek' }),
          enrichModel({ id: 'deepseek-no-thinking', object: 'model', owned_by: 'deepseek' }),
        ]
      : deduped;

  // Adicionar o modelo virtual "auto" como primeiro da lista
  if (!seen.has('auto')) {
    result.unshift(enrichModel({
      id: 'auto',
      object: 'model',
      owned_by: 'deepsproxy',
      name: 'Auto (Smart Router)',
    }));
  }

  return c.json({ object: 'list', data: result });
});

dashboard.post('/api/provider/test', async (c) => {
  try {
    const body: any = await c.req.json().catch(() => ({}));
    const result = await testProviderConnection(body?.baseUrl, body?.apiKey, 5000, body?.type);
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

dashboard.post('/api/qwen/login/start', async (c) => {
  try {
    await startQwenLoginFlow();
    console.log('[qwen] Navegador aberto para login. Conclua no navegador e clique em "Concluir login".');
    return c.json({ ok: true, inProgress: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

dashboard.post('/api/qwen/login/finish', async (c) => {
  try {
    await finishQwenLoginFlow();
    const login = await getQwenLoginStatus();
    console.log(`[qwen] Fluxo concluído. Logado: ${login.loggedIn}`);
    return c.json({ ok: true, login });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

dashboard.post('/api/gemini/login/start', async (c) => {
  try {
    await startGeminiLoginFlow();
    console.log('[gemini] Navegador aberto para login. Conclua no navegador e clique em "Concluir login".');
    return c.json({ ok: true, inProgress: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

dashboard.post('/api/gemini/login/finish', async (c) => {
  try {
    await finishGeminiLoginFlow();
    const login = await getGeminiLoginStatus();
    console.log(`[gemini] Fluxo concluído. Logado: ${login.loggedIn}`);
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

/* ------------------------- AI Gateway (apps) ------------------------- */

// Anexa nome do provedor, Base URL e env var da chave ao payload de uma app.
// O provedor é resolvido automaticamente pelo catálogo a partir do modelo.
async function enrichApp(app: any, registry: ProviderRegistry): Promise<any> {
  const entry = app.model ? await resolveModelEntry(app.model, registry) : null;
  return {
    ...app,
    providerName: entry ? entry.providerName : null,
    providerType: entry ? entry.providerType : null,
    providerEnabled: !!entry,
    baseUrl: entry ? entry.baseUrl || null : null,
    apiKeyEnvVar: entry ? entry.apiKeyEnvVar || null : null,
  };
}

// GET /api/models/catalog — catálogo unificado (fixos + cache) para o dropdown
// de modelos da aba Apps, agrupável por provedor no frontend.
dashboard.get('/api/models/catalog', async (c) => {
  const registry = resolveRegistry(c.req.header('Cookie'));
  const catalog = await getModelCatalog(registry);
  return c.json({ ok: true, count: catalog.length, models: catalog });
});

/* ------------------------- Modo Economia de Tokens ------------------------- */

// GET /api/settings/token-economy — configuração atual do modo economia.
dashboard.get('/api/settings/token-economy', (c) => {
  return c.json({ ok: true, settings: getTokenEconomy() });
});

// PATCH /api/settings/token-economy — atualiza (parcialmente) e persiste.
dashboard.patch('/api/settings/token-economy', async (c) => {
  try {
    const body: any = await c.req.json().catch(() => ({}));
    const patch: any = {};
    for (const key of ['enabled', 'cachePrefix', 'truncateHistory', 'summarizeHistory', 'stripReasoning', 'truncateToolOutput', 'responseCache', 'tokenEstimation', 'smartTruncation', 'dedupConsecutive'] as const) {
      if (typeof body[key] === 'boolean') patch[key] = body[key];
    }
    if (body.maxContextTokens !== undefined) patch.maxContextTokens = body.maxContextTokens;
    const settings = updateTokenEconomy(patch);
    console.log(
      `[economy] configuração atualizada: enabled=${settings.enabled} cachePrefix=${settings.cachePrefix} truncate=${settings.truncateHistory} summarize=${settings.summarizeHistory} stripReasoning=${settings.stripReasoning} toolOutput=${settings.truncateToolOutput} responseCache=${settings.responseCache} tokenEstimation=${settings.tokenEstimation} smartTruncation=${settings.smartTruncation} dedup=${settings.dedupConsecutive}`
    );
    return c.json({ ok: true, settings });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

/* ------------------------- Modo Booster (modelos fracos) ------------------------- */

// GET /api/settings/booster — configuração atual do booster.
dashboard.get('/api/settings/booster', (c) => {
  return c.json({ ok: true, settings: getBoosterSettings() });
});

// PATCH /api/settings/booster — atualiza (parcialmente) e persiste.
dashboard.patch('/api/settings/booster', async (c) => {
  try {
    const body: any = await c.req.json().catch(() => ({}));
    const patch: any = {};
    for (const key of ['enabled', 'promptReinforcement', 'correctiveLoop', 'tolerantParser'] as const) {
      if (typeof body[key] === 'boolean') patch[key] = body[key];
    }
    if (Array.isArray(body.models)) patch.models = body.models;
    const settings = updateBoosterSettings(patch);
    console.log(
      `[booster] configuração atualizada: enabled=${settings.enabled} models=[${settings.models.join(', ') || 'nenhum'}] prompt=${settings.promptReinforcement} corrective=${settings.correctiveLoop} tolerant=${settings.tolerantParser}`
    );
    return c.json({ ok: true, settings });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// POST /api/settings/booster/models — liga/desliga o booster de um modelo.
// Corpo: { "model": "meu-modelo", "enable": true|false }
dashboard.post('/api/settings/booster/models', async (c) => {
  try {
    const body: any = await c.req.json().catch(() => ({}));
    const model = String(body.model || '').trim();
    if (!model) return c.json({ ok: false, error: 'Informe o campo "model".' }, 400);
    const enable = body.enable !== false;
    const settings = toggleModelBooster(model, enable);
    console.log(`[booster] modelo "${model}" ${enable ? 'habilitado' : 'desabilitado'} (${isModelBoosted(model) ? 'ativo' : 'inativo'})`);
    return c.json({ ok: true, settings, boosted: isModelBoosted(model) });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Limpa o cache da última raiz de workspace (troca manual de projeto, sem
// reiniciar o proxy). A partir daí, a raiz passa a ser decidida pela evidência
// do PRÓXIMO request (header x-workspace-root / workspacePath / mensagens).
dashboard.post('/api/settings/clear-workspace-root', (c) => {
  clearWorkspaceRootCache();
  console.log('[workspace-root] cache de raiz limpo via dashboard');
  return c.json({ ok: true });
});

dashboard.get('/api/apps', async (c) => {
  const registry = resolveRegistry(c.req.header('Cookie'));
  const apps = [];
  for (const a of listApps()) {
    apps.push(await enrichApp(a, registry));
  }
  return c.json({ ok: true, apps });
});dashboard.post('/api/apps', async (c) => {
  try {
    const body: any = await c.req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return c.json({ ok: false, error: 'Informe o nome da aplicação.' }, 400);
    const model = String(body.model || '').trim();
    if (!model) return c.json({ ok: false, error: 'Selecione um modelo (o provedor é resolvido automaticamente).' }, 400);

    const registry = resolveRegistry(c.req.header('Cookie'));
    const entry = await resolveModelEntry(model, registry);
    if (!entry) {
      return c.json(
        { ok: false, error: `Modelo "${model}" não encontrado no catálogo. Verifique a aba Conexão.` },
        400
      );
    }

    const { app, apiKey } = createApp({ name, model });
    console.log(`[gateway] app criada: ${app.name} (model: ${model}, provider: ${entry.providerName})`);
    return c.json({ ok: true, app: await enrichApp(app, registry), apiKey }, 201);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

dashboard.patch('/api/apps/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = getAppById(id);
    if (!existing) return c.json({ ok: false, error: 'Aplicação não encontrada.' }, 404);
    const body: any = await c.req.json().catch(() => ({}));
    if (body.model !== undefined && body.model !== existing.model) {
      const registry = resolveRegistry(c.req.header('Cookie'));
      const entry = await resolveModelEntry(String(body.model || ''), registry);
      if (!entry) {
        return c.json(
          { ok: false, error: `Modelo "${body.model}" não encontrado no catálogo. Verifique a aba Conexão.` },
          400
        );
      }
    }
    const app = updateApp(id, {
      name: body.name,
      model: body.model,
      enabled: body.enabled,
      temperature: body.temperature,
      top_p: body.top_p,
      systemPromptOverride: body.systemPromptOverride,
      maxTokens: body.maxTokens,
    });
    if (!app) return c.json({ ok: false, error: 'Aplicação não encontrada.' }, 404);
    const registry = resolveRegistry(c.req.header('Cookie'));
    return c.json({ ok: true, app: await enrichApp(app, registry) });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

dashboard.delete('/api/apps/:id', (c) => {
  const id = c.req.param('id');
  if (!deleteApp(id)) return c.json({ ok: false, error: 'Aplicação não encontrada.' }, 404);
  console.log(`[gateway] app excluída: ${id}`);
  return c.json({ ok: true });
});

dashboard.post('/api/apps/:id/key', async (c) => {
  const id = c.req.param('id');
  const result = regenerateAppKey(id);
  if (!result) return c.json({ ok: false, error: 'Aplicação não encontrada.' }, 404);
  console.log(`[gateway] chave regenerada para a app ${id}`);
  const registry = resolveRegistry(c.req.header('Cookie'));
  return c.json({ ok: true, app: await enrichApp(result.app, registry), apiKey: result.apiKey });
});

// ── AI Config Wizard: configura automaticamente a app baseada na descrição do uso ──
dashboard.post('/api/apps/:id/ai-config', async (c) => {
  try {
    const id = c.req.param('id');
    const body: any = await c.req.json().catch(() => ({}));
    const description = String(body.description || '').trim();
    if (!description) {
      return c.json({ ok: false, error: 'Descreva para que vai usar esta aplicação.' }, 400);
    }

    const app = getAppById(id);
    if (!app) return c.json({ ok: false, error: 'Aplicação não encontrada.' }, 404);

    const registry = resolveRegistry(c.req.header('Cookie'));
    const enabled = enabledProviders(registry);
    const catalog = await getModelCatalog(registry);

    // Usa o modelo atual da app ou o modelo principal do registry
    const currentModel = app.model || '';
    const modelEntry = currentModel ? await resolveModelEntry(currentModel, registry) : null;
    const providerType = modelEntry?.providerType || (enabled[0]?.type || 'openai-compatible');

    // Prompt para a IA gerar a configuração ideal
    const systemPrompt = `
Você é um especialista em configuração de modelos LLM para o DeepsProxy.
Sua tarefa: receber a descrição do caso de uso e retornar um JSON com a configuração ideal
para aquela aplicação, incluindo parâmetros LLM, economia de tokens e booster.

CONTEXTO DO SISTEMA:
- Provedor atual: ${providerType}
- Modelo atual: ${currentModel || 'auto'}
- Modelos disponíveis: ${catalog.map(m => m.id).slice(0, 20).join(', ')}

CONFIGURAÇÕES POSSÍVEIS (parâmetros LLM por aplicação):
- temperature: 0.0 a 2.0 (controla aleatoriedade; 0.1 = determinístico, 0.7 = equilibrado, 1.0+ = criativo)
- top_p: 0.0 a 1.0 (nucleus sampling; 0.95 = padrão, 0.1 = muito focado)
- systemPromptOverride: string (instruções extras anexadas ao system prompt da requisição)
- maxTokens: número (limite de tokens na resposta; 0 = sem limite/usa padrão do modelo)

CONFIGURAÇÕES POSSÍVEIS (token-economy):
- enabled: master toggle (true/false)
- cachePrefix: prompt caching (prefixo estável) — sem impacto na qualidade, economiza 10-25% no Anthropic/Gemini
- truncateHistory: trunca histórico antigo — alto risco (pode perder contexto)
- summarizeHistory: resume histórico descartado — médio risco
- stripReasoning: remove thinking do histórico — baixo risco, economiza muito em modelos de raciocínio
- truncateToolOutput: limita saída de tools a 4k chars — médio risco
- responseCache: cache de respostas idênticas (60s) — sem impacto
- tokenEstimation: log de tokens no servidor — apenas informativo
- smartTruncation: trunca por importância — médio risco
- dedupConsecutive: remove duplicatas exatas — baixo risco
- maxContextTokens: janela máxima (default 56000)

CONFIGURAÇÕES POSSÍVEIS (booster - para modelos fracos):
- enabled: master toggle
- promptReinforcement: injeta regras + exemplo de tool_call
- correctiveLoop: loop corretivo quando tool falha
- tolerantParser: parser que repara JSON quebrado
- models: array de ids de modelos que recebem booster

REGRAS DE DECISÃO (parâmetros LLM):
1. PROGRAMAÇÃO/AGENTE DE CÓDIGO: temperature=0.1, top_p=0.95, systemPromptOverride com instruções de precisão, maxTokens=8000
2. CHAT/CONVERSAÇÃO GERAL: temperature=0.7, top_p=0.95, systemPromptOverride vazio, maxTokens=4000
3. ANÁLISE DE DADOS/ARQUIVOS GRANDES: temperature=0.2, top_p=0.9, systemPromptOverride focado em estrutura, maxTokens=8000
4. ESCRITA CRIATIVA/MARKETING: temperature=0.9, top_p=0.95, systemPromptOverride para estilo, maxTokens=4000
5. RACIOCÍNIO COMPLEXO/MATEMÁTICA: temperature=0.1, top_p=0.9, systemPromptOverride para chain-of-thought, maxTokens=16000
6. MODELOS DE RACIOCÍNIO (deepseek-thinking, qwen-max): temperature=0.1, stripReasoning=true obrigatório

REGRAS DE DECISÃO (token-economy/booster):
1. PROGRAMAÇÃO/AGENTE DE CÓDIGO: stripReasoning=true, truncateToolOutput=true, cachePrefix=true, responseCache=false, booster habilitado se modelo fraco
2. CHAT/CONVERSAÇÃO GERAL: cachePrefix=true, responseCache=true, truncateHistory=false
3. ANÁLISE DE DADOS/ARQUIVOS GRANDES: truncateHistory=true, summarizeHistory=true, truncateToolOutput=true
4. MODELO DE RACIOCÍNIO (deepseek-thinking, qwen-max, etc): stripReasoning=true obrigatório
5. MODELOS LOCAIS PEQUENOS (<=7B): truncateHistory=true, truncateToolOutput=true, smartTruncation=true
6. MODELOS COM CONTEXTO GRANDE (Gemini 1M, Claude 200k): desligar truncateHistory
7. USE CASE "AGENTE AUTÔNOMO": booster.enabled=true com promptReinforcement+correctiveLoop+tolerantParser

RETORNE APENAS JSON VÁLIDO:
{
  "llmParams": {
    "temperature": 0.1,
    "top_p": 0.95,
    "systemPromptOverride": "Instruções extras para o caso de uso...",
    "maxTokens": 8000
  },
  "tokenEconomy": { ... },
  "booster": { ... },
  "recommendedModel": "id_do_modelo_recomendado_ou_vazio",
  "reasoning": "explicação breve em português"
}
    `.trim();

    const userPrompt = `PROFILE DO USUÁRIO (leia com atenção e ajuste TODA a configuração a este perfil):

${description}

Decida cada parâmetro baseado EXCLUSIVAMENTE neste perfil:
- código/programação → máxima precisão e determinismo;
- escrita criativa/marketing → variedade e expressividade;
- análise de dados/logs → estrutura e foco em extrair insights;
- etc.
Escreva o "systemPromptOverride" específico deste perfil (nunca genérico).`;

    // Escolhe um provedor de API para gerar a configuração. Provedores de
    // navegador (deepseek/qwen/gemini-web) não expõem HTTP para chamada direta
    // e cairiam sempre no fallback heurístico — por isso buscamos qualquer
    // provedor de API habilitado, mesmo que o principal seja via navegador.
    const apiProviders = enabled.filter(
      (p) => p.type !== 'deepseek' && p.type !== 'qwen' && p.type !== 'gemini-web'
    );
    const llmProvider = apiProviders.find((p) => p.id === registry.active) ?? apiProviders[0] ?? null;
    let configJson = null;

    if (llmProvider) {
      try {
        // Resolve um modelo REAL para o provedor: o modelo cadastrado, senão o
        // primeiro do catálogo daquele provedor, senão um padrão por tipo.
        // Enviar "default" ao Gemini resultava em 404 (modelo inexistente).
        const defaultByType: Record<string, string> = {
          gemini: 'gemini-2.5-flash',
          anthropic: 'claude-sonnet-4-5',
        };
        const catalogModel = catalog.find((m: any) => m.provider === llmProvider.id)?.id || '';
        const chosenModel =
          (llmProvider.model && llmProvider.model !== 'default' ? llmProvider.model : '') ||
          catalogModel ||
          defaultByType[llmProvider.type] ||
          '';

        const payload = {
          model: chosenModel,
          stream: false,
          temperature: 0.2,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        };

        let resp: Response | null = null;
        const resolvedKey = primaryApiKey(llmProvider);
        if (llmProvider.type === 'gemini' || llmProvider.type === 'anthropic' || llmProvider.type === 'ollama') {
          const { dispatchAdapterChat } = await import('../services/adapters/index.ts');
          resp = await dispatchAdapterChat(payload, llmProvider);
        } else if (llmProvider.type === 'openai-compatible' && llmProvider.baseUrl && resolvedKey) {
          const { optimizedFetch } = await import('../services/optimizations.ts');
          resp = await optimizedFetch(`${llmProvider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolvedKey}` },
            body: JSON.stringify(payload)
          });
        }

        if (resp && resp.ok) {
          const data = await resp.json();
          const content = data.choices?.[0]?.message?.content || '';
          configJson = extractJsonObject(content);
        } else {
          let detail = `status ${resp?.status || 'sem resposta'}`;
          if (resp) {
            try {
              const errBody: any = await resp.clone().json();
              const msg = String(errBody?.error?.message || errBody?.message || '').slice(0, 300);
              if (msg) detail += ` — ${msg}`;
            } catch {}
          }
          console.warn(
            `[ai-config] LLM ${llmProvider.name}/${chosenModel || 'default'} respondeu ${detail} — fallback heurístico`
          );
        }
        console.log(
          `[ai-config] LLM ${llmProvider.name}/${chosenModel || 'default'} → ${configJson ? 'config gerada pela IA' : 'resposta sem JSON válido, fallback heurístico'}`
        );
      } catch (e) {
        console.warn('[ai-config] Falha ao chamar LLM para config, usando fallback:', (e as Error).message);
      }
    } else {
      console.log('[ai-config] Sem provedor de API habilitado — usando fallback heurístico');
    }

    // Fallback heurístico se a IA falhou
    if (!configJson) {
      configJson = generateHeuristicConfig(description, providerType, currentModel, catalog);
    }

    // Aplica a configuração no servidor (token-economy global)
    if (configJson.tokenEconomy) {
      await updateTokenEconomy(configJson.tokenEconomy);
    }

    // Aplica booster se recomendado
    if (configJson.booster && configJson.booster.enabled) {
      const { updateBoosterSettings } = await import('../services/booster.ts');
      await updateBoosterSettings(configJson.booster);
    }

    // Se recomendou trocar de modelo, atualiza a app
    if (configJson.recommendedModel && configJson.recommendedModel !== currentModel) {
      const entry = await resolveModelEntry(configJson.recommendedModel, registry);
      if (entry) {
        const updated = updateApp(id, { model: configJson.recommendedModel });
        console.log(`[ai-config] Modelo da app ${id} alterado para ${configJson.recommendedModel}`);
      }
    }

    // Aplica parâmetros LLM por aplicação
    if (configJson.llmParams) {
      const { temperature, top_p, systemPromptOverride, maxTokens } = configJson.llmParams;
      const updated = updateApp(id, { temperature, top_p, systemPromptOverride, maxTokens });
      if (updated) {
        console.log(`[ai-config] Parâmetros LLM da app ${id} atualizados:`, configJson.llmParams);
      }
    }

    return c.json({ ok: true, config: configJson, app: await enrichApp(app, registry) });
  } catch (e: any) {
    console.error('[ai-config] Erro:', e);
    return c.json({ ok: false, error: e.message }, 500);
  }
});

function extractJsonObject(content: string): any {
  if (!content) return null;
  const raw = String(content).trim();
  try { return JSON.parse(raw); } catch {}
  // Fences markdown: ```json { ... } ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // Texto ao redor: pega do primeiro "{" ao último "}".
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function generateHeuristicConfig(description: string, providerType: string, currentModel: string, catalog: any[]): any {
  const desc = description.toLowerCase();
  // Design/arte/visual com HTML+CSS é CRIATIVO — suprime a classificação de
  // coding que o regex pegaria em palavras como "código"/"css".
  const isDesignCreative = /design|artes?|parte criativa|ilustra|visual|layout|branding|pouca programa|html|css|front-?end|web design|marketing|copy|escrita|poesia|redes sociais|hist[óo]ria/i.test(desc);
  const isCoding = !isDesignCreative && /programa|c[oó]digo|desenvolv|agent|aut[oô]nom|refator|debug|bug|arquivo|edit|write|read|file|code|coding/i.test(desc);
  const isChat = /chat|conversa|atendimento|suporte|assistente|geral/i.test(desc);
  const isData = /dados|an[aá]lise|relat[oó]rio|processar|arquivo grande|log|csv|json|dataset/i.test(desc);
  const isCreative = /criativ|escrita|texto|hist[oó]ria|poesia|marketing|copy|redes sociais/i.test(desc);
  const isReasoning = /racioc[io]nio|l[oó]gica|matem[aá]tica|complexo|dif[íi]cil|pensar|thinking/i.test(desc);
  const isLocalSmall = /local|ollama|lm studio|pequen|3b|7b|1b/i.test(desc) || catalog.some(m => /:3b|:7b|:1b/.test(m.id) && m.id === currentModel);

  const tokenEconomy: any = {
    enabled: true,
    cachePrefix: true,
    responseCache: !isCoding, // agentes de código não cacheiam respostas
    tokenEstimation: true,
    maxContextTokens: 56000,
  };

  const booster: any = { enabled: false };

  if (isCoding) {
    tokenEconomy.stripReasoning = true;
    tokenEconomy.truncateToolOutput = true;
    tokenEconomy.truncateHistory = false;
    tokenEconomy.summarizeHistory = false;
    tokenEconomy.smartTruncation = false;
    tokenEconomy.dedupConsecutive = true;
    // Booster para agentes de código com modelos fracos
    if (isLocalSmall || /qwen|codellama|deepseek-coder|starcoder/i.test(currentModel)) {
      booster.enabled = true;
      booster.promptReinforcement = true;
      booster.correctiveLoop = true;
      booster.tolerantParser = true;
      booster.models = ['*'];
    }
  } else if (isData) {
    tokenEconomy.truncateHistory = true;
    tokenEconomy.summarizeHistory = true;
    tokenEconomy.truncateToolOutput = true;
    tokenEconomy.stripReasoning = true;
    tokenEconomy.smartTruncation = true;
    tokenEconomy.dedupConsecutive = true;
  } else if (isCreative) {
    tokenEconomy.truncateHistory = false;
    tokenEconomy.stripReasoning = false;
    tokenEconomy.responseCache = false;
  } else if (isReasoning) {
    tokenEconomy.stripReasoning = true;
    tokenEconomy.cachePrefix = true;
  } else {
    // Chat geral
    tokenEconomy.truncateHistory = false;
    tokenEconomy.stripReasoning = false;
    tokenEconomy.responseCache = true;
  }

  // Ajuste por tipo de provedor/modelo
  if (/gemini-2\.5|gemini-3|claude-.*-4|claude-opus/.test(currentModel)) {
    tokenEconomy.truncateHistory = false;
    tokenEconomy.maxContextTokens = 200000;
  }
  if (/deepseek-thinking/.test(currentModel)) {
    tokenEconomy.stripReasoning = true;
    tokenEconomy.maxContextTokens = 64000;
  }

  let recommendedModel = '';
  if (isCoding && !/coder|coding|code/.test(currentModel)) {
    const codeModel = catalog.find(m => /coder|coding|code/.test(m.id));
    if (codeModel) recommendedModel = codeModel.id;
  }

  // Parâmetros LLM por caso de uso
  let llmParams: any = { temperature: 0.7, top_p: 0.95, systemPromptOverride: '', maxTokens: 4000 };
  if (isCoding) {
    llmParams = { temperature: 0.1, top_p: 0.95, systemPromptOverride: 'Responda de forma direta, precisa e técnica. Priorize correção e completude do código. Evite explicações desnecessárias.', maxTokens: 8000 };
  } else if (isData) {
    llmParams = { temperature: 0.2, top_p: 0.9, systemPromptOverride: 'Foque em estrutura, precisão e completude dos dados. Retorne formatos estruturados (JSON, tabelas) quando apropriado.', maxTokens: 8000 };
  } else if (isCreative) {
    llmParams = { temperature: 0.9, top_p: 0.95, systemPromptOverride: 'Seja criativo, variado e expressivo. Use linguagem rica e envolvente.', maxTokens: 4000 };
  } else if (isReasoning) {
    llmParams = { temperature: 0.1, top_p: 0.9, systemPromptOverride: 'Use raciocínio passo a passo (chain-of-thought). Mostre o processo lógico antes da conclusão.', maxTokens: 16000 };
  } else {
    llmParams = { temperature: 0.7, top_p: 0.95, systemPromptOverride: '', maxTokens: 4000 };
  }

  return {
    llmParams,
    tokenEconomy,
    booster,
    recommendedModel,
    reasoning: `Configuração heurística baseada em: ${isCoding ? 'programação/agente' : isData ? 'análise de dados' : isCreative ? 'escrita criativa' : isReasoning ? 'raciocínio complexo' : 'chat geral'}${isLocalSmall ? ' + modelo local pequeno' : ''}.`
  };
}

// ── FASE 4: Local Models ──────────────────────────────────────────────────

import {
  discoverLocalInstances,
  getLocalInstances,
  checkAllHealth,
  getAllHealthStatuses,
  getAllMetrics,
  getFallbackConfig,
  configureFallback,
  getLocalModelsDashboard,
} from '../services/local-discovery.ts';

dashboard.get('/api/local-models', (c) => {
  return c.json(getLocalModelsDashboard());
});

dashboard.post('/api/local-models/refresh', async (c) => {
  const instances = await discoverLocalInstances();
  return c.json({ ok: true, count: instances.length, instances });
});

dashboard.get('/api/local-models/health', async (c) => {
  const statuses = await checkAllHealth();
  return c.json(statuses);
});

dashboard.get('/api/local-models/metrics', (c) => {
  return c.json(getAllMetrics());
});

dashboard.patch('/api/local-models/fallback', async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  configureFallback(body);
  return c.json({ ok: true, fallback: getFallbackConfig() });
});

// ── Auto Router ─────────────────────────────────────────────────────────

import {
  updateAutoRouterConfig,
  getAutoRouterConfig,
  getAutoRouterStatus,
  getAllModelMetadata,
  isModelDown,
  getModelHealthState,
  getModelMetricsFor,
} from '../services/auto-router/index.ts';

dashboard.get('/api/auto-router', (c) => {
  return c.json(getAutoRouterStatus());
});

dashboard.patch('/api/auto-router', async (c) => {
  const body: any = await c.req.json().catch(() => ({}));
  updateAutoRouterConfig(body);
  return c.json({ ok: true, config: getAutoRouterConfig() });
});

dashboard.get('/api/auto-router/metadata', (c) => {
  const now = Date.now();
  return c.json(
    getAllModelMetadata().map((m) => {
      const metrics = getModelMetricsFor(m.id);
      return {
        ...m,
        down: isModelDown(m.id, now),
        retryInMs: isModelDown(m.id, now)
          ? Math.max(0, getModelHealthState().find((h) => h.modelId === m.id)!.downUntil - now)
          : 0,
        metrics: metrics ?? null,
      };
    })
  );
});
