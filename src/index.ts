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
import { checkLogin, getLoginStatus } from './services/playwright.ts';
import { dashboard } from './ui/dashboard.ts';
import { attachLogger } from './ui/logger.ts';
import { fetchModels } from './services/local.ts';
import { attachVnc, attachVncWs } from './ui/vnc.ts';
import {
  resolveRegistry,
  enabledProviders,
  isDeepseekProvider,
  resolveActiveProvider,
} from './services/config.ts';

dotenv.config();

export const app = new Hono();

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
    } else {
      const models = await fetchModels(provider);
      if (models) data.push(...models);
    }
  }

  const deduped = data.filter((m) => {
    const id = m.id;
    if (seen.has(id)) return false;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  attachLogger();
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3005;

  const startupProvider = resolveActiveProvider();
  const needsPlaywright = enabledProviders(resolveRegistry()).some((p) => isDeepseekProvider(p));
  if (!needsPlaywright) {
    console.log(`Provedor principal: ${startupProvider.name}`);
    console.log(`LLM_BASE_URL=${startupProvider.baseUrl}`);
    if (startupProvider.model) console.log(`LLM_MODEL=${startupProvider.model}`);
    console.log('Playwright desativado (para usar a DeepSeek, não defina PROVIDER=local no .env).');
    startServer(port);
  } else {
    initPlaywright().then(() => {
      console.log('Playwright initialized.');
      startServer(port);

      // Aviso de login no startup
      (async () => {
        try {
          const quick = await getLoginStatus();
          const loggedIn = quick.loggedIn ? await checkLogin() : false;
          if (loggedIn) {
            console.log('Login na DeepSeek detectado. Tudo pronto para o chat.');
          } else {
            console.warn('Não foi detectado login na DeepSeek. Use "npm run login" ou o botão "Fazer login" do dashboard antes de usar o chat.');
          }
        } catch {
          // ignora falhas no check de login
        }
      })();
    }).catch((err: any) => {
      console.error('Failed to initialize playwright:', err);
      process.exit(1);
    });
  }
}
