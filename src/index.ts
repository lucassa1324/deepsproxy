/*
 * File: index.ts
 * Project: deepsproxy
 * Author: Lucas Sá
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Lucas Sá
 */

import { serve } from '@hono/node-server';
import { Hono, type Context, type Next } from 'hono';
import { HonoRequest } from 'hono/request';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import * as dotenv from 'dotenv';
import { initPlaywright } from './services/playwright.ts';
import { checkLogin } from './services/playwright.ts';
import { initQwenPlaywright, checkQwenLogin, loginToQwen, ensureQwenPage, isQwenLoginFlowActive, activeQwenPage } from './services/qwen-playwright.ts';
import { fetchQwenModels, QWEN_KNOWN_MODELS, qwenStreamsActive } from './services/qwen.ts';
import { initGeminiPlaywright, checkGeminiLogin } from './services/gemini-playwright.ts';
import { GEMINI_KNOWN_MODELS } from './services/gemini-web.ts';
import { dashboard } from './ui/dashboard.ts';
import { attachLogger } from './ui/logger.ts';
import { fetchModels, findProviderForModel } from './services/local.ts';
import { isAdapterProvider, fetchProviderModels } from './services/adapters/index.ts';
import { attachVnc, attachVncWs } from './ui/vnc.ts';
import { webSearch, registerWebSearchTool } from './tools/web-search.ts';
import { listServerTools } from './services/agent.ts';
import {
  resolveRegistry,
  enabledProviders,
  isDeepseekProvider,
  isQwenProvider,
  isGeminiWebProvider,
  resolveActiveProvider,
  normalizeModelId,
  primaryApiKey,
  getActiveApiKey,
} from './services/config.ts';
import type { Provider } from './services/config.ts';
import {
  extractBearerToken,
  getAppByKey,
  isVirtualKeyFormat,
} from './services/gateway.ts';
import { shutdownAgentPool, optimizedFetch } from './services/optimizations.ts';
import { startDiscovery, stopDiscovery, startHealthCheck, stopHealthCheck } from './services/local-discovery.ts';
import { updateApp } from './update.ts';

dotenv.config();

export const app = new Hono();

// AI Gateway: segunda porta (GATEWAY_PORT, padrão 3006). Aqui as rotas OpenAI
// (/v1/*) só respondem com uma chave virtual de aplicação — o modelo que o app
// recebe é controlado pelo painel (aba Apps), não pela ferramenta cliente.
export const gatewayApp = new Hono();

/** True quando o valor de um header de destino aponta para o PRÓPRIO proxy
 *  (localhost / loopback / porta local). Nesses casos o cliente HTTP de rede da
 *  IDE (mesh) rejeita a requisição com HTTP 400 antes de qualquer processamento. */
export function isLocalDestinationHeaderValue(value: string | null | undefined): boolean {
  const v = String(value ?? '').trim();
  if (!v) return false;
  // Porta local nua (ex.: '3005') — header de destino sem host.
  if (/^\d{1,5}$/.test(v)) return true;
  // localhost / loopback IPv4 / IPv6 (::1), com porta opcional ':3005'.
  return /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)(?::\d{1,5})?$/i.test(v)
    || /^\[::1\](?::\d{1,5})?$/i.test(v);
}

/** Remove 'destination-addr'/'destination-domain' de uma coleção de headers
 *  QUANDO um deles aponta para o destino local. Função pura (testável): os dois
 *  cabeçalhos de destino são removidos juntos para a requisição não carregar
 *  informação inconsistente; qualquer outro header permanece byte a byte. */
export function sanitizeDestinationHeadersFrom(headersInit: HeadersInit): Headers {
  const headers = new Headers(headersInit);
  const addr = headers.get('destination-addr');
  const domain = headers.get('destination-domain');
  if (isLocalDestinationHeaderValue(addr) || isLocalDestinationHeaderValue(domain)) {
    headers.delete('destination-addr');
    headers.delete('destination-domain');
  }
  return headers;
}

