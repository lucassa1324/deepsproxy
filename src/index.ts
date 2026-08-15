/*
 * File: index.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatCompletions } from './routes/chat.ts';
import * as dotenv from 'dotenv';
import { initPlaywright } from './services/playwright.ts';
import { checkLogin } from './services/playwright.ts';
import { initQwenPlaywright, checkQwenLogin, loginToQwen, ensureQwenPage, isQwenLoginFlowActive, activeQwenPage } from './services/qwen-playwright.ts';
import { fetchQwenModels, QWEN_KNOWN_MODELS, qwenStreamsActive } from './services/qwen.ts';
import { dashboard } from './ui/dashboard.ts';
import { attachLogger } from './ui/logger.ts';
import { fetchModels, findProviderForModel } from './services/local.ts';
import { isAdapterProvider, fetchProviderModels } from './services/adapters/index.ts';
import { attachVnc, attachVncWs } from './ui/vnc.ts';
import { webSearch, registerWebSearchTool } from './tools/web-search.ts';
import {
  resolveRegistry,
  enabledProviders,
  isDeepseekProvider,
  isQwenProvider,
  resolveActiveProvider,
  normalizeModelId,
} from './services/config.ts';
import type { Provider } from './services/config.ts';

dotenv.config();

export const app = new Hono();

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
]);

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
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }
  }
  await next();
});

// Dashboard (interface gráfica)
app.route('/', dashboard);

// Login remoto (VNC) — apenas quando ENABLE_VNC=true (Docker)
attachVnc(app);

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', async (c) => {
  const registry = resolveRegistry(c.req.header('Cookie'));
  const enabled = enabledProviders(registry);
  const seen = new Set<string>();
  const data: any[] = [];

  for (const provider of enabled) {
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
    } else {
      const models = isAdapterProvider(provider) ? await fetchProviderModels(provider) : await fetchModels(provider);
      if (models) data.push(...models);
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

  return c.json({
    object: 'list',
    data: deduped.length
      ? deduped
      : [
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
        ],
  });
});

// OpenAI compatible embeddings. Roteia pelo nome do modelo para o provedor
// que "dona" dele (openai-compatible/ollama/gemini). DeepSeek e Qwen (browser)
// e Anthropic não têm endpoint de embeddings — respondem 501 com mensagem.
app.post('/v1/embeddings', async (c) => {
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

  if (isDeepseekProvider(target) || isQwenProvider(target)) {
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
  if (target.apiKey) headers['authorization'] = `Bearer ${target.apiKey}`;

  let url: string;
  let payload: any = { model, input };
  if (target.type === 'gemini') {
    // Gemini: POST {base}/models/{model}:embedContent (chave na query string).
    url = `${target.baseUrl}/models/${model}:embedContent`;
    const texts = (Array.isArray(input) ? input : [input]).map((t: any) => String(t));
    payload = { content: { parts: texts.map((t) => ({ text: t })) } };
    delete headers['authorization'];
    if (target.apiKey) url += `?key=${encodeURIComponent(target.apiKey)}`;
  } else if (target.type === 'ollama') {
    // Ollama expõe a API OpenAI-compatível sob /v1.
    url = `${target.baseUrl}/v1/embeddings`;
  } else {
    url = `${target.baseUrl}/embeddings`;
  }

  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (err: any) {
    return c.json({ error: { message: `Falha ao conectar com ${target.name}: ${err?.message || String(err)}` } }, 502);
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
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

// Busca na web (backend da tool web_search). Retorna títulos, URLs e trechos
// no formato JSON — útil para agentes e scripts.
app.post('/v1/web/search', async (c) => {
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
    const results = await webSearch(query, max);
    return c.json({ query, results });
  } catch (err: any) {
    return c.json({ error: { message: err?.message || String(err) } }, 502);
  }
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

function startServer(port: number) {
  console.log(`Server is running on port ${port}`);
  console.log(`Dashboard: http://localhost:${port}`);
  if (process.env.ENABLE_VNC === 'true') {
    console.log('VNC remoto habilitado em /vnc (login do DeepSeek pelo navegador).');
  }

  const server = serve({
    fetch: app.fetch,
    port
  });

  attachVncWs(server);

  openDashboard(port);
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

  const startupProvider = resolveActiveProvider();
  const registry = resolveRegistry();
  const enabled = enabledProviders(registry);
  const needsDeepseekPlaywright = enabled.some((p) => isDeepseekProvider(p));
  const needsQwenPlaywright = enabled.some((p) => isQwenProvider(p));

  if (!needsDeepseekPlaywright && !needsQwenPlaywright) {
    console.log(`Provedor principal: ${startupProvider.name}`);
    console.log(`LLM_BASE_URL=${startupProvider.baseUrl}`);
    if (startupProvider.model) console.log(`LLM_MODEL=${startupProvider.model}`);
    console.log('Playwright desativado (para usar a DeepSeek ou o Qwen, não defina PROVIDER=local no .env).');
    startServer(port);
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
    };

    boot()
      .then(() => {
        if (needsDeepseekPlaywright) console.log('Playwright (DeepSeek) initialized.');
        if (needsQwenPlaywright) console.log('Playwright (Qwen) initialized.');
        startServer(port);
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
      })
      .catch((err: any) => {
        console.error('Failed to initialize playwright:', err);
        process.exit(1);
      });
  }
}