/** Intercepta as requisições recebidas (ambos os apps) e remove os cabeçalhos
 *  de destino locais ('destination-addr'/'destination-domain' apontando para
 *  localhost/127.0.0.1/porta local), evitando a rejeição HTTP 400 do cliente
 *  HTTP de rede da IDE. O `req` do Context do Hono v4 é getter omnileitura;
 *  a substituição usa defineProperty para não alterar o restante do pipeline. */
async function sanitizeLocalDestinationHeaders(c: Context, next: Next) {
  const raw = c.req.raw;
  const addr = raw.headers.get('destination-addr');
  const domain = raw.headers.get('destination-domain');
  if (isLocalDestinationHeaderValue(addr) || isLocalDestinationHeaderValue(domain)) {
    const sanitized = new Request(raw.url, {
      method: raw.method,
      headers: sanitizeDestinationHeadersFrom(raw.headers),
      body: raw.body,
      signal: raw.signal,
    });
    Object.defineProperty(c, 'req', {
      configurable: true,
      enumerable: true,
      get() {
        return new HonoRequest(sanitized);
      },
    } as unknown as PropertyDescriptor);
  }
  await next();
}

// Registra a tool nativa de busca na web (agentes que usam o registry).
registerWebSearchTool();

// Rotas internas do dashboard que não exigem API key
const PUBLIC_PATHS = new Set([
  '/',
  '/chat',
  '/chat-example',
  '/components/chat-component.js',
  '/health',
  '/api/status',
  '/api/logs',
  '/api/logs/stream',
  '/api/login/start',
  '/api/login/finish',
  '/api/qwen/login/start',
  '/api/qwen/login/finish',
  '/api/gemini/login/start',
  '/api/gemini/login/finish',
  '/api/update/check',
  '/api/update/download',
  '/api/update/launch',
]);

// Rotas do gateway (OpenAI-compatível): autenticáveis por chave virtual de app.
const GATEWAY_PATHS = new Set(['/v1/chat/completions', '/v1/models', '/v1/embeddings', '/v1/web/search', '/v1/tools']);

app.use('*', sanitizeLocalDestinationHeaders);
app.use('*', cors());

app.use('*', async (c, next) => {
  const p = c.req.path;
  const isVncPath = p === '/vnc' || p.startsWith('/vnc/');
  if (!PUBLIC_PATHS.has(p) && !isVncPath) {
    const apiKey = process.env.API_KEY;
    if (apiKey) {
      const authHeader = c.req.header('Authorization');
      const xApiKey = c.req.header('X-API-Key');
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
      if (!providedKey || providedKey !== apiKey) {
        // Chaves virtuais do gateway só autorizam as rotas OpenAI (/v1/*);
        // o restante (dashboard/admin) exige a API_KEY mestre do .env.
        const token = extractBearerToken(authHeader);
        const isGatewayAuthed =
          GATEWAY_PATHS.has(p) && !!token && isVirtualKeyFormat(token) && !!getAppByKey(token);
        if (!isGatewayAuthed) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }
    }
  }
  await next();
});

/* ------------------------- Modo direto (PORT, padrão 3005) ------------------------- */
// Dashboard (interface gráfica)
app.route('/', dashboard);

// Atualização via GitHub Releases (banner no dashboard).
app.route('/', updateApp);

// Login remoto (VNC) — apenas quando ENABLE_VNC=true (Docker)
attachVnc(app);

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Rotas OpenAI-compatíveis compartilhadas (chat/models/embeddings/web search).
registerOpenAIRoutes(app);

/* ------------------------- AI Gateway (GATEWAY_PORT, padrão 3006) ------------------------- */
// No gateway, /v1/* só responde com chave virtual de aplicação — o controle do
// modelo fica no painel (aba Apps), a IDE só aponta para a URL e envia a chave.
// As rotas do dashboard seguem a mesma proteção do modo direto (API_KEY do
// .env, quando configurada).
gatewayApp.use('*', sanitizeLocalDestinationHeaders);
gatewayApp.use('*', cors());
gatewayApp.use('*', async (c, next) => {
  const p = c.req.path;
  const isVncPath = p === '/vnc' || p.startsWith('/vnc/');
  if (PUBLIC_PATHS.has(p) || isVncPath) return next();

  if (GATEWAY_PATHS.has(p)) {
    const token = extractBearerToken(c.req.header('Authorization'));
    const entry = token ? getAppByKey(token) : null;
    if (!entry) {
      return c.json(
        { error: { message: 'API key inválida. Crie uma chave virtual na aba Apps do dashboard.' } },
        401
      );
    }
    if (entry.enabled === false) {
      return c.json({ error: { message: `Aplicação "${entry.name}" desativada no painel.` } }, 403);
    }
    // Guarda a aplicação no contexto: o handler de chat (porta 3006) lê daqui
    // o modelo configurado no painel e ignora o model enviado pelo cliente.
    (c as any).set('gatewayAppEntry', entry);
    return next();
  }

  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
    if (!providedKey || providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

gatewayApp.route('/', dashboard);
attachVnc(gatewayApp);
gatewayApp.get('/health', (c) => c.json({ status: 'ok', mode: 'gateway' }));
registerOpenAIRoutes(gatewayApp);

/**
 * Registra as rotas OpenAI-compatíveis (/v1/*) em um app Hono. O mesmo conjunto
 * é montado no modo direto (PORT) e no AI Gateway (GATEWAY_PORT) — a diferença
 * entre as portas está apenas na camada de autenticação de cada app.
 */
function registerOpenAIRoutes(h: Hono) {
  // OpenAI compatible routes
  h.post('/v1/chat/completions', chatCompletions);

  h.get('/v1/models', async (c) => {
    const registry = resolveRegistry(c.req.header('Cookie'));
    const enabled = enabledProviders(registry);
    return listModelsForProviders(enabled);
  });
}

// Helper: monta a lista deduplicada de modelos de um conjunto de provedores.
// Também exportado para reuso (rota do dashboard já usa outra via).
export async function listModelsForProviders(providers: Provider[]): Promise<Response> {
  const seen = new Set<string>();
  const data: any[] = [];
  const hasGeminiWeb = providers.some(isGeminiWebProvider);
  const geminiWebIds = new Set(GEMINI_KNOWN_MODELS.map((m) => m.id));

  for (const provider of providers) {
    if (isDeepseekProvider(provider)) {
      data.push(
        {
          id: 'deepseek-thinking',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'deepseek',
          permission: [],
          root: 'deepseek-thinking',
          parent: null,
        },
        {
          id: 'deepseek-no-thinking',
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'deepseek',
          permission: [],
          root: 'deepseek-no-thinking',
          parent: null,
        }
      );
    } else if (isQwenProvider(provider)) {
      let qwenModels: any[] = [];
      try {
        qwenModels = await fetchQwenModels();
      } catch (err: any) {
        console.warn('[models] falha ao buscar modelos do Qwen; usando lista conhecida:', err.message);
      }
      if (!qwenModels.length) {
        qwenModels = QWEN_KNOWN_MODELS.map((m) => ({
          ...m,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          permission: [],
          root: m.id,
          parent: null,
        }));
      }
      data.push(...qwenModels);
    } else if (isGeminiWebProvider(provider)) {
      data.push(
        ...GEMINI_KNOWN_MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'gemini-web',
          permission: [],
          root: m.id,
          parent: null,
        }))
      );
    } else {
      const models = isAdapterProvider(provider) ? await fetchProviderModels(provider, getActiveApiKey(provider)) : await fetchModels(provider);
      if (models) data.push(...models.filter((m: any) => !(hasGeminiWeb && geminiWebIds.has(normalizeModelId(m.id)))));
    }
    // Inclui o modelo de override do provedor, se configurado.
    if (provider.model) {
      data.push({
        id: provider.model,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.name,
        permission: [],
        root: provider.model,
        parent: null,
      });
    }
  }

  const deduped = data
    .map((m: any) => ({ ...m, id: normalizeModelId(m.id) }))
    .filter((m) => {
      const id = m.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  // Adicionar os modelos virtuais como primeiros da lista
  const autoModel = {
    id: 'auto',
    object: 'model' as const,
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepsproxy',
    permission: [],
    root: 'auto',
    parent: null,
  };

  const autoFreeModel = {
    id: 'auto-free',
    object: 'model' as const,
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepsproxy',
    permission: [],
    root: 'auto-free',
    parent: null,
  };

  const modelList = deduped.length ? [autoModel, autoFreeModel, ...deduped] : [autoModel, autoFreeModel,
    {
      id: 'deepseek-thinking',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'deepseek',
      permission: [],
      root: 'deepseek-thinking',
      parent: null,
    },
    {
      id: 'deepseek-no-thinking',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'deepseek',
      permission: [],
      root: 'deepseek-no-thinking',
      parent: null,
    },
  ];

  return new Response(
    JSON.stringify({
      object: 'list',
      data: modelList,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// OpenAI compatible embeddings. Roteia pelo nome do modelo para o provedor
// que "dona" dele (openai-compatible/ollama/gemini). DeepSeek e Qwen (browser)
// e Anthropic não têm endpoint de embeddings — respondem 501 com mensagem.
[app, gatewayApp].forEach((h) => {
  h.post('/v1/embeddings', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Corpo inválido (esperado JSON).' } }, 400);
  }

  const model = normalizeModelId(body.model);
  const input = body.input;
  if (!model) {
    return c.json({ error: { message: 'Informe o model de embedding.' } }, 400);
  }
  if (input === undefined || input === null || (Array.isArray(input) && input.length === 0)) {
    return c.json({ error: { message: 'Informe o campo "input" (texto ou lista de textos).' } }, 400);
  }

  const registryResolved = resolveRegistry(c.req.header('Cookie'));
  const enabled = enabledProviders(registryResolved);
  const primary = resolveActiveProvider(c.req.header('Cookie'));

  let target: Provider = primary;
  const owner = await findProviderForModel(enabled, model);
  if (owner) target = owner;

  if (isDeepseekProvider(target) || isQwenProvider(target) || isGeminiWebProvider(target)) {
    return c.json(
      {
        error: {
          message: `O provedor "${target.name}" (${target.type}) não suporta embeddings. Configure um provedor OpenAI-compatível (ex.: Ollama).`,
        },
      },
      501
    );
  }
  if (target.type === 'anthropic') {
    return c.json(
      { error: { message: 'O provedor Anthropic não oferece endpoint de embeddings.' } },
      501
    );
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const resolvedKey = primaryApiKey(target);
  if (resolvedKey) headers['authorization'] = `Bearer ${resolvedKey}`;

  let url: string;
  let payload: any = { model, input };
  if (target.type === 'gemini') {
    // Gemini: POST {base}/models/{model}:embedContent (chave na query string).
    url = `${target.baseUrl}/models/${model}:embedContent`;
    const texts = (Array.isArray(input) ? input : [input]).map((t: any) => String(t));
    payload = { content: { parts: texts.map((t) => ({ text: t })) } };
    delete headers['authorization'];
    if (resolvedKey) url += `?key=${encodeURIComponent(resolvedKey)}`;
  } else if (target.type === 'ollama') {
    // Ollama expõe a API OpenAI-compatível sob /v1.
    url = `${target.baseUrl}/v1/embeddings`;
  } else {
    url = `${target.baseUrl}/embeddings`;
  }

  console.log(`[embeddings] forward → ${target.name} (${target.type}) model=${model}`);

  let resp: Response;
  try {
    resp = await optimizedFetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (err: any) {
    console.error(`[embeddings] connection error ${target.name}: ${err?.message || String(err)}`);
    return c.json({ error: { message: `Falha ao conectar com ${target.name}: ${err?.message || String(err)}` } }, 502);
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`[embeddings] upstream error ${target.name}: HTTP ${resp.status} - ${errText}`);
    return c.json(
      { error: { message: `Upstream ${target.name} respondeu ${resp.status}: ${errText.slice(0, 300)}` } },
      502
    );
  }
  const data: any = await resp.json();

  // Gemini devolve { embedding: { values: [...] } }; converte para o formato OpenAI.
  if (target.type === 'gemini') {
    const embedding: number[] = data?.embedding?.values || data?.embedding || [];
    const texts = Array.isArray(input) ? input : [input];
    return c.json({
      object: 'list',
      data: texts.map((_, i) => ({ object: 'embedding', index: i, embedding })),
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  }

    return c.json(data);
  });

  // Lista as tools nativas que o proxy executa no modo agente (agent:true).
  h.get('/v1/tools', (c) => c.json({ tools: listServerTools() }));

  // Busca na web (backend da tool web_search). Retorna títulos, URLs e trechos
  // no formato JSON — útil para agentes e scripts.
  h.post('/v1/web/search', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: 'Corpo inválido (esperado JSON).' } }, 400);
  }
  const query = String(body.query || '').trim();
  if (!query) return c.json({ error: { message: 'Informe o campo "query".' } }, 400);
  const max = Math.min(Math.max(Number(body.max_results) || 5, 1), 10);

  try {
    console.log(`[web-search] query="${query}" max=${max}`);
    const results = await webSearch(query, max);
    return c.json({ query, results });
  } catch (err: any) {
    console.error(`[web-search] error: ${err?.message || String(err)}`);
    return c.json({ error: { message: err?.message || String(err) } }, 502);
  }
  });
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

function openDashboard(port: number) {
  if (process.env.OPEN_UI === 'false') return;
  const url = `http://localhost:${port}`;
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {});
}

function serveApp(label: string, honoApp: Hono, port: number, opts: { openUi?: boolean } = {}) {
  console.log(`[${label}] ${label === 'gateway' ? 'AI Gateway' : 'Modo direto'} rodando em http://localhost:${port}`);
  console.log(`[${label}] Dashboard: http://localhost:${port}`);
  if (process.env.ENABLE_VNC === 'true') {
    console.log(`[${label}] VNC remoto habilitado em /vnc (login do DeepSeek pelo navegador).`);
  }

  const server = serve({
    fetch: honoApp.fetch,
    port
  });

  attachVncWs(server);

  // Fecha o pool de conexões HTTP e discovery ao desligar o servidor
  process.on('SIGINT', () => {
    stopDiscovery();
    stopHealthCheck();
    shutdownAgentPool();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopDiscovery();
    stopHealthCheck();
    shutdownAgentPool();
    process.exit(0);
  });

  if (opts.openUi) openDashboard(port);
  return server;
}

function startGatewayServer(port: number) {
  if (process.env.ENABLE_GATEWAY === 'false') {
    console.log('[gateway] Desativado (ENABLE_GATEWAY=false). Usando apenas o modo direto (PORT).');
    return;
  }
  serveApp('gateway', gatewayApp, port);
  console.log(`[gateway] Para controlar o modelo pelo painel, configure suas IDEs com http://localhost:${port}/v1 + uma chave virtual (aba Apps).`);
}

/**
 * Cron de revalidação do Qwen: periodicamente verifica se o browser/sessão
 * continua utilizável e avisa quando o Qwen estiver indisponível (browser
 * fechado, login pendente ou sessão expirada). Não interrompe chats em
 * andamento e não reabre browser se ele nunca foi inicializado.
 */
function startQwenRevalidationCron() {
  const minutes = parseInt(process.env.QWEN_REVALIDATE_MINUTES || '5', 10);
  if (!(minutes > 0)) return;
  setInterval(() => {
    (async () => {
      try {
        if (isQwenLoginFlowActive()) {
          console.warn('[qwen] Aviso: fluxo de login do Qwen pendente (janela aberta sem "Concluir login"). Finalize ou cancele antes de usar o chat.');
          return;
        }
        if (qwenStreamsActive() > 0) {
          return; // há um chat em andamento; evita navegar a página no meio do stream
        }
        const page = activeQwenPage;
        if (!page || page.isClosed()) {
          console.warn('[qwen] Aviso: browser do Qwen fechado/inacessível. Tentando reinicializar...');
          await ensureQwenPage();
          console.log('[qwen] Browser do Qwen reinicializado.');
          return;
        }
        const loggedIn = await checkQwenLogin();
        if (!loggedIn) {
          console.warn('[qwen] Aviso: sessão do Qwen expirada ou inválida. Faça login novamente pelo dashboard (botão "Fazer login").');
        }
      } catch (err: any) {
        console.warn('[qwen] Aviso: Qwen indisponível na revalidação:', err.message);
      }
    })().catch(() => {});
  }, minutes * 60 * 1000);
  console.log(`[qwen] Cron de revalidação ativa a cada ${minutes} min. (QWEN_REVALIDATE_MINUTES).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  attachLogger();
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3005;
  const gatewayPort = process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT) : 3006;

  const startupProvider = resolveActiveProvider();
  const registry = resolveRegistry();
  const enabled = enabledProviders(registry);
  const needsDeepseekPlaywright = enabled.some((p) => isDeepseekProvider(p));
  const needsQwenPlaywright = enabled.some((p) => isQwenProvider(p));
  const needsGeminiPlaywright = enabled.some((p) => isGeminiWebProvider(p));

  if (!needsDeepseekPlaywright && !needsQwenPlaywright && !needsGeminiPlaywright) {
    console.log(`Provedor principal: ${startupProvider.name}`);
    console.log(`LLM_BASE_URL=${startupProvider.baseUrl}`);
    if (startupProvider.model) console.log(`LLM_MODEL=${startupProvider.model}`);
    console.log('Playwright desativado (para usar a DeepSeek, o Qwen ou o Gemini Web, não defina PROVIDER=local no .env).');
    serveApp('direct', app, port, { openUi: true });
    startGatewayServer(gatewayPort);
    // FASE 4: Auto-discovery e health check para modelos locais
    startDiscovery();
    startHealthCheck();
  } else {
    const boot = async () => {
      if (needsDeepseekPlaywright) await initPlaywright();
      if (needsQwenPlaywright) {
        await initQwenPlaywright();
        const email = process.env.QWEN_EMAIL;
        const password = process.env.QWEN_PASSWORD;
        if (email && password) {
          try {
            const alreadyLogged = await checkQwenLogin();
            if (!alreadyLogged) {
              const ok = await loginToQwen(email, password);
              if (ok) console.log('[qwen] Login automático com QWEN_EMAIL realizado.');
            }
          } catch (err: any) {
            console.warn('[qwen] Falha no login automático:', err.message);
          }
        }
      }
      if (needsGeminiPlaywright) await initGeminiPlaywright();
    };

    boot()
      .then(() => {
        if (needsDeepseekPlaywright) console.log('Playwright (DeepSeek) initialized.');
        if (needsQwenPlaywright) console.log('Playwright (Qwen) initialized.');
        if (needsGeminiPlaywright) console.log('Playwright (Gemini Web) initialized.');
        serveApp('direct', app, port, { openUi: true });
        startGatewayServer(gatewayPort);
        if (needsQwenPlaywright) startQwenRevalidationCron();

        // Avisos de login no startup
        if (needsDeepseekPlaywright) {
          (async () => {
            try {
              const loggedIn = await checkLogin();
              if (loggedIn) {
                console.log('Login na DeepSeek detectado. Tudo pronto para o chat.');
              } else {
                console.warn('Não foi detectado login na DeepSeek. Use "npm run login" ou o botão "Fazer login" do dashboard antes de usar o chat.');
              }
            } catch {
              // ignora falhas no check de login
            }
          })();
        }

        if (needsQwenPlaywright) {
          (async () => {
            try {
              const loggedIn = await checkQwenLogin();
              if (loggedIn) {
                console.log('Login no Qwen detectado. Tudo pronto para o chat.');
              } else {
                console.warn('Não foi detectado login no Qwen. Use o botão "Fazer login" do dashboard antes de usar o chat.');
              }
            } catch {
              // ignora falhas no check de login
            }
          })();
        }

        if (needsGeminiPlaywright) {
          (async () => {
            try {
              const loggedIn = await checkGeminiLogin();
              if (loggedIn) {
                console.log('Login no Gemini (Web) detectado. Tudo pronto para o chat.');
              } else {
                console.warn('Não foi detectado login no Gemini. Use o botão "Fazer login" do dashboard antes de usar o chat.');
              }
            } catch {
              // ignora falhas no check de login
            }
          })();
        }
      })
      .catch((err: any) => {
        console.error('Failed to initialize playwright:', err);
        process.exit(1);
      });
  }
}
